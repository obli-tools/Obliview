import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';
import { getEffectiveTenantScope } from '../utils/tenantScope';

/**
 * Agents inside the team model.
 *
 * An agent device is reached through its `type='agent'` monitor
 * (monitors.agent_device_id): team permissions on that monitor (direct, or
 * inherited from its group through the closure table) decide who may open the
 * device (RO) and edit its per-device presentation (RW: notes, display config,
 * sensor names, thresholds). Lifecycle and tenant-wide operations (approval,
 * suspension, deletion, commands, group moves, heartbeat/interval settings)
 * need the `agents.manage` tenant capability instead.
 *
 * Platform admins always pass, but only inside their current workspace unless
 * they are in the God View (master tenant): a device of another workspace
 * answers 404, exactly like a missing one.
 */

/** Tenant capability that unlocks agent lifecycle / fleet management. */
export const AGENTS_MANAGE_CAPABILITY = 'agents.manage';

export interface AgentDeviceAccess {
  deviceId: number;
  tenantId: number;
  /** The device's agent monitor (null for a pending/refused device without one). */
  monitorId: number | null;
  /** RW on the agent monitor (or agents.manage / platform admin). */
  canWrite: boolean;
  /** Platform admin or agents.manage in the device's workspace. */
  canManage: boolean;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAgentDeviceRead / requireAgentDeviceWrite. */
      agentAccess?: AgentDeviceAccess;
    }
  }
}

const MAX_PG_INT = 2_147_483_647;

// One capability lookup per request, however many checks ask for it.
const manageCache = new WeakMap<Request, Promise<boolean>>();

/**
 * True when the caller may manage the agents of the current workspace:
 * platform admin, or the `agents.manage` capability of their tenant role
 * (tenant role 'admin' short-circuits inside permissionService).
 * Must run after requireAuth + requireTenant.
 */
export function canManageAgents(req: Request): Promise<boolean> {
  if (req.session.role === 'admin') return Promise.resolve(true);
  let p = manageCache.get(req);
  if (!p) {
    const userId = req.session.userId;
    p = userId
      ? permissionService.userHasTenantCapability(userId, req.tenantId, AGENTS_MANAGE_CAPABILITY)
      : Promise.resolve(false);
    manageCache.set(req, p);
  }
  return p;
}

function parseDeviceId(raw: string | undefined): number | null {
  if (!/^\d+$/.test(raw ?? '')) return null;
  const id = parseInt(raw as string, 10);
  return id > 0 && id <= MAX_PG_INT ? id : null;
}

/**
 * Resolve the caller's access to a device. Throws 400 (bad id), 404 (missing
 * or outside the caller's tenant scope) or 403 (no team access).
 */
async function resolveAgentDeviceAccess(
  req: Request,
  rawId: string | undefined,
  need: 'read' | 'write',
): Promise<AgentDeviceAccess> {
  const deviceId = parseDeviceId(rawId);
  if (deviceId === null) throw new AppError(400, 'Invalid device ID');

  const device = await db('agent_devices')
    .where({ id: deviceId })
    .select('id', 'tenant_id')
    .first() as { id: number; tenant_id: number } | undefined;
  const scope = getEffectiveTenantScope(req);
  if (!device || (scope !== null && device.tenant_id !== scope)) {
    throw new AppError(404, 'Device not found');
  }

  const monitor = await db('monitors')
    .where({ agent_device_id: deviceId, type: 'agent' })
    .orderBy('id')
    .select('id')
    .first() as { id: number } | undefined;
  const monitorId = monitor?.id ?? null;
  const base = { deviceId, tenantId: device.tenant_id, monitorId };

  // Outside the God View the device tenant equals req.tenantId here, so the
  // capability lookup below is made against the device's own workspace.
  if (await canManageAgents(req)) {
    return { ...base, canWrite: true, canManage: true };
  }

  // Team access goes through the agent monitor: a device without one
  // (pending / refused) is only visible to agent managers.
  if (monitorId === null) throw new AppError(403, 'Insufficient permissions');
  const level = await permissionService.getMonitorPermission(req.session.userId!, monitorId, false);
  if (level === null || (need === 'write' && level !== 'rw')) {
    throw new AppError(403, 'Insufficient permissions');
  }
  return { ...base, canWrite: level === 'rw', canManage: false };
}

function agentDeviceGuard(need: 'read' | 'write', param: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.session?.userId) return next(new AppError(401, 'Authentication required'));
      req.agentAccess = await resolveAgentDeviceAccess(req, req.params[param], need);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Read access to an agent device (`req.params[param]` = agent_devices.id):
 * platform admin / agents.manage, or at least RO on its agent monitor.
 * Must be applied after requireAuth + requireTenant. Sets req.agentAccess.
 */
export function requireAgentDeviceRead(param = 'id') {
  return agentDeviceGuard('read', param);
}

/**
 * Write access to an agent device: platform admin / agents.manage, or RW on
 * its agent monitor. Lifecycle fields are checked on top of this by the
 * controller (req.agentAccess.canManage). Sets req.agentAccess.
 */
export function requireAgentDeviceWrite(param = 'id') {
  return agentDeviceGuard('write', param);
}

/**
 * Whether a user may route monitor checks through an agent device (proxy):
 * the device must be an approved device of `tenantId`, and the user a
 * platform admin, an agents.manage holder of that tenant, or RW on the
 * device's agent monitor. Used by GET /agent/proxy-candidates and meant for
 * the monitor create/update checks on proxyAgentDeviceId.
 */
export async function canUseAgentAsProxy(
  userId: number,
  isPlatformAdmin: boolean,
  tenantId: number,
  deviceId: number,
): Promise<boolean> {
  const device = await db('agent_devices')
    .where({ id: deviceId, tenant_id: tenantId, status: 'approved' })
    .select('id')
    .first();
  if (!device) return false;
  if (isPlatformAdmin) return true;
  if (await permissionService.userHasTenantCapability(userId, tenantId, AGENTS_MANAGE_CAPABILITY)) return true;
  const monitor = await db('monitors')
    .where({ agent_device_id: deviceId, type: 'agent', tenant_id: tenantId })
    .orderBy('id')
    .select('id')
    .first() as { id: number } | undefined;
  if (!monitor) return false;
  return (await permissionService.getMonitorPermission(userId, monitor.id, false)) === 'rw';
}
