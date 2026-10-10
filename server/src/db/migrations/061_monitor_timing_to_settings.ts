import type { Knex } from 'knex';

/**
 * Monitor timing: the settings table becomes the single source.
 *
 * Until now the check interval, timeout, retry interval and max retries of a
 * monitor lived in two places:
 *   - the monitors columns (interval_seconds, timeout_ms,
 *     retry_interval_seconds, max_retries), written by the monitor form;
 *   - scope='monitor' settings rows, written by bulk edit and SettingsPanel.
 * MonitorWorkerManager.buildConfig used the column ONLY when no settings row
 * existed anywhere in the chain (monitor → group ancestors → workspace); any
 * settings row won over it.
 *
 * From now on buildConfig reads the resolved settings only. This migration
 * copies every column value that is EFFECTIVE today into a scope='monitor'
 * settings row (tenant = the monitor's tenant), so no running monitor changes
 * timing on upgrade:
 *   - column NULL                                  → nothing to copy;
 *   - a settings row already exists for that key on
 *     the monitor, one of its group ancestors or
 *     the workspace                                → the column was ignored
 *                                                    (shadowed): not copied;
 *   - otherwise                                    → copied (clamped to the
 *                                                    setting's range).
 * Shadowed column values are logged so an operator can recreate the overrides
 * that were intended.
 *
 * This is the SERVER worker's rule. Proxied monitors ran with a different one
 * (the proxy read the columns only, 60 s / 10 s when NULL): 062 pins their
 * timing.
 *
 * The columns stay in place (no longer read). Down is a no-op: the copied rows
 * cannot be told apart from overrides created afterwards, and the previous
 * code resolved those rows the same way (a monitor-scope row always won).
 */

interface TimingColumn {
  column: string;
  key: string;
  min: number;
  max: number;
}

// Frozen copy of shared/src/settingsDefaults.ts (keys, units and ranges) at
// the time of this migration — migrations must not follow later changes.
const TIMING_COLUMNS: TimingColumn[] = [
  { column: 'interval_seconds',       key: 'check_interval', min: 1,    max: 86400 }, // seconds
  { column: 'timeout_ms',             key: 'timeout',        min: 1000, max: 60000 }, // ms
  { column: 'retry_interval_seconds', key: 'retry_interval', min: 1,    max: 3600 },  // seconds
  { column: 'max_retries',            key: 'max_retries',    min: 0,    max: 20 },    // retries
];

/** SQL predicate: a settings row for `key` exists in the chain of monitor `m`. */
const CHAIN_HAS_SETTING = `
  (
    EXISTS (
      SELECT 1 FROM settings s
       WHERE s.scope = 'monitor' AND s.scope_id = m.id AND s.key = :key
    )
    OR EXISTS (
      SELECT 1
        FROM group_closure gc
        JOIN settings s
          ON s.scope = 'group'
         AND s.scope_id = gc.ancestor_id
         AND s.tenant_id = m.tenant_id
         AND s.key = :key
       WHERE gc.descendant_id = m.group_id
    )
    OR EXISTS (
      SELECT 1 FROM settings s
       WHERE s.scope = 'global' AND s.scope_id IS NULL
         AND s.tenant_id = m.tenant_id AND s.key = :key
    )
  )
`;

export async function up(knex: Knex): Promise<void> {
  for (const { column, key, min, max } of TIMING_COLUMNS) {
    // Shadowed values (column set, but a settings row already won): log only.
    const shadowed = await knex.raw(
      `
      SELECT m.id, m.tenant_id, m.:column: AS value
        FROM monitors m
       WHERE m.:column: IS NOT NULL
         AND ${CHAIN_HAS_SETTING}
       ORDER BY m.id
      `,
      { column, key },
    ) as { rows: Array<{ id: number; tenant_id: number; value: number }> };
    if (shadowed.rows.length > 0) {
      console.warn(
        `[061] ${shadowed.rows.length} monitor(s) had a ${column} value that a settings row already overrode — not copied (${key})`,
        shadowed.rows.slice(0, 200),
      );
    }

    // Effective values: copy them into monitor-scope rows.
    await knex.raw(
      `
      INSERT INTO settings (tenant_id, scope, scope_id, key, value, created_at, updated_at)
      SELECT m.tenant_id, 'monitor', m.id, :key,
             to_jsonb(LEAST(GREATEST(m.:column:, :min), :max)),
             NOW(), NOW()
        FROM monitors m
       WHERE m.:column: IS NOT NULL
         AND NOT ${CHAIN_HAS_SETTING}
      ON CONFLICT (tenant_id, scope, scope_id, key) WHERE scope_id IS NOT NULL DO NOTHING
      `,
      { column, key, min, max },
    );
  }
}

export async function down(_knex: Knex): Promise<void> {
  // No-op — see the header comment.
}
