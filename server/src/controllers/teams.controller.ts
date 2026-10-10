import type { Request, Response, NextFunction } from 'express';
import { teamService } from '../services/team.service';
import { AppError } from '../middleware/errorHandler';
import { db } from '../db';
import type { UserTeam } from '@obliview/shared';
import type {
  CreateTeamInput,
  UpdateTeamInput,
  SetTeamMembersInput,
  SetTeamPermissionsInput,
} from '../validators/team.schema';
import { getEffectiveTenantScope, isGodView } from '../utils/tenantScope';
import { auditService } from '../services/audit.service';

/** Team actions are filed in the team's own tenant (a god-view action on
 *  another tenant's team shows up in that tenant's log too). */
function auditTeam(req: Request, action: string, team: Pick<UserTeam, 'id' | 'tenantId'>, details?: Record<string, unknown>): Promise<void> {
  return auditService.logReq(req, action, {
    tenantId: team.tenantId ?? req.tenantId,
    resourceType: 'team',
    resourceId: team.id,
    details,
  });
}

/**
 * Load a team for a request and apply the tenant ownership gate.
 * `teamService.getById` is tenant-agnostic, so every by-id route goes through
 * here: outside the god view, a team of another tenant answers 404 — the
 * same shape as "does not exist", so its existence is not leaked.
 */
async function loadOwnedTeam(req: Request): Promise<UserTeam> {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) throw new AppError(404, 'Team not found');
  const team = await teamService.getById(id);
  if (!team) throw new AppError(404, 'Team not found');
  if (!isGodView(req) && team.tenantId !== req.tenantId) {
    throw new AppError(404, 'Team not found');
  }
  return team;
}

export const teamsController = {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // God view (platform admin on the master tenant) → every tenant's teams;
      // anyone else → the teams of the active tenant.
      const teams = await teamService.getAll(getEffectiveTenantScope(req));
      res.json({ success: true, data: teams });
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadOwnedTeam(req);
      const [members, permissions] = await Promise.all([
        teamService.getMembers(team.id),
        teamService.getPermissions(team.id),
      ]);

      res.json({ success: true, data: { ...team, memberIds: members, permissions } });
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateTeamInput;

      // Teams are strictly mono-tenant: a team only grants access inside its
      // own tenant. To give a user access to N tenants, create N teams.
      //   - God view: the platform admin MUST pick the tenant in the body (it
      //     may be the master tenant itself).
      //   - Any other tenant: the body's tenantId is ignored (anti-escalation).
      let targetTenantId: number;
      if (isGodView(req)) {
        if (!data.tenantId) {
          throw new AppError(400, 'tenantId is required when creating a team from the master tenant', 'TEAM_TENANT_REQUIRED');
        }
        const tenant = await db('tenants').where({ id: data.tenantId }).first('id');
        if (!tenant) throw new AppError(400, 'Tenant not found');
        targetTenantId = data.tenantId;
      } else {
        targetTenantId = req.tenantId;
      }

      const { tenantId: _ignored, ...rest } = data;
      const team = await teamService.create(rest, targetTenantId);
      await auditTeam(req, 'team.created', { id: team.id, tenantId: targetTenantId }, { name: team.name });
      res.status(201).json({ success: true, data: team });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Team name already exists'));
      } else {
        next(err);
      }
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const existing = await loadOwnedTeam(req);
      const data = req.body as UpdateTeamInput;
      const team = await teamService.update(existing.id, data);
      if (!team) throw new AppError(404, 'Team not found');
      await auditTeam(req, 'team.updated', existing, { fields: Object.keys(data ?? {}) });
      res.json({ success: true, data: team });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Team name already exists'));
      } else {
        next(err);
      }
    }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const existing = await loadOwnedTeam(req);
      const deleted = await teamService.delete(existing.id);
      if (!deleted) throw new AppError(404, 'Team not found');
      await auditTeam(req, 'team.deleted', existing, { name: existing.name });
      res.json({ success: true, message: 'Team deleted' });
    } catch (err) {
      next(err);
    }
  },

  // ── Members ──

  async getMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadOwnedTeam(req);
      const members = await teamService.getMembers(team.id);
      res.json({ success: true, data: members });
    } catch (err) {
      next(err);
    }
  },

  async setMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadOwnedTeam(req);
      const { userIds } = req.body as SetTeamMembersInput;
      // Rejects (400) users without user_tenants in the team's tenant.
      await teamService.setMembers(team.id, userIds);
      await auditTeam(req, 'team.members_set', team, { userIds });
      res.json({ success: true, data: userIds });
    } catch (err) {
      next(err);
    }
  },

  // ── Permissions ──

  async getPermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadOwnedTeam(req);
      const permissions = await teamService.getPermissions(team.id);
      res.json({ success: true, data: permissions });
    } catch (err) {
      next(err);
    }
  },

  async setPermissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadOwnedTeam(req);
      const { permissions } = req.body as SetTeamPermissionsInput;
      // Rejects (400) groups / monitors outside the team's tenant.
      const result = await teamService.setPermissions(team.id, permissions);
      await auditTeam(req, 'team.permissions_set', team, { count: Array.isArray(permissions) ? permissions.length : 0, permissions });
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  async removePermission(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const team = await loadOwnedTeam(req);
      const permId = parseInt(req.params.permId, 10);
      if (!Number.isInteger(permId)) throw new AppError(404, 'Permission not found');
      // Scoped to :id — a permission of another team answers 404.
      const deleted = await teamService.removePermission(team.id, permId);
      if (!deleted) throw new AppError(404, 'Permission not found');
      await auditTeam(req, 'team.permission_removed', team, { permissionId: permId });
      res.json({ success: true, message: 'Permission removed' });
    } catch (err) {
      next(err);
    }
  },
};
