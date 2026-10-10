import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { settingsService } from '../services/settings.service';
import { permissionService } from '../services/permission.service';
import { MonitorWorkerManager } from '../workers/MonitorWorkerManager';
import { agentHub } from '../services/agentHub.service';
import type { SettingsScope } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { SETTINGS_KEYS } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import { getEffectiveTenantScope } from '../utils/tenantScope';
import type { SetSettingInput, SetSettingsBulkInput } from '../validators/settings.schema';

/** Body of PUT /settings/monitors/bulk (validated in settings.routes.ts). */
export interface MonitorsBulkSettingsInput {
  monitorIds: number[];
  overrides: Array<{ key: string; value: number }>;
  remove: string[];
}

const KNOWN_KEYS = new Set<string>(Object.values(SETTINGS_KEYS));

/**
 * Scope id of a scoped route. Routes name it `:id` (so requireMonitorWrite /
 * requireGroupWrite read it); the global scope has none (`/global/:id` carries
 * the legacy `null` placeholder and is ignored).
 */
function parseScopeId(req: Request, scope: SettingsScope): number | null {
  if (scope === 'global') return null;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) throw new AppError(400, scope === 'group' ? 'Invalid group ID' : 'Invalid monitor ID');
  return id;
}

/**
 * Tenant whose settings rows a request reads or writes.
 *  - global → the active tenant (workspace defaults);
 *  - group / monitor → the entity's tenant. An entity of another tenant is a
 *    404, except in the god view where the entity's own tenant is used.
 */
async function resolveTargetTenant(req: Request, scope: SettingsScope, scopeId: number | null): Promise<number> {
  if (scope === 'global' || scopeId === null) return req.tenantId;

  const entityTenantId = await settingsService.getScopeTenantId(scope, scopeId);
  const notFound = scope === 'group' ? 'Group not found' : 'Monitor not found';
  if (entityTenantId === null) throw new AppError(404, notFound);

  const tenantScope = getEffectiveTenantScope(req);
  if (tenantScope !== null && entityTenantId !== tenantScope) {
    throw new AppError(404, notFound);
  }
  return entityTenantId;
}

/**
 * Read access to a group / monitor (resolved views). Platform admins always
 * pass; others need RO or RW through their teams (or a general group).
 * Called after resolveTargetTenant so a foreign entity stays a 404.
 */
async function assertCanRead(req: Request, scope: 'group' | 'monitor', scopeId: number): Promise<void> {
  if (req.session.role === 'admin') return;
  const userId = req.session.userId!;
  const canRead = scope === 'monitor'
    ? await permissionService.canReadMonitor(userId, scopeId, false)
    : await permissionService.canReadGroup(userId, scopeId, false);
  if (!canRead) throw new AppError(403, 'Insufficient permissions');
}

/** Validation errors thrown by settingsService → 400 with their message. */
function toClientError(err: unknown): unknown {
  if (err instanceof Error && !(err instanceof AppError) && (
    err.message.includes('must be between') ||
    err.message.includes('must be at least') ||
    err.message.includes('Unknown setting') ||
    err.message.includes('admin policy')
  )) {
    return new AppError(400, err.message);
  }
  return err;
}

/**
 * Proxy agents receive their monitors' timing in their config push: re-sync
 * them after a settings change (fire-and-forget, like monitors.controller).
 */
function syncProxyAgents(): void {
  agentHub.syncAllProxyMonitors().catch(() => {});
}

function emitSettingsUpdated(req: Request, tenantId: number, payload: Record<string, unknown>): void {
  const io = req.app.get('io');
  if (io) {
    io.to(`tenant:${tenantId}:admin`).emit('settings:updated', payload);
  }
}

export const settingsController = {
  // GET /api/settings/global/resolved
  async getGlobalResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await settingsService.resolveGlobal(req.tenantId);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/settings/group/:id/resolved
  async getGroupResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = parseScopeId(req, 'group')!;
      const tenantId = await resolveTargetTenant(req, 'group', groupId);
      await assertCanRead(req, 'group', groupId);
      const result = await settingsService.resolveForGroup(groupId, tenantId);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/settings/monitor/:id/resolved
  // → { resolved, overrides, inherited }: `inherited` is the chain without the
  //   monitor's own overrides (placeholder of an empty override field).
  async getMonitorResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const monitorId = parseScopeId(req, 'monitor')!;

      // Need the monitor's group_id
      const monitor = await db('monitors').where({ id: monitorId }).select('group_id').first() as
        { group_id: number | null } | undefined;
      if (!monitor) throw new AppError(404, 'Monitor not found');

      const tenantId = await resolveTargetTenant(req, 'monitor', monitorId);
      await assertCanRead(req, 'monitor', monitorId);

      const [resolved, inherited, overrides] = await Promise.all([
        settingsService.resolveForMonitor(monitorId, monitor.group_id, tenantId),
        settingsService.resolveForMonitor(monitorId, monitor.group_id, tenantId, false),
        // Monitor-level overrides specifically
        settingsService.getByScope(tenantId, 'monitor', monitorId),
      ]);

      res.json({ success: true, data: { resolved, overrides, inherited } });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/settings/:scope/:id   (global: /global/null)
  set(scope: SettingsScope): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const scopeId = parseScopeId(req, scope);
        const { key, value } = req.body as SetSettingInput;
        const tenantId = await resolveTargetTenant(req, scope, scopeId);

        await settingsService.set(tenantId, scope, scopeId, key as SettingsKey, value);

        // Restart affected workers so they pick up the new settings immediately.
        void MonitorWorkerManager.getInstance().restartAffectedBySettings(scope, scopeId, tenantId);

        // Broadcast settings update to the admins of the entity's tenant
        emitSettingsUpdated(req, tenantId, { scope, scopeId, key, value });
        syncProxyAgents();

        res.json({ success: true, message: 'Setting saved' });
      } catch (err: unknown) {
        next(toClientError(err));
      }
    };
  },

  // PUT /api/settings/:scope/:id/bulk
  setBulk(scope: SettingsScope): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const scopeId = parseScopeId(req, scope);
        const { overrides } = req.body as SetSettingsBulkInput;
        const tenantId = await resolveTargetTenant(req, scope, scopeId);

        await settingsService.setBulk(
          tenantId,
          scope,
          scopeId,
          overrides.map((o) => ({ key: o.key as SettingsKey, value: o.value })),
        );

        // Restart affected workers so they pick up the new settings immediately.
        void MonitorWorkerManager.getInstance().restartAffectedBySettings(scope, scopeId, tenantId);

        emitSettingsUpdated(req, tenantId, { scope, scopeId, overrides });
        syncProxyAgents();

        res.json({ success: true, message: 'Settings saved' });
      } catch (err: unknown) {
        next(toClientError(err));
      }
    };
  },

  // DELETE /api/settings/:scope/:id/:key  (reset to inherited)
  remove(scope: SettingsScope): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const scopeId = parseScopeId(req, scope);
        const { key } = req.params;
        if (!KNOWN_KEYS.has(key)) throw new AppError(400, `Unknown setting key: ${key}`);
        const tenantId = await resolveTargetTenant(req, scope, scopeId);

        const deleted = await settingsService.remove(tenantId, scope, scopeId, key as SettingsKey);

        if (deleted) {
          // Restart affected workers so they pick up the reset (inherited) settings.
          void MonitorWorkerManager.getInstance().restartAffectedBySettings(scope, scopeId, tenantId);

          emitSettingsUpdated(req, tenantId, { scope, scopeId, key, removed: true });
          syncProxyAgents();
        }

        res.json({ success: true, message: deleted ? 'Setting reset to inherited' : 'No override found' });
      } catch (err) {
        next(err);
      }
    };
  },

  /**
   * PUT /api/settings/monitors/bulk  { monitorIds, overrides, remove }
   * Monitor-scope overrides on many monitors in one request (bulk edit). Every
   * monitor must exist in the active tenant (god view: any tenant) and be
   * writable by the caller; nothing is written otherwise.
   */
  async setMonitorsBulk(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { monitorIds, overrides, remove } = req.body as MonitorsBulkSettingsInput;
      const ids = [...new Set(monitorIds)];

      const rows = await db('monitors').whereIn('id', ids).select('id', 'tenant_id') as
        Array<{ id: number; tenant_id: number }>;
      const tenantById = new Map(rows.map((r) => [r.id, r.tenant_id]));
      const tenantScope = getEffectiveTenantScope(req);
      const isAdmin = req.session.role === 'admin';

      const targets: Array<{ monitorId: number; tenantId: number }> = [];
      for (const monitorId of ids) {
        const tenantId = tenantById.get(monitorId);
        if (tenantId === undefined || (tenantScope !== null && tenantId !== tenantScope)) {
          throw new AppError(404, `Monitor ${monitorId} not found`);
        }
        if (!isAdmin && !(await permissionService.canWriteMonitor(req.session.userId!, monitorId, false))) {
          throw new AppError(403, `No write permission on monitor ${monitorId}`);
        }
        targets.push({ monitorId, tenantId });
      }

      await settingsService.applyMonitorOverrides(
        targets,
        overrides.map((o) => ({ key: o.key as SettingsKey, value: o.value })),
        remove as SettingsKey[],
      );

      const wm = MonitorWorkerManager.getInstance();
      void (async () => {
        for (const { monitorId, tenantId } of targets) {
          await wm.restartAffectedBySettings('monitor', monitorId, tenantId);
        }
      })().catch(() => { /* a failed restart keeps the old config until the next one */ });

      const byTenant = new Map<number, number[]>();
      for (const { monitorId, tenantId } of targets) {
        const list = byTenant.get(tenantId);
        if (list) list.push(monitorId);
        else byTenant.set(tenantId, [monitorId]);
      }
      for (const [tenantId, tenantMonitorIds] of byTenant) {
        emitSettingsUpdated(req, tenantId, { scope: 'monitor', scopeIds: tenantMonitorIds, overrides, removed: remove });
      }

      syncProxyAgents();
      res.json({ success: true, message: 'Settings saved', data: { updated: targets.length } });
    } catch (err: unknown) {
      next(toClientError(err));
    }
  },
};
