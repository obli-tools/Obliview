import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'crypto';
import { authService } from '../services/auth.service';
import { appConfigService } from '../services/appConfig.service';
import { twoFactorService } from '../services/twoFactor.service';
import { permissionService } from '../services/permission.service';
import { tenantService } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';
import { config } from '../config';
import { obligateService } from '../services/obligate.service';
import { db } from '../db';
import { clearLegacyPartitionedCookie, SESSION_COOKIE_NAME } from '../session';
import { regenerateSession } from '../utils/session';
import { auditService } from '../services/audit.service';
import type { LoginInput } from '../validators/auth.schema';

/** Helper: resolve & store the first accessible tenant in the session. */
async function setSessionTenant(req: Request, userId: number): Promise<void> {
  const tenant = await tenantService.getFirstTenantForUser(userId);
  req.session.currentTenantId = tenant?.id ?? 1;
}

export const authController = {
  async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { username, password } = req.body as LoginInput;
      const user = await authService.authenticate(username, password);

      if (!user) {
        // Platform-level row (no tenant, no actor): only the attempted
        // username is kept — never the password.
        await auditService.logReq(req, 'auth.login_refused', {
          tenantId: null,
          userId: null,
          details: { username: String(username ?? '').slice(0, 100) },
        });
        throw new AppError(401, 'Invalid username or password');
      }

      const hasMfa = user.totpEnabled || user.emailOtpEnabled;

      if (hasMfa) {
        // New session id once the password is proven (session fixation): an
        // id planted before sign-in never reaches the pending-2FA state.
        await regenerateSession(req);

        // Step 1: store pending MFA, don't create real session yet
        req.session.pendingMfaUserId = user.id;

        // If email OTP is enabled, auto-send a code. Only its SHA-256 hash is
        // kept in the session (compared in constant time at /2fa/verify).
        if (user.emailOtpEnabled && user.email) {
          const cfg = await appConfigService.getAll();
          if (cfg.otp_smtp_server_id) {
            const code = twoFactorService.generateEmailOtp();
            const codeHash = createHash('sha256').update(code).digest('hex');
            req.session.pendingEmailOtp = { codeHash, email: user.email, expires: Date.now() + 10 * 60 * 1000 };
            await twoFactorService.sendEmailOtp(cfg.otp_smtp_server_id, user.email, code);
          }
        }

        res.json({
          success: true,
          data: {
            requires2fa: true,
            methods: { totp: user.totpEnabled ?? false, email: user.emailOtpEnabled ?? false },
          },
        });
        return;
      }

      // No 2FA — complete the session immediately, under a NEW id (session
      // fixation): the pre-login id is deleted with its row.
      await regenerateSession(req);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      await setSessionTenant(req, user.id);
      await auditService.logReq(req, 'auth.login', {
        resourceType: 'user',
        resourceId: user.id,
        details: { method: 'password' },
      });

      res.json({ success: true, data: { user } });
    } catch (err) {
      next(err);
    }
  },

  async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Written before the session is destroyed (actor + tenant come from it).
      if (req.session.userId) {
        await auditService.logReq(req, 'auth.logout', { resourceType: 'user', resourceId: req.session.userId });
      }
      req.session.destroy((err) => {
        if (err) {
          next(new AppError(500, 'Failed to logout'));
          return;
        }
        clearLegacyPartitionedCookie(res);
        res.clearCookie(SESSION_COOKIE_NAME);
        res.json({ success: true, message: 'Logged out' });
      });
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.userId!;

      const fRow = await db('users').where({ id: userId }).select('foreign_source', 'foreign_id', 'is_active').first() as
        { foreign_source: string | null; foreign_id: number | null; is_active: boolean } | undefined;
      // A deactivated (or deleted) user has no session, whatever the store
      // still holds (sessionUserGuard normally ends it first).
      if (!fRow || fRow.is_active === false) {
        throw new AppError(401, 'User not found');
      }

      // Sync preferences from Obligate for SSO users (throttled, non-blocking)
      if (fRow.foreign_source === 'obligate' && fRow.foreign_id) {
        await obligateService.syncUserPreferences(userId, fRow.foreign_id).catch(() => {});
      }

      const user = await authService.getUserById(userId);
      if (!user || !user.isActive) {
        throw new AppError(401, 'User not found');
      }

      // Repair missing currentTenantId (e.g. sessions from before Phase 13)
      if (!req.session.currentTenantId) {
        await setSessionTenant(req, user.id);
      }

      const isAdmin = user.role === 'admin';
      // Effective map + tenantCapabilities for the ACTIVE tenant
      const permissions = await permissionService.getUserPermissions(user.id, isAdmin, req.session.currentTenantId!);

      // Check if force 2FA applies to this user
      let requires2faSetup = false;
      // Obligate SSO users are exempt (their 2FA is enforced by Obligate),
      // matching the require2faSetup middleware.
      if (!config.disable2faForce && fRow.foreign_source !== 'obligate') {
        const cfg = await appConfigService.getAll();
        if (cfg.force_2fa && !user.totpEnabled && !user.emailOtpEnabled) {
          requires2faSetup = true;
        }
      }

      res.json({
        success: true,
        data: { user, permissions, requires2faSetup, currentTenantId: req.session.currentTenantId },
      });
    } catch (err) {
      next(err);
    }
  },

  async permissions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const isAdmin = req.session.role === 'admin';
      const userId = req.session.userId!;
      if (!req.session.currentTenantId) await setSessionTenant(req, userId);
      // Effective map + tenantCapabilities for the ACTIVE tenant
      const permissions = await permissionService.getUserPermissions(userId, isAdmin, req.session.currentTenantId!);
      res.json({ success: true, data: permissions });
    } catch (err) {
      next(err);
    }
  },
};
