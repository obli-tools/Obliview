import type { Request, Response, NextFunction } from 'express';
import { performance } from 'node:perf_hooks';
import { db } from '../db';
import { config } from '../config';
import { appConfigService } from '../services/appConfig.service';

// "Force 2FA for all users" (app_config force_2fa), enforced server-side.
//
// GET /auth/me reports requires2faSetup and the client sends the user to
// /profile?setup2fa=1, but the API itself must refuse as well: a signed-in
// local account without any second factor only reaches what it needs to set
// one up (answer 403 { code: '2FA_SETUP_REQUIRED' } everywhere else).
//
// Mounted in app.ts on /api, after the session middleware and
// sessionUserGuard (so a dead session is already anonymous here). Requests
// without a signed-in user (agents, push heartbeats, the pending-2FA step of
// a sign-in, Obligate server-to-server calls) are not concerned.
//
// Exempt:
//   - Obligate SSO users (their 2FA is enforced by Obligate);
//   - DISABLE_2FA_FORCE=true (config.disable2faForce, emergency switch);
//   - /api/auth/*         sign-in state, /me, logout, enrollment, SSO config;
//   - /api/profile[/...]  the user's own profile (the 2FA setup is there:
//                         /api/profile/2fa/*);
//   - GET /api/admin/config  read by the profile page (allow_2fa).
//
// The Socket.io handshake (socket.ts) uses needs2faSetup too: no live data
// reaches a user who must set up a factor first.

const CONFIG_TTL_MS = 5_000;
const USER_TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;

let forceCache: { at: number; force: boolean } | null = null;
/** Users seen exempt (SSO, or with a factor): cached briefly. A user still
 *  without a factor is never cached, so enabling one takes effect at once. */
const exemptCache = new Map<number, number>();

async function forceEnabled(): Promise<boolean> {
  const now = performance.now();
  if (forceCache && now - forceCache.at < CONFIG_TTL_MS) return forceCache.force;
  const force = (await appConfigService.getAll()).force_2fa === true;
  forceCache = { at: now, force };
  return force;
}

async function isExempt(userId: number): Promise<boolean> {
  const now = performance.now();
  const at = exemptCache.get(userId);
  if (at !== undefined && now - at < USER_TTL_MS) return true;
  const row = await db('users')
    .where({ id: userId })
    .first('foreign_source', 'totp_enabled', 'email_otp_enabled') as
    { foreign_source: string | null; totp_enabled: boolean | null; email_otp_enabled: boolean | null } | undefined;
  // A missing user is left to requireAuth / sessionUserGuard.
  const exempt = !row || row.foreign_source === 'obligate' || !!row.totp_enabled || !!row.email_otp_enabled;
  if (exempt) {
    if (exemptCache.size >= MAX_ENTRIES) exemptCache.clear();
    exemptCache.set(userId, now);
  }
  return exempt;
}

/** Path relative to the /api mount, e.g. '/profile/2fa/status'. */
function isAllowedPath(req: Request): boolean {
  const p = req.path;
  if (p === '/auth' || p.startsWith('/auth/')) return true;
  if (p === '/profile' || p.startsWith('/profile/')) return true;
  if (req.method === 'GET' && (p === '/admin/config' || p === '/admin/config/')) return true;
  return false;
}

/**
 * True when this signed-in user must set up a second factor before using the
 * application (force_2fa on, not exempt). Shared by the HTTP middleware and
 * the Socket.io handshake so both checks cannot drift.
 */
export async function needs2faSetup(userId: number): Promise<boolean> {
  if (config.disable2faForce) return false;
  if (!(await forceEnabled())) return false;
  return !(await isExempt(userId));
}

export async function require2faSetup(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = Number(req.session?.userId);
  if (!Number.isInteger(userId) || userId <= 0) { next(); return; }
  if (isAllowedPath(req)) { next(); return; }
  try {
    if (!(await needs2faSetup(userId))) { next(); return; }
    res.status(403).json({
      success: false,
      error: 'Two-factor authentication must be set up before using the application',
      code: '2FA_SETUP_REQUIRED',
    });
  } catch (err) {
    next(err);
  }
}
