import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from './errorHandler';
import { permissionService } from '../services/permission.service';

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session?.userId) {
      next(new AppError(401, 'Authentication required'));
      return;
    }

    if (!roles.includes(req.session.role as UserRole)) {
      next(new AppError(403, 'Insufficient permissions'));
      return;
    }

    next();
  };
}

/**
 * Require write permission on a monitor (id from req.params.id).
 * Admins always pass. Non-admins need RW via their teams.
 */
export function requireMonitorWrite() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const monitorId = parseInt(req.params.id, 10);
      if (isNaN(monitorId)) return next(new AppError(400, 'Invalid monitor ID'));
      const canWrite = await permissionService.canWriteMonitor(req.session.userId!, monitorId, false);
      if (!canWrite) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require write permission on a group (id from req.params.id).
 */
export function requireGroupWrite() {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return next(new AppError(400, 'Invalid group ID'));
      const canWrite = await permissionService.canWriteGroup(req.session.userId!, groupId, false);
      if (!canWrite) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require canCreate on the ACTIVE tenant (for creating new monitors/groups):
 *   - the tenant capability (monitors.manage for monitors, groups.manage for
 *     groups) decides WHAT the user may do;
 *   - a can_create team of that tenant decides that the user may create at
 *     all (the new object is granted RW to those teams).
 * Platform admins always pass. Must be applied after requireTenant.
 */
export function requireCanCreate(capability: 'monitors.manage' | 'groups.manage') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      const userId = req.session.userId!;
      if (!req.tenantId) return next(new AppError(403, 'Insufficient permissions'));
      if (!(await permissionService.userHasTenantCapability(userId, req.tenantId, capability))) {
        return next(new AppError(403, `Missing capability: ${capability}`));
      }
      const canCreate = await permissionService.canCreate(userId, false, req.tenantId);
      if (!canCreate) return next(new AppError(403, 'Insufficient permissions'));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require a tenant-wide capability resolved from the active permission_set
 * attached to the user via user_tenants.role.
 *
 * Order of checks:
 *   1. Platform admins (users.role='admin') always pass — they sit above the
 *      tenant capability matrix.
 *   2. Tenant role='admin' short-circuits (see permission.service).
 *   3. Otherwise the capability must be present in the permission_set.
 *
 * Must be applied AFTER `requireAuth` and `requireTenant`.
 */
export function requireTenantCapability(capability: string) {
  return requireAnyTenantCapability(capability);
}

/**
 * Like requireTenantCapability, but passes when the user holds ANY of the
 * listed capabilities on the active tenant (or is a platform admin).
 */
export function requireAnyTenantCapability(...capabilities: string[]) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();
      if (!req.tenantId) return next(new AppError(403, 'Insufficient permissions'));
      for (const cap of capabilities) {
        if (await permissionService.userHasTenantCapability(req.session.userId!, req.tenantId, cap)) {
          return next();
        }
      }
      next(new AppError(403, `Missing capability: ${capabilities.join(' | ')}`));
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Require the caller to be a platform admin (users.role='admin').
 * This is the global, tenant-agnostic admin gate — distinct from a
 * tenant-scoped 'admin' role carried by user_tenants.
 */
export function requirePlatformAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.session.role !== 'admin') {
      next(new AppError(403, 'Platform admin required'));
      return;
    }
    next();
  };
}

/**
 * Require the active tenant to be the master tenant (God View). Combine with
 * requirePlatformAdmin() for endpoints that fan out across all tenants.
 */
export function requireMasterTenant() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!isMasterTenant(req.tenantId)) {
      next(new AppError(403, 'Master tenant required'));
      return;
    }
    next();
  };
}
