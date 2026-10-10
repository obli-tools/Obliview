import type { Knex } from 'knex';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import type { UserTeam, TeamPermission } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';

/**
 * Teams are strictly mono-tenant (same model as Obliance, migration 064):
 * a team only grants access inside its own tenant (user_teams.tenant_id).
 *   - its permissions may only target groups / monitors of that tenant;
 *   - its members must belong to that tenant (user_tenants).
 * To give a user access to N tenants, create N teams.
 */

interface TeamRow {
  id: number;
  name: string;
  description: string | null;
  can_create: boolean;
  tenant_id: number;
  tenant_name?: string; // populated by JOIN in getAll()
  created_at: Date;
  updated_at: Date;
}

interface PermissionRow {
  id: number;
  team_id: number;
  scope: 'group' | 'monitor';
  scope_id: number;
  level: 'ro' | 'rw';
}

type PermissionInput = { scope: 'group' | 'monitor'; scopeId: number; level: 'ro' | 'rw' };

function rowToTeam(row: TeamRow): UserTeam {
  // `as UserTeam`: the shared type may still carry the legacy `isGlobal`
  // field (global teams were removed by migration 064).
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    canCreate: row.can_create,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  } as UserTeam;
}

function rowToPermission(row: PermissionRow): TeamPermission {
  return {
    id: row.id,
    teamId: row.team_id,
    scope: row.scope,
    scopeId: row.scope_id,
    level: row.level,
  };
}

/** Tenant that owns the team, or 404. */
async function teamTenantId(conn: Knex | Knex.Transaction, teamId: number): Promise<number> {
  const row = await conn('user_teams').where({ id: teamId }).first('tenant_id');
  if (!row) throw new AppError(404, 'Team not found');
  return row.tenant_id as number;
}

/**
 * Reject (400) any group / monitor id that does not belong to the team's
 * tenant. Ids that do not exist are rejected the same way.
 */
async function assertScopesInTenant(
  conn: Knex | Knex.Transaction,
  tenantId: number,
  permissions: Array<{ scope: 'group' | 'monitor'; scopeId: number }>,
): Promise<void> {
  const groupIds = [...new Set(permissions.filter((p) => p.scope === 'group').map((p) => p.scopeId))];
  const monitorIds = [...new Set(permissions.filter((p) => p.scope === 'monitor').map((p) => p.scopeId))];

  if (groupIds.length > 0) {
    const rows = await conn('monitor_groups').whereIn('id', groupIds).where({ tenant_id: tenantId }).select('id');
    if (rows.length !== groupIds.length) {
      throw new AppError(400, 'Some groups do not belong to the team\'s tenant', 'TEAM_SCOPE_OTHER_TENANT');
    }
  }
  if (monitorIds.length > 0) {
    const rows = await conn('monitors').whereIn('id', monitorIds).where({ tenant_id: tenantId }).select('id');
    if (rows.length !== monitorIds.length) {
      throw new AppError(400, 'Some monitors do not belong to the team\'s tenant', 'TEAM_SCOPE_OTHER_TENANT');
    }
  }
}

export const teamService = {
  /**
   * Returns the teams of a tenant.
   * tenantId = null (platform admin god view) → every tenant's teams, joined
   * with the tenant name.
   */
  async getAll(tenantId: number | null): Promise<UserTeam[]> {
    const q = db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .select('user_teams.*', 'tenants.name as tenant_name')
      .orderBy('user_teams.name');
    if (tenantId !== null) q.where('user_teams.tenant_id', tenantId);
    const rows = await q;
    return rows.map(rowToTeam);
  },

  /**
   * Tenant-agnostic lookup (background jobs read across tenants). Callers
   * serving a request MUST compare `team.tenantId` with the request tenant.
   */
  async getById(id: number): Promise<UserTeam | null> {
    const row = await db<TeamRow>('user_teams').where({ id }).first();
    return row ? rowToTeam(row) : null;
  },

  async create(data: { name: string; description?: string | null; canCreate?: boolean }, tenantId: number): Promise<UserTeam> {
    const [row] = await db<TeamRow>('user_teams')
      .insert({
        name: data.name,
        description: data.description ?? null,
        can_create: data.canCreate ?? false,
        tenant_id: tenantId,
      })
      .returning('*');
    return rowToTeam(row);
  },

  async update(
    id: number,
    data: { name?: string; description?: string | null; canCreate?: boolean },
  ): Promise<UserTeam | null> {
    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.canCreate !== undefined) updateData.can_create = data.canCreate;

    const [row] = await db<TeamRow>('user_teams')
      .where({ id })
      .update(updateData)
      .returning('*');
    return row ? rowToTeam(row) : null;
  },

  async delete(id: number): Promise<boolean> {
    const count = await db('user_teams').where({ id }).del();
    return count > 0;
  },

  // ── Members ──

  async getMembers(teamId: number): Promise<number[]> {
    const rows = await db('team_memberships')
      .where({ team_id: teamId })
      .select('user_id');
    return rows.map((r) => r.user_id);
  },

  /**
   * Replace the members of a team. Every user must belong to the team's
   * tenant (user_tenants), otherwise 400.
   */
  async setMembers(teamId: number, userIds: number[]): Promise<void> {
    const ids = [...new Set(userIds)];
    await db.transaction(async (trx) => {
      const tenantId = await teamTenantId(trx, teamId);
      if (ids.length > 0) {
        const allowed = new Set<number>(
          ((await trx('user_tenants').where({ tenant_id: tenantId }).whereIn('user_id', ids).pluck('user_id')) as number[])
            .map(Number),
        );
        if (isMasterTenant(tenantId)) {
          // Legacy accounts without any user_tenants row belong to the master
          // tenant (same fallback as userService.getAll / permissionService).
          const rowless = (await trx('users')
            .whereIn('id', ids)
            .whereNotExists(trx('user_tenants').whereRaw('user_tenants.user_id = users.id'))
            .pluck('id')) as number[];
          rowless.forEach((id) => allowed.add(Number(id)));
        }
        if (ids.some((id) => !allowed.has(Number(id)))) {
          throw new AppError(400, 'Some users are not members of the team\'s tenant', 'TEAM_MEMBER_OTHER_TENANT');
        }
      }
      await trx('team_memberships').where({ team_id: teamId }).del();
      if (ids.length > 0) {
        await trx('team_memberships').insert(
          ids.map((uid) => ({ team_id: teamId, user_id: uid })),
        );
      }
    });
  },

  async getUserTeams(userId: number): Promise<UserTeam[]> {
    const rows = await db<TeamRow>('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .select('user_teams.*')
      .orderBy('user_teams.name');
    return rows.map(rowToTeam);
  },

  // ── Permissions ──

  async getPermissions(teamId: number): Promise<TeamPermission[]> {
    const rows = await db<PermissionRow>('team_permissions')
      .where({ team_id: teamId })
      .orderBy('scope')
      .orderBy('scope_id');
    return rows.map(rowToPermission);
  },

  /**
   * Replace the permissions of a team. Every scope id must be a group /
   * monitor of the team's tenant, otherwise 400.
   */
  setPermissions(
    teamId: number,
    permissions: PermissionInput[],
  ): Promise<TeamPermission[]> {
    return db.transaction(async (trx) => {
      const tenantId = await teamTenantId(trx, teamId);
      await assertScopesInTenant(trx, tenantId, permissions);

      await trx('team_permissions').where({ team_id: teamId }).del();
      if (permissions.length > 0) {
        await trx('team_permissions').insert(
          permissions.map((p) => ({
            team_id: teamId,
            scope: p.scope,
            scope_id: p.scopeId,
            level: p.level,
          })),
        );
      }
      const rows = await trx<PermissionRow>('team_permissions')
        .where({ team_id: teamId })
        .orderBy('scope')
        .orderBy('scope_id');
      return rows.map(rowToPermission);
    });
  },

  async addPermission(
    teamId: number,
    scope: 'group' | 'monitor',
    scopeId: number,
    level: 'ro' | 'rw',
  ): Promise<TeamPermission> {
    const tenantId = await teamTenantId(db, teamId);
    await assertScopesInTenant(db, tenantId, [{ scope, scopeId }]);
    const [row] = await db<PermissionRow>('team_permissions')
      .insert({ team_id: teamId, scope, scope_id: scopeId, level })
      .onConflict(['team_id', 'scope', 'scope_id'])
      .merge({ level })
      .returning('*');
    return rowToPermission(row);
  },

  /** Delete one permission of `teamId` (false when it is not that team's). */
  async removePermission(teamId: number, permissionId: number): Promise<boolean> {
    const count = await db('team_permissions').where({ id: permissionId, team_id: teamId }).del();
    return count > 0;
  },
};
