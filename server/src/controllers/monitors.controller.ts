import type { Request, Response, NextFunction } from 'express';
import type { Heartbeat, Monitor, UptimeSeriesPeriod } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { monitorService } from '../services/monitor.service';
import { heartbeatService, type UptimeSeriesBucket } from '../services/heartbeat.service';
import { permissionService } from '../services/permission.service';
import { teamService } from '../services/team.service';
import { MonitorWorkerManager } from '../workers/MonitorWorkerManager';
import { AppError } from '../middleware/errorHandler';
import { canManageAgents } from '../middleware/agentRbac';
import type { CreateMonitorInput, UpdateMonitorInput, BulkUpdateInput } from '../validators/monitor.schema';
import { maintenanceService } from '../services/maintenance.service';
import { agentHub } from '../services/agentHub.service';
import { agentService } from '../services/agent.service';
import { getEffectiveTenantScope, assertInScope } from '../utils/tenantScope';
import { splitLegacyTiming, applyMonitorTiming, type LegacyTiming } from '../services/monitorTiming.service';
import { auditService } from '../services/audit.service';

/**
 * Broadcast a monitor CRUD event to the admin room of the MONITOR's tenant
 * (God-View admins join every tenant's admin room) and to every user who can
 * read the monitor (`user:<id>` rooms), so team members see what other
 * members create, rename, move or delete.
 */
function emitMonitorEvent(
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

/** Users with at least read access to the monitor (compute BEFORE a delete). */
async function monitorAudience(monitorId: number): Promise<number[]> {
  try {
    return await permissionService.getUsersWithMonitorAccess(monitorId);
  } catch {
    return [];
  }
}

/**
 * Tenant gate of the by-id routes: the monitor must belong to the active
 * tenant (God View excepted), for admins and non-admins alike. 404 otherwise,
 * so foreign ids cannot be probed.
 */
async function getMonitorInScope(req: Request, id: number): Promise<Monitor> {
  if (!Number.isInteger(id) || id <= 0) throw new AppError(400, 'Invalid monitor ID');
  const monitor = await monitorService.getById(id, getEffectiveTenantScope(req));
  if (!monitor) throw new AppError(404, 'Monitor not found');
  assertInScope(req, monitor.tenantId, 'Monitor not found');
  return monitor;
}

/**
 * Bulk endpoints: ids deduplicated, validated, and all in the active tenant
 * (God View excepted). Foreign ids are rejected (400), never silently dropped.
 */
async function resolveBulkIds(req: Request, raw: unknown): Promise<number[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AppError(400, 'monitorIds array is required');
  }
  const ids = [...new Set(raw.map((v) => Number(v)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new AppError(400, 'Invalid monitor ID');
  }
  const inScope = await monitorService.filterIdsByTenant(ids, getEffectiveTenantScope(req));
  if (inScope.length !== ids.length) {
    throw new AppError(400, 'Some monitors do not belong to the current workspace', 'FOREIGN_MONITOR_IDS');
  }
  return ids;
}

const PROXY_FORBIDDEN = 'You are not allowed to run checks through this agent';

/**
 * Routing a check through a proxy agent makes that agent fetch the target
 * from its own network (an SSRF pivot into a LAN the caller may not reach).
 * Setting or changing proxyAgentDeviceId therefore requires the platform
 * admin role, the tenant capability 'agents.manage', or write access on the
 * device's agent monitor. Clearing it, or resending the current value, is
 * always allowed. (Tenant + type consistency is checked in monitorService.)
 */
async function assertProxyAllowed(
  req: Request,
  nextProxyId: number | null | undefined,
  currentProxyId: number | null | undefined,
): Promise<void> {
  if (nextProxyId === undefined || nextProxyId === null) return;
  if (nextProxyId === (currentProxyId ?? null)) return;
  if (req.session.role === 'admin') return;
  const userId = req.session.userId!;
  if (await permissionService.userHasTenantCapability(userId, req.tenantId, 'agents.manage')) return;
  const agentMonitorId = await monitorService.getAgentMonitorIdForDevice(nextProxyId, req.tenantId);
  if (agentMonitorId !== null && await permissionService.canWriteMonitor(userId, agentMonitorId, false)) return;
  throw new AppError(403, PROXY_FORBIDDEN, 'PROXY_FORBIDDEN');
}

const SCRIPT_ADMIN_ONLY = 'Only platform admins can manage script monitors';

/** '' and null both mean "no script command". */
function normScript(cmd: string | null | undefined): string | null {
  return cmd ? cmd : null;
}

/**
 * Script monitors run an arbitrary shell command on the Obliview host (or on
 * a proxy agent), so only platform admins may create one, turn a monitor into
 * one, or change its command / execution host. Non-admins may still edit the
 * harmless fields of an existing (admin-created) script monitor.
 * `current` is null on create.
 */
function assertScriptChangeAllowed(
  req: Request,
  data: Partial<Pick<Monitor, 'type' | 'scriptCommand' | 'proxyAgentDeviceId'>>,
  current: Monitor | null,
): void {
  if (req.session.role === 'admin') return;

  const currentType = current?.type ?? null;
  const nextType = data.type ?? currentType;

  // No switching a monitor to or away from the 'script' type
  if (nextType !== currentType && (nextType === 'script' || currentType === 'script')) {
    throw new AppError(403, SCRIPT_ADMIN_ONLY);
  }

  // No setting / changing the command (clearing it on a non-script monitor is fine)
  if (data.scriptCommand !== undefined) {
    const nextCmd = normScript(data.scriptCommand);
    const curCmd = normScript(current?.scriptCommand);
    if (nextCmd !== curCmd && !(nextCmd === null && nextType !== 'script')) {
      throw new AppError(403, SCRIPT_ADMIN_ONLY);
    }
  }

  // No moving an existing script monitor to another execution host
  if (
    nextType === 'script' &&
    data.proxyAgentDeviceId !== undefined &&
    (data.proxyAgentDeviceId ?? null) !== (current?.proxyAgentDeviceId ?? null)
  ) {
    throw new AppError(403, SCRIPT_ADMIN_ONLY);
  }
}

/**
 * Non-admins may only put a monitor into a group they can write to (the
 * tenant consistency of the group is enforced in monitorService).
 */
async function assertGroupWritable(req: Request, groupId: number | null | undefined): Promise<void> {
  if (!groupId || req.session.role === 'admin') return;
  const canWrite = await permissionService.canWriteGroup(req.session.userId!, groupId, false);
  if (!canWrite) throw new AppError(403, 'No write permission on target group');
}

// ── Agent monitors ──────────────────────────────────────────────────────────
// A type='agent' monitor is the backing row of an approved agent device.
// Pausing, resuming or deleting it through the generic monitor API is
// delegated to the device (suspend / reinstate / delete): a merely 'paused'
// agent monitor is re-activated by the next agent push, and deleting the
// monitor alone leaves an approved device without a monitor.

const AGENT_DEVICE_ADMIN_ONLY = 'Missing capability: agents.manage (suspend, reinstate or delete agent devices)';

type DeviceBackedMonitor = Monitor & { agentDeviceId: number };

/** True for an agent monitor linked to a device (legacy rows without a device are handled generically). */
function isDeviceBacked(monitor: Monitor | null | undefined): monitor is DeviceBackedMonitor {
  return !!monitor && monitor.type === 'agent' && !!monitor.agentDeviceId;
}

/**
 * Legacy timing fields of the monitor API (intervalSeconds, timeoutMs,
 * retryIntervalSeconds, maxRetries) → monitor-scope settings overrides, the
 * only timing source since migration 061. A number sets the override; null
 * is ignored (GET returns null for these fields, so a GET-modify-PUT never
 * erases an override — clearing goes through the settings API). Agent
 * monitors take their timing from the device: ignored.
 */
async function applyApiTiming(req: Request, monitors: Monitor[], timing: LegacyTiming): Promise<void> {
  const numeric: LegacyTiming = {};
  for (const [field, value] of Object.entries(timing) as Array<[keyof LegacyTiming, number | null | undefined]>) {
    if (typeof value === 'number' && Number.isFinite(value)) numeric[field] = value;
  }
  if (Object.keys(numeric).length === 0) return;
  for (const m of monitors) {
    if (m.type === 'agent') continue;
    const tenantId = m.tenantId ?? req.tenantId;
    if (!tenantId) continue;
    await applyMonitorTiming(tenantId, m.id, numeric);
  }
}

/** Device lifecycle needs agents.manage in the agent API — the monitor API applies the same gate. */
async function assertCanManageAgentDevices(req: Request): Promise<void> {
  if (!(await canManageAgents(req))) throw new AppError(403, AGENT_DEVICE_ADMIN_ONLY);
}

/** True when the agent monitor is currently paused (device suspended, or a legacy monitor-level pause). */
async function isAgentMonitorPaused(monitor: DeviceBackedMonitor): Promise<boolean> {
  if (monitor.status === 'paused' || !monitor.isActive) return true;
  const device = await agentService.getDeviceById(monitor.agentDeviceId);
  return device?.status === 'suspended';
}

/**
 * Pause (suspend the device) or resume (reinstate the device) an agent monitor.
 * Returns the resulting monitor status, or null when the device is missing or
 * neither approved nor suspended (pending / refused devices are handled on the
 * agents page).
 */
async function setAgentMonitorPaused(monitor: DeviceBackedMonitor, pause: boolean): Promise<'paused' | 'pending' | null> {
  const device = await agentService.getDeviceById(monitor.agentDeviceId);
  if (!device || (device.status !== 'approved' && device.status !== 'suspended')) return null;

  if (pause) {
    // Device suspended, agent monitor paused + inactive, worker stopped,
    // AGENT_DEVICE_UPDATED emitted — all by agentService.
    await agentService.suspendDevice(device.id);
    return 'paused';
  }

  // Device approved again and agent monitor re-activated ('pending'). The
  // worker is armed by agentService once the agent pushes again, so a device
  // that is still offline does not raise a false DOWN right away.
  await agentService.reinstateDevice(device.id);
  return 'pending';
}

/**
 * Ids of the monitors the caller can see in the active tenant scope — the
 * scoping shared by the dashboard aggregates (summary, recent heartbeats,
 * uptime series), mirroring list().
 */
async function resolveScopedMonitorIds(req: Request): Promise<number[]> {
  const isAdmin = req.session.role === 'admin';
  const tenantScope = getEffectiveTenantScope(req);
  const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

  if (visibleIds === 'all') {
    // Admin — restrict to the active tenant scope (or all in God View)
    const monitors = await monitorService.getAll(tenantScope);
    return monitors.map((m) => m.id);
  }
  // Non-admin — restrict to the active tenant as well, mirroring list()
  return monitorService.filterIdsByTenant(visibleIds, tenantScope);
}

/** GET /monitors/uptime-series periods: date_trunc unit + number of buckets (current one included). */
const UPTIME_SERIES_WINDOWS = new Map<UptimeSeriesPeriod, { bucket: UptimeSeriesBucket; buckets: number }>([
  ['24h', { bucket: 'hour', buckets: 24 }],
  ['7d', { bucket: 'day', buckets: 7 }],
  ['14d', { bucket: 'day', buckets: 14 }],
  ['30d', { bucket: 'day', buckets: 30 }],
]);

export const monitorsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const tenantScope = getEffectiveTenantScope(req);
      const visibleIds = await permissionService.getVisibleMonitorIds(req.session.userId!, isAdmin);

      let monitors;
      if (visibleIds === 'all') {
        monitors = await monitorService.getAll(tenantScope);
      } else {
        monitors = await monitorService.getByIds(visibleIds, tenantScope ?? undefined);
      }

      // Batch-resolve maintenance state: monitor- and group-scope windows for
      // every monitor, plus the agent-scope windows (scoped on the device) for
      // agent monitors — same rule as GET /groups/:id/monitors.
      const agentMonitors = monitors.filter((m) => m.type === 'agent' && m.agentDeviceId != null);
      const [inMaintenanceIds, inMaintenanceDeviceIds] = await Promise.all([
        maintenanceService.getInMaintenanceMonitorIds(
          monitors.map((m) => ({ id: m.id, groupId: m.groupId, tenantId: m.tenantId })),
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

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const monitor = await getMonitorInScope(req, id);

      // Check visibility
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadMonitor(req.session.userId!, id, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      // Same maintenance resolution as the worker (cached), so a monitor
      // opened by deep link shows MAINT. like it does in the list.
      const inMaintenance = monitor.type === 'agent' && monitor.agentDeviceId
        ? await maintenanceService.isInMaintenance('agent', monitor.agentDeviceId, monitor.groupId)
        : await maintenanceService.isInMaintenance('monitor', monitor.id, monitor.groupId);

      res.json({ success: true, data: { ...monitor, inMaintenance } });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { rest: data, timing } = splitLegacyTiming(req.body as CreateMonitorInput);
      assertScriptChangeAllowed(req, data, null);
      await assertGroupWritable(req, data.groupId);
      await assertProxyAllowed(req, data.proxyAgentDeviceId, null);
      const monitor = await monitorService.create(data, req.session.userId!, req.tenantId);
      // Before the worker starts: it resolves its timing from settings.
      await applyApiTiming(req, [monitor], timing);

      // Auto-assign RW to the creator's canCreate teams — of the monitor's
      // tenant only (teams are mono-tenant: a team of another tenant must
      // never get a grant on this tenant's monitor).
      if (req.session.role !== 'admin') {
        const userTeams = await teamService.getUserTeams(req.session.userId!);
        for (const team of userTeams) {
          if (team.canCreate && team.tenantId === monitor.tenantId) {
            await teamService.addPermission(team.id, 'monitor', monitor.id, 'rw');
          }
        }
      }

      // Start worker for this monitor (performs first check immediately)
      const wm = MonitorWorkerManager.getInstance();
      await wm.startMonitor(monitor);

      // If this monitor uses a proxy agent, sync the config to the agent.
      if (monitor.proxyAgentDeviceId) {
        agentHub.syncAllProxyMonitors().catch(() => {});
      }

      // Wait briefly for the first check to complete, then return updated monitor
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const updated = await monitorService.getById(monitor.id, monitor.tenantId);

      emitMonitorEvent(
        req, monitor.tenantId, await monitorAudience(monitor.id),
        SOCKET_EVENTS.MONITOR_CREATED, { monitor: updated ?? monitor },
      );
      res.status(201).json({ success: true, data: updated || monitor });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const split = splitLegacyTiming(req.body as UpdateMonitorInput);
      let data = split.rest;

      const current = await getMonitorInScope(req, id);
      assertScriptChangeAllowed(req, data, current);
      await assertProxyAllowed(req, data.proxyAgentDeviceId, current.proxyAgentDeviceId);
      // Users who could see it before the change (a move may hide it from some).
      const audienceBefore = await monitorAudience(id);
      // isActive of a device-backed agent monitor is never written directly:
      // a change suspends / reinstates the device (agents.manage, like pause).
      // An unchanged value (full-form save) is simply dropped.
      if (isDeviceBacked(current) && data.isActive !== undefined) {
        const { isActive, ...rest } = data;
        if (isActive !== current.isActive) {
          await assertCanManageAgentDevices(req);
          const result = await setAgentMonitorPaused(current, !isActive);
          if (result === null) {
            throw new AppError(409, 'The agent device is not approved — manage it from the agents page');
          }
        }
        data = rest;
      }
      if (data.groupId !== undefined && data.groupId !== current.groupId) {
        await assertGroupWritable(req, data.groupId);
      }

      const monitor = await monitorService.update(id, data, current.tenantId);

      if (!monitor) {
        throw new AppError(404, 'Monitor not found');
      }
      await applyApiTiming(req, [monitor], split.timing);

      // Restart worker with new config
      const wm = MonitorWorkerManager.getInstance();
      await wm.restartMonitor(id);

      // Sync proxy configs to agents (covers add, change, and remove of proxy assignment)
      agentHub.syncAllProxyMonitors().catch(() => {});

      emitMonitorEvent(
        req, monitor.tenantId, [...audienceBefore, ...(await monitorAudience(id))],
        SOCKET_EVENTS.MONITOR_UPDATED, { monitorId: id, changes: monitor },
      );
      res.json({ success: true, data: monitor });
    } catch (err) {
      next(err);
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const wm = MonitorWorkerManager.getInstance();

      // Agent monitor: delete the device (agentService stops the worker and
      // removes the agent monitor with it).
      const current = await getMonitorInScope(req, id);
      // Computed before the delete: the grants are gone afterwards.
      const audience = await monitorAudience(id);
      if (isDeviceBacked(current)) {
        await assertCanManageAgentDevices(req);
        const deviceDeleted = await agentService.deleteDevice(current.agentDeviceId);
        if (!deviceDeleted) {
          // Orphan row: the device is already gone — drop the monitor itself.
          await wm.stopMonitor(id);
          await monitorService.delete(id, current.tenantId);
        }
        agentHub.syncAllProxyMonitors().catch(() => {});
        emitMonitorEvent(req, current.tenantId, audience, SOCKET_EVENTS.MONITOR_DELETED, { monitorId: id });
        await auditService.logReq(req, 'monitor.deleted', {
          tenantId: current.tenantId,
          resourceType: 'monitor',
          resourceId: id,
          details: { name: current.name, type: current.type, agentDeviceId: current.agentDeviceId },
        });
        res.json({ success: true, message: 'Agent device deleted' });
        return;
      }

      // Stop worker before deleting
      await wm.stopMonitor(id);

      const deleted = await monitorService.delete(id, current.tenantId);
      if (!deleted) {
        throw new AppError(404, 'Monitor not found');
      }

      // Sync proxy configs so agents stop checking this monitor.
      agentHub.syncAllProxyMonitors().catch(() => {});

      emitMonitorEvent(req, current.tenantId, audience, SOCKET_EVENTS.MONITOR_DELETED, { monitorId: id });
      await auditService.logReq(req, 'monitor.deleted', {
        tenantId: current.tenantId,
        resourceType: 'monitor',
        resourceId: id,
        details: { name: current.name, type: current.type },
      });
      res.json({ success: true, message: 'Monitor deleted' });
    } catch (err) {
      next(err);
    }
  },

  async pause(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const monitor = await getMonitorInScope(req, id);

      let newStatus: 'paused' | 'pending';
      if (isDeviceBacked(monitor)) {
        // Agent monitor: suspend / reinstate the device so the pause is durable.
        await assertCanManageAgentDevices(req);
        const pause = !(await isAgentMonitorPaused(monitor));
        const result = await setAgentMonitorPaused(monitor, pause);
        if (result === null) {
          throw new AppError(409, 'The agent device is not approved — manage it from the agents page');
        }
        newStatus = result;
      } else {
        const wm = MonitorWorkerManager.getInstance();
        newStatus = monitor.status === 'paused' ? 'pending' : 'paused';
        await monitorService.updateStatus(id, newStatus, monitor.tenantId);

        if (newStatus === 'paused') {
          await wm.stopMonitor(id);
        } else {
          await wm.restartMonitor(id);
        }
      }

      // Proxy agents must stop (or resume) running this monitor's check.
      agentHub.syncAllProxyMonitors().catch(() => {});

      emitMonitorEvent(
        req, monitor.tenantId, await monitorAudience(id),
        SOCKET_EVENTS.MONITOR_PAUSED, { monitorId: id, isPaused: newStatus === 'paused' },
      );
      res.json({
        success: true,
        data: { id, status: newStatus },
      });
    } catch (err) {
      next(err);
    }
  },

  async bulkDelete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const monitorIds = await resolveBulkIds(req, (req.body as { monitorIds?: unknown })?.monitorIds);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        for (const mid of monitorIds) {
          const canWrite = await permissionService.canWriteMonitor(req.session.userId!, mid, false);
          if (!canWrite) throw new AppError(403, `No write permission on monitor ${mid}`);
        }
      }

      const tenantScope = getEffectiveTenantScope(req);
      const monitors = await monitorService.getByIds(monitorIds, tenantScope ?? undefined);
      // Computed before the delete: the grants are gone afterwards.
      const audiences = new Map<number, number[]>();
      for (const m of monitors) audiences.set(m.id, await monitorAudience(m.id));

      // Agent monitors are deleted through their device (agentService stops the
      // workers and removes the agent monitors with the devices).
      const agentMonitors = monitors.filter(isDeviceBacked);
      if (agentMonitors.length > 0) await assertCanManageAgentDevices(req);
      const agentMonitorIds = new Set(agentMonitors.map((m) => m.id));
      if (agentMonitors.length > 0) {
        await agentService.bulkDeleteDevices([...new Set(agentMonitors.map((m) => m.agentDeviceId))]);
      }

      const wm = MonitorWorkerManager.getInstance();
      for (const m of monitors) {
        if (!agentMonitorIds.has(m.id)) {
          await wm.stopMonitor(m.id);
          await monitorService.delete(m.id, m.tenantId);
        }
        emitMonitorEvent(req, m.tenantId, audiences.get(m.id) ?? [], SOCKET_EVENTS.MONITOR_DELETED, { monitorId: m.id });
      }

      // Sync proxy configs so agents stop checking the deleted monitors.
      agentHub.syncAllProxyMonitors().catch(() => {});

      // One row per tenant (the god view may delete across workspaces).
      const byTenant = new Map<number, Array<{ id: number; name: string }>>();
      for (const m of monitors) {
        const mTenantId = m.tenantId ?? req.tenantId;
        const list = byTenant.get(mTenantId) ?? [];
        list.push({ id: m.id, name: m.name });
        byTenant.set(mTenantId, list);
      }
      for (const [tenantId, deletedMonitors] of byTenant) {
        await auditService.logReq(req, 'monitor.bulk_deleted', {
          tenantId,
          resourceType: 'monitor',
          details: { count: deletedMonitors.length, monitors: deletedMonitors },
        });
      }

      res.json({ success: true, message: `${monitors.length} monitor(s) deleted` });
    } catch (err) {
      next(err);
    }
  },

  async bulkPause(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { pause } = req.body as { pause: boolean };
      const monitorIds = await resolveBulkIds(req, (req.body as { monitorIds?: unknown })?.monitorIds);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        for (const mid of monitorIds) {
          const canWrite = await permissionService.canWriteMonitor(req.session.userId!, mid, false);
          if (!canWrite) throw new AppError(403, `No write permission on monitor ${mid}`);
        }
      }

      const tenantScope = getEffectiveTenantScope(req);
      const monitors = await monitorService.getByIds(monitorIds, tenantScope ?? undefined);

      // Agent monitors are paused / resumed through their device (suspend / reinstate).
      const agentMonitors = new Map(monitors.filter(isDeviceBacked).map((m) => [m.id, m]));
      if (agentMonitors.size > 0) await assertCanManageAgentDevices(req);

      const wm = MonitorWorkerManager.getInstance();
      const newStatus = pause ? 'paused' : 'pending';

      for (const m of monitors) {
        const agentMonitor = agentMonitors.get(m.id);
        if (agentMonitor) {
          // Devices that are neither approved nor suspended are left untouched.
          const result = await setAgentMonitorPaused(agentMonitor, pause);
          if (result === null) continue;
        } else {
          await monitorService.updateStatus(m.id, newStatus, m.tenantId);
          if (pause) {
            await wm.stopMonitor(m.id);
          } else {
            await wm.restartMonitor(m.id);
          }
        }
        emitMonitorEvent(
          req, m.tenantId, await monitorAudience(m.id),
          SOCKET_EVENTS.MONITOR_PAUSED, { monitorId: m.id, isPaused: pause },
        );
      }

      // Proxy agents must stop (or resume) running these monitors' checks.
      agentHub.syncAllProxyMonitors().catch(() => {});

      res.json({ success: true, message: `${monitors.length} monitor(s) ${pause ? 'paused' : 'resumed'}` });
    } catch (err) {
      next(err);
    }
  },

  async bulkUpdate(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { monitorIds: rawIds, changes: rawChanges } = req.body as BulkUpdateInput;
      const monitorIds = await resolveBulkIds(req, rawIds);
      const { rest: changes, timing } = splitLegacyTiming(rawChanges);
      const tenantScope = getEffectiveTenantScope(req);

      // Check write permission on all monitors
      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        for (const mid of monitorIds) {
          const canWrite = await permissionService.canWriteMonitor(req.session.userId!, mid, false);
          if (!canWrite) throw new AppError(403, `No write permission on monitor ${mid}`);
        }

        // Script-related fields are platform-admin only (checked per monitor)
        if (changes.type !== undefined || changes.scriptCommand !== undefined || changes.proxyAgentDeviceId !== undefined) {
          const currents = await monitorService.getByIds(monitorIds, tenantScope ?? undefined);
          for (const current of currents) assertScriptChangeAllowed(req, changes, current);
        }
        await assertGroupWritable(req, changes.groupId);
      }

      // Proxy agent assignment: same entitlement as a single update, checked
      // once when at least one monitor would change device.
      if (changes.proxyAgentDeviceId) {
        const currents = await monitorService.getByIds(monitorIds, tenantScope ?? undefined);
        if (currents.some((c) => (c.proxyAgentDeviceId ?? null) !== changes.proxyAgentDeviceId)) {
          await assertProxyAllowed(req, changes.proxyAgentDeviceId, null);
        }
      }

      // Users who could see the monitors before the change (a move may hide
      // them from some).
      const audiencesBefore = new Map<number, number[]>();
      for (const mid of monitorIds) audiencesBefore.set(mid, await monitorAudience(mid));

      // isActive of device-backed agent monitors goes through their device
      // (suspend / reinstate, agents.manage) and is never written on the row.
      let applied = changes;
      if (changes.isActive !== undefined) {
        const agentMonitors = (await monitorService.getByIds(monitorIds, tenantScope ?? undefined)).filter(isDeviceBacked);
        if (agentMonitors.length > 0) {
          await assertCanManageAgentDevices(req);
          for (const m of agentMonitors) {
            if (m.isActive !== changes.isActive) await setAgentMonitorPaused(m, !changes.isActive);
          }
          const agentIds = new Set(agentMonitors.map((m) => m.id));
          const { isActive, ...rest } = changes;
          applied = rest;
          const otherIds = monitorIds.filter((mid) => !agentIds.has(mid));
          if (otherIds.length > 0) await monitorService.bulkUpdate(otherIds, { isActive }, tenantScope);
        }
      }

      const monitors = await monitorService.bulkUpdate(monitorIds, applied, tenantScope);
      await applyApiTiming(req, monitors, timing);

      // Restart all affected workers
      const wm = MonitorWorkerManager.getInstance();
      await wm.restartMonitors(monitorIds);

      // Sync proxy configs (covers proxy assignment and check-config changes)
      agentHub.syncAllProxyMonitors().catch(() => {});

      for (const m of monitors) {
        emitMonitorEvent(
          req, m.tenantId, [...(audiencesBefore.get(m.id) ?? []), ...(await monitorAudience(m.id))],
          SOCKET_EVENTS.MONITOR_UPDATED, { monitorId: m.id, changes: m },
        );
      }
      res.json({ success: true, data: monitors });
    } catch (err) {
      next(err);
    }
  },

  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const monitorId = parseInt(req.params.id, 10);
      const period = (req.query.period as string) || '24h';

      await getMonitorInScope(req, monitorId);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadMonitor(req.session.userId!, monitorId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      const since = new Date();
      switch (period) {
        case '1h': since.setHours(since.getHours() - 1); break;
        case '24h': since.setHours(since.getHours() - 24); break;
        case '7d': since.setDate(since.getDate() - 7); break;
        case '30d': since.setDate(since.getDate() - 30); break;
        case '365d': since.setDate(since.getDate() - 365); break;
        default: since.setHours(since.getHours() - 24);
      }

      const stats = await heartbeatService.getStats(monitorId, since);
      res.json({ success: true, data: { ...stats, period } });
    } catch (err) {
      next(err);
    }
  },

  async summary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const since = new Date();
      since.setHours(since.getHours() - 24);

      // Restrict the aggregate to monitors the user can actually see. This
      // both plugs a cross-tenant data leak (any user was receiving uptime %
      // + avg RT for every monitor in every tenant) and lets Postgres drive
      // the per-monitor index range scan instead of full-scanning the whole
      // heartbeats table on every 60 s dashboard poll.
      const monitorIds = await resolveScopedMonitorIds(req);

      const statsMap = await heartbeatService.getStatsForAllMonitors(since, monitorIds);
      const data: Record<number, { uptimePct: number; avgResponseTime: number | null }> = {};
      for (const [id, s] of statsMap) {
        data[id] = s;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  /**
   * GET /monitors/uptime-series?period=24h|7d|14d|30d — average uptime % of
   * the caller's visible monitors (agents excluded) per hour (24h) or per
   * day (7d / 14d / 30d), scoped exactly like summary().
   */
  async uptimeSeries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const period = (typeof req.query.period === 'string' ? req.query.period : '24h') as UptimeSeriesPeriod;
      const cfg = UPTIME_SERIES_WINDOWS.get(period);
      if (!cfg) {
        throw new AppError(400, 'period must be one of 24h, 7d, 14d, 30d', 'INVALID_PERIOD');
      }

      const monitorIds = await resolveScopedMonitorIds(req);
      const data = await heartbeatService.getUptimeSeries(
        monitorIds, cfg.bucket, cfg.buckets, getEffectiveTenantScope(req) ?? null,
      );
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async allHeartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const count = parseInt(req.query.count as string, 10) || 50;
      const clampedCount = Math.min(Math.max(count, 1), 300);

      // Resolve the concrete monitor id list to push into SQL — the previous
      // implementation window-numbered the whole heartbeats table then
      // filtered in JS, degrading to a full scan on any real install.
      const monitorIds = await resolveScopedMonitorIds(req);

      const allMap = await heartbeatService.getRecentForAllMonitors(monitorIds, clampedCount);

      const data: Record<number, Heartbeat[]> = {};
      for (const [id, hbs] of allMap) {
        data[id] = hbs;
      }

      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  async heartbeats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const monitorId = parseInt(req.params.id, 10);
      const period = req.query.period as string | undefined;

      await getMonitorInScope(req, monitorId);

      const isAdmin = req.session.role === 'admin';
      if (!isAdmin) {
        const canRead = await permissionService.canReadMonitor(req.session.userId!, monitorId, false);
        if (!canRead) throw new AppError(403, 'Access denied');
      }

      // Custom range (zoom): ?from=<ISO>&to=<ISO>
      const fromStr = req.query.from as string | undefined;
      const toStr   = req.query.to   as string | undefined;
      if (fromStr && toStr) {
        const fromDate = new Date(fromStr);
        const toDate   = new Date(toStr);
        if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
          const heartbeats = await heartbeatService.getByMonitorRange(monitorId, fromDate, toDate, 500);
          res.json({ success: true, data: heartbeats });
          return;
        }
      }

      if (period) {
        // Period-based fetch with downsampling
        const since = new Date();
        switch (period) {
          case '1h': since.setHours(since.getHours() - 1); break;
          case '24h': since.setHours(since.getHours() - 24); break;
          case '7d': since.setDate(since.getDate() - 7); break;
          case '30d': since.setDate(since.getDate() - 30); break;
          case '365d': since.setDate(since.getDate() - 365); break;
          default: since.setHours(since.getHours() - 24);
        }
        const heartbeats = await heartbeatService.getByMonitorSince(monitorId, since, 500);
        res.json({ success: true, data: heartbeats });
        return;
      }

      // Legacy pagination-based fetch
      const limit = parseInt(req.query.limit as string, 10) || 100;
      const offset = parseInt(req.query.offset as string, 10) || 0;
      const heartbeats = await heartbeatService.getByMonitor(monitorId, limit, offset);
      res.json({ success: true, data: heartbeats });
    } catch (err) {
      next(err);
    }
  },
};
