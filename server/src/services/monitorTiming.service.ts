import type { Knex } from 'knex';
import { db } from '../db';
import { SETTINGS_KEYS, SETTINGS_DEFINITIONS, type SettingsKey } from '@obliview/shared';
import { settingsService } from './settings.service';

/**
 * Legacy per-monitor timing fields (intervalSeconds, timeoutMs,
 * retryIntervalSeconds, maxRetries).
 *
 * Since migration 061 the settings table is the single timing source: the
 * monitors columns interval_seconds / timeout_ms / retry_interval_seconds /
 * max_retries are no longer read. The monitor API and import/export still
 * accept (and export) these fields for compatibility, translated here into
 * scope='monitor' settings rows (null = no monitor override = inherit).
 */

export const LEGACY_TIMING_FIELDS = [
  { field: 'intervalSeconds',      key: SETTINGS_KEYS.CHECK_INTERVAL },
  { field: 'timeoutMs',            key: SETTINGS_KEYS.TIMEOUT },
  { field: 'retryIntervalSeconds', key: SETTINGS_KEYS.RETRY_INTERVAL },
  { field: 'maxRetries',           key: SETTINGS_KEYS.MAX_RETRIES },
] as const;

export type LegacyTimingField = (typeof LEGACY_TIMING_FIELDS)[number]['field'];
/** Present field = set (number) or clear (null) the monitor override. */
export type LegacyTiming = Partial<Record<LegacyTimingField, number | null>>;

const TIMING_KEYS: SettingsKey[] = LEGACY_TIMING_FIELDS.map((f) => f.key);

/** Removes the legacy timing fields from `data`; returns the rest and the fields that were present. */
export function splitLegacyTiming<T extends object>(data: T): { rest: T; timing: LegacyTiming; hasTiming: boolean } {
  const rest = { ...data } as Record<string, unknown>;
  const timing: LegacyTiming = {};
  let hasTiming = false;
  for (const { field } of LEGACY_TIMING_FIELDS) {
    if (rest[field] !== undefined) {
      const v = rest[field];
      timing[field] = v === null ? null : Number(v);
      hasTiming = true;
    }
    delete rest[field];
  }
  return { rest: rest as T, timing, hasTiming };
}

/**
 * A timing value made valid for its setting: rounded, clamped to the
 * setting's range and to the admin minimums (MIN_CHECK_INTERVAL /
 * MIN_RETRY_INTERVAL). null for a missing or non-numeric value.
 */
export function clampTimingValue(key: SettingsKey, raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const def = SETTINGS_DEFINITIONS.find((d) => d.key === key);
  if (!def) return null;
  let min = def.min;
  if (key === SETTINGS_KEYS.CHECK_INTERVAL) {
    min = Math.max(min, Math.max(1, parseInt(process.env.MIN_CHECK_INTERVAL ?? '10', 10)));
  } else if (key === SETTINGS_KEYS.RETRY_INTERVAL) {
    min = Math.max(min, Math.max(1, parseInt(process.env.MIN_RETRY_INTERVAL ?? '5', 10)));
  }
  return Math.min(def.max, Math.max(min, Math.round(n)));
}

/**
 * Writes the present timing fields of one monitor as monitor-scope settings
 * (number = override, null = remove the override).
 */
export async function applyMonitorTiming(
  tenantId: number,
  monitorId: number,
  timing: LegacyTiming,
  conn: Knex | Knex.Transaction = db,
): Promise<void> {
  for (const { field, key } of LEGACY_TIMING_FIELDS) {
    if (!(field in timing) || timing[field] === undefined) continue;
    const value = clampTimingValue(key, timing[field]);
    if (value === null) {
      await conn('settings')
        .where({ tenant_id: tenantId, scope: 'monitor', scope_id: monitorId, key })
        .del();
    } else {
      await settingsService.upsert(tenantId, 'monitor', monitorId, key, value, conn);
    }
  }
}

/**
 * True when a settings row for `key` exists in the chain of the monitor:
 * the monitor itself, one of its group ancestors or the workspace — the rule
 * under which a legacy timing column was ignored (migration 061).
 */
export async function chainHasTimingSetting(
  conn: Knex | Knex.Transaction,
  tenantId: number,
  monitorId: number,
  key: SettingsKey,
): Promise<boolean> {
  const result = await conn.raw(
    `
    SELECT 1
      FROM monitors m
     WHERE m.id = ?
       AND (
         EXISTS (SELECT 1 FROM settings s
                  WHERE s.tenant_id = ? AND s.scope = 'monitor' AND s.scope_id = m.id AND s.key = ?)
         OR EXISTS (SELECT 1
                      FROM group_closure gc
                      JOIN settings s
                        ON s.scope = 'group' AND s.scope_id = gc.ancestor_id
                       AND s.tenant_id = ? AND s.key = ?
                     WHERE gc.descendant_id = m.group_id)
         OR EXISTS (SELECT 1 FROM settings s
                     WHERE s.tenant_id = ? AND s.scope = 'global' AND s.scope_id IS NULL AND s.key = ?)
       )
     LIMIT 1
    `,
    [monitorId, tenantId, key, tenantId, key, tenantId, key],
  ) as { rows: unknown[] };
  return result.rows.length > 0;
}

/** Monitor-scope timing overrides of a tenant, as legacy fields (export). */
export async function getMonitorTimingOverrides(tenantId: number): Promise<Map<number, LegacyTiming>> {
  const rows = await db('settings')
    .where({ tenant_id: tenantId, scope: 'monitor' })
    .whereIn('key', TIMING_KEYS)
    .whereNotNull('scope_id')
    .orderBy('id')
    .select('scope_id', 'key', 'value') as Array<{ scope_id: number; key: string; value: unknown }>;
  const out = new Map<number, LegacyTiming>();
  for (const r of rows) {
    const def = LEGACY_TIMING_FIELDS.find((f) => f.key === r.key);
    if (!def) continue;
    const raw = typeof r.value === 'string' ? Number(r.value) : r.value;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    if (n === null) continue;
    const entry = out.get(r.scope_id) ?? {};
    entry[def.field] = n;
    out.set(r.scope_id, entry);
  }
  return out;
}
