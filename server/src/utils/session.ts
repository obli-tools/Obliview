import type { Request } from 'express';
import { clearLegacyPartitionedCookie } from '../session';

/**
 * Issues a NEW session id before a session gains privileges (login, 2FA
 * completion, SSO callback), so an id planted in the victim's browser before
 * sign-in (session fixation) never becomes authenticated. The old session row
 * is deleted by express-session. [keep] lists the pre-login fields to carry
 * over (e.g. a requested tenant).
 *
 * The new id reaches the browser only through the session cookie. A leftover
 * Partitioned cookie of an earlier version is deleted in the same response
 * (see clearLegacyPartitionedCookie).
 */
export function regenerateSession(req: Request, keep: string[] = []): Promise<void> {
  const session = req.session as unknown as Record<string, unknown>;
  const carried: Record<string, unknown> = {};
  for (const key of keep) {
    if (session[key] !== undefined) carried[key] = session[key];
  }
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) { reject(err); return; }
      Object.assign(req.session as unknown as Record<string, unknown>, carried);
      clearLegacyPartitionedCookie(req.res);
      resolve();
    });
  });
}
