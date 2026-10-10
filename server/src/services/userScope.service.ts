import type { Request } from 'express';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { isGodView } from '../utils/tenantScope';
import { normalizeTenantRole } from './tenant.service';

// ── Scope of the /api/users routes (port of Obliance userScope.service) ─────
//
// The users routes are open to holders of the tenant capability
// `users.manage`, not only to platform admins. Password, deletion and
// activation act on the GLOBAL account, so:
//   - reads (GET /users/:id, /:id/teams, /:id/tenants) see the same
//     population as GET /users: every account in the God View (platform admin
//     on the master tenant), the members of the current tenant otherwise;
//   - writes need the target to be a member of the current tenant (unless in
//     the God View) and, for a caller that is not a platform admin, an account
//     it fully dominates:
//       · never a platform admin (users.role = 'admin');
//       · in EVERY tenant the account belongs to: a tenant administrator
//         (user_tenants.role = 'admin') only if the caller is tenant
//         administrator there too; otherwise the caller holds `users.manage`
//         there AND every capability of the account's permission set there
//         (taking over an account must never widen the caller's rights).
//
// A user without any user_tenants row is a legacy account signed in on the
// master tenant (auth fallback): it counts as a member of the master tenant.

export type ScopeActor = {
  userId: number;
  isPlatformAdmin: boolean;
  tenantId: number;
  godView: boolean;
};

export type ManagedTarget = {
  id: number;
  username: string;
  role: string;
  is_active: boolean;
  foreign_source: string | null;
};

export type TenantAssignment = { tenantId: number; role: string };

export function actorFromReq(req: Request): ScopeActor {
  return {
    userId: Number(req.session.userId),
    isPlatformAdmin: req.session.role === 'admin',
    tenantId: Number(req.tenantId),
    godView: isGodView(req),
  };
}

type Caps = { all: true } | { all: false; set: Set<string> };

async function capsOfRole(role: string): Promise<Caps | null> {
  if (role === 'admin') return { all: true };
  const row = await db('permission_sets').where({ slug: role }).first('capabilities') as
    { capabilities: unknown } | undefined;
  if (!row) return null; // unknown slug: no capability (userHasTenantCapability)
  const raw = typeof row.capabilities === 'string' ? JSON.parse(row.capabilities) : row.capabilities;
  return { all: false, set: new Set(Array.isArray(raw) ? raw.map(String) : []) };
}

async function membershipRole(userId: number, tenantId: number): Promise<string | null> {
  const row = await db('user_tenants').where({ user_id: userId, tenant_id: tenantId }).first('role') as
    { role: string } | undefined;
  return row ? normalizeTenantRole(row.role) : null;
}

async function membershipsOf(userId: number): Promise<TenantAssignment[]> {
  const rows = await db('user_tenants').where({ user_id: userId }).select('tenant_id', 'role') as
    Array<{ tenant_id: number; role: string }>;
  return rows.map((r) => ({ tenantId: Number(r.tenant_id), role: normalizeTenantRole(r.role) }));
}

/** Member of `tenantId`, with the legacy "no row at all = master tenant" fallback. */
function isMemberOf(memberships: TenantAssignment[], tenantId: number): boolean {
  if (memberships.length === 0) return tenantId === MASTER_TENANT_ID;
  return memberships.some((m) => m.tenantId === tenantId);
}

/**
 * Can `actor` (not a platform admin) manage an account whose role in
 * `tenantId` is `targetRole`? Returns the refusal text, or null when allowed.
 */
async function refusalFor(actor: ScopeActor, tenantId: number, targetRole: string): Promise<string | null> {
  const callerRole = await membershipRole(actor.userId, tenantId);
  if (callerRole === 'admin') return null; // tenant admin: every capability there
  if (targetRole === 'admin') {
    return "Only an administrator of each of this user's tenants can manage a tenant administrator";
  }
  const callerCaps = callerRole ? await capsOfRole(callerRole) : null;
  if (callerCaps?.all) return null;
  if (!callerCaps || !callerCaps.set.has('users.manage')) {
    return 'This user also belongs to a tenant where you cannot manage users';
  }
  const targetCaps = await capsOfRole(targetRole);
  if (targetCaps?.all) return 'This user has permissions you do not hold';
  for (const cap of targetCaps?.set ?? []) {
    if (!callerCaps.set.has(cap)) return 'This user has permissions you do not hold';
  }
  return null;
}

function assertValidId(targetId: number): void {
  if (!Number.isInteger(targetId) || targetId <= 0) throw new AppError(400, 'Invalid user id');
}

export const userScope = {
  /**
   * A new account gets `role` in `tenantId` (POST /users): a non platform
   * admin may only grant a role whose capabilities they hold there (same
   * "never widen the caller's rights" rule as role changes). 403 otherwise.
   */
  async assertCanGrantRole(actor: ScopeActor, tenantId: number, role: string): Promise<void> {
    if (actor.isPlatformAdmin) return;
    const refusal = await refusalFor(actor, tenantId, role);
    if (refusal) throw new AppError(403, 'You can only grant a role whose permissions you hold');
  },

  /**
   * Read access (GET /users/:id, /:id/teams, /:id/tenants): every account in
   * the God View, members of the current tenant otherwise. 404 outside.
   */
  async assertReadableTarget(actor: ScopeActor, targetId: number): Promise<void> {
    assertValidId(targetId);
    if (actor.godView) return;
    const memberships = await membershipsOf(targetId);
    if (!isMemberOf(memberships, actor.tenantId)) throw new AppError(404, 'User not found');
  },

  /**
   * Write access (edit, enable/disable, password reset, delete, tenant
   * access). Throws 400 / 403 / 404 (AppError).
   */
  async assertManageableTarget(actor: ScopeActor, targetId: number): Promise<ManagedTarget> {
    assertValidId(targetId);
    const target = await db('users').where({ id: targetId })
      .first('id', 'username', 'role', 'is_active', 'foreign_source') as ManagedTarget | undefined;
    if (!target) throw new AppError(404, 'User not found');
    if (actor.godView) return target;

    const memberships = await membershipsOf(targetId);
    if (!isMemberOf(memberships, actor.tenantId)) throw new AppError(404, 'User not found');
    if (actor.isPlatformAdmin) return target;

    if (target.role === 'admin') {
      throw new AppError(403, 'Only a platform administrator can manage an administrator account');
    }
    for (const m of memberships) {
      const refusal = await refusalFor(actor, m.tenantId, m.role);
      if (refusal) throw new AppError(403, refusal);
    }
    return target;
  },

  /**
   * Resolves PUT /users/:id/tenants into the full list of memberships to
   * store. Platform admin: the list as sent ('member' read as 'user').
   * Other managers: only the CURRENT tenant's row may change (add a role,
   * change it, or remove it); every other membership is kept as it is —
   * absent from the list or repeated unchanged, never altered.
   */
  async resolveTenantAssignments(actor: ScopeActor, targetId: number, assignments: unknown): Promise<TenantAssignment[]> {
    if (!Array.isArray(assignments)) throw new AppError(400, 'assignments must be an array');
    const wanted: TenantAssignment[] = [];
    const seen = new Set<number>();
    for (const a of assignments as Array<{ tenantId?: unknown; role?: unknown }>) {
      const tenantId = Number(a?.tenantId);
      if (!Number.isInteger(tenantId) || tenantId <= 0) throw new AppError(400, 'Invalid tenant id');
      if (seen.has(tenantId)) throw new AppError(400, 'Duplicate tenant in assignments');
      seen.add(tenantId);
      const role = a?.role === undefined || a?.role === null ? '' : String(a.role);
      wanted.push({ tenantId, role: normalizeTenantRole(role.trim()) });
    }
    if (actor.isPlatformAdmin) return wanted;

    if (targetId === actor.userId) throw new AppError(403, 'You cannot change your own tenant access');
    await this.assertManageableTarget(actor, targetId); // member of the current tenant, dominated everywhere

    const kept = (await membershipsOf(targetId)).filter((r) => r.tenantId !== actor.tenantId);
    for (const w of wanted) {
      if (w.tenantId === actor.tenantId) continue;
      const same = kept.find((k) => k.tenantId === w.tenantId);
      if (!same || same.role !== w.role) throw new AppError(403, 'You can only change access to the current tenant');
    }

    const next = wanted.find((w) => w.tenantId === actor.tenantId);
    if (next) {
      const callerRole = await membershipRole(actor.userId, actor.tenantId);
      if (next.role === 'admin') {
        if (callerRole !== 'admin') {
          throw new AppError(403, 'Only a tenant administrator can grant the tenant administrator role');
        }
      } else {
        if (!(await capsOfRole(next.role))) throw new AppError(400, `Unknown role: ${next.role}`);
        const refusal = await refusalFor(actor, actor.tenantId, next.role);
        if (refusal) throw new AppError(403, 'You can only grant a role whose permissions you hold');
      }
    }
    return next ? [...kept, next] : kept;
  },
};
