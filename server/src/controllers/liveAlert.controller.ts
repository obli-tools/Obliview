import type { Request, Response } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { liveAlertService } from '../services/liveAlert.service';
import type { MonitorVisibility } from '../services/liveAlert.service';
import { permissionService } from '../services/permission.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';

// Every handler is wrapped with asyncHandler in liveAlert.routes.ts: errors
// (AppError included) reach the global errorHandler.

function isPlatformAdmin(req: Request): boolean {
  return req.session.role === 'admin';
}

/**
 * Tenants whose alerts the caller may read / act on: null = every tenant
 * (platform admin in the god view, i.e. session on the master tenant).
 * Otherwise the user's memberships (no membership = the default tenant), plus
 * the session tenant for platform admins (they may be on any tenant).
 * Taken from the session, not req.tenantId: the cross-tenant routes do not
 * run requireTenant.
 */
async function accessibleTenantIds(req: Request): Promise<number[] | null> {
  const sessionTenantId = req.session.currentTenantId ?? null;
  if (isPlatformAdmin(req) && isMasterTenant(sessionTenantId)) return null;
  const ids = new Set(await permissionService._getUserTenantIds(req.session.userId!));
  if (isPlatformAdmin(req) && sessionTenantId) ids.add(sessionTenantId);
  return [...ids];
}

/** Monitors whose alerts the caller can see ('all' for platform admins). */
function visibleMonitors(req: Request): Promise<MonitorVisibility> {
  return permissionService.getVisibleMonitorIds(req.session.userId!, isPlatformAdmin(req));
}

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError(400, 'Invalid alert id');
  return id;
}

/** `?scope=all` asks for a hard delete (every user); platform admins only. */
function wantsHardDelete(req: Request): boolean {
  if (req.query.scope !== 'all') return false;
  if (!isPlatformAdmin(req)) throw new AppError(403, 'Only administrators can delete alerts for everyone');
  return true;
}

/** GET /api/live-alerts — current tenant, as seen by the caller */
export async function getAlerts(req: Request, res: Response): Promise<void> {
  const alerts = await liveAlertService.getForUser(
    req.session.userId!,
    [req.tenantId],
    await visibleMonitors(req),
    100,
  );
  res.json(alerts);
}

/**
 * GET /api/live-alerts/all — every tenant accessible to the caller (all
 * tenants in the god view). Returns { alerts, tenants }, alerts enriched
 * with tenantName.
 */
export async function getAllTenantAlerts(req: Request, res: Response): Promise<void> {
  const tenantIds = await accessibleTenantIds(req);
  const tenantsQuery = db('tenants').select('id', 'name').orderBy('id');
  if (tenantIds !== null) tenantsQuery.whereIn('id', tenantIds);
  const tenants = await tenantsQuery as { id: number; name: string }[];

  const alerts = await liveAlertService.getForUser(
    req.session.userId!,
    tenantIds,
    await visibleMonitors(req),
    200,
  );
  res.json({ alerts, tenants });
}

/** PATCH /api/live-alerts/:id/read — mark one alert read for the caller (cross-tenant) */
export async function markRead(req: Request, res: Response): Promise<void> {
  const id = parseId(req.params.id);
  const alert = await liveAlertService.findAccessible(id, await accessibleTenantIds(req), await visibleMonitors(req));
  if (!alert) throw new AppError(404, 'Alert not found');
  await liveAlertService.markRead(req.session.userId!, id);
  res.json({ ok: true });
}

/** POST /api/live-alerts/read-all — mark every visible alert of the current tenant read for the caller */
export async function markAllRead(req: Request, res: Response): Promise<void> {
  await liveAlertService.markAllRead(req.session.userId!, req.tenantId, await visibleMonitors(req));
  res.json({ ok: true });
}

/**
 * DELETE /api/live-alerts/:id — dismiss one alert for the caller (cross-tenant).
 * `?scope=all`: hard delete for everyone, platform admins only.
 */
export async function deleteAlert(req: Request, res: Response): Promise<void> {
  const id = parseId(req.params.id);
  const hard = wantsHardDelete(req);
  const alert = await liveAlertService.findAccessible(id, await accessibleTenantIds(req), await visibleMonitors(req));
  if (!alert) throw new AppError(404, 'Alert not found');
  if (hard) await liveAlertService.deleteAlert(id);
  else await liveAlertService.dismiss(req.session.userId!, id);
  res.json({ ok: true });
}

/**
 * DELETE /api/live-alerts — "Clear all": dismiss every visible alert of the
 * current tenant for the caller. `?scope=all`: hard delete of the tenant's
 * alerts for everyone, platform admins only.
 */
export async function clearAll(req: Request, res: Response): Promise<void> {
  if (wantsHardDelete(req)) await liveAlertService.clearAll(req.tenantId);
  else await liveAlertService.dismissAll(req.session.userId!, req.tenantId, await visibleMonitors(req));
  res.json({ ok: true });
}
