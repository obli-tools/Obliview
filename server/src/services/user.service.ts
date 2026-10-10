import { db } from '../db';
import { hashPassword } from '../utils/crypto';
import type { User, UserRole, UserTenantAssignment } from '@obliview/shared';
import { isMasterTenant, MASTER_TENANT_ID } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import {
  DEFAULT_TENANT_ROLE,
  deactivateTenantlessUsers,
  killSessionsAfterTenantLoss,
  normalizeTenantRole,
  pruneTeamMembershipsOutsideTenants,
  resolveTenantRoles,
} from './tenant.service';

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  foreign_source: string | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role as UserRole,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    preferredLanguage: 'en',
    enrollmentVersion: 0,
    foreignSource: row.foreign_source ?? null,
  };
}

export const userService = {
  /**
   * Accounts of one tenant (user_tenants members), or of the whole install
   * when tenantId is null (God View). Legacy accounts without any
   * user_tenants row belong to the master tenant (auth fallback).
   */
  async getAll(tenantId: number | null): Promise<User[]> {
    const q = db<UserRow>('users').orderBy('username');
    if (tenantId !== null) {
      q.where(function () {
        this.whereExists(
          db('user_tenants')
            .whereRaw('user_tenants.user_id = users.id')
            .where('user_tenants.tenant_id', tenantId),
        );
        if (isMasterTenant(tenantId)) {
          this.orWhereNotExists(db('user_tenants').whereRaw('user_tenants.user_id = users.id'));
        }
      });
    }
    const rows = await q;
    return rows.map(rowToUser);
  },

  /** Active platform admins other than `excludeId` (last-admin protections). */
  async countOtherActiveAdmins(excludeId: number): Promise<number> {
    const row = await db('users')
      .where({ role: 'admin', is_active: true })
      .whereNot({ id: excludeId })
      .count<{ count: string | number }[]>('id as count')
      .first();
    return Number(row?.count ?? 0);
  },

  async getById(id: number): Promise<User | null> {
    const row = await db<UserRow>('users').where({ id }).first();
    return row ? rowToUser(row) : null;
  },

  async create(data: {
    username: string;
    password: string;
    displayName?: string | null;
    role?: UserRole;
  }, tenantId: number | null = null): Promise<User> {
    const passwordHash = await hashPassword(data.password);

    // The account becomes a member of the tenant it is created from (the
    // master tenant included) in the same transaction, so its membership is
    // a real row rather than the legacy "no row = master" fallback.
    // Platform admins reach every workspace and get no row.
    return db.transaction(async (trx) => {
      const [row] = await trx<UserRow>('users')
        .insert({
          username: data.username,
          password_hash: passwordHash,
          display_name: data.displayName || null,
          role: data.role || 'user',
        })
        .returning('*');

      if ((data.role || 'user') !== 'admin') {
        await trx('user_tenants').insert({
          user_id: row.id,
          tenant_id: tenantId ?? MASTER_TENANT_ID,
          role: DEFAULT_TENANT_ROLE,
          created_at: new Date(),
        });
      }

      return rowToUser(row);
    });
  },

  async update(id: number, data: {
    displayName?: string | null;
    role?: UserRole;
    isActive?: boolean;
  }): Promise<User | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.displayName !== undefined) updateData.display_name = data.displayName;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.isActive !== undefined) updateData.is_active = data.isActive;

    const [row] = await db<UserRow>('users')
      .where({ id })
      .update(updateData)
      .returning('*');

    return row ? rowToUser(row) : null;
  },

  async changePassword(id: number, newPassword: string): Promise<boolean> {
    const passwordHash = await hashPassword(newPassword);
    const count = await db('users')
      .where({ id })
      .update({ password_hash: passwordHash, updated_at: new Date() });
    return count > 0;
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('users').where({ id }).del();
    return count > 0;
  },

  /** Returns all tenants with this user's membership status and role. */
  async getUserTenantAssignments(userId: number): Promise<UserTenantAssignment[]> {
    const rows = await db('tenants as t')
      .leftJoin('user_tenants as ut', function () {
        this.on('ut.tenant_id', '=', 't.id').andOnVal('ut.user_id', '=', userId);
      })
      .select(
        't.id as tenantId',
        't.name as tenantName',
        't.slug as tenantSlug',
        db.raw('(ut.user_id IS NOT NULL) as is_member'),
        // role is a permission_set slug (053). 'user' is the default
        // non-admin set; the legacy 'member' is reported as 'user'.
        db.raw("COALESCE(ut.role, 'user') as role"),
      )
      .orderBy('t.name');

    return rows.map((r) => ({
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      tenantSlug: r.tenantSlug,
      isMember: Boolean(r.is_member),
      role: normalizeTenantRole(r.role),
    }));
  },

  /** Bulk-replaces all tenant memberships for a user.
   *  Each role must be 'admin' or an existing permission_sets.slug
   *  (AppError 400 otherwise); a missing role defaults to 'user'.
   *  The user's memberships in teams of tenants no longer granted are
   *  deleted in the same transaction, then — when a tenant was dropped —
   *  the user's sessions are ended (platform admins keep access to every
   *  workspace, so theirs are left alone). */
  async setUserTenantAssignments(
    userId: number,
    assignments: { tenantId: number; role?: string | null }[],
  ): Promise<{ removedTenantIds: number[] }> {
    // Validate every role up front so an invalid entry cannot wipe the
    // user's existing memberships.
    const roles = await resolveTenantRoles(assignments.map((a) => a.role));
    const tenantIds = assignments.map((a) => Number(a.tenantId));
    if (tenantIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      throw new AppError(400, 'Invalid tenant id');
    }
    if (new Set(tenantIds).size !== tenantIds.length) {
      throw new AppError(400, 'Duplicate tenant in assignments');
    }

    const removedTenantIds = await db.transaction(async (trx) => {
      const before = await trx('user_tenants').where({ user_id: userId }).pluck('tenant_id') as number[];
      await trx('user_tenants').where({ user_id: userId }).del();
      if (assignments.length > 0) {
        await trx('user_tenants').insert(
          assignments.map((a, i) => ({
            user_id: userId,
            tenant_id: tenantIds[i],
            role: roles[i],
            created_at: new Date(),
          })),
        );
      }
      await pruneTeamMembershipsOutsideTenants(trx, userId);
      const kept = new Set(tenantIds);
      return before.map(Number).filter((tid) => !kept.has(tid));
    });

    if (removedTenantIds.length > 0) await killSessionsAfterTenantLoss(userId);
    if (assignments.length === 0) await deactivateTenantlessUsers([userId], 'every tenant membership removed');
    return { removedTenantIds };
  },
};
