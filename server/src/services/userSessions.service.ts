import { db } from '../db';
import { getIO } from '../socket';
import { logger } from '../utils/logger';
import { forgetSessionUser } from '../middleware/sessionUserGuard';
import { forgetTenantAccess } from '../middleware/tenant';
import { sessionHash, sessionRoom } from '../utils/sessionHash';

// Session kill-switch for one user.
//
// requireAuth only checks that req.session.userId is set, and requireRole /
// the admin bypasses read req.session.role: a session outlives a
// deactivation, a deletion or a demotion of its user until it expires
// (7 days). Every path that takes access away calls this to delete the
// user's rows from the connect-pg-simple `session` table (sess is JSON),
// including half-open sign-ins (pendingMfaUserId), and to drop the user's
// live Socket.io connections (room `user:<id>`, joined at handshake).
//
// Deleting rows alone is not enough: a request already in flight saves its
// session back when it ends. middleware/sessionUserGuard.ts re-reads the
// user on every request (its cache entry is dropped here), so such a
// resurrected row dies on its next use.

export async function killSessionsForUser(userId: number, reason = 'unspecified'): Promise<number> {
  if (!Number.isInteger(userId) || userId <= 0) return 0;
  const uid = String(userId);
  // Text comparison (not ::int) so one malformed row can never make the
  // whole DELETE fail.
  const res = await db.raw(
    `DELETE FROM session
      WHERE (sess::jsonb ->> 'userId') = ?
         OR (sess::jsonb ->> 'pendingMfaUserId') = ?`,
    [uid, uid],
  ) as { rowCount?: number } | undefined;
  const count = Number(res?.rowCount ?? 0);
  forgetSessionUser(userId);
  forgetTenantAccess(userId);
  try {
    getIO().in(`user:${userId}`).disconnectSockets(true);
  } catch { /* Socket.io not initialised (CLI, tests) */ }
  logger.info({ userId, reason, count }, 'user sessions killed');
  return count;
}

export { forgetSessionUser, sessionHash, sessionRoom };
