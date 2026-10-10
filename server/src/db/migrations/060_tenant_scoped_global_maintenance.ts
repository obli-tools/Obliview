import type { Knex } from 'knex';

/**
 * Keep day-1 coverage of global maintenance windows after they became
 * workspace-scoped.
 *
 * Until this release a global maintenance window (scope_type = 'global') in
 * ANY tenant suppressed alerts for EVERY tenant: maintenance.service looked
 * global windows up without a tenant filter. It now only applies a tenant's own
 * global windows, so a platform-wide "Sunday 02:00 patching" window created in
 * the master tenant would silently stop covering the other workspaces.
 *
 * For every global window W and every other tenant T this migration:
 *   - inserts a copy of W in T (same name, schedule, timezone, active flag and
 *     last-notified timestamps, so a window running right now does not send a
 *     fresh "start" notification); notify_channel_ids keeps only the channels T
 *     owns or has shared to it — usually none, which avoids duplicate start/end
 *     messages on the source tenant's channels;
 *   - moves W's opt-outs (maintenance_window_disables) whose entity belongs to
 *     T onto T's copy; opt-outs of entities that no longer exist are dropped.
 *
 * Idempotent: a tenant that already has a global window with the same name and
 * schedule fields reuses it instead of getting another copy.
 *
 * Down is a no-op: the copies cannot be told apart from windows created by
 * hand afterwards, and the old cross-tenant behaviour is not restored (same
 * convention as 058's down).
 */

interface WindowRow {
  id: number;
  name: string;
  scope_type: string;
  scope_id: number | null;
  is_override: boolean;
  schedule_type: string;
  start_at: Date | null;
  end_at: Date | null;
  start_time: string | null;
  end_time: string | null;
  recurrence_type: string | null;
  days_of_week: number[] | null;
  timezone: string;
  notify_channel_ids: number[] | null;
  last_notified_start_at: Date | null;
  last_notified_end_at: Date | null;
  active: boolean;
  tenant_id: number;
}

function ts(d: Date | null): number | null {
  return d ? new Date(d).getTime() : null;
}

/** Identity of a window for the idempotency check (tenant excluded). */
function windowKey(w: WindowRow): string {
  return JSON.stringify([
    w.name,
    w.schedule_type,
    ts(w.start_at),
    ts(w.end_at),
    w.start_time,
    w.end_time,
    w.recurrence_type,
    w.days_of_week ?? null,
    w.timezone,
  ]);
}

export async function up(knex: Knex): Promise<void> {
  const globals = await knex<WindowRow>('maintenance_windows')
    .where({ scope_type: 'global' })
    .orderBy('id')
    .select('*') as WindowRow[];
  if (globals.length === 0) return;

  const tenantIds = (await knex('tenants').pluck('id') as number[]).map(Number);
  if (tenantIds.length < 2) return;

  // Channels usable by each tenant: owned or shared to it.
  const usable = new Map<number, Set<number>>();
  const use = (tenantId: number, channelId: number) => {
    if (!usable.has(tenantId)) usable.set(tenantId, new Set());
    usable.get(tenantId)!.add(channelId);
  };
  const owned = await knex('notification_channels').select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
  for (const c of owned) use(Number(c.tenant_id), Number(c.id));
  const shared = await knex('notification_channel_tenants').select('channel_id', 'tenant_id') as
    Array<{ channel_id: number; tenant_id: number }>;
  for (const s of shared) use(Number(s.tenant_id), Number(s.channel_id));

  // Existing global windows per tenant, keyed for the idempotency check.
  const existing = new Map<string, number>(); // `${tenant}|${key}` → window id
  for (const w of globals) existing.set(`${w.tenant_id}|${windowKey(w)}`, w.id);

  for (const w of globals) {
    // Opt-outs of this window, with the tenant of the entity that opted out.
    const disables = await knex.raw(`
      SELECT d.id, d.scope_type, d.scope_id,
             COALESCE(g.tenant_id, m.tenant_id, a.tenant_id) AS entity_tenant_id
        FROM maintenance_window_disables d
        LEFT JOIN monitor_groups g ON d.scope_type = 'group'   AND g.id = d.scope_id
        LEFT JOIN monitors       m ON d.scope_type = 'monitor' AND m.id = d.scope_id
        LEFT JOIN agent_devices  a ON d.scope_type = 'agent'   AND a.id = d.scope_id
       WHERE d.window_id = ?
    `, [w.id]) as {
      rows: Array<{ id: number; scope_type: string; scope_id: number; entity_tenant_id: number | null }>;
    };

    // Opt-outs of entities that no longer exist can never apply again.
    const gone = disables.rows.filter((d) => d.entity_tenant_id === null).map((d) => d.id);
    if (gone.length > 0) await knex('maintenance_window_disables').whereIn('id', gone).del();

    for (const tenantId of tenantIds) {
      if (tenantId === Number(w.tenant_id)) continue;

      const key = `${tenantId}|${windowKey(w)}`;
      let cloneId = existing.get(key);
      if (cloneId === undefined) {
        const allowed = usable.get(tenantId) ?? new Set<number>();
        const notifyIds = (w.notify_channel_ids ?? []).filter((id) => allowed.has(Number(id)));
        const [inserted] = await knex('maintenance_windows')
          .insert({
            name: w.name,
            scope_type: 'global',
            scope_id: null,
            is_override: w.is_override,
            schedule_type: w.schedule_type,
            start_at: w.start_at,
            end_at: w.end_at,
            start_time: w.start_time,
            end_time: w.end_time,
            recurrence_type: w.recurrence_type,
            days_of_week: w.days_of_week,
            timezone: w.timezone,
            notify_channel_ids: notifyIds,
            last_notified_start_at: w.last_notified_start_at,
            last_notified_end_at: w.last_notified_end_at,
            active: w.active,
            tenant_id: tenantId,
          })
          .returning('id') as Array<{ id: number } | number>;
        cloneId = typeof inserted === 'object' ? inserted.id : inserted;
        existing.set(key, cloneId);
      }

      // Move this tenant's opt-outs from the source window to its copy.
      for (const d of disables.rows) {
        if (d.entity_tenant_id === null || Number(d.entity_tenant_id) !== tenantId) continue;
        const already = await knex('maintenance_window_disables')
          .where({ window_id: cloneId, scope_type: d.scope_type, scope_id: d.scope_id })
          .first('id');
        if (already) {
          await knex('maintenance_window_disables').where({ id: d.id }).del();
        } else {
          await knex('maintenance_window_disables').where({ id: d.id }).update({ window_id: cloneId });
        }
      }
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Intentionally a no-op: see the header comment.
}
