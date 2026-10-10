import { db } from '../db';
import { SETTINGS_KEYS, HARDCODED_DEFAULTS, SETTINGS_DEFINITIONS } from '@obliview/shared';
import { settingsService } from './settings.service';
import { logger } from '../utils/logger';

/** Rows deleted per DELETE statement (keeps each statement / lock short). */
const BATCH_SIZE = 10_000;
/** Monitor ids per `monitor_id = ANY(?)` array. */
const IDS_PER_STATEMENT = 1_000;
/** Pause between full batches so live heartbeat inserts are not starved. */
const BATCH_PAUSE_MS = 50;

const RETENTION_KEY = SETTINGS_KEYS.HEARTBEAT_RETENTION_DAYS;
const RETENTION_DEF = SETTINGS_DEFINITIONS.find((d) => d.key === RETENTION_KEY);
const MIN_DAYS = RETENTION_DEF?.min ?? 1;
const MAX_DAYS = RETENTION_DEF?.max ?? 3650;
const DEFAULT_DAYS = HARDCODED_DEFAULTS[RETENTION_KEY];

export interface RetentionPurgeResult {
  /** Heartbeats deleted across every tenant. */
  heartbeats: number;
  /** remediation_runs rows deleted. */
  remediationRuns: number;
  /** Longest effective retention (days) — the remediation_runs horizon. */
  maxDays: number;
}

let running = false;

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
}

/** Effective retention in whole days, kept inside the setting's range. */
function clampDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(value)));
}

function cutoffFor(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/** Deletes, in batches, the heartbeats of `monitorIds` older than `cutoff`. */
async function purgeHeartbeats(monitorIds: number[], cutoff: Date): Promise<number> {
  let total = 0;
  for (let i = 0; i < monitorIds.length; i += IDS_PER_STATEMENT) {
    const chunk = monitorIds.slice(i, i + IDS_PER_STATEMENT);
    for (;;) {
      const result = await db.raw(
        `DELETE FROM heartbeats
          WHERE id IN (
                SELECT id
                  FROM heartbeats
                 WHERE monitor_id = ANY(?::int[])
                   AND created_at < ?
                 LIMIT ?
              )`,
        [chunk, cutoff, BATCH_SIZE],
      ) as { rowCount?: number | null };
      const count = result.rowCount ?? 0;
      total += count;
      // A partial batch means nothing older than the cutoff is left for this chunk.
      if (count < BATCH_SIZE) break;
      await pause();
    }
  }
  return total;
}

/** Deletes, in batches, the remediation runs triggered before `cutoff`. */
async function purgeRemediationRuns(cutoff: Date): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.raw(
      `DELETE FROM remediation_runs
        WHERE id IN (
              SELECT id
                FROM remediation_runs
               WHERE triggered_at < ?
               LIMIT ?
            )`,
      [cutoff, BATCH_SIZE],
    ) as { rowCount?: number | null };
    const count = result.rowCount ?? 0;
    total += count;
    if (count < BATCH_SIZE) break;
    await pause();
  }
  return total;
}

export const retentionService = {
  /**
   * Heartbeat retention driven by the `heartbeat_retention_days` setting.
   *
   * For each tenant the setting is resolved per monitor (monitor override →
   * nearest group ancestor → workspace → default 365) and the monitors are
   * bucketed by their number of days; each bucket is purged in batches of
   * BATCH_SIZE rows. remediation_runs (no per-monitor setting) are kept as
   * long as the longest effective retention.
   *
   * Re-entrant calls while a purge is still running are skipped (returns null).
   */
  async runPurge(): Promise<RetentionPurgeResult | null> {
    if (running) return null;
    running = true;
    try {
      const tenants = await db('tenants').select('id').orderBy('id') as Array<{ id: number }>;

      let heartbeats = 0;
      let maxDays = 0;

      for (const { id: tenantId } of tenants) {
        try {
          const values = await settingsService.resolveKeyForTenantMonitors(tenantId, RETENTION_KEY);

          const buckets = new Map<number, number[]>();
          for (const { monitorId, value } of values) {
            const days = clampDays(value);
            const ids = buckets.get(days);
            if (ids) ids.push(monitorId);
            else buckets.set(days, [monitorId]);
          }

          let tenantDeleted = 0;
          for (const [days, monitorIds] of buckets) {
            maxDays = Math.max(maxDays, days);
            tenantDeleted += await purgeHeartbeats(monitorIds, cutoffFor(days));
          }
          heartbeats += tenantDeleted;

          if (tenantDeleted > 0) {
            const summary = [...buckets.entries()]
              .sort(([a], [b]) => a - b)
              .map(([days, ids]) => `${days}d×${ids.length}`)
              .join(', ');
            logger.info(`Retention: tenant ${tenantId} — purged ${tenantDeleted} heartbeats (${summary})`);
          }
        } catch (err) {
          // One tenant failing must not stop the others.
          logger.error(err, `Retention: heartbeat purge failed for tenant ${tenantId}`);
        }
      }

      // No monitor anywhere: fall back to the default horizon.
      if (maxDays === 0) maxDays = DEFAULT_DAYS;

      let remediationRuns = 0;
      try {
        remediationRuns = await purgeRemediationRuns(cutoffFor(maxDays));
        if (remediationRuns > 0) {
          logger.info(`Retention: purged ${remediationRuns} remediation runs older than ${maxDays} days`);
        }
      } catch (err) {
        logger.error(err, 'Retention: remediation_runs purge failed');
      }

      return { heartbeats, remediationRuns, maxDays };
    } finally {
      running = false;
    }
  },
};
