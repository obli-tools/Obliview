import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import { db } from '../db';
import { SOCKET_EVENTS, MASTER_TENANT_ID } from '@obliview/shared';
import { permissionService } from './permission.service';

let _io: SocketIOServer | null = null;

export function setLiveAlertIO(io: SocketIOServer): void {
  _io = io;
}

/**
 * Suite-wide vocabulary (Obliance, Obli Android shell): 'critical' for
 * outages, 'warning' for degraded states / threshold breaches, 'info' for
 * everything else. The Android shell maps anything that is not 'warning' or
 * 'critical' to INFO.
 */
export type LiveAlertSeverity = 'info' | 'warning' | 'critical';

export interface LiveAlertRow {
  id: number;
  tenantId: number;
  tenantName?: string;
  severity: LiveAlertSeverity;
  title: string;
  message: string;
  navigateTo: string | null;
  stableKey: string | null;
  monitorId: number | null;
  agentDeviceId: number | null;
  /** Read by the requesting user (per-user state). */
  read: boolean;
  readAt: string | null;
  /** The incident is over (recovery). Resolved rows stay listed, greyed out. */
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string; // ISO
}

/**
 * Which monitors a caller can see: 'all' (platform admin) or a list of ids
 * (permissionService.getVisibleMonitorIds).
 */
export type MonitorVisibility = number[] | 'all';

const MAX_ALERTS_PER_TENANT = 200;

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return new Date(v as string | Date).toISOString();
}

function rowToAlert(row: Record<string, unknown>): LiveAlertRow {
  // user_read_at comes from the per-user state join; live_alerts.read_at is
  // the legacy "read for everyone" marker (pre-065 rows).
  const readAt = toIso(row.user_read_at) ?? toIso(row.read_at);
  const resolvedAt = toIso(row.resolved_at);
  return {
    id: row.id as number,
    tenantId: row.tenant_id as number,
    tenantName: row.tenant_name as string | undefined,
    severity: row.severity as LiveAlertSeverity,
    title: row.title as string,
    message: row.message as string,
    navigateTo: row.navigate_to as string | null,
    stableKey: row.stable_key as string | null,
    monitorId: (row.monitor_id as number | null) ?? null,
    agentDeviceId: (row.agent_device_id as number | null) ?? null,
    read: readAt !== null,
    readAt,
    resolved: resolvedAt !== null,
    resolvedAt,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

// ─── Incident keys ───────────────────────────────────────────────────────────
// One incident = one monitor + one problem category. While the problem lasts
// at most ONE row per (tenant, stable key) is active (resolved_at IS NULL);
// the recovery resolves it instead of inserting a "back to normal" row.
//
//   category  stable keys
//   down      monitor:{monitorId}:down
//   ssl       monitor:{monitorId}:ssl
//   alert     monitor:{monitorId}:alert, agent-{deviceId}-{metricKey} (one per metric)

export type MonitorIncidentCategory = 'down' | 'ssl' | 'alert';

export function monitorIncidentKey(monitorId: number, category: MonitorIncidentCategory): string {
  return `monitor:${monitorId}:${category}`;
}

/** Category of a stable key, or null (legacy / not a monitor incident key). */
export function monitorIncidentCategory(stableKey: string | null | undefined): MonitorIncidentCategory | null {
  if (!stableKey) return null;
  const m = /^monitor:\d+:(down|ssl|alert)$/.exec(stableKey);
  if (m) return m[1] as MonitorIncidentCategory;
  if (/^agent-\d+-/.test(stableKey)) return 'alert';
  return null;
}

/** Advisory lock of one (tenant, stable key): raises and resolves of an incident run one at a time. */
async function lockKeys(trx: Knex.Transaction, tenantId: number, keys: string[]): Promise<void> {
  const lockIds = [...new Set(keys)].map((k) => `live_alert:${tenantId}:${k}`).sort();
  for (const k of lockIds) {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [k]);
  }
}

// ─── Audience ────────────────────────────────────────────────────────────────

/**
 * Socket.io rooms that may receive an alert of this entity:
 *   - tenant:{id}:admin — platform admins on that tenant (and god-view admins,
 *     who join every tenant's admin room, see socket.ts);
 *   - user:{id} — every user who can read the monitor (agent alerts follow the
 *     device's agent monitor) and is a member of the tenant;
 *   - user:{id} — platform admins who are members of the tenant, so they get
 *     its alerts while working in another tenant.
 */
async function audienceRooms(tenantId: number, monitorId: number | null, agentDeviceId: number | null): Promise<string[]> {
  const rooms = new Set<string>([`tenant:${tenantId}:admin`]);

  let mid = monitorId;
  if (mid === null && agentDeviceId !== null) {
    const m = await db('monitors')
      .where({ agent_device_id: agentDeviceId, tenant_id: tenantId })
      .select('id')
      .first() as { id: number } | undefined;
    mid = m?.id ?? null;
  }

  const candidateIds = mid !== null ? await permissionService.getUsersWithMonitorAccess(mid) : [];

  // Restrict to active members of the tenant (users without any membership
  // count as members of the master/default tenant — same rule as permissionService).
  const members = await db('users')
    .where('users.is_active', true)
    .where(function () {
      this.whereExists(
        db('user_tenants').whereRaw('user_tenants.user_id = users.id').where('user_tenants.tenant_id', tenantId),
      );
      if (tenantId === MASTER_TENANT_ID) {
        this.orWhereNotExists(db('user_tenants').whereRaw('user_tenants.user_id = users.id'));
      }
    })
    .where(function () {
      this.where('users.role', 'admin');
      if (candidateIds.length > 0) this.orWhereIn('users.id', candidateIds);
    })
    .pluck('users.id') as number[];

  for (const uid of members) rooms.add(`user:${uid}`);
  return [...rooms];
}

async function emitTo(
  tenantId: number,
  monitorId: number | null,
  agentDeviceId: number | null,
  event: string,
  payload: unknown,
): Promise<void> {
  if (!_io) return;
  const rooms = await audienceRooms(tenantId, monitorId, agentDeviceId);
  // One emit over several rooms: a socket in more than one of them gets it once.
  _io.to(rooms).emit(event, payload);
}

type ResolvedRow = { id: number; monitor_id: number | null; agent_device_id: number | null };

/** NOTIFICATION_RESOLVED { ids, resolvedAt }, grouped by entity (same audience as NOTIFICATION_NEW). */
async function emitResolved(tenantId: number, rows: ResolvedRow[], resolvedAt: Date): Promise<void> {
  if (!_io || rows.length === 0) return;
  const groups = new Map<string, { monitorId: number | null; agentDeviceId: number | null; ids: number[] }>();
  for (const r of rows) {
    const key = `${r.monitor_id ?? ''}:${r.agent_device_id ?? ''}`;
    const g = groups.get(key) ?? { monitorId: r.monitor_id, agentDeviceId: r.agent_device_id, ids: [] };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    await emitTo(tenantId, g.monitorId, g.agentDeviceId, SOCKET_EVENTS.NOTIFICATION_RESOLVED, {
      ids: g.ids,
      resolvedAt: resolvedAt.toISOString(),
    });
  }
}

/**
 * Keep at most 200 alerts per tenant. Active (unresolved) rows are kept
 * first, then rows nobody has read or dismissed yet, newest first — so the
 * resolved history of a flapping monitor never pushes an open incident out.
 */
async function trimTenant(tenantId: number): Promise<void> {
  await db.raw(
    `DELETE FROM live_alerts WHERE tenant_id = ? AND id NOT IN (
       SELECT la.id FROM live_alerts la WHERE la.tenant_id = ?
        ORDER BY (la.resolved_at IS NULL) DESC,
                 (la.read_at IS NULL AND NOT EXISTS (
                    SELECT 1 FROM live_alert_user_state s
                     WHERE s.alert_id = la.id AND (s.read_at IS NOT NULL OR s.dismissed_at IS NOT NULL)
                 )) DESC,
                 la.created_at DESC
        LIMIT ${MAX_ALERTS_PER_TENANT}
     )`,
    [tenantId, tenantId],
  );
}

/**
 * Restrict a live_alerts query (aliased `la`) to the alerts of visible
 * monitors. Agent alerts without a monitor follow their device's agent
 * monitor. Alerts linked to no entity are admin-only.
 */
function applyVisibility(q: Knex.QueryBuilder, visible: MonitorVisibility): void {
  if (visible === 'all') return;
  q.where(function () {
    this.whereIn('la.monitor_id', visible)
      .orWhere(function () {
        this.whereNull('la.monitor_id').whereIn(
          'la.agent_device_id',
          db('monitors').whereIn('id', visible).whereNotNull('agent_device_id').select('agent_device_id'),
        );
      });
  });
}

/** Base list query for one user: their read state joined, their dismissed alerts excluded. */
function userAlertsQuery(userId: number): Knex.QueryBuilder {
  return db('live_alerts as la')
    .join('tenants as t', 'la.tenant_id', 't.id')
    .leftJoin('live_alert_user_state as s', function () {
      this.on('s.alert_id', '=', 'la.id').andOn('s.user_id', '=', db.raw('?', [userId]));
    })
    .whereNull('s.dismissed_at');
}

export interface AddLiveAlertOpts {
  severity: LiveAlertSeverity;
  title: string;
  message: string;
  navigateTo?: string | null;
  stableKey?: string | null;
  monitorId?: number | null;
  agentDeviceId?: number | null;
}

export const liveAlertService = {
  /**
   * Add a new live alert. With a stableKey, the insert is skipped while an
   * ACTIVE (unresolved) alert with the same (tenant_id, stable_key) exists —
   * one row per incident. Returns the inserted row, or null if deduped.
   * After insert, emits NOTIFICATION_NEW to the alert's audience.
   */
  async add(tenantId: number, opts: AddLiveAlertOpts): Promise<LiveAlertRow | null> {
    const row = await db.transaction(async (trx) => {
      if (opts.stableKey) {
        await lockKeys(trx, tenantId, [opts.stableKey]);
        const existing = await trx('live_alerts')
          .where({ tenant_id: tenantId, stable_key: opts.stableKey })
          .whereNull('resolved_at')
          .select('id')
          .first();
        if (existing) return null;
      }
      const [inserted] = await trx('live_alerts')
        .insert({
          tenant_id: tenantId,
          severity: opts.severity,
          title: opts.title,
          message: opts.message,
          navigate_to: opts.navigateTo ?? null,
          stable_key: opts.stableKey ?? null,
          monitor_id: opts.monitorId ?? null,
          agent_device_id: opts.agentDeviceId ?? null,
        })
        .returning('*');
      return inserted as Record<string, unknown>;
    });
    if (!row) return null;

    await trimTenant(tenantId);

    const tenantRow = await db('tenants').where({ id: tenantId }).select('name').first() as { name: string } | undefined;
    const enriched: LiveAlertRow = { ...rowToAlert(row), tenantName: tenantRow?.name ?? '' };

    await emitTo(tenantId, enriched.monitorId, enriched.agentDeviceId, SOCKET_EVENTS.NOTIFICATION_NEW, enriched);
    return enriched;
  },

  /**
   * Resolve the active incident(s) with these stable keys in the tenant
   * (sets resolved_at) and emit NOTIFICATION_RESOLVED. Returns the resolved ids.
   */
  async resolve(tenantId: number, stableKeys: string | string[]): Promise<number[]> {
    const keys = (Array.isArray(stableKeys) ? stableKeys : [stableKeys]).filter(Boolean);
    if (keys.length === 0) return [];
    const resolvedAt = new Date();
    const rows = await db.transaction(async (trx) => {
      await lockKeys(trx, tenantId, keys);
      return await trx('live_alerts')
        .where({ tenant_id: tenantId })
        .whereIn('stable_key', keys)
        .whereNull('resolved_at')
        .update({ resolved_at: resolvedAt })
        .returning(['id', 'monitor_id', 'agent_device_id']) as ResolvedRow[];
    });
    await emitResolved(tenantId, rows, resolvedAt);
    return rows.map((r) => r.id);
  },

  /**
   * Resolve every active alert of a monitor (any category, legacy rows
   * included), except the category given in `keep` — e.g. a monitor going
   * from DOWN to SSL warning resolves its 'down' incident but not its 'ssl' one.
   */
  async resolveMonitor(tenantId: number, monitorId: number, keep?: MonitorIncidentCategory): Promise<number[]> {
    const active = await db('live_alerts')
      .where({ tenant_id: tenantId, monitor_id: monitorId })
      .whereNull('resolved_at')
      .select('id', 'stable_key') as { id: number; stable_key: string | null }[];
    const targets = active.filter((r) => !keep || monitorIncidentCategory(r.stable_key) !== keep);
    if (targets.length === 0) return [];

    const resolvedAt = new Date();
    const keys = targets.map((r) => r.stable_key).filter((k): k is string => !!k);
    const rows = await db.transaction(async (trx) => {
      await lockKeys(trx, tenantId, keys);
      return await trx('live_alerts')
        .whereIn('id', targets.map((r) => r.id))
        .whereNull('resolved_at')
        .update({ resolved_at: resolvedAt })
        .returning(['id', 'monitor_id', 'agent_device_id']) as ResolvedRow[];
    });
    await emitResolved(tenantId, rows, resolvedAt);
    return rows.map((r) => r.id);
  },

  /**
   * Alerts of the given tenants (null = every tenant, god view) as seen by
   * one user: per-user read state, dismissed alerts excluded, non-admins
   * limited to visible monitors. Newest first, enriched with the tenant name.
   */
  async getForUser(
    userId: number,
    tenantIds: number[] | null,
    visible: MonitorVisibility,
    limit = 200,
  ): Promise<LiveAlertRow[]> {
    if (tenantIds !== null && tenantIds.length === 0) return [];
    const q = userAlertsQuery(userId);
    if (tenantIds !== null) q.whereIn('la.tenant_id', tenantIds);
    applyVisibility(q, visible);
    const rows = await q
      .orderBy('la.created_at', 'desc')
      .limit(limit)
      .select('la.*', 't.name as tenant_name', 's.read_at as user_read_at');
    return (rows as Record<string, unknown>[]).map(rowToAlert);
  },

  /**
   * One alert the user may act on (tenant in `tenantIds` — null = any — and
   * monitor visible), or undefined.
   */
  async findAccessible(
    id: number,
    tenantIds: number[] | null,
    visible: MonitorVisibility,
  ): Promise<{ id: number; tenantId: number } | undefined> {
    if (tenantIds !== null && tenantIds.length === 0) return undefined;
    const q = db('live_alerts as la').where('la.id', id);
    if (tenantIds !== null) q.whereIn('la.tenant_id', tenantIds);
    applyVisibility(q, visible);
    const row = await q.select('la.id', 'la.tenant_id').first() as { id: number; tenant_id: number } | undefined;
    return row ? { id: row.id, tenantId: row.tenant_id } : undefined;
  },

  /** Mark one alert read for one user. */
  async markRead(userId: number, alertId: number): Promise<void> {
    await db.raw(
      `INSERT INTO live_alert_user_state (user_id, alert_id, read_at) VALUES (?, ?, now())
       ON CONFLICT (user_id, alert_id)
       DO UPDATE SET read_at = COALESCE(live_alert_user_state.read_at, EXCLUDED.read_at)`,
      [userId, alertId],
    );
  },

  /** Mark every visible alert of a tenant read for one user. */
  async markAllRead(userId: number, tenantId: number, visible: MonitorVisibility): Promise<void> {
    const sub = db('live_alerts as la')
      .where('la.tenant_id', tenantId)
      .select(db.raw('?::int', [userId]), 'la.id', db.raw('now()'));
    applyVisibility(sub, visible);
    await db.raw(
      `INSERT INTO live_alert_user_state (user_id, alert_id, read_at) ?
       ON CONFLICT (user_id, alert_id)
       DO UPDATE SET read_at = COALESCE(live_alert_user_state.read_at, EXCLUDED.read_at)`,
      [sub],
    );
  },

  /** Dismiss one alert for one user (hidden from their lists; also counts as read). */
  async dismiss(userId: number, alertId: number): Promise<void> {
    await db.raw(
      `INSERT INTO live_alert_user_state (user_id, alert_id, read_at, dismissed_at) VALUES (?, ?, now(), now())
       ON CONFLICT (user_id, alert_id)
       DO UPDATE SET read_at = COALESCE(live_alert_user_state.read_at, EXCLUDED.read_at),
                     dismissed_at = COALESCE(live_alert_user_state.dismissed_at, EXCLUDED.dismissed_at)`,
      [userId, alertId],
    );
  },

  /** Dismiss every visible alert of a tenant for one user ("Clear all" for non-admins). */
  async dismissAll(userId: number, tenantId: number, visible: MonitorVisibility): Promise<void> {
    const sub = db('live_alerts as la')
      .where('la.tenant_id', tenantId)
      .select(db.raw('?::int', [userId]), 'la.id', db.raw('now()'), db.raw('now()'));
    applyVisibility(sub, visible);
    await db.raw(
      `INSERT INTO live_alert_user_state (user_id, alert_id, read_at, dismissed_at) ?
       ON CONFLICT (user_id, alert_id)
       DO UPDATE SET read_at = COALESCE(live_alert_user_state.read_at, EXCLUDED.read_at),
                     dismissed_at = COALESCE(live_alert_user_state.dismissed_at, EXCLUDED.dismissed_at)`,
      [sub],
    );
  },

  /** Hard delete of one alert, for every user (platform admins only — enforced by the controller). */
  async deleteAlert(id: number): Promise<void> {
    await db('live_alerts').where({ id }).delete();
  },

  /** Hard delete of every alert of a tenant (platform admins only — enforced by the controller). */
  async clearAll(tenantId: number): Promise<void> {
    await db('live_alerts').where({ tenant_id: tenantId }).delete();
  },

  /**
   * Periodic cleanup (retention job in index.ts): remove alerts older than
   * daysOld that are over — resolved incidents, legacy rows read by everyone,
   * and one-shot alerts without a stable key. Active incidents are never
   * purged by age. Returns the number of deleted rows.
   */
  async cleanup(daysOld = 30): Promise<number> {
    return db('live_alerts')
      .where('created_at', '<', new Date(Date.now() - daysOld * 86_400_000))
      .where(function () {
        this.whereNotNull('resolved_at').orWhereNotNull('read_at').orWhereNull('stable_key');
      })
      .delete();
  },
};
