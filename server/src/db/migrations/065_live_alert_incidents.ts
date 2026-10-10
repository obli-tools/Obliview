import type { Knex } from 'knex';

/**
 * Live alerts: incident model, entity links and per-user state.
 *
 * - live_alerts.monitor_id / agent_device_id: the entity an alert is about
 *   (visibility filtering + targeted Socket.io delivery). ON DELETE CASCADE:
 *   deleting the monitor / device removes its alerts.
 * - live_alerts.resolved_at: an incident (one active row per stable key) is
 *   resolved on recovery instead of a separate 'up' row being inserted.
 * - severity vocabulary aligned with the suite (Obliance, Android shell):
 *   'down' → 'critical', 'warning' stays, 'up' → 'info' (and those former
 *   recovery rows are resolved).
 * - live_alert_user_state: read / dismissed per user (live_alerts.read_at is
 *   kept as a legacy "read for everyone" marker and no longer written).
 *
 * Legacy rows are linked back to their monitor / device from navigate_to and
 * the agent stable key, so their incidents can still be resolved.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('live_alerts', (t) => {
    t.integer('monitor_id').nullable().references('id').inTable('monitors').onDelete('CASCADE');
    t.integer('agent_device_id').nullable().references('id').inTable('agent_devices').onDelete('CASCADE');
    t.timestamp('resolved_at', { useTz: true }).nullable();
  });

  // ── Backfill entity links (only when the entity still exists in the same tenant) ──
  await knex.raw(`
    UPDATE live_alerts la
       SET monitor_id = m.id
      FROM monitors m
     WHERE la.monitor_id IS NULL
       AND la.navigate_to ~ '^/monitors?/[0-9]{1,9}(/.*)?$'
       AND m.id = substring(la.navigate_to from '^/monitors?/([0-9]{1,9})')::int
       AND m.tenant_id = la.tenant_id
  `);
  await knex.raw(`
    UPDATE live_alerts la
       SET agent_device_id = d.id
      FROM agent_devices d
     WHERE la.agent_device_id IS NULL
       AND la.stable_key ~ '^agent-[0-9]{1,9}-'
       AND d.id = substring(la.stable_key from '^agent-([0-9]{1,9})-')::int
       AND d.tenant_id = la.tenant_id
  `);
  await knex.raw(`
    UPDATE live_alerts la
       SET agent_device_id = d.id
      FROM agent_devices d
     WHERE la.agent_device_id IS NULL
       AND la.navigate_to ~ '^/agents/[0-9]{1,9}(/.*)?$'
       AND d.id = substring(la.navigate_to from '^/agents/([0-9]{1,9})')::int
       AND d.tenant_id = la.tenant_id
  `);
  // Agent monitor alerts: link the device behind the monitor.
  await knex.raw(`
    UPDATE live_alerts la
       SET agent_device_id = m.agent_device_id
      FROM monitors m
     WHERE la.agent_device_id IS NULL
       AND la.monitor_id = m.id
       AND m.agent_device_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM agent_devices d WHERE d.id = m.agent_device_id)
  `);

  // ── Severity vocabulary ──
  await knex('live_alerts').where({ severity: 'down' }).update({ severity: 'critical' });
  // Former recovery rows: informational and already over.
  await knex.raw(`
    UPDATE live_alerts SET severity = 'info', resolved_at = created_at WHERE severity = 'up'
  `);

  // Legacy DOWN rows of a monitor get the incident stable key.
  await knex.raw(`
    UPDATE live_alerts
       SET stable_key = 'monitor:' || monitor_id || ':down'
     WHERE stable_key IS NULL AND severity = 'critical' AND monitor_id IS NOT NULL
  `);

  // Resolve legacy problem rows that were followed by a recovery row of the
  // same monitor (the old model inserted 'up' rows instead of resolving).
  await knex.raw(`
    UPDATE live_alerts p
       SET resolved_at = (
         SELECT min(r.created_at) FROM live_alerts r
          WHERE r.monitor_id = p.monitor_id AND r.severity = 'info'
            AND r.resolved_at IS NOT NULL AND r.created_at >= p.created_at
       )
     WHERE p.resolved_at IS NULL
       AND p.monitor_id IS NOT NULL
       AND p.severity IN ('critical', 'warning')
       AND EXISTS (
         SELECT 1 FROM live_alerts r
          WHERE r.monitor_id = p.monitor_id AND r.severity = 'info'
            AND r.resolved_at IS NOT NULL AND r.created_at >= p.created_at
       )
  `);
  // And those whose monitor is not in a problem state any more.
  await knex.raw(`
    UPDATE live_alerts la
       SET resolved_at = now()
      FROM monitors m
     WHERE la.resolved_at IS NULL
       AND la.monitor_id = m.id
       AND la.severity IN ('critical', 'warning')
       AND m.status NOT IN ('down', 'alert', 'ssl_warning', 'ssl_expired')
  `);
  // At most one active row per (tenant, stable key): keep the newest.
  await knex.raw(`
    UPDATE live_alerts la
       SET resolved_at = now()
     WHERE la.resolved_at IS NULL
       AND la.stable_key IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM live_alerts n
          WHERE n.tenant_id = la.tenant_id AND n.stable_key = la.stable_key
            AND n.resolved_at IS NULL AND n.id > la.id
       )
  `);

  await knex.raw(`CREATE INDEX live_alerts_monitor ON live_alerts(monitor_id) WHERE monitor_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX live_alerts_agent_device ON live_alerts(agent_device_id) WHERE agent_device_id IS NOT NULL`);
  // Active-incident lookup (dedup + resolve).
  await knex.raw(`
    CREATE INDEX live_alerts_active_key ON live_alerts(tenant_id, stable_key)
     WHERE stable_key IS NOT NULL AND resolved_at IS NULL
  `);

  await knex.schema.createTable('live_alert_user_state', (t) => {
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.integer('alert_id').notNullable().references('id').inTable('live_alerts').onDelete('CASCADE');
    t.timestamp('read_at', { useTz: true }).nullable();
    t.timestamp('dismissed_at', { useTz: true }).nullable();
    t.primary(['user_id', 'alert_id']);
  });
  await knex.raw(`CREATE INDEX live_alert_user_state_alert ON live_alert_user_state(alert_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('live_alert_user_state');
  await knex.raw(`DROP INDEX IF EXISTS live_alerts_active_key`);
  await knex.raw(`DROP INDEX IF EXISTS live_alerts_agent_device`);
  await knex.raw(`DROP INDEX IF EXISTS live_alerts_monitor`);
  await knex('live_alerts').where({ severity: 'critical' }).update({ severity: 'down' });
  // Resolved informational rows were recovery rows.
  await knex('live_alerts').where({ severity: 'info' }).whereNotNull('resolved_at').update({ severity: 'up' });
  await knex.raw(`UPDATE live_alerts SET stable_key = NULL WHERE stable_key ~ '^monitor:[0-9]+:'`);
  await knex.schema.alterTable('live_alerts', (t) => {
    t.dropColumn('resolved_at');
    t.dropColumn('agent_device_id');
    t.dropColumn('monitor_id');
  });
}
