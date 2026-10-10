import type { Knex } from 'knex';

/**
 * Proxied monitors keep the timing their proxy agent actually used.
 *
 * Before the settings table became the single timing source (061), the config
 * pushed to proxy agents (agentHub.syncProxyMonitors) read the monitors
 * columns directly and never looked at settings:
 *   intervalSeconds = interval_seconds ?? 60
 *   timeoutMs       = timeout_ms       ?? 10000
 * 061 only copied the columns the SERVER worker treated as effective (no
 * settings row anywhere in the chain), so for a proxied monitor:
 *   - a NULL column would now resolve to the group / workspace value or the
 *     5000 ms default timeout instead of the 60 s / 10 s the proxy used;
 *   - a column shadowed by a group / workspace row would be replaced by that
 *     row, which the proxy never read.
 *
 * This migration pins, for every proxied monitor WITHOUT a monitor-scope row
 * for the key, a monitor-scope row equal to what the proxy ran with
 * (COALESCE(column, proxy fallback), clamped to the setting's range). Group
 * and workspace rows are ignored on purpose (the proxy never read them).
 * Existing monitor-scope rows are explicit overrides (or 061's copy of the
 * column): kept as they are; those that differ from the proxy's previous
 * timing are logged.
 *
 * Only check_interval and timeout: the proxy never consumed the retry keys.
 * Separate from 061 so installs that already applied 061 get it too.
 * Down is a no-op: the rows cannot be told apart from later overrides.
 */

// Frozen literals (keys, ranges, proxy fallbacks) — migrations must not follow
// later changes of shared/src/settingsDefaults.ts or agentHub.
const PROXY_TIMING = [
  { column: 'interval_seconds', key: 'check_interval', fallback: 60,    min: 1,    max: 86400 },
  { column: 'timeout_ms',       key: 'timeout',        fallback: 10000, min: 1000, max: 60000 },
];

export async function up(knex: Knex): Promise<void> {
  for (const { column, key, fallback, min, max } of PROXY_TIMING) {
    const differing = await knex.raw(
      `
      SELECT m.id, m.tenant_id, s.value AS override,
             LEAST(GREATEST(COALESCE(m.:column:, :fallback), :min), :max) AS proxy_value
        FROM monitors m
        JOIN settings s
          ON s.scope = 'monitor' AND s.scope_id = m.id AND s.key = :key
       WHERE m.proxy_agent_device_id IS NOT NULL
         AND s.value <> to_jsonb(LEAST(GREATEST(COALESCE(m.:column:, :fallback), :min), :max))
       ORDER BY m.id
      `,
      { column, key, fallback, min, max },
    ) as { rows: unknown[] };
    if (differing.rows.length > 0) {
      console.warn(
        `[062] ${differing.rows.length} proxied monitor(s) have a monitor-scope ${key} override that differs from the timing their proxy used (${column}) — the override is kept`,
        differing.rows.slice(0, 200),
      );
    }

    await knex.raw(
      `
      INSERT INTO settings (tenant_id, scope, scope_id, key, value, created_at, updated_at)
      SELECT m.tenant_id, 'monitor', m.id, :key,
             to_jsonb(LEAST(GREATEST(COALESCE(m.:column:, :fallback), :min), :max)),
             NOW(), NOW()
        FROM monitors m
       WHERE m.proxy_agent_device_id IS NOT NULL
         AND NOT EXISTS (
               SELECT 1 FROM settings s
                WHERE s.scope = 'monitor' AND s.scope_id = m.id AND s.key = :key
             )
      ON CONFLICT (tenant_id, scope, scope_id, key) WHERE scope_id IS NOT NULL DO NOTHING
      `,
      { column, key, fallback, min, max },
    );
  }
}

export async function down(_knex: Knex): Promise<void> {
  // No-op — see the header comment.
}
