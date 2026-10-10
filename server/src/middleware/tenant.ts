import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { AppError } from './errorHandler';
import { isMasterTenant } from '@obliview/shared';
import { tenantService } from '../services/tenant.service';
import { db } from '../db';

// Extend Express.Request to carry the resolved tenantId
declare global {
  namespace Express {
    interface Request {
      tenantId: number;
    }
  }
}

// Membership of non-admin users is re-checked on every request (cached a few
// seconds): session.currentTenantId is written at sign-in / tenant switch and
// would otherwise outlive the removal of the user from that workspace. Only
// positive answers are cached; killSessionsForUser drops a user's entries.
const ACCESS_TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;
const accessCache = new Map<number, Map<number, number>>(); // userId → tenantId → cachedAt

/** Drops the cached workspace memberships of a user. */
export function forgetTenantAccess(userId: number): void {
  accessCache.delete(userId);
}

async function hasAccess(userId: number, tenantId: number): Promise<boolean> {
  const now = performance.now();
  const at = accessCache.get(userId)?.get(tenantId);
  if (at !== undefined && now - at < ACCESS_TTL_MS) return true;
  let ok = await tenantService.userHasAccess(userId, tenantId);
  // A local user with no membership at all is signed in on the master tenant
  // (legacy auth fallback): keep that default workspace usable. Never for SSO
  // accounts: Obligate grants their workspaces, and none granted means none.
  if (!ok && isMasterTenant(tenantId) && !(await tenantService.getFirstTenantForUser(userId))) {
    const u = await db('users').where({ id: userId }).first('foreign_source') as { foreign_source: string | null } | undefined;
    ok = !!u && u.foreign_source !== 'obligate';
  }
  if (ok) {
    if (accessCache.size >= MAX_ENTRIES) accessCache.clear();
    let perUser = accessCache.get(userId);
    if (!perUser) { perUser = new Map(); accessCache.set(userId, perUser); }
    perUser.set(tenantId, now);
  } else {
    accessCache.get(userId)?.delete(tenantId);
  }
  return ok;
}

/**
 * Resolves req.tenantId from the session.
 * Must be applied after requireAuth on all routes that operate on tenant-scoped data.
 * Non-admin sessions must still be members of that workspace; otherwise the
 * session moves to the user's first remaining workspace (if any) and the
 * request is refused.
 */
export async function requireTenant(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const tid = req.session?.currentTenantId;
  if (!tid) {
    next(new AppError(400, 'No tenant selected'));
    return;
  }
  try {
    const userId = Number(req.session.userId);
    if (req.session.role !== 'admin' && Number.isInteger(userId) && userId > 0) {
      if (!(await hasAccess(userId, tid))) {
        const fallback = await tenantService.getFirstTenantForUser(userId);
        if (fallback) req.session.currentTenantId = fallback.id;
        else delete req.session.currentTenantId;
        next(new AppError(403, 'No access to this workspace'));
        return;
      }
    }
    req.tenantId = tid;
    next();
  } catch (err) {
    next(err);
  }
}
