import type { Request, Response, NextFunction } from 'express';
import type { AgentGroupConfig, Heartbeat, MonitorGroup } from '@obliview/shared';
import { db } from '../db';
import { groupService } from '../services/group.service';
import { monitorService } from '../services/monitor.service';
import { heartbeatService } from '../services/heartbeat.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { maintenanceService } from '../services/maintenance.service';
import { AppError } from '../middleware/errorHandler';
import type { CreateGroupInput, UpdateGroupInput, MoveGroupInput } from '../validators/group.schema';
import { getEffectiveTenantScope, assertInScope } from '../utils/tenantScope';
import { auditService } from '../services/audit.service';
import { agentService } from '../services/agent.service';
import { agentUpdateRollout } from '../services/agentUpdateRollout.service';
import { agentUpdatePolicyService, invalidateAgentUpdatePolicyCache } from '../services/agentUpdatePolicy.service';
import { isAgentUpdatePolicyInput } from '../utils/agentUpdate';

/**
 * Server-side memo for /groups/stats. Key is `tenantId` for a tenant-scoped
 * view or the literal 'god' for the God View fan-out. 30-second TTL matches
 * a comfortable interval below the client's 60 s poll — a full refresh cycle
 * still happens, but concurrent users share one DB round-trip most of the time.
 */
interface GroupUptimeStats { uptimePct: number; total: number; up: number }

/**
 * Live per-group counts of GET /groups/stats?counts=1, descendants included.
 * Monitor statuses are read like the client's effectiveStatus() (a monitor
 * in a maintenance window counts as maintenance, never as down) and exclude
 * agents; agents are counted apart (online = up or alert).
 */
interface GroupLiveCounts {
  monitors: number;
  up: number;
  down: number;
  alert: number;
  paused: number;
  maintenance: number;
  ssl: number;
  agentsOnline: number;
  agentsTotal: number;
}
type GroupStatsEntry = GroupUptimeStats & Partial<GroupLiveCounts>;

const LIVE_COUNT_KEYS: ReadonlyArray<keyof GroupLiveCounts> = [
  'monitors', 'up', 'down', 'alert', 'paused', 'maintenance', 'ssl', 'agentsOnline', 'agentsTotal',
];

function emptyLiveCounts(): GroupLiveCounts {
  return { monitors: 0, up: 0, down: 0, alert: 0, paused: 0, maintenance: 0, ssl: 0, agentsOnline: 0, agentsTotal: 0 };
}

const statsCache = new Map<number | 'god', {
  at: number;
  /** Unfiltered 24 h uptime aggregate per group (descendants included). */
  data: Record<number, GroupUptimeStats>;
  /** Group id → ids of the group and all its descendants (closure). */
  descendants: Record<number, number[]>;
}>();

/** Drops the /groups/stats memo (e.g. after a tenant deletion). */
export function clearGroupStatsCache(): void {
  statsCache.clear();
}

/**
 * Tenant gate of the by-id routes: the group must belong to the active
 * tenant (God View excepted), for admins and non-admins alike — a platform
 * admin working in child tenant B must not read or write tenant A groups by
 * id. 404 otherwise, so foreign ids cannot be probed.
 */
async function getGroupInScope(req: Request, id: number): Promise<MonitorGroup> {
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'Invalid group ID');
  const group = await groupService.getById(id, getEffectiveTenantScope(req));
  if (!group) throw new AppError(404, 'Group not found');
  assertInScope(req, group.tenantId, 'Group not found');
  return group;
}

/**
 * isGeneral makes a group (and its monitors) readable by every member of the
 * tenant, team or not: only platform admins and holders of the tenant
 * capability 'groups.manage' may set or change it. For anyone else the field
 * is ignored (anti-escalation).
 */
async function canSetGeneralFlag(req: Request): Promise<boolean> {
  if (req.session.role === 'admin') return true;
  return permissionService.userHasTenantCapability(req.session.userId!, req.tenantId, 'groups.manage');
}

/**
 * Users who see the group through a team grant on it or on one of its
 * ancestors (teams of the group's tenant only), plus every member of the
 * tenant for a general group. Compute BEFORE a delete.
 */
async function groupAudience(group: Pick<MonitorGroup, 'id' | 'tenantId' | 'isGeneral'>): Promise<number[]> {
  try {
    const rows = await db('team_memberships as tm')
      .join('team_permissions as tp', 'tp.team_id', 'tm.team_id')
      .join('user_teams as ut', 'ut.id', 'tm.team_id')
      .join('group_closure as gc', 'gc.ancestor_id', 'tp.scope_id')
      .where('tp.scope', 'group')
      .where('gc.descendant_id', group.id)
      .where('ut.tenant_id', group.tenantId)
      .distinct('tm.user_id') as Array<{ user_id: number }>;
    const userIds = new Set(rows.map((r) => Number(r.user_id)));
    if (group.isGeneral) {
      // Same audience rule as the monitor events (legacy no-row accounts of the master tenant included).
      for (const u of await permissionService.getTenantMemberUserIds(group.tenantId)) userIds.add(u);
    }
    return [...userIds];
  } catch {
    return [];
  }
}

/**
 * Broadcast a group:* event to the admin room of the GROUP's tenant (God-View
 * admins join every tenant's admin room) and to the users who see the group.
 */
function emitGroupEvent(
  req: Request,
  tenantId: number | null | undefined,
  userIds: number[],
  event: string,
  payload: unknown,
): void {
  const io = req.app.get('io');
  if (!io || !tenantId) return;
  const rooms = [`tenant:${tenantId}:admin`, ...[...new Set(userIds)].map((u) => `user:${u}`)];
  io.to(rooms).emit(event, payload);
}

/** Start of the window selected by the group page's period selector. */
function periodStart(period: string): Date {
  const since = new Date();
  switch (period) {
    case '1h': since.setHours(since.getHours() - 1); break;
    case '24h': since.setHours(since.getHours() - 24); break;
    case '7d': since.setDate(since.getDate() - 7); break;
    case '30d': since.setDate(since.getDate() - 30); break;
    case '365d': since.setDate(since.getDate() - 365); break;
    default: since.setHours(since.getHours() - 24);
  }
  return since;
}

// ── "Monitors" block of the group page ─────────────────────────────────────
// A group holds monitors and agents side by side (migration 054). The group
// page shows agents in their own block (online / alert / offline), so the
// period stats and the heartbeat chart only cover the non-agent monitors:
// agent heartbeats ('alert' beats, no response time) would skew the uptime.

/**
 * Non-agent monitors of the group subtree, in the group's tenant, restricted
 * to what a non-admin caller can see (so no hidden monitor name leaks through
 * the stats either).
 */
async function getCheckMonitorIds(req: Request, group: MonitorGroup): Promise<number[]> {
  const rows = await db('monitors')
    .whereIn('group_id', db('group_closure').where('ancestor_id', group.id).select('descendant_id'))
    .where('tenant_id', group.tenantId)
    .whereNot('type', 'agent')
    .select('id') as Array<{ id: number }>;
  const ids = rows.map((r) => r.id);
  if (req.session.role === 'admin' || ids.length === 0) return ids;

  const visible = await permissionService.getVisibleMonitorIds(req.session.userId!, false);
  if (visible === 'all') return ids;
  const visibleSet = new Set(visible);
  return ids.filter((id) => visibleSet.has(id));
}

interface HeartbeatRow {
  id: number;
  monitor_id: number;
  status: string;
  response_time: number | null;
  status_code: number | null;
  message: string | null;
  ping: number | null;
  is_retrying: boolean | null;
  value: string | null;
  in_maintenance: boolean | null;
  created_at: Date;
}

function toHeartbeat(row: HeartbeatRow): Heartbeat {
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

const MAX_GROUP_CHART_POINTS = 500;

/**
 * Heartbeats of the given monitors since `since`, downsampled like a single
 * monitor's chart: every nth beat for the line, plus the non-'up' beats
 * (themselves sampled when there are too many, so a chronic incident at long
 * range still returns a bounded payload).
 */
async function getHeartbeatsForMonitors(monitorIds: number[], since: Date): Promise<Heartbeat[]> {
  if (monitorIds.length === 0) return [];
  const scoped = () => db('heartbeats')
    .whereIn('monitor_id', monitorIds)
    .where('created_at', '>=', since);

  const [counts] = await scoped().select(
    db.raw('COUNT(*)::int as total'),
    db.raw("COUNT(*) FILTER (WHERE status != 'up')::int as non_up"),
  ) as Array<{ total: number | null; non_up: number | null }>;
  const total = Number(counts?.total ?? 0);
  const nonUp = Number(counts?.non_up ?? 0);

  if (total <= MAX_GROUP_CHART_POINTS) {
    const rows = await scoped().orderBy('created_at', 'asc').select('*') as HeartbeatRow[];
    return rows.map(toHeartbeat);
  }

  const nth = Math.ceil(total / MAX_GROUP_CHART_POINTS);
  const nthNonUp = nonUp > MAX_GROUP_CHART_POINTS ? Math.ceil(nonUp / MAX_GROUP_CHART_POINTS) : 1;
  const sampled = scoped().select(
    '*',
    db.raw('ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn_all'),
    db.raw("ROW_NUMBER() OVER (PARTITION BY (status = 'up') ORDER BY created_at ASC) as rn_status"),
  );
  const rows = await db.from(sampled.as('sub'))
    .where(function () {
      this.whereRaw('rn_all % ? = 1', [nth])
        .orWhereRaw("(status != 'up' AND rn_status % ? = 1)", [nthNonUp]);
    })
    .orderBy('created_at', 'asc')
    .select('*') as HeartbeatRow[];
  return rows.map(toHeartbeat);
}

/** Same shape as heartbeatService.getGroupStats, over an explicit monitor list. */
async function getStatsForMonitors(monitorIds: number[], since: Date): Promise<{
  total: number;
  up: number;
  down: number;
  uptimePct: number;
  avgResponseTime: number | null;
  monitorCount: number;
  downMonitorNames: string[];
}> {
  if (monitorIds.length === 0) {
    return { total: 0, up: 0, down: 0, uptimePct: 100, avgResponseTime: null, monitorCount: 0, downMonitorNames: [] };
  }

  const [row] = await db('heartbeats')
    .whereIn('monitor_id', monitorIds)
    .where('created_at', '>=', since)
    .where({ in_maintenance: false })
    .select(
      db.raw('COUNT(*)::int as total'),
      // Legacy 'ssl_warning' beats are reachable checks: counted as up, like
      // heartbeatService.getStats / getUptimeSeries.
      db.raw("COUNT(*) FILTER (WHERE status IN ('up', 'ssl_warning'))::int as up"),
      db.raw("COUNT(*) FILTER (WHERE status = 'down')::int as down"),
      db.raw('ROUND(AVG(response_time))::int as avg_rt'),
    ) as Array<{ total: number | null; up: number | null; down: number | null; avg_rt: number | null }>;

  const total = row?.total ?? 0;
  const up = row?.up ?? 0;

  const monitorRows = await db('monitors')
    .whereIn('id', monitorIds)
    .where({ is_active: true })
    .select('name', 'status') as Array<{ name: string; status: string }>;
  const PROBLEM_STATUSES = new Set(['down', 'ssl_expired', 'ssl_warning', 'alert']);

  return {
    total,
    up,
    down: row?.down ?? 0,
    uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
    avgResponseTime: row?.avg_rt ?? null,
    monitorCount: monitorRows.length,
    downMonitorNames: monitorRows.filter((m) => PROBLEM_STATUSES.has(m.status)).map((m) => m.name),
  };
}

export const groupsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const allGroups = await groupService.getAll(getEffectiveTenantScope(req));

      if (isAdmin) {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false);
      if (visibleIds === 'all') {
        res.json({ success: true, data: allGroups });
        return;
      }

      const visibleSet = new Set(visibleIds);
      const filtered = allGroups.filter((g) => visibleSet.has(g.id));
      res.json({ success: true, data: filtered });
    } catch (err) {
      next(err);
    }
  },

  async tree(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const tree = await groupService.getTree(getEffectiveTenantScope(req));

      if (isAdmin) {
        res.json({ success: true, data: tree });
        return;
      }

      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, false);
      if (visibleIds === 'all') {
        res.json({ success: true, data: tree });
        return;
      }

      // Filter tree to only include visible groups
      const visibleSet = new Set(visibleIds);
      function filterTree(nodes: typeof tree): typeof tree {
        return nodes
          .filter((n) => visibleSet.has(n.id))
          .map((n) => ({ ...n, children: filterTree(n.children) }));
      }
      res.json({ success: true, data: filterTree(tree) });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const group = await getGroupInScope(req, id);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, id, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateGroupInput;
      // Exposing a group to the whole workspace (is_general makes its
      // monitors readable by every member) is reserved to platform admins
      // and 'groups.manage' holders; the field is ignored for anyone else.
      // groupService.create defaults it to false.
      if (data.isGeneral !== undefined && !(await canSetGeneralFlag(req))) delete data.isGeneral;

      // Validate parent: must exist in the caller's tenant (keeps the closure
      // table intra-tenant) and non-admins need write access on it.
      if (data.parentId) {
        const parent = await groupService.getById(data.parentId, req.tenantId);
        if (!parent) throw new AppError(400, 'Parent group not found');
        if (req.session.role !== 'admin') {
          const canWriteParent = await permissionService.canWriteGroup(req.session.userId!, data.parentId, false);
          if (!canWriteParent) throw new AppError(403, 'No write permission on parent group');
        }
      }

      const group = await groupService.create(data, req.tenantId);

      // Auto-assign RW to the creator's canCreate teams — of the group's
      // tenant only (teams are mono-tenant: a team of another tenant must
      // never get a grant on this tenant's group).
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!);
        for (const team of userTeams) {
          if (team.canCreate && team.tenantId === group.tenantId) {
            await teamService.addPermission(team.id, 'group', group.id, 'rw');
          }
        }
      }

      emitGroupEvent(req, group.tenantId, await groupAudience(group), 'group:created', { group });

      res.status(201).json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as UpdateGroupInput;
      const current = await getGroupInScope(req, id);
      // The general flag (group readable by every workspace member) is
      // reserved to platform admins and 'groups.manage' holders: ignored for
      // anyone else (a full-form save resends the current value).
      if (data.isGeneral !== undefined && !(await canSetGeneralFlag(req))) delete data.isGeneral;

      const audienceBefore = await groupAudience(current);
      const group = await groupService.update(id, data, current.tenantId);

      if (!group) throw new AppError(404, 'Group not found');

      if (data.groupNotifications !== undefined) {
        groupNotificationService.removeGroup(id);
      }

      emitGroupEvent(
        req, group.tenantId, [...audienceBefore, ...(await groupAudience(group))],
        'group:updated', { group },
      );

      res.json({ success: true, data: group });
    } catch (err) {
      next(err);
    }
  },

  async move(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { newParentId } = req.body as MoveGroupInput;
      const current = await getGroupInScope(req, id);

      // Also check write permission on target parent if non-admin
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin && newParentId !== null) {
        const canWriteTarget = await permissionService.canWriteGroup(req.session.userId!, newParentId, false);
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      }

      // Users who saw it under its old parent chain, then under the new one.
      const audienceBefore = await groupAudience(current);
      const group = await groupService.move(id, newParentId, current.tenantId);
      if (!group) throw new AppError(404, 'Group not found');

      emitGroupEvent(
        req, group.tenantId, [...audienceBefore, ...(await groupAudience(group))],
        'group:moved', { group },
      );

      res.json({ success: true, data: group });
    } catch (err: unknown) {
      if (err instanceof Error && !(err instanceof AppError) && err.message.includes('circular')) {
        next(new AppError(400, err.message));
      } else {
        next(err);
      }
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const group = await getGroupInScope(req, id);
      // Computed before the delete: the grants are gone afterwards.
      const audience = await groupAudience(group);

      groupNotificationService.removeGroup(id);

      const deleted = await groupService.delete(id, group.tenantId);
      if (!deleted) throw new AppError(404, 'Group not found');

      emitGroupEvent(req, group.tenantId, audience, 'group:deleted', { groupId: id });

      res.json({ success: true, message: 'Group deleted' });
    } catch (err) {
      next(err);
    }
  },

  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantScope = getEffectiveTenantScope(req);
      // ?counts=1 adds the live per-group status counts (dashboard group
      // summary). The sidebar poll omits it and stays on the cheap memo path.
      const withCounts = req.query.counts === '1' || req.query.counts === 'true';

      // Per-tenant-scope memo (30 s TTL). This endpoint is polled every 60 s
      // from GroupTree by every logged-in user, and the underlying queries
      // scan heartbeats × monitors + group_closure. Even a 30 s cache absorbs
      // most of the concurrent-user amplification without the client noticing.
      // The cache holds the unfiltered per-scope aggregate; visibility is
      // applied per caller on every request (hit or miss), so one user's
      // filtered view is never served to another.
      const cacheKey = tenantScope ?? 'god';
      const isAdmin = req.session.role === 'admin';
      const visibleIds = await permissionService.getVisibleGroupIds(req.session.userId!, isAdmin);
      const visibleGroupSet = visibleIds === 'all' ? null : new Set(visibleIds);

      const now = Date.now();
      let entry = statsCache.get(cacheKey);
      if (!entry || now - entry.at >= 30_000) {
        const since = new Date();
        since.setHours(since.getHours() - 24);

        const rawStats = await heartbeatService.getRawStatsPerGroup(since, tenantScope);

        // Scope the closure load to tenant when possible — closure rows are
        // structural (small) but on large multi-tenant installs the unfiltered
        // load hits the JS heap harder than needed.
        const closureQuery = db('group_closure').select<{ ancestor_id: number; descendant_id: number }[]>(
          'group_closure.ancestor_id',
          'group_closure.descendant_id',
        );
        if (typeof tenantScope === 'number') {
          closureQuery
            .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
            .where('monitor_groups.tenant_id', tenantScope);
        }
        const closureRows = await closureQuery;

        const descendantsMap = new Map<number, number[]>();
        for (const row of closureRows) {
          if (!descendantsMap.has(row.ancestor_id)) {
            descendantsMap.set(row.ancestor_id, []);
          }
          descendantsMap.get(row.ancestor_id)!.push(row.descendant_id);
        }

        const allGroups = await groupService.getAll(tenantScope);
        const uptime: Record<number, GroupUptimeStats> = {};
        const descendants: Record<number, number[]> = {};

        for (const group of allGroups) {
          const descIds = descendantsMap.get(group.id) || [group.id];
          descendants[group.id] = descIds;
          let total = 0;
          let up = 0;

          for (const descId of descIds) {
            const stats = rawStats.get(descId);
            if (stats) {
              total += stats.total;
              up += stats.up;
            }
          }

          uptime[group.id] = {
            total,
            up,
            uptimePct: total > 0 ? Math.round((up / total) * 10000) / 100 : 100,
          };
        }

        entry = { at: now, data: uptime, descendants };
        statsCache.set(cacheKey, entry);
      }

      const groupIds = Object.keys(entry.data)
        .map(Number)
        .filter((id) => !visibleGroupSet || visibleGroupSet.has(id));

      if (!withCounts) {
        res.json({ success: true, data: Object.fromEntries(groupIds.map((id) => [id, entry!.data[id]])) });
        return;
      }

      // ── Live counts (never memoised: they follow the monitors' status) ──
      // Only the monitors the caller can read are counted, so an ancestor
      // shown for navigation never reveals the size of a subtree the caller
      // has no grant on.
      const visibleMonitorIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);
      const rows = await groupService.getMonitorStatusRows(tenantScope, visibleMonitorIds);
      // Maintenance only changes how a non-agent monitor is counted (agent
      // reachability is a fact, maintenance or not — same rule as the hero).
      const inMaintenanceIds = await maintenanceService.getInMaintenanceMonitorIds(
        rows.filter((r) => r.type !== 'agent').map((r) => ({ id: r.id, groupId: r.groupId, tenantId: r.tenantId })),
      );

      // Direct counts per group (own monitors only)
      const direct = new Map<number, GroupLiveCounts>();
      for (const r of rows) {
        let c = direct.get(r.groupId);
        if (!c) { c = emptyLiveCounts(); direct.set(r.groupId, c); }
        if (r.type === 'agent') {
          c.agentsTotal++;
          if (r.status === 'up' || r.status === 'alert') c.agentsOnline++;
          continue;
        }
        const inMaintenance = inMaintenanceIds.has(r.id);
        // effectiveStatus(): a monitor in a maintenance window is not down.
        const status = inMaintenance && r.status !== 'up' ? 'maintenance' : r.status;
        c.monitors++;
        switch (status) {
          case 'up': c.up++; break;
          case 'down': c.down++; break;
          case 'alert': c.alert++; break;
          case 'paused': c.paused++; break;
          case 'maintenance': c.maintenance++; break;
          case 'ssl_warning':
          case 'ssl_expired': c.ssl++; break;
          default: break;
        }
      }

      const data: Record<number, GroupStatsEntry> = {};
      for (const id of groupIds) {
        const counts = emptyLiveCounts();
        for (const descId of entry.descendants[id] ?? [id]) {
          const c = direct.get(descId);
          if (!c) continue;
          for (const k of LIVE_COUNT_KEYS) counts[k] += c[k];
        }
        data[id] = { ...entry.data[id], ...counts };
      }

      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async clearHeartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const group = await getGroupInScope(req, groupId);

      const closureRows = await db('group_closure')
        .where({ ancestor_id: groupId })
        .select('descendant_id');
      const groupIds = closureRows.map((r: any) => r.descendant_id);

      const monitorRows = await db('monitors')
        .whereIn('group_id', groupIds)
        .where('tenant_id', group.tenantId)
        .select('id');
      const monitorIds = monitorRows.map((r: any) => r.id);

      const deleted = await heartbeatService.clearForMonitors(monitorIds);

      res.json({ success: true, data: { deleted, monitorCount: monitorIds.length } });
    } catch (err) {
      next(err);
    }
  },

  async reorder(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const raw = req.body?.items as unknown;
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new AppError(400, 'items array is required');
      }
      const items = (raw as Array<{ id?: unknown; sortOrder?: unknown }>).map((i) => ({
        id: Number(i?.id),
        sortOrder: Number(i?.sortOrder),
      }));
      if (items.some((i) => !Number.isInteger(i.id) || i.id <= 0 || !Number.isFinite(i.sortOrder))) {
        throw new AppError(400, 'Invalid reorder item');
      }

      // Every group must be in the active tenant (God View excepted).
      const tenantScope = getEffectiveTenantScope(req);
      const ids = [...new Set(items.map((i) => i.id))];
      const q = db('monitor_groups').whereIn('id', ids).select('id', 'tenant_id', 'is_general');
      if (tenantScope !== null) q.where({ tenant_id: tenantScope });
      const rows = await q as Array<{ id: number; tenant_id: number; is_general: boolean }>;
      if (rows.length !== ids.length) {
        throw new AppError(400, 'Some groups do not belong to the current workspace', 'FOREIGN_GROUP_IDS');
      }

      await groupService.reorder(items, tenantScope);

      // One event per tenant, to its admin room and the users who see the
      // reordered groups.
      const byTenant = new Map<number, { items: typeof items; userIds: number[] }>();
      for (const row of rows) {
        const entry = byTenant.get(row.tenant_id) ?? { items: [], userIds: [] };
        entry.items.push(...items.filter((i) => i.id === row.id));
        entry.userIds.push(...await groupAudience({ id: row.id, tenantId: row.tenant_id, isGeneral: row.is_general }));
        byTenant.set(row.tenant_id, entry);
      }
      for (const [tenantId, entry] of byTenant) {
        emitGroupEvent(req, tenantId, entry.userIds, 'group:reordered', { items: entry.items });
      }

      res.json({ success: true, message: 'Groups reordered' });
    } catch (err) {
      next(err);
    }
  },

  async getMonitors(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const group = await getGroupInScope(req, groupId);

      // Check read permission
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, groupId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      const descendants = req.query.descendants === 'true';
      const groupIds = descendants ? await groupService.getDescendantIds(groupId) : [groupId];

      // Mapped API models (not raw rows), restricted to the group's own tenant
      let monitors = await monitorService.getByGroupIds(groupIds, group.tenantId);

      // For non-admin users, further filter to only visible monitors
      if (!isAdmin) {
        const visibleMonitorIds = await permissionService.getVisibleMonitorIds(req.session.userId!, false);
        if (visibleMonitorIds !== 'all') {
          const visibleSet = new Set(visibleMonitorIds);
          monitors = monitors.filter((m) => visibleSet.has(m.id));
        }
      }

      // Maintenance flag, batch-resolved like GET /monitors: monitor- and
      // group-scope windows for every monitor, plus the agent-scope windows
      // (scoped on the device) for agent monitors.
      const agentMonitors = monitors.filter((m) => m.type === 'agent' && m.agentDeviceId != null);
      const [inMaintenanceIds, inMaintenanceDeviceIds] = await Promise.all([
        maintenanceService.getInMaintenanceMonitorIds(
          monitors.map((m) => ({ id: m.id, groupId: m.groupId, tenantId: group.tenantId })),
        ),
        maintenanceService.getInMaintenanceAgentIds(
          agentMonitors.map((m) => ({ id: m.agentDeviceId!, groupId: m.groupId })),
        ),
      ]);
      const enriched = monitors.map((m) => ({
        ...m,
        inMaintenance: inMaintenanceIds.has(m.id)
          || (m.type === 'agent' && m.agentDeviceId != null && inMaintenanceDeviceIds.has(m.agentDeviceId)),
      }));

      res.json({ success: true, data: enriched });
    } catch (err) {
      next(err);
    }
  },

  async heartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const period = (req.query.period as string) || '24h';

      const group = await getGroupInScope(req, groupId);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, groupId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      // Non-agent monitors only (agents have their own block on the group page)
      const monitorIds = await getCheckMonitorIds(req, group);
      const heartbeats = await getHeartbeatsForMonitors(monitorIds, periodStart(period));
      res.json({ success: true, data: heartbeats });
    } catch (err) {
      next(err);
    }
  },

  async groupDetailStats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      const period = (req.query.period as string) || '24h';

      const group = await getGroupInScope(req, groupId);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadGroup(req.session.userId!, groupId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      // Non-agent monitors only (agents have their own block on the group page)
      const monitorIds = await getCheckMonitorIds(req, group);
      const stats = await getStatsForMonitors(monitorIds, periodStart(period));
      res.json({ success: true, data: stats });
    } catch (err) {
      next(err);
    }
  },

  /** PATCH /groups/:id/agent-config — update agent group config (thresholds + group settings) */
  async updateAgentGroupConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');

      const group = await getGroupInScope(req, groupId);

      const { agentGroupConfig: rawConfig, agentThresholds } = req.body as {
        agentGroupConfig?: Partial<AgentGroupConfig>;
        agentThresholds?: unknown;
      };
      // The update policy has its own route (gate, audit, cancellation):
      // PUT /groups/:id/agent-update-policy. Ignored here.
      let agentGroupConfig = rawConfig;
      if (agentGroupConfig && typeof agentGroupConfig === 'object' && 'updatePolicy' in agentGroupConfig) {
        const { updatePolicy: _ignored, ...rest } = agentGroupConfig;
        agentGroupConfig = rest;
      }

      let updated = group;
      if (agentGroupConfig !== undefined) {
        updated = (await groupService.updateAgentGroupConfig(groupId, agentGroupConfig, group.tenantId)) ?? updated;
      }
      if (agentThresholds !== undefined) {
        updated = (await groupService.updateAgentThresholds(groupId, agentThresholds as any, group.tenantId)) ?? updated;
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /groups/:id/agent-update-policy — the group's own update policy, what
   * it inherits (ancestors of the same workspace, workspace, global) and the
   * effective value. agents.manage on the group's workspace.
   */
  async getAgentUpdatePolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const group = await getGroupInScope(req, parseInt(req.params.id, 10));
      res.json({ success: true, data: await agentUpdatePolicyService.getGroupContext(group.id, group.tenantId) });
    } catch (err) {
      next(err);
    }
  },

  /**
   * PUT /groups/:id/agent-update-policy { updatePolicy: 'auto'|'manual'|'off'|null }
   * null = inherit. 'off' freezes the sub-tree: the updates still waiting
   * for its agents are cancelled.
   */
  async setAgentUpdatePolicy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const group = await getGroupInScope(req, parseInt(req.params.id, 10));
      const body = (req.body ?? {}) as { updatePolicy?: unknown };
      if (!('updatePolicy' in body) || !isAgentUpdatePolicyInput(body.updatePolicy)) {
        throw new AppError(400, "updatePolicy must be 'auto', 'manual', 'off' or null");
      }
      const to = body.updatePolicy;
      const before = await agentUpdatePolicyService.getGroupContext(group.id, group.tenantId);
      const updated = await groupService.updateAgentGroupConfig(group.id, { updatePolicy: to }, group.tenantId);
      if (!updated) throw new AppError(404, 'Group not found');
      invalidateAgentUpdatePolicyCache();

      if (before.ownPolicy !== to) {
        await auditService.logReq(req, 'agent_update_policy.changed', {
          tenantId: group.tenantId,
          resourceType: 'group',
          resourceId: group.id,
          details: { level: 'group', scopeId: group.id, groupName: group.name, from: before.ownPolicy, to },
        });
      }
      const deviceIds = await agentUpdatePolicyService.deviceIdsInGroupTree(group.id, group.tenantId);
      if (to === 'off') {
        if (deviceIds.length > 0) await agentUpdateRollout.cancelPending(group.tenantId, deviceIds);
      } else {
        agentUpdateRollout.nudge();
      }
      // Devices of the sub-tree show their new effective policy (and cancelled updates).
      if (deviceIds.length > 0) await agentService.emitDevicesByIds(deviceIds);

      res.json({
        success: true,
        data: {
          group: updated,
          policy: await agentUpdatePolicyService.getGroupContext(group.id, group.tenantId),
        },
      });
    } catch (err) {
      next(err);
    }
  },
};
