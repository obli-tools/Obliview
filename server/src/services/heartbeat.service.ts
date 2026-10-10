import { db } from '../db';
import type { Heartbeat, UptimeSeriesPoint } from '@obliview/shared';

/** Bucket unit of the uptime series (whitelisted: inlined in the SQL). */
export type UptimeSeriesBucket = 'hour' | 'day';

/**
 * Short-lived cache of the fleet uptime series raw counts. The aggregate scans
 * every heartbeat of a workspace over up to 30 days, and the dashboard asks
 * for it on every mount / period switch; a stale-by-a-minute chart is fine.
 * The cache holds per-(bucket, monitor) counts for the whole tenant scope and
 * the widest window of the unit (24 hours / 30 days), keyed by scope + unit
 * only: every user and every period of that unit share one aggregate, and the
 * caller's visibility / window is applied in JS.
 */
const UPTIME_SERIES_TTL_MS: Record<UptimeSeriesBucket, number> = { hour: 60_000, day: 300_000 };
const UPTIME_SERIES_MAX_BUCKETS: Record<UptimeSeriesBucket, number> = { hour: 24, day: 30 };
const UPTIME_SERIES_CACHE_MAX = 100;
interface UptimeSeriesCount { bucket: string; age: number; monitorId: number; up: number; total: number }
const uptimeSeriesCache = new Map<string, { expires: number; buckets: number; rows: UptimeSeriesCount[] }>();
const uptimeSeriesInFlight = new Map<string, Promise<UptimeSeriesCount[]>>();

interface HeartbeatRow {
  id: number;
  monitor_id: number;
  status: string;
  response_time: number | null;
  status_code: number | null;
  message: string | null;
  ping: number | null;
  is_retrying: boolean;
  value: string | null;
  in_maintenance: boolean;
  created_at: Date;
}

function rowToHeartbeat(row: HeartbeatRow): Heartbeat {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status as Heartbeat['status'],
    responseTime: row.response_time,
    statusCode: row.status_code,
    message: row.message,
    ping: row.ping,
    isRetrying: row.is_retrying ?? false,
    value: row.value ?? null,
    inMaintenance: row.in_maintenance ?? false,
    createdAt: row.created_at.toISOString(),
  };
}

export const heartbeatService = {
  async create(data: {
    monitorId: number;
    status: string;
    responseTime?: number;
    statusCode?: number;
    message?: string;
    ping?: number;
    isRetrying?: boolean;
    value?: string;
    inMaintenance?: boolean;
  }): Promise<Heartbeat> {
    const [row] = await db<HeartbeatRow>('heartbeats')
      .insert({
        monitor_id: data.monitorId,
        status: data.status,
        response_time: data.responseTime ?? null,
        status_code: data.statusCode ?? null,
        message: data.message ?? null,
        ping: data.ping ?? null,
        is_retrying: data.isRetrying ?? false,
        value: data.value ?? null,
        in_maintenance: data.inMaintenance ?? false,
      })
      .returning('*');

    return rowToHeartbeat(row);
  },

  async getByMonitor(
    monitorId: number,
    limit: number = 100,
    offset: number = 0,
  ): Promise<Heartbeat[]> {
    const rows = await db<HeartbeatRow>('heartbeats')
      .where({ monitor_id: monitorId })
      .orderBy('created_at', 'desc')
      .limit(limit)
      .offset(offset);

    return rows.map(rowToHeartbeat);
  },

  async getLatest(monitorId: number): Promise<Heartbeat | null> {
    const row = await db<HeartbeatRow>('heartbeats')
      .where({ monitor_id: monitorId })
      .orderBy('created_at', 'desc')
      .first();

    if (!row) return null;
    return rowToHeartbeat(row);
  },

  async getRecentByMonitor(monitorId: number, count: number = 50): Promise<Heartbeat[]> {
    const rows = await db<HeartbeatRow>('heartbeats')
      .where({ monitor_id: monitorId })
      .orderBy('created_at', 'desc')
      .limit(count);

    return rows.map(rowToHeartbeat).reverse(); // chronological order
  },

  /**
   * Compute uptime and response time stats for a monitor over a time period.
   */
  async getStats(
    monitorId: number,
    since?: Date,
  ): Promise<{
    total: number;
    up: number;
    down: number;
    uptimePct: number;
    avgResponseTime: number | null;
    minResponseTime: number | null;
    maxResponseTime: number | null;
  }> {
    const query = db('heartbeats').where({ monitor_id: monitorId }).where({ in_maintenance: false });
    if (since) {
      query.where('created_at', '>=', since);
    }

    // 'ssl_warning' rows (written before the worker recorded them as 'up')
    // are reachable checks: they count as up.
    const [row] = await query.select(
      db.raw('COUNT(*)::int as total'),
      db.raw("COUNT(*) FILTER (WHERE status IN ('up', 'ssl_warning'))::int as up"),
      db.raw("COUNT(*) FILTER (WHERE status = 'down')::int as down"),
      db.raw('ROUND(AVG(response_time))::int as avg_rt'),
      db.raw('MIN(response_time)::int as min_rt'),
      db.raw('MAX(response_time)::int as max_rt'),
    );

    const total = row.total || 0;
    const up = row.up || 0;

    return {
      total,
      up,
      down: row.down || 0,
      uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 0,
      avgResponseTime: row.avg_rt ?? null,
      minResponseTime: row.min_rt ?? null,
      maxResponseTime: row.max_rt ?? null,
    };
  },

  /**
   * Get stats for all monitors at once (dashboard summary).
   *
   * `monitorIds` restricts the scan to a specific set — this is essential:
   *   - Security: without it, a user in tenant B receives uptime% / RT for
   *     every monitor in tenant A (critical).
   *   - Perf: idx_heartbeats(monitor_id, created_at) can drive a per-monitor
   *     index range scan when the predicate leads with monitor_id.
   * Passing an empty array short-circuits and returns an empty map.
   */
  async getStatsForAllMonitors(
    since: Date | undefined,
    monitorIds: number[],
  ): Promise<Map<number, { uptimePct: number; avgResponseTime: number | null }>> {
    if (monitorIds.length === 0) return new Map();

    const query = db('heartbeats')
      .where({ in_maintenance: false })
      .whereIn('monitor_id', monitorIds);
    if (since) {
      query.where('created_at', '>=', since);
    }

    const rows = await query
      .groupBy('monitor_id')
      .select(
        'monitor_id',
        db.raw('COUNT(*)::int as total'),
        db.raw("COUNT(*) FILTER (WHERE status IN ('up', 'ssl_warning'))::int as up"),
        db.raw('ROUND(AVG(response_time))::int as avg_rt'),
      );

    const result = new Map<number, { uptimePct: number; avgResponseTime: number | null }>();
    for (const row of rows) {
      const total = row.total || 0;
      const up = row.up || 0;
      result.set(row.monitor_id, {
        uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 0,
        avgResponseTime: row.avg_rt ?? null,
      });
    }
    return result;
  },

  /**
   * Fleet uptime series for the dashboard (GET /monitors/uptime-series).
   *
   * Heartbeats of `monitorIds` (the caller's visible, tenant-scoped set) are
   * bucketed with date_trunc(`bucket`) over the last `buckets` buckets, the
   * current one included (the window starts on a bucket boundary, in the DB
   * session time zone, so the first bucket is never partial). Each point is
   * the AVERAGE of the per-monitor uptime % in that bucket, so a monitor
   * checked every 20 s does not outweigh one checked every 5 min.
   *
   * Counted beats: agent monitors are excluded (their reachability is shown
   * separately), as are retrying beats (unconfirmed failures), maintenance
   * beats and non-decisive statuses (pending / paused / …). 'ssl_warning'
   * counts as up. Buckets without any counted beat are omitted.
   */
  async getUptimeSeries(
    monitorIds: number[],
    bucket: UptimeSeriesBucket,
    buckets: number,
    tenantScope: number | null = null,
  ): Promise<UptimeSeriesPoint[]> {
    if (monitorIds.length === 0 || buckets < 1) return [];
    const unit: UptimeSeriesBucket = bucket === 'hour' ? 'hour' : 'day';
    const window = Math.max(buckets, UPTIME_SERIES_MAX_BUCKETS[unit]);

    const cacheKey = `${tenantScope ?? 'all'}:${unit}`;
    const now = Date.now();
    let rows: UptimeSeriesCount[];
    const cached = uptimeSeriesCache.get(cacheKey);
    if (cached && cached.expires > now && cached.buckets >= buckets) {
      rows = cached.rows;
    } else {
      let pending = uptimeSeriesInFlight.get(cacheKey);
      if (!pending) {
        pending = this._fetchUptimeSeriesCounts(unit, window, tenantScope)
          .then((fetched) => {
            // Bounded cache: drop expired entries, then the oldest ones.
            const at = Date.now();
            for (const [key, entry] of uptimeSeriesCache) {
              if (entry.expires <= at) uptimeSeriesCache.delete(key);
            }
            while (uptimeSeriesCache.size >= UPTIME_SERIES_CACHE_MAX) {
              const oldest = uptimeSeriesCache.keys().next().value;
              if (oldest === undefined) break;
              uptimeSeriesCache.delete(oldest);
            }
            uptimeSeriesCache.set(cacheKey, { expires: at + UPTIME_SERIES_TTL_MS[unit], buckets: window, rows: fetched });
            return fetched;
          })
          .finally(() => { uptimeSeriesInFlight.delete(cacheKey); });
        uptimeSeriesInFlight.set(cacheKey, pending);
      }
      rows = await pending;
    }

    // Caller's scope and window: average of the per-monitor uptime % per bucket.
    const visible = new Set(monitorIds);
    const perBucket = new Map<string, { sum: number; n: number }>();
    for (const r of rows) {
      if (r.age > buckets - 1 || !visible.has(r.monitorId) || r.total <= 0) continue;
      const acc = perBucket.get(r.bucket) ?? { sum: 0, n: 0 };
      acc.sum += (100 * r.up) / r.total;
      acc.n += 1;
      perBucket.set(r.bucket, acc);
    }
    return [...perBucket.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([t, { sum, n }]) => ({ t, uptime: Math.round((sum / n) * 100) / 100 }));
  },

  /**
   * Raw per-(bucket, monitor) counts of the uptime series for a tenant scope
   * (null = every tenant, God View) over the last `window` buckets. `age` is
   * the bucket's distance from the current one (0 = current), computed in SQL
   * in the DB session time zone.
   */
  async _fetchUptimeSeriesCounts(
    unit: UptimeSeriesBucket,
    window: number,
    tenantScope: number | null,
  ): Promise<UptimeSeriesCount[]> {
    // `unit` is whitelisted — safe to inline (a bound parameter in both the
    // SELECT and GROUP BY would be two different expressions to Postgres).
    const unitSeconds = unit === 'hour' ? 3600 : 86400;
    const result = await db.raw(`
      SELECT date_trunc('${unit}', h.created_at) AS bucket,
             ROUND(EXTRACT(EPOCH FROM (date_trunc('${unit}', NOW()) - date_trunc('${unit}', h.created_at))) / ${unitSeconds})::int AS age,
             h.monitor_id,
             COUNT(*) FILTER (WHERE h.status IN ('up', 'ssl_warning'))::int AS up,
             COUNT(*)::int AS total
      FROM heartbeats h
      JOIN monitors m ON m.id = h.monitor_id
      WHERE m.type <> 'agent'
        AND (?::int IS NULL OR m.tenant_id = ?::int)
        AND h.created_at >= date_trunc('${unit}', NOW()) - ?::interval
        AND h.is_retrying = false
        AND h.in_maintenance = false
        AND h.status IN ('up', 'ssl_warning', 'down', 'alert', 'ssl_expired')
      GROUP BY 1, 2, 3
    `, [tenantScope, tenantScope, `${window - 1} ${unit}s`]);

    return (result.rows as { bucket: Date | string; age: number; monitor_id: number; up: number; total: number }[])
      .map((r) => ({
        bucket: new Date(r.bucket).toISOString(),
        age: Number(r.age),
        monitorId: Number(r.monitor_id),
        up: Number(r.up),
        total: Number(r.total),
      }));
  },

  /**
   * Get raw heartbeat stats per group_id (direct monitors only, no recursion).
   * Returns Map<groupId, { total, up }>.
   *
   * `tenantScope` behaviour:
   *   - number    → WHERE monitors.tenant_id = <scope>  (regular tenant view)
   *   - null      → no tenant filter  (platform-admin God View across all tenants)
   *   - undefined → same as null, preserved for legacy callers
   *
   * The tenant filter is essential — the endpoint is polled every 60s by every
   * logged-in user via GET /groups/stats, and an unfiltered scan of
   * heartbeats × monitors across the whole install was the top source of
   * sustained PG CPU pressure under load.
   */
  async getRawStatsPerGroup(
    since?: Date,
    tenantScope?: number | null,
  ): Promise<Map<number, { total: number; up: number }>> {
    const query = db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereNotNull('monitors.group_id')
      .where({ 'heartbeats.in_maintenance': false });

    if (since) {
      query.where('heartbeats.created_at', '>=', since);
    }
    if (typeof tenantScope === 'number') {
      query.where('monitors.tenant_id', tenantScope);
    }

    const rows = await query
      .groupBy('monitors.group_id')
      .select(
        'monitors.group_id',
        db.raw('COUNT(*)::int as total'),
        db.raw("COUNT(*) FILTER (WHERE heartbeats.status = 'up')::int as up"),
      );

    const result = new Map<number, { total: number; up: number }>();
    for (const row of rows) {
      result.set(row.group_id, { total: row.total || 0, up: row.up || 0 });
    }
    return result;
  },

  /**
   * Get heartbeats for a monitor within an explicit date range, with optional downsampling.
   * Used for the zoom-in feature in the chart.
   */
  async getByMonitorRange(
    monitorId: number,
    from: Date,
    to: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    const [{ count }] = await db('heartbeats')
      .where({ monitor_id: monitorId })
      .where('created_at', '>=', from)
      .where('created_at', '<=', to)
      .count('* as count');

    const total = Number(count);

    if (total <= maxPoints) {
      const rows = await db<HeartbeatRow>('heartbeats')
        .where({ monitor_id: monitorId })
        .where('created_at', '>=', from)
        .where('created_at', '<=', to)
        .orderBy('created_at', 'asc');
      return rows.map(rowToHeartbeat);
    }

    const nth = Math.ceil(total / maxPoints);
    const result = await db.raw(`
      SELECT * FROM (
        SELECT *, ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn
        FROM heartbeats
        WHERE monitor_id = ? AND created_at >= ? AND created_at <= ?
      ) sub
      WHERE rn % ? = 1 OR status != 'up'
      ORDER BY created_at ASC
      LIMIT ?
    `, [monitorId, from, to, nth, maxPoints]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get heartbeats for a monitor since a given date, with optional downsampling.
   * Keeps ~maxPoints sampled "up" rows for the smooth line, plus non-'up' rows
   * (also sampled when there are too many, so a chronically-alerting monitor
   * viewed at long range doesn't return 500k rows and crash the chart).
   */
  async getByMonitorSince(
    monitorId: number,
    since: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    // Count total + non-'up' rows in one round-trip. The non-'up' count is
    // needed to decide whether incidents themselves need a second modulo pass.
    const [row] = await db('heartbeats')
      .where({ monitor_id: monitorId })
      .where('created_at', '>=', since)
      .select(
        db.raw('COUNT(*)::int as total'),
        db.raw("COUNT(*) FILTER (WHERE status != 'up')::int as non_up"),
      );
    const total = Number(row?.total ?? 0);
    const nonUp = Number(row?.non_up ?? 0);

    if (total <= maxPoints) {
      // No downsampling needed — return all
      const rows = await db<HeartbeatRow>('heartbeats')
        .where({ monitor_id: monitorId })
        .where('created_at', '>=', since)
        .orderBy('created_at', 'asc');
      return rows.map(rowToHeartbeat);
    }

    // Baseline nth-sampling over ALL rows preserves the smooth line.
    // Secondary nth-sampling over non-'up' rows only kicks in when a chronic
    // incident monitor blows past `maxPoints`, so an always-alerting agent at
    // 30 d / 60 s (~43 k rows) or 1 y (~500 k rows) still returns a bounded
    // payload instead of the raw heartbeat torrent.
    //
    // Ceiling on payload size: 2 * maxPoints in the worst case (baseline
    // sample fully disjoint from the incident sample). Well within Recharts
    // + client memory limits.
    const nth = Math.ceil(total / maxPoints);
    const nthNonUp = nonUp > maxPoints ? Math.ceil(nonUp / maxPoints) : 1;
    const result = await db.raw(`
      SELECT * FROM (
        SELECT *,
          ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn_all,
          ROW_NUMBER() OVER (
            PARTITION BY (status = 'up')
            ORDER BY created_at ASC
          ) as rn_status
        FROM heartbeats
        WHERE monitor_id = ? AND created_at >= ?
      ) sub
      WHERE rn_all % ? = 1
         OR (status != 'up' AND rn_status % ? = 1)
      ORDER BY created_at ASC
    `, [monitorId, since, nth, nthNonUp]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get the N most recent heartbeats for a set of monitors.
   *
   * `monitorIds` restricts both the SQL (idx_heartbeats(monitor_id, created_at)
   * → per-monitor index range scan) and the visibility of the response.
   * The previous unbounded version ran a window function
   * over the ENTIRE heartbeats table on every dashboard mount, degrading
   * into a full seq scan + big sort as retention grew (up to ~21 M rows).
   *
   * The LATERAL join pattern lets Postgres jump into the index per monitor
   * and grab just the top N rows, instead of window-numbering the whole
   * table first and filtering afterward.
   */
  async getRecentForAllMonitors(
    monitorIds: number[],
    count: number = 50,
  ): Promise<Map<number, Heartbeat[]>> {
    const map = new Map<number, Heartbeat[]>();
    if (monitorIds.length === 0) return map;

    const result = await db.raw(`
      SELECT h.*
      FROM unnest(?::int[]) AS m(id)
      CROSS JOIN LATERAL (
        SELECT *
        FROM heartbeats
        WHERE monitor_id = m.id
        ORDER BY created_at DESC
        LIMIT ?
      ) h
      ORDER BY h.monitor_id, h.created_at ASC
    `, [monitorIds, count]);

    for (const row of result.rows as HeartbeatRow[]) {
      const hb = rowToHeartbeat(row);
      if (!map.has(hb.monitorId)) {
        map.set(hb.monitorId, []);
      }
      map.get(hb.monitorId)!.push(hb);
    }
    return map;
  },

  /**
   * Delete heartbeats for specific monitor IDs.
   */
  async clearForMonitors(monitorIds: number[]): Promise<number> {
    if (monitorIds.length === 0) return 0;
    const count = await db('heartbeats')
      .whereIn('monitor_id', monitorIds)
      .del();
    return count;
  },

  /**
   * Get aggregated heartbeats for a group and all its descendants.
   * Uses the closure table for group hierarchy. Includes downsampling.
   */
  async getByGroupSince(
    groupId: number,
    since: Date,
    maxPoints: number = 500,
  ): Promise<Heartbeat[]> {
    const descendantSubquery = db('group_closure')
      .where('ancestor_id', groupId)
      .select('descendant_id');

    // Count total
    const [{ count }] = await db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereIn('monitors.group_id', descendantSubquery)
      .where('heartbeats.created_at', '>=', since)
      .count('* as count');

    const total = Number(count);

    if (total <= maxPoints) {
      const rows = await db<HeartbeatRow>('heartbeats')
        .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
        .whereIn('monitors.group_id', descendantSubquery)
        .where('heartbeats.created_at', '>=', since)
        .orderBy('heartbeats.created_at', 'asc')
        .select('heartbeats.*');
      return rows.map(rowToHeartbeat);
    }

    // Downsample: nth-row but keep all non-UP heartbeats
    const nth = Math.ceil(total / maxPoints);
    const result = await db.raw(`
      SELECT * FROM (
        SELECT h.*, ROW_NUMBER() OVER (ORDER BY h.created_at ASC) as rn
        FROM heartbeats h
        JOIN monitors m ON h.monitor_id = m.id
        WHERE m.group_id IN (SELECT descendant_id FROM group_closure WHERE ancestor_id = ?)
          AND h.created_at >= ?
      ) sub
      WHERE rn % ? = 1 OR status != 'up'
      ORDER BY created_at ASC
      LIMIT ?
    `, [groupId, since, nth, maxPoints]);

    return (result.rows as HeartbeatRow[]).map(rowToHeartbeat);
  },

  /**
   * Get aggregated stats for a group and all its descendants.
   */
  async getGroupStats(
    groupId: number,
    since?: Date,
  ): Promise<{
    total: number;
    up: number;
    down: number;
    uptimePct: number;
    avgResponseTime: number | null;
    monitorCount: number;
    downMonitorNames: string[];
  }> {
    const descendantSubquery = db('group_closure')
      .where('ancestor_id', groupId)
      .select('descendant_id');

    // Heartbeat stats
    const query = db('heartbeats')
      .join('monitors', 'heartbeats.monitor_id', 'monitors.id')
      .whereIn('monitors.group_id', descendantSubquery)
      .where({ 'heartbeats.in_maintenance': false });

    if (since) {
      query.where('heartbeats.created_at', '>=', since);
    }

    const [row] = await query.select(
      db.raw('COUNT(*)::int as total'),
      db.raw("COUNT(*) FILTER (WHERE heartbeats.status = 'up')::int as up"),
      db.raw("COUNT(*) FILTER (WHERE heartbeats.status = 'down')::int as down"),
      db.raw('ROUND(AVG(heartbeats.response_time))::int as avg_rt'),
    );

    const total = row.total || 0;
    const up = row.up || 0;

    // Monitor counts
    const monitorRows = await db('monitors')
      .whereIn('group_id', descendantSubquery)
      .where({ is_active: true })
      .select('id', 'name', 'status');

    const PROBLEM_STATUSES = new Set(['down', 'ssl_expired', 'ssl_warning', 'alert']);
    const downMonitorNames = monitorRows
      .filter((m: { status: string }) => PROBLEM_STATUSES.has(m.status))
      .map((m: { name: string }) => m.name);

    return {
      total,
      up,
      down: row.down || 0,
      uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
      avgResponseTime: row.avg_rt ?? null,
      monitorCount: monitorRows.length,
      downMonitorNames,
    };
  },

  /**
   * Delete heartbeats older than the given number of days.
   * Deletes in batches of 10 000 rows (short transactions, no long lock on a
   * huge table on the first run of a long-lived install) until nothing is
   * left, and returns the total number of deleted rows.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const BATCH_SIZE = 10_000;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    let total = 0;
    for (;;) {
      const count = await db('heartbeats')
        .whereIn(
          'id',
          db('heartbeats').select('id').where('created_at', '<', cutoff).limit(BATCH_SIZE),
        )
        .del();
      total += count;
      // A partial batch means nothing older than the cutoff is left (saves
      // one more scan of the table, which has no index on created_at alone).
      if (count < BATCH_SIZE) break;
      // Yield between batches so live heartbeat inserts are not starved.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return total;
  },
};
