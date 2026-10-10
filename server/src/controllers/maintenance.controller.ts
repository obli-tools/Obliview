import type { Request, Response } from 'express';
import { maintenanceService, isWindowActive } from '../services/maintenance.service';
import type { CreateMaintenanceWindowRequest, UpdateMaintenanceWindowRequest, MaintenanceScopeType } from '@obliview/shared';
import { db } from '../db';
import { getEffectiveTenantScope, isGodView, assertInScope } from '../utils/tenantScope';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function enrichWindow(w: Awaited<ReturnType<typeof maintenanceService.getById>>) {
  if (!w) return null;
  const now = new Date();
  const isActiveNow = isWindowActive(w, now);

  // Resolve scope name
  let scopeName: string;
  if (w.scopeType === 'global') {
    scopeName = 'Global';
  } else {
    scopeName = `#${w.scopeId}`;
    try {
      if (w.scopeType === 'group') {
        const row = await db('monitor_groups').where({ id: w.scopeId }).select('name').first();
        if (row) scopeName = row.name;
      } else if (w.scopeType === 'monitor') {
        const row = await db('monitors').where({ id: w.scopeId }).select('name').first();
        if (row) scopeName = row.name;
      } else if (w.scopeType === 'agent') {
        const row = await db('agent_devices').where({ id: w.scopeId }).select('name', 'hostname').first();
        if (row) scopeName = row.name ?? row.hostname;
      }
    } catch { /* ignore */ }
  }

  return { ...w, isActiveNow, scopeName };
}

/** God view = platform admin on the master tenant (getEffectiveTenantScope → null). */
function isGodViewRequest(req: Request): boolean {
  return getEffectiveTenantScope(req) === null;
}

/** Validation failure carrying an HTTP status (mapped by each handler). */
class ScopeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Tenant a window with this scope belongs to.
 *  - global → `fallbackTenantId` (the active tenant on create, the window's
 *    own tenant on update);
 *  - group / monitor / agent → the entity's tenant. An entity of another
 *    tenant than the active one is a 404, except in the god view where the
 *    window is stored under the entity's own tenant.
 */
async function resolveWindowTenant(
  req: Request,
  scopeType: MaintenanceScopeType,
  scopeId: number | null | undefined,
  fallbackTenantId: number,
): Promise<number> {
  if (scopeType === 'global') return fallbackTenantId;
  if (!['group', 'monitor', 'agent'].includes(scopeType)) {
    throw new ScopeError(400, 'scopeType must be global, group, monitor or agent');
  }
  if (!scopeId) throw new ScopeError(400, 'scopeId is required for non-global windows');

  const entityTenantId = await maintenanceService.getScopeTenantId(scopeType as 'group' | 'monitor' | 'agent', Number(scopeId));
  if (entityTenantId === null) throw new ScopeError(404, 'Scope not found');
  if (!isGodViewRequest(req) && entityTenantId !== req.tenantId) {
    throw new ScopeError(404, 'Scope not found');
  }
  return entityTenantId;
}

/** Reject notify channels that are neither owned by nor shared to the window tenant. */
async function assertChannelsUsable(channelIds: number[] | undefined, tenantId: number): Promise<void> {
  if (!channelIds || channelIds.length === 0) return;
  if (!Array.isArray(channelIds) || channelIds.some((id) => !Number.isInteger(id))) {
    throw new ScopeError(400, 'notifyChannelIds must be an array of channel ids');
  }
  const foreign = await maintenanceService.getForeignChannelIds(channelIds, tenantId);
  if (foreign.length > 0) {
    throw new ScopeError(400, `Notification channel(s) not available in this workspace: ${foreign.join(', ')}`);
  }
}

// ── Controllers ───────────────────────────────────────────────────────────────

export const maintenanceController = {
  async list(req: Request, res: Response) {
    try {
      const { scopeType, scopeId } = req.query;
      const filters: { scopeType?: string; scopeId?: number } = {};
      if (typeof scopeType === 'string') filters.scopeType = scopeType;
      if (typeof scopeId === 'string') filters.scopeId = Number(scopeId);

      const windows = await maintenanceService.list(getEffectiveTenantScope(req), filters);
      const enriched = await Promise.all(windows.map(enrichWindow));
      return res.json({ success: true, data: enriched });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  async getById(req: Request, res: Response) {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ success: false, error: 'Not found' });
      // WHERE id AND tenant_id (god view: any tenant) — another tenant's window is a 404
      const window = await maintenanceService.getById(id, getEffectiveTenantScope(req));
      if (!window) return res.status(404).json({ success: false, error: 'Not found' });
      const enriched = await enrichWindow(window);
      return res.json({ success: true, data: enriched });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  async create(req: Request, res: Response) {
    try {
      const body: CreateMaintenanceWindowRequest = req.body;

      if (!body.name || !body.scopeType || !body.scheduleType) {
        return res.status(400).json({ success: false, error: 'name, scopeType and scheduleType are required' });
      }
      // scopeId is required for non-global scope types
      if (body.scopeType !== 'global' && !body.scopeId) {
        return res.status(400).json({ success: false, error: 'scopeId is required for non-global windows' });
      }
      if (body.scheduleType === 'one_time' && (!body.startAt || !body.endAt)) {
        return res.status(400).json({ success: false, error: 'startAt and endAt are required for one-time windows' });
      }
      if (body.scheduleType === 'recurring' && (!body.startTime || !body.endTime || !body.recurrenceType)) {
        return res.status(400).json({ success: false, error: 'startTime, endTime and recurrenceType are required for recurring windows' });
      }

      // The scope entity must belong to the active tenant (god view: the window
      // is stored under the entity's tenant), and notify channels must be
      // usable by that tenant.
      const windowTenantId = await resolveWindowTenant(req, body.scopeType, body.scopeId, req.tenantId);
      await assertChannelsUsable(body.notifyChannelIds, windowTenantId);

      const created = await maintenanceService.create({
        tenantId: windowTenantId,
        name: body.name,
        scopeType: body.scopeType,
        scopeId: body.scopeType === 'global' ? null : (body.scopeId ?? null),
        scheduleType: body.scheduleType,
        startAt: body.startAt ?? null,
        endAt: body.endAt ?? null,
        startTime: body.startTime ?? null,
        endTime: body.endTime ?? null,
        recurrenceType: body.recurrenceType ?? null,
        daysOfWeek: body.daysOfWeek ?? null,
        timezone: body.timezone ?? 'UTC',
        notifyChannelIds: body.notifyChannelIds ?? [],
        lastNotifiedStartAt: null,
        lastNotifiedEndAt: null,
        active: body.active ?? true,
      });

      await auditService.logReq(req, 'maintenance.window_created', {
        tenantId: windowTenantId,
        resourceType: 'maintenance_window',
        resourceId: created.id,
        details: { name: created.name, scopeType: created.scopeType, scopeId: created.scopeId, scheduleType: created.scheduleType },
      });

      const enriched = await enrichWindow(created);
      return res.status(201).json({ success: true, data: enriched });
    } catch (err) {
      if (err instanceof ScopeError) {
        return res.status(err.status).json({ success: false, error: err.message });
      }
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  async update(req: Request, res: Response) {
    try {
      const id = Number(req.params.id);
      const body: UpdateMaintenanceWindowRequest = req.body;

      if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ success: false, error: 'Not found' });
      const tenantScope = getEffectiveTenantScope(req);
      const existing = await maintenanceService.getById(id, tenantScope);
      const existingTenantId = existing ? await maintenanceService.getWindowTenantId(id) : null;
      if (!existing || existingTenantId === null) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      assertInScope(req, existingTenantId, 'Not found');

      // Effective scope after the patch: re-validate it when it changes, and
      // the notify channels against the (possibly new) window tenant.
      const nextScopeType = body.scopeType ?? existing.scopeType;
      const nextScopeId = body.scopeId !== undefined ? body.scopeId : existing.scopeId;
      const scopeChanged = body.scopeType !== undefined || body.scopeId !== undefined;
      const windowTenantId = scopeChanged
        ? await resolveWindowTenant(req, nextScopeType, nextScopeId, existingTenantId)
        : existingTenantId;
      await assertChannelsUsable(
        body.notifyChannelIds ?? (windowTenantId !== existingTenantId ? existing.notifyChannelIds : undefined),
        windowTenantId,
      );

      const updated = await maintenanceService.update(id, {
        ...(windowTenantId !== existingTenantId ? { tenantId: windowTenantId } : {}),
        name: body.name,
        scopeType: body.scopeType,
        scopeId: body.scopeType === 'global' ? null : body.scopeId,
        scheduleType: body.scheduleType,
        startAt: body.startAt,
        endAt: body.endAt,
        startTime: body.startTime,
        endTime: body.endTime,
        recurrenceType: body.recurrenceType,
        daysOfWeek: body.daysOfWeek,
        timezone: body.timezone,
        notifyChannelIds: body.notifyChannelIds,
        active: body.active,
      }, tenantScope);
      if (!updated) return res.status(404).json({ success: false, error: 'Not found' });
      await auditService.logReq(req, 'maintenance.window_updated', {
        tenantId: windowTenantId,
        resourceType: 'maintenance_window',
        resourceId: id,
        details: { name: updated.name, fields: Object.keys(body ?? {}) },
      });

      const enriched = await enrichWindow(updated);
      return res.json({ success: true, data: enriched });
    } catch (err) {
      if (err instanceof ScopeError) {
        return res.status(err.status).json({ success: false, error: err.message });
      }
      if (err instanceof AppError) {
        return res.status(err.statusCode).json({ success: false, error: err.message });
      }
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  async delete(req: Request, res: Response) {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ success: false, error: 'Not found' });
      // WHERE id AND tenant_id (god view: any tenant)
      const tenantScope = getEffectiveTenantScope(req);
      const before = await maintenanceService.getById(id, tenantScope);
      const windowTenantId = before ? await maintenanceService.getWindowTenantId(id) : null;
      const deleted = await maintenanceService.delete(id, tenantScope);
      if (!deleted) return res.status(404).json({ success: false, error: 'Not found' });
      await auditService.logReq(req, 'maintenance.window_deleted', {
        tenantId: windowTenantId ?? req.tenantId,
        resourceType: 'maintenance_window',
        resourceId: id,
        details: { name: before?.name ?? null },
      });
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  /**
   * GET /maintenance/effective/:type/:id
   * Returns all effective windows (local + inherited) for a monitor, agent, or group.
   * Enriches each window with source, sourceName, isDisabledHere, canEdit, etc.
   */
  async getEffective(req: Request, res: Response) {
    try {
      const scopeType = req.params.type as 'monitor' | 'agent' | 'group';
      const scopeId = Number(req.params.id);

      if (!['monitor', 'agent', 'group'].includes(scopeType)) {
        return res.status(400).json({ success: false, error: 'type must be monitor, agent, or group' });
      }
      if (!Number.isInteger(scopeId) || scopeId <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid id' });
      }

      // The entity must belong to the active tenant (god view: any tenant);
      // its own tenant decides which global windows apply.
      const entityTenantId = await maintenanceService.getScopeTenantId(scopeType, scopeId);
      if (entityTenantId === null || (!isGodViewRequest(req) && entityTenantId !== req.tenantId)) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }

      // Resolve groupId for monitors and agents
      let groupId: number | null = null;
      if (scopeType === 'monitor') {
        const row = await db('monitors').where({ id: scopeId }).select('group_id').first();
        groupId = row?.group_id ?? null;
      } else if (scopeType === 'agent') {
        const row = await db('agent_devices').where({ id: scopeId }).select('group_id').first();
        groupId = row?.group_id ?? null;
      } else {
        // group: groupId = scopeId itself (used to find parent groups)
        groupId = scopeId;
      }

      const windows = await maintenanceService.getEffectiveWindows(scopeType, scopeId, groupId, entityTenantId);

      // Enrich sourceName for local windows (we know the scope name since we're on the detail page,
      // but keep it undefined to let the client use its own label — consistent with plan)
      const now = new Date();
      const enriched = windows.map((w) => ({
        ...w,
        isActiveNow: w.isActiveNow ?? isWindowActive(w, now),
      }));

      return res.json({ success: true, data: enriched });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  /**
   * POST /maintenance/:id/disable
   * Body: { scopeType: 'group'|'monitor'|'agent', scopeId: number }
   * Disables an inherited window at the given scope.
   */
  async disable(req: Request, res: Response) {
    try {
      const windowId = Number(req.params.id);
      const { scopeType, scopeId } = req.body as { scopeType: 'group' | 'monitor' | 'agent'; scopeId: number };

      if (!scopeType || !scopeId) {
        return res.status(400).json({ success: false, error: 'scopeType and scopeId are required' });
      }
      if (!['group', 'monitor', 'agent'].includes(scopeType)) {
        return res.status(400).json({ success: false, error: 'scopeType must be group, monitor, or agent' });
      }

      // The window must be visible in the active tenant (god view: any) and the
      // entity must belong to the window's tenant — otherwise a 404.
      const ok = Number.isInteger(windowId) && windowId > 0 && await maintenanceService.disableWindowForScope(
        windowId, scopeType, Number(scopeId), getEffectiveTenantScope(req),
      );
      if (!ok) return res.status(404).json({ success: false, error: 'Maintenance window not found' });
      await auditService.logReq(req, 'maintenance.window_disabled_for_scope', {
        resourceType: 'maintenance_window',
        resourceId: windowId,
        details: { scopeType, scopeId: Number(scopeId) },
      });
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },

  /**
   * DELETE /maintenance/:id/disable
   * Body: { scopeType: 'group'|'monitor'|'agent', scopeId: number }
   * Re-enables a previously disabled inherited window at the given scope.
   */
  async enable(req: Request, res: Response) {
    try {
      const windowId = Number(req.params.id);
      const { scopeType, scopeId } = req.body as { scopeType: 'group' | 'monitor' | 'agent'; scopeId: number };

      if (!scopeType || !scopeId) {
        return res.status(400).json({ success: false, error: 'scopeType and scopeId are required' });
      }
      if (!['group', 'monitor', 'agent'].includes(scopeType)) {
        return res.status(400).json({ success: false, error: 'scopeType must be group, monitor, or agent' });
      }

      // Same gate as disable: visible window + entity of the window's tenant.
      const ok = Number.isInteger(windowId) && windowId > 0 && await maintenanceService.enableWindowForScope(
        windowId, scopeType, Number(scopeId), getEffectiveTenantScope(req),
      );
      if (!ok) return res.status(404).json({ success: false, error: 'Maintenance window not found' });
      await auditService.logReq(req, 'maintenance.window_enabled_for_scope', {
        resourceType: 'maintenance_window',
        resourceId: windowId,
        details: { scopeType, scopeId: Number(scopeId) },
      });
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  },
};
