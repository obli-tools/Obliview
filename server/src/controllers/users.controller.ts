import type { Request, Response, NextFunction } from 'express';
import { userService } from '../services/user.service';
import { DEFAULT_TENANT_ROLE } from '../services/tenant.service';
import { teamService } from '../services/team.service';
import { killSessionsForUser, forgetSessionUser } from '../services/userSessions.service';
import { AppError } from '../middleware/errorHandler';
import { userScope, actorFromReq } from '../services/userScope.service';
import { getEffectiveTenantScope, isGodView } from '../utils/tenantScope';
import { auditService } from '../services/audit.service';
import { db } from '../db';
import type {
  CreateUserInput,
  UpdateUserInput,
  ChangePasswordInput,
} from '../validators/user.schema';

export const usersController = {
  // GET /api/users
  // God View (platform admin on the master tenant): every account of the
  // install. Anywhere else: the members of the current tenant only.
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const users = await userService.getAll(getEffectiveTenantScope(req));
      // Second-factor flags (badges and the 'Reset 2FA' action of the users
      // table). Booleans only: the secrets never leave the server.
      const ids = users.map((u) => u.id);
      const factors = ids.length
        ? await db('users').whereIn('id', ids).select('id', 'totp_enabled', 'email_otp_enabled') as
          { id: number; totp_enabled: boolean | null; email_otp_enabled: boolean | null }[]
        : [];
      const byId = new Map(factors.map((f) => [f.id, f]));
      const data = users.map((u) => ({
        ...u,
        totpEnabled: !!byId.get(u.id)?.totp_enabled,
        emailOtpEnabled: !!byId.get(u.id)?.email_otp_enabled,
      }));
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id
  async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await userScope.assertReadableTarget(actorFromReq(req), id);
      const user = await userService.getById(id);
      if (!user) throw new AppError(404, 'User not found');
      res.json({ success: true, data: user });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/users
  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateUserInput;
      // Creating a platform admin is a platform-role change.
      if (data.role === 'admin' && req.session.role !== 'admin') {
        throw new AppError(403, 'Only a platform administrator can create an administrator account');
      }
      // The account becomes a DEFAULT_TENANT_ROLE member of the active tenant:
      // the caller must hold every capability of that role there.
      if (data.role !== 'admin' && req.tenantId) {
        await userScope.assertCanGrantRole(actorFromReq(req), Number(req.tenantId), DEFAULT_TENANT_ROLE);
      }
      // Member of the active tenant (same transaction).
      const user = await userService.create(data, req.tenantId ?? null);
      void auditService.logReq(req, 'user.created', {
        resourceType: 'user', resourceId: user.id,
        details: { username: user.username, role: user.role },
      });
      res.status(201).json({ success: true, data: user });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Username already exists'));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/users/:id
  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as UpdateUserInput;

      // Member of the current tenant (God View excepted) and, for a manager
      // that is not a platform admin, an account it dominates.
      const scoped = await userScope.assertManageableTarget(actorFromReq(req), id);
      // The edit form always sends the current role: only a CHANGE is refused.
      if (data.role !== undefined && data.role !== scoped.role && req.session.role !== 'admin') {
        throw new AppError(403, 'Only a platform administrator can change a user role');
      }

      // Block role/isActive changes for SSO users — manage from Obligate
      const targetUser = await userService.getById(id);
      if (targetUser?.foreignSource === 'obligate') {
        if (data.role !== undefined || data.isActive !== undefined) {
          throw new AppError(400, 'Cannot modify SSO user — manage from Obligate');
        }
      }

      // Prevent modifying username of SSO users
      if (data.username) {
        if (targetUser?.foreignSource) {
          throw new AppError(400, 'Cannot change username of SSO user');
        }
      }

      // Prevent demoting the last admin
      if (data.role === 'user' || data.isActive === false) {
        if (targetUser?.role === 'admin' && (await userService.countOtherActiveAdmins(id)) === 0) {
          throw new AppError(400, 'Cannot remove the last active admin');
        }
      }

      const user = await userService.update(id, data);
      if (!user) throw new AppError(404, 'User not found');

      // Access taken away (deactivation, or demotion from admin): end every
      // session and socket of the user now — a session would otherwise keep
      // its admin role / access for up to 7 days.
      const deactivated = data.isActive === false;
      const demoted = data.role === 'user' && targetUser?.role === 'admin';
      if (deactivated || demoted) {
        await killSessionsForUser(id, deactivated ? 'user deactivated' : 'admin demoted');
      } else {
        forgetSessionUser(id);
      }

      // Field names only (never a value such as a password or e-mail).
      void auditService.logReq(req, 'user.updated', {
        resourceType: 'user', resourceId: id,
        details: {
          username: user.username,
          fields: Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined),
          ...(data.role !== undefined && data.role !== targetUser?.role ? { role: data.role } : {}),
          ...(data.isActive !== undefined && data.isActive !== targetUser?.isActive ? { isActive: data.isActive } : {}),
        },
      });

      res.json({ success: true, data: user });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('unique')) {
        next(new AppError(409, 'Username already exists'));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/users/:id/password
  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await userScope.assertManageableTarget(actorFromReq(req), id);
      const user = await userService.getById(id);
      if (user?.foreignSource) {
        throw new AppError(400, 'Cannot change password of SSO user');
      }
      const data = req.body as ChangePasswordInput;
      const success = await userService.changePassword(id, data.password);
      if (!success) throw new AppError(404, 'User not found');
      // An admin resetting someone else's password (e.g. a compromised
      // account): the sessions opened with the old one must not survive.
      if (id !== req.session.userId) {
        await killSessionsForUser(id, 'password reset by admin');
      }
      res.json({ success: true, message: 'Password changed' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/users/:id
  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);

      if (id === req.session.userId) {
        throw new AppError(400, 'Cannot delete your own account');
      }

      await userScope.assertManageableTarget(actorFromReq(req), id);
      const user = await userService.getById(id);

      // Block deletion of SSO users — manage from Obligate
      if (user?.foreignSource === 'obligate') {
        throw new AppError(400, 'Cannot delete SSO user — manage from Obligate');
      }

      if (user?.role === 'admin' && (await userService.countOtherActiveAdmins(id)) === 0) {
        throw new AppError(400, 'Cannot delete the last admin');
      }

      const deleted = await userService.delete(id);
      if (!deleted) throw new AppError(404, 'User not found');
      await killSessionsForUser(id, 'user deleted');
      void auditService.logReq(req, 'user.deleted', {
        resourceType: 'user', resourceId: id,
        details: { username: user?.username ?? null },
      });
      res.json({ success: true, message: 'User deleted' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/users/:id/2fa — removes every local second factor of a
  // locked-out user (lost authenticator, unreachable OTP mailbox).
  async resetTwoFactor(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // One's own factors are managed from the profile, with a step-up
      // proof: this route must not be a way around it.
      if (id === req.session.userId) {
        throw new AppError(400, 'Use your profile to manage your own two-factor authentication', 'SELF_2FA_RESET');
      }
      // Member of the current tenant (God View excepted) and, for a manager
      // that is not a platform admin, an account it dominates.
      const target = await userScope.assertManageableTarget(actorFromReq(req), id);
      if (target.foreign_source === 'obligate') {
        throw new AppError(400, 'The two-factor authentication of an SSO account is managed in Obligate', 'SSO_2FA_MANAGED');
      }

      const before = await db('users').where({ id }).first('totp_enabled', 'email_otp_enabled') as
        { totp_enabled: boolean | null; email_otp_enabled: boolean | null } | undefined;
      const count = await db('users').where({ id }).update({
        totp_secret: null,
        totp_enabled: false,
        totp_last_step: null,
        email_otp_enabled: false,
        updated_at: new Date(),
      });
      if (!count) throw new AppError(404, 'User not found');

      // Sessions opened with the removed factors end now.
      await killSessionsForUser(id, '2fa reset by admin');
      void auditService.logReq(req, 'user.2fa_reset', {
        resourceType: 'user', resourceId: id,
        details: {
          username: target.username,
          totp: !!before?.totp_enabled,
          emailOtp: !!before?.email_otp_enabled,
        },
      });
      res.json({ success: true, message: 'Two-factor authentication reset' });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/teams
  async getTeams(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await userScope.assertReadableTarget(actorFromReq(req), id);
      let teams = await teamService.getUserTeams(id);
      // Outside the God View, only the current tenant's teams are shown.
      if (!isGodView(req)) {
        teams = teams.filter((tm) => Number(tm.tenantId) === req.tenantId);
      }
      res.json({ success: true, data: teams });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/users/:id/tenants
  async getTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      await userScope.assertReadableTarget(actorFromReq(req), id);
      let assignments = await userService.getUserTenantAssignments(id);
      // A manager that is not a platform admin sees (and may change) only
      // the current tenant's row: other tenants are neither listed nor
      // named. PUT /:id/tenants keeps the rows it does not send.
      if (req.session.role !== 'admin') {
        assignments = assignments.filter((a) => Number(a.tenantId) === req.tenantId);
      }
      res.json({ success: true, data: assignments });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/users/:id/tenants
  // Body: { assignments: [{ tenantId: number, role: <permission set slug> }] }
  async setTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const actor = actorFromReq(req);
      // Platform admins: the list as sent (target in the current tenant unless
      // in the God View). Other managers: only the current tenant's row of an
      // account they dominate; other rows are kept as they are.
      if (actor.isPlatformAdmin) await userScope.assertManageableTarget(actor, id);
      const targetUser = await userService.getById(id);
      if (!targetUser) throw new AppError(404, 'User not found');
      if (targetUser.foreignSource === 'obligate') {
        throw new AppError(400, 'Cannot modify SSO user tenant access — manage from Obligate');
      }
      const assignments = await userScope.resolveTenantAssignments(
        actor, id, (req.body as { assignments?: unknown })?.assignments,
      );
      // Memberships in teams of dropped tenants are pruned in the same
      // transaction, and the user's sessions are ended when a tenant was
      // dropped (platform admins excepted).
      await userService.setUserTenantAssignments(id, assignments);
      void auditService.logReq(req, 'user.tenants_set', {
        resourceType: 'user', resourceId: id,
        details: { username: targetUser.username, assignments },
      });
      res.json({ success: true, message: 'Tenant assignments updated' });
    } catch (err) {
      next(err);
    }
  },
};
