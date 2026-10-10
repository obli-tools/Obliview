import type { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { db } from '../db';
import { twoFactorService } from '../services/twoFactor.service';
import { appConfigService } from '../services/appConfig.service';
import { authService } from '../services/auth.service';
import { tenantService } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';
import { comparePassword } from '../utils/crypto';
import { regenerateSession } from '../utils/session';
import { auditService } from '../services/audit.service';
import { logger } from '../utils/logger';

// Extend session type for 2FA state
declare module 'express-session' {
  interface SessionData {
    pendingMfaUserId?: number;
    pendingTotpSecret?: string;
    /** Epoch ms after which the pending TOTP secret is refused (10 min). */
    pendingTotpExpiresAt?: number;
    /** The pending setup replaces a live TOTP (its step-up was passed). */
    pendingTotpReplaces?: boolean;
    /** E-mail codes: only the SHA-256 of the code is kept, never the code. */
    pendingEmailOtp?: { codeHash: string; email: string; expires: number };
    pendingEmailOtpSetup?: { codeHash: string; email: string; expires: number };
  }
}

/** Lifetime of a pending TOTP secret or e-mail code. */
const PENDING_TTL_MS = 10 * 60 * 1000;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Constant-time check of a submitted 6-digit code against a stored SHA-256 hash. */
function codeMatches(submitted: unknown, codeHash: unknown): boolean {
  if (typeof codeHash !== 'string' || !/^[0-9a-f]{64}$/.test(codeHash)) return false;
  const token = String(submitted ?? '').trim();
  if (!/^\d{6}$/.test(token)) return false;
  const a = Buffer.from(hashCode(token), 'hex');
  const b = Buffer.from(codeHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function clearPendingTotp(req: Request): void {
  delete req.session.pendingTotpSecret;
  delete req.session.pendingTotpExpiresAt;
  delete req.session.pendingTotpReplaces;
}

/**
 * Step-up proof for adding, replacing or removing a second factor (TOTP,
 * e-mail codes). A stolen session cookie alone can then neither plant a
 * factor the attacker controls nor remove the user's.
 *   - The account has a local TOTP: body.currentCode, a CURRENT code of it
 *     (anti-replay: a code already used, even to sign in, is refused).
 *   - Otherwise: body.currentPassword, the account's current password.
 * Throws AppError 400 when the proof is missing, 403 when it is wrong.
 * Wrong proofs are capped per user by stepUpLimiter (twoFactor.routes.ts).
 */
async function checkFactorManagement(req: Request): Promise<void> {
  const userId = req.session.userId!;
  const row = await db('users')
    .where({ id: userId })
    .first('totp_enabled', 'totp_secret', 'password_hash') as {
      totp_enabled: boolean | null; totp_secret: string | null; password_hash: string | null;
    } | undefined;
  if (!row) throw new AppError(401, 'User not found');
  // body.currentCode / body.currentPassword, copied by captureStepUpProof (app.ts).
  const proof = req.stepUpProof ?? {};

  if (row.totp_enabled && row.totp_secret) {
    const code = proof.currentCode ?? '';
    if (!code) {
      throw new AppError(400, 'Enter a current code from your authenticator app to confirm this change.', 'CURRENT_CODE_REQUIRED');
    }
    const step = twoFactorService.verifyTotpStep(row.totp_secret, code);
    if (step === null) throw new AppError(403, 'Invalid authenticator code', 'INVALID_CURRENT_CODE');
    if (!(await twoFactorService.acceptTotpStep(userId, step))) {
      throw new AppError(403, 'This code was already used. Wait for the next code.', 'CODE_ALREADY_USED');
    }
    return;
  }

  const password = proof.currentPassword ?? '';
  if (!password) {
    throw new AppError(400, 'Enter your current password to confirm this change.', 'CURRENT_PASSWORD_REQUIRED');
  }
  if (!row.password_hash) {
    throw new AppError(403, 'This account has no local password; ask an administrator.', 'NO_LOCAL_PASSWORD');
  }
  if (!(await comparePassword(password, row.password_hash))) {
    throw new AppError(403, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
  }
}

export const twoFactorController = {
  // ── Profile endpoints (authenticated) ─────────────────────────────────────

  async status(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await authService.getUserById(req.session.userId!);
      if (!user) throw new AppError(401, 'User not found');
      res.json({ success: true, data: {
        totpEnabled: user.totpEnabled ?? false,
        emailOtpEnabled: user.emailOtpEnabled ?? false,
        email: user.email ?? null,
      }});
    } catch (err) { next(err); }
  },

  // TOTP setup step 1: generate secret + QR (stored in session, 10 min).
  // Always needs a step-up: the current password for a first enrolment, a
  // current code of the live TOTP to replace it. A stolen session alone can
  // then not plant an authenticator the attacker controls.
  // Obligate SSO accounts manage their second factor in Obligate.
  async totpSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users')
        .where({ id: req.session.userId! })
        .first('username', 'totp_enabled', 'totp_secret', 'foreign_source') as {
          username: string; totp_enabled: boolean | null; totp_secret: string | null; foreign_source: string | null;
        } | undefined;
      if (!row) throw new AppError(401, 'User not found');
      if (row.foreign_source === 'obligate') {
        throw new AppError(400, 'Two-factor authentication of SSO accounts is managed in Obligate.', 'SSO_MANAGED_2FA');
      }
      const hasLocalTotp = !!(row.totp_enabled && row.totp_secret);
      await checkFactorManagement(req);

      const { secret, uri } = twoFactorService.generateTotpSecret(row.username);
      const qrDataUrl = await twoFactorService.generateTotpQr(uri);
      // Bounded: a forgotten enrolment must not leave a usable secret in the
      // session store indefinitely.
      req.session.pendingTotpSecret = secret;
      req.session.pendingTotpExpiresAt = Date.now() + PENDING_TTL_MS;
      req.session.pendingTotpReplaces = hasLocalTotp;
      res.json({ success: true, data: { secret, qrDataUrl } });
    } catch (err) { next(err); }
  },

  // TOTP setup step 2: verify code, save secret and enable
  async totpEnable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = (req.body ?? {}) as { code?: unknown };
      const secret = req.session.pendingTotpSecret;
      if (!secret) throw new AppError(400, 'No pending TOTP setup. Call /setup first.');
      if (Date.now() > (req.session.pendingTotpExpiresAt ?? 0)) {
        clearPendingTotp(req);
        throw new AppError(400, 'TOTP setup expired. Start the setup again.', 'TOTP_SETUP_EXPIRED');
      }
      const step = twoFactorService.verifyTotpStep(secret, String(code ?? ''));
      if (step === null) throw new AppError(400, 'Invalid code');

      // A setup started while no TOTP was live passed no code step-up: it must
      // not overwrite a TOTP enabled in the meantime (e.g. from another
      // session). The condition is IN the update, so two racing enables
      // cannot both win. The enabling code's step is recorded (anti-replay).
      const query = db('users').where({ id: req.session.userId });
      if (!req.session.pendingTotpReplaces) {
        query.where((q) => q.where('totp_enabled', false).orWhereNull('totp_enabled').orWhereNull('totp_secret'));
      }
      const updated = await query.update({
        totp_secret: secret,
        totp_enabled: true,
        totp_last_step: db.raw('GREATEST(COALESCE(totp_last_step, ?), ?)', [step, step]),
      });
      clearPendingTotp(req);
      if (!updated) {
        throw new AppError(409, 'Two-factor authentication was enabled in the meantime. Start the setup again.', 'TOTP_ALREADY_ENABLED');
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Removing a live TOTP needs a current code of it (step-up).
  async totpDisable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users')
        .where({ id: req.session.userId })
        .first('totp_enabled', 'totp_secret') as { totp_enabled: boolean | null; totp_secret: string | null } | undefined;
      const hadTotp = !!(row?.totp_enabled && row?.totp_secret);
      if (hadTotp) await checkFactorManagement(req);
      await db('users').where({ id: req.session.userId }).update({
        totp_secret: null,
        totp_enabled: false,
      });
      clearPendingTotp(req);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Email OTP setup step 1: send a code to the account's PROFILE address.
  //
  // This route never changes users.email (the password-reset channel): the
  // address is the one of the profile (PUT /api/profile, which requires the
  // current password to change it). Enabling e-mail codes adds a sign-in
  // factor, so the step-up proof is required before any code is sent.
  async emailSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users').where({ id: req.session.userId! }).first('email') as { email: string | null } | undefined;
      const profileEmail = String(row?.email ?? '').trim();
      if (!profileEmail) {
        throw new AppError(400, 'Set an e-mail address in your profile first.', 'PROFILE_EMAIL_REQUIRED');
      }
      const body = (req.body ?? {}) as { email?: unknown };
      const asked = typeof body.email === 'string' ? body.email.trim() : '';
      if (asked && asked.toLowerCase() !== profileEmail.toLowerCase()) {
        throw new AppError(400, 'Codes are sent to the e-mail address of your profile. Change it in your profile first.', 'EMAIL_NOT_PROFILE');
      }
      const cfg = await appConfigService.getAll();
      if (!cfg.otp_smtp_server_id) throw new AppError(400, 'No SMTP server configured for OTP. Ask your administrator.');

      await checkFactorManagement(req);

      const code = twoFactorService.generateEmailOtp();
      req.session.pendingEmailOtpSetup = { codeHash: hashCode(code), email: profileEmail, expires: Date.now() + PENDING_TTL_MS };
      await twoFactorService.sendEmailOtp(cfg.otp_smtp_server_id, profileEmail, code);
      res.json({ success: true, message: `Code sent to ${profileEmail}` });
    } catch (err) { next(err); }
  },

  // Email OTP setup step 2: verify the mailed code and enable e-mail codes
  // (on the profile address, which is NOT written here).
  async emailEnable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code } = (req.body ?? {}) as { code?: unknown };
      const pending = req.session.pendingEmailOtpSetup;
      if (!pending) throw new AppError(400, 'No pending email OTP setup. Call /setup first.');
      if (Date.now() > pending.expires) {
        delete req.session.pendingEmailOtpSetup;
        throw new AppError(400, 'Code expired');
      }
      if (!codeMatches(code, pending.codeHash)) throw new AppError(400, 'Invalid code');
      // Only if the profile address is still the one the code went to.
      const updated = await db('users')
        .where({ id: req.session.userId })
        .whereRaw('lower(trim(email)) = ?', [String(pending.email).trim().toLowerCase()])
        .update({ email_otp_enabled: true });
      delete req.session.pendingEmailOtpSetup;
      if (!updated) {
        throw new AppError(409, 'Your e-mail address changed during the setup. Start again.', 'EMAIL_CHANGED');
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // Removing a sign-in factor needs the same proof as adding one.
  async emailDisable(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users')
        .where({ id: req.session.userId })
        .first('email_otp_enabled') as { email_otp_enabled: boolean | null } | undefined;
      if (row?.email_otp_enabled) await checkFactorManagement(req);
      await db('users').where({ id: req.session.userId }).update({ email_otp_enabled: false });
      delete req.session.pendingEmailOtpSetup;
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Auth endpoints (after step-1 login, session has pendingMfaUserId) ─────

  async verify(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { code, method } = (req.body ?? {}) as { code?: unknown; method?: unknown };
      const userId = req.session.pendingMfaUserId;
      if (!userId) throw new AppError(400, 'No pending 2FA session');

      // is_active: a deactivation between the password and the code step
      // must not complete the sign-in.
      const row = await db('users')
        .where({ id: userId, is_active: true })
        .first('id', 'username', 'role', 'totp_secret', 'totp_enabled', 'email_otp_enabled', 'email');

      if (!row) {
        // Deleted or deactivated meanwhile: drop the pending sign-in (the
        // client goes back to the credentials step).
        delete req.session.pendingMfaUserId;
        delete req.session.pendingEmailOtp;
        throw new AppError(400, 'No pending 2FA session');
      }

      let valid = false;

      if (method === 'totp' && row.totp_enabled && row.totp_secret) {
        // ±1 step, and a code is accepted once only (users.totp_last_step).
        const step = twoFactorService.verifyTotpStep(row.totp_secret, String(code ?? ''));
        valid = step !== null && await twoFactorService.acceptTotpStep(row.id, step);
      } else if (method === 'totp') {
        logger.warn({ userId, totpEnabled: row.totp_enabled, hasSecret: !!row.totp_secret },
          'TOTP verify: totp_enabled or totp_secret missing in DB');
      } else if (method === 'email' && row.email_otp_enabled) {
        const pending = req.session.pendingEmailOtp;
        if (pending && Date.now() <= pending.expires && codeMatches(code, pending.codeHash)) {
          valid = true;
        }
      }

      if (!valid) {
        // A known password brute-forcing the second factor shows up in the
        // Security page. The code itself is never logged.
        await auditService.logReq(req, 'auth.login_refused', {
          tenantId: null,
          userId: row.id,
          resourceType: 'user',
          resourceId: row.id,
          details: {
            method: method === 'totp' ? 'totp' : method === 'email' ? 'email_otp' : 'unknown',
            reason: 'bad_code',
          },
        });
        throw new AppError(401, 'Invalid code');
      }

      const firstTenant = await tenantService.getFirstTenantForUser(row.id);

      // Complete the session under a NEW id (session fixation): the pending
      // state (pendingMfaUserId, pendingEmailOtp) is dropped with the old id.
      await regenerateSession(req);
      req.session.userId = row.id;
      req.session.username = row.username;
      req.session.role = row.role;
      req.session.currentTenantId = firstTenant?.id ?? 1;
      await auditService.logReq(req, 'auth.login', {
        resourceType: 'user',
        resourceId: row.id,
        details: { method: method === 'totp' ? 'totp' : 'email_otp' },
      });

      const user = await authService.getUserById(row.id);
      res.json({ success: true, data: { user } });
    } catch (err) { next(err); }
  },

  async resendEmail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.session.pendingMfaUserId;
      if (!userId) throw new AppError(400, 'No pending 2FA session');

      const row = await db('users').where({ id: userId, is_active: true }).first('email', 'email_otp_enabled');
      if (!row || !row.email_otp_enabled || !row.email) {
        throw new AppError(400, 'Email OTP not configured for this user');
      }

      const cfg = await appConfigService.getAll();
      if (!cfg.otp_smtp_server_id) throw new AppError(400, 'No SMTP server configured for OTP');

      const code = twoFactorService.generateEmailOtp();
      req.session.pendingEmailOtp = { codeHash: hashCode(code), email: row.email, expires: Date.now() + PENDING_TTL_MS };
      await twoFactorService.sendEmailOtp(cfg.otp_smtp_server_id, row.email, code);
      res.json({ success: true, message: `Code sent to ${row.email}` });
    } catch (err) { next(err); }
  },
};
