import type { Request } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';

/**
 * Resolve the tenant scope for a listing request:
 *   - Platform admin (users.role='admin') connected to the master tenant
 *     → null = cross-tenant fan-out (God View).
 *   - Anyone else → req.tenantId, scoped to the active tenant.
 *
 * Service-layer list methods should accept `number | null` for their
 * `tenantId` parameter and skip the `WHERE tenant_id = ?` clause when null.
 *
 * Must be called after `requireAuth` + `requireTenant` have populated the
 * session and req.tenantId.
 */
export function getEffectiveTenantScope(req: Request): number | null {
  if (req.session?.role === 'admin' && isMasterTenant(req.tenantId)) {
    return null;
  }
  return req.tenantId;
}

/**
 * Same as above but typed as `boolean` — handy when a controller only needs
 * to branch on whether it's a God View call.
 */
export function isGodView(req: Request): boolean {
  return req.session?.role === 'admin' && isMasterTenant(req.tenantId);
}

/**
 * Tenant gate for by-id routes ("WHERE id AND tenant_id"): an entity is reachable only from its own tenant, or from the
 * God View (platform admin on the master tenant). Applies to admins and
 * non-admins alike — a platform admin working in child tenant B must not read
 * or write tenant A objects by id.
 *
 * Throws a 404 (never 403) so the check cannot be used to probe other
 * tenants' ids.
 */
export function assertInScope(
  req: Request,
  entityTenantId: number | null | undefined,
  msg = 'Not found',
): void {
  if (isGodView(req)) return;
  if (entityTenantId == null || entityTenantId !== req.tenantId) {
    throw new AppError(404, msg);
  }
}
