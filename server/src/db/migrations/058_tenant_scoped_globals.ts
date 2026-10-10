import type { Knex } from 'knex';

/**
 * Tenant-scope the "global" layers.
 *
 * Until now "global" meant platform-wide:
 *   - a global notification binding created in any tenant sent EVERY tenant's
 *     alerts to that tenant's channel (notification_bindings had no tenant_id);
 *   - global settings rows ignored settings.tenant_id, and every save of a
 *     global setting inserted a duplicate row because UNIQUE(scope, scope_id,
 *     key) never matches when scope_id IS NULL (PostgreSQL: NULL != NULL).
 *
 * After this migration "global" means "workspace-wide" (one tenant).
 *
 * (a) notification_bindings.tenant_id
 *     - backfilled from the channel's tenant for global rows and from the
 *       scope entity's tenant for group / monitor / agent rows;
 *     - orphans (scope entity gone) and rows whose channel is neither owned by
 *       nor shared to the binding tenant are deleted (the dropped rows are
 *       logged so an operator can recreate the intentional ones);
 *     - duplicate global rows are collapsed (same reason as settings below)
 *       and protected by a partial unique index;
 *     - NOT NULL + index (tenant_id, scope, scope_id);
 *     - every global binding is then copied to each tenant the channel is
 *       shared with (notification_channel_tenants), override_mode unchanged, so
 *       a shared channel keeps receiving those tenants' alerts as before.
 *
 * (b) settings
 *     - tenant_id backfilled for group / monitor rows from their entity;
 *     - duplicates removed (highest id wins);
 *     - UNIQUE(scope, scope_id, key) replaced by two partial unique indexes,
 *       same layout as Obliance migration 009:
 *         (tenant_id, scope, key)           WHERE scope_id IS NULL
 *         (tenant_id, scope, scope_id, key) WHERE scope_id IS NOT NULL
 *
 * (c) the master tenant's (id 1) global settings are copied to every other
 *     existing tenant so effective values are unchanged on day 1.
 *
 * (d) maintenance_windows: scoped windows (group / monitor / agent) created
 *     from the god view were stored under the master tenant. They are re-homed
 *     to their entity's tenant, and notify channels that tenant can no longer
 *     use are dropped. Global windows keep their tenant (authoritative).
 */

const MASTER_TENANT_ID = 1;

export async function up(knex: Knex): Promise<void> {
  // ── (a) notification_bindings.tenant_id ────────────────────────────────────

  await knex.schema.alterTable('notification_bindings', (t) => {
    t.integer('tenant_id')
      .nullable()
      .references('id')
      .inTable('tenants')
      .onDelete('CASCADE');
  });

  // Global rows → owner tenant of the channel
  await knex.raw(`
    UPDATE notification_bindings nb
       SET tenant_id = c.tenant_id
      FROM notification_channels c
     WHERE nb.channel_id = c.id
       AND nb.scope = 'global'
  `);

  // Group rows → tenant of the group
  await knex.raw(`
    UPDATE notification_bindings nb
       SET tenant_id = g.tenant_id
      FROM monitor_groups g
     WHERE nb.scope = 'group'
       AND nb.scope_id = g.id
  `);

  // Monitor rows → tenant of the monitor
  await knex.raw(`
    UPDATE notification_bindings nb
       SET tenant_id = m.tenant_id
      FROM monitors m
     WHERE nb.scope = 'monitor'
       AND nb.scope_id = m.id
  `);

  // Agent rows → tenant of the device
  await knex.raw(`
    UPDATE notification_bindings nb
       SET tenant_id = d.tenant_id
      FROM agent_devices d
     WHERE nb.scope = 'agent'
       AND nb.scope_id = d.id
  `);

  // Orphans: the scope entity no longer exists (or unknown scope) — they could
  // never fire for anything, drop them.
  const orphans = await knex.raw(`
    DELETE FROM notification_bindings
     WHERE tenant_id IS NULL
    RETURNING id, channel_id, scope, scope_id, tenant_id, override_mode
  `) as { rows: unknown[] };
  if (orphans.rows.length > 0) {
    console.warn('[058] dropped orphan notification_bindings', orphans.rows);
  }

  // Cross-tenant leaks: the channel is neither owned by the binding tenant nor
  // shared to it through notification_channel_tenants. Logged so an operator
  // can recreate the ones that were intentional.
  const leaks = await knex.raw(`
    DELETE FROM notification_bindings nb
     USING notification_channels c
     WHERE nb.channel_id = c.id
       AND c.tenant_id <> nb.tenant_id
       AND NOT EXISTS (
             SELECT 1
               FROM notification_channel_tenants nct
              WHERE nct.channel_id = nb.channel_id
                AND nct.tenant_id  = nb.tenant_id
           )
    RETURNING nb.id, nb.channel_id, nb.scope, nb.scope_id, nb.tenant_id, nb.override_mode
  `) as { rows: unknown[] };
  if (leaks.rows.length > 0) {
    console.warn('[058] dropped cross-tenant notification_bindings', leaks.rows);
  }

  // Global rows were never deduplicated (UNIQUE(channel_id, scope, scope_id)
  // ignores NULL scope_id) — keep the highest id per (tenant, channel).
  await knex.raw(`
    DELETE FROM notification_bindings a
     USING notification_bindings b
     WHERE a.id < b.id
       AND a.tenant_id  = b.tenant_id
       AND a.channel_id = b.channel_id
       AND a.scope      = b.scope
       AND a.scope_id IS NULL
       AND b.scope_id IS NULL
  `);

  await knex.raw(`ALTER TABLE notification_bindings ALTER COLUMN tenant_id SET NOT NULL`);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS notification_bindings_tenant_scope_idx
      ON notification_bindings (tenant_id, scope, scope_id)
  `);

  // One global binding per (tenant, channel). Scoped rows stay covered by the
  // existing UNIQUE(channel_id, scope, scope_id) — a scope entity belongs to a
  // single tenant.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS notification_bindings_global_uq
      ON notification_bindings (tenant_id, channel_id, scope)
      WHERE scope_id IS NULL
  `);

  // Global bindings used to fire for every tenant. Give each tenant the channel
  // is shared with its own copy (override_mode as-is) so delivery is unchanged
  // wherever the owner-or-shared model allows it. Tenants the channel is not
  // shared with get nothing: the runtime filter rejects that channel for them.
  await knex.raw(`
    INSERT INTO notification_bindings (channel_id, scope, scope_id, override_mode, tenant_id)
    SELECT nb.channel_id, nb.scope, NULL, nb.override_mode, nct.tenant_id
      FROM notification_bindings nb
      JOIN notification_channel_tenants nct ON nct.channel_id = nb.channel_id
     WHERE nb.scope = 'global'
       AND nb.scope_id IS NULL
       AND nct.tenant_id <> nb.tenant_id
    ON CONFLICT (tenant_id, channel_id, scope) WHERE scope_id IS NULL DO NOTHING
  `);

  // ── (b) settings ───────────────────────────────────────────────────────────

  // Backfill tenant_id of scoped rows from their entity (039 defaulted every
  // row to tenant 1 and the service never wrote tenant_id since).
  await knex.raw(`
    UPDATE settings s
       SET tenant_id = g.tenant_id
      FROM monitor_groups g
     WHERE s.scope = 'group'
       AND s.scope_id = g.id
       AND s.tenant_id <> g.tenant_id
  `);
  await knex.raw(`
    UPDATE settings s
       SET tenant_id = m.tenant_id
      FROM monitors m
     WHERE s.scope = 'monitor'
       AND s.scope_id = m.id
       AND s.tenant_id <> m.tenant_id
  `);

  // Deduplicate global rows — keep the highest id per (tenant_id, scope, key).
  await knex.raw(`
    DELETE FROM settings a
     USING settings b
     WHERE a.id < b.id
       AND a.tenant_id = b.tenant_id
       AND a.scope     = b.scope
       AND a.key       = b.key
       AND a.scope_id IS NULL
       AND b.scope_id IS NULL
  `);

  // Deduplicate scoped rows — keep the highest id per (tenant_id, scope, scope_id, key).
  await knex.raw(`
    DELETE FROM settings a
     USING settings b
     WHERE a.id < b.id
       AND a.tenant_id = b.tenant_id
       AND a.scope     = b.scope
       AND a.scope_id  = b.scope_id
       AND a.key       = b.key
  `);

  // Drop the old UNIQUE(scope, scope_id, key). Knex names it
  // settings_scope_scope_id_key_unique (006_create_settings.ts), but look it up
  // by its columns as well so a differently-named constraint is not missed.
  await knex.raw(`ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_scope_scope_id_key_unique`);
  const legacy = await knex.raw(`
    SELECT con.conname AS name
      FROM pg_constraint con
      JOIN pg_class rel     ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE rel.relname = 'settings'
       AND nsp.nspname = current_schema()
       AND con.contype = 'u'
       AND (
             SELECT array_agg(att.attname::text ORDER BY att.attname::text)
               FROM unnest(con.conkey) AS k(attnum)
               JOIN pg_attribute att
                 ON att.attrelid = con.conrelid
                AND att.attnum   = k.attnum
           ) = ARRAY['key', 'scope', 'scope_id']::text[]
  `) as { rows: Array<{ name: string }> };
  for (const row of legacy.rows) {
    await knex.raw('ALTER TABLE settings DROP CONSTRAINT ??', [row.name]);
  }
  // In case it ever existed as a bare unique index rather than a constraint.
  await knex.raw(`DROP INDEX IF EXISTS settings_scope_scope_id_key_unique`);

  // Partial unique indexes (Obliance 009 layout).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS settings_global_uq
      ON settings (tenant_id, scope, key)
      WHERE scope_id IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS settings_scoped_uq
      ON settings (tenant_id, scope, scope_id, key)
      WHERE scope_id IS NOT NULL
  `);

  // ── (c) Copy the master tenant's global settings to every other tenant ────
  // Keys a tenant already has (e.g. imported into that tenant) are kept.
  await knex.raw(
    `
    INSERT INTO settings (tenant_id, scope, scope_id, key, value, created_at, updated_at)
    SELECT t.id, s.scope, NULL, s.key, s.value, NOW(), NOW()
      FROM settings s
     CROSS JOIN tenants t
     WHERE s.tenant_id = ?
       AND s.scope_id IS NULL
       AND t.id <> ?
    ON CONFLICT (tenant_id, scope, key) WHERE scope_id IS NULL DO NOTHING
    `,
    [MASTER_TENANT_ID, MASTER_TENANT_ID],
  );

  // ── (d) maintenance_windows: re-home scoped windows to their entity's tenant ─
  await knex.raw(`
    UPDATE maintenance_windows w
       SET tenant_id = g.tenant_id
      FROM monitor_groups g
     WHERE w.scope_type = 'group'
       AND w.scope_id = g.id
       AND w.tenant_id <> g.tenant_id
  `);
  await knex.raw(`
    UPDATE maintenance_windows w
       SET tenant_id = m.tenant_id
      FROM monitors m
     WHERE w.scope_type = 'monitor'
       AND w.scope_id = m.id
       AND w.tenant_id <> m.tenant_id
  `);
  await knex.raw(`
    UPDATE maintenance_windows w
       SET tenant_id = d.tenant_id
      FROM agent_devices d
     WHERE w.scope_type = 'agent'
       AND w.scope_id = d.id
       AND w.tenant_id <> d.tenant_id
  `);
  // Keep only the notify channels the window's tenant owns or has shared to
  // it, so the window stays saveable and nothing goes to a foreign channel.
  await knex.raw(`
    UPDATE maintenance_windows w
       SET notify_channel_ids = ARRAY(
             SELECT cid
               FROM unnest(w.notify_channel_ids) AS u(cid)
               JOIN notification_channels c ON c.id = u.cid
              WHERE c.tenant_id = w.tenant_id
                 OR EXISTS (
                      SELECT 1
                        FROM notification_channel_tenants nct
                       WHERE nct.channel_id = u.cid
                         AND nct.tenant_id  = w.tenant_id
                    )
           )
     WHERE w.scope_type <> 'global'
       AND cardinality(w.notify_channel_ids) > 0
  `);
}

export async function down(knex: Knex): Promise<void> {
  // settings — back to UNIQUE(scope, scope_id, key). Scoped rows cannot collide
  // across tenants (a group / monitor has one tenant); global rows have a NULL
  // scope_id so the restored constraint does not see them.
  await knex.raw(`DROP INDEX IF EXISTS settings_global_uq`);
  await knex.raw(`DROP INDEX IF EXISTS settings_scoped_uq`);
  await knex.raw(`
    DELETE FROM settings a
     USING settings b
     WHERE a.id < b.id
       AND a.scope    = b.scope
       AND a.scope_id = b.scope_id
       AND a.key      = b.key
  `);
  await knex.raw(`
    ALTER TABLE settings
      ADD CONSTRAINT settings_scope_scope_id_key_unique
      UNIQUE (scope, scope_id, key)
  `);

  // notification_bindings — drop the tenant column (deleted leak / orphan rows
  // are not restored). The per-shared-tenant copies of global rows go first so
  // only the owner's row remains, as before the migration.
  await knex.raw(`DROP INDEX IF EXISTS notification_bindings_global_uq`);
  await knex.raw(`
    DELETE FROM notification_bindings nb
     USING notification_channels c
     WHERE nb.channel_id = c.id
       AND nb.scope = 'global'
       AND nb.scope_id IS NULL
       AND nb.tenant_id <> c.tenant_id
  `);
  await knex.raw(`DROP INDEX IF EXISTS notification_bindings_tenant_scope_idx`);
  await knex.schema.alterTable('notification_bindings', (t) => {
    t.dropColumn('tenant_id');
  });
}
