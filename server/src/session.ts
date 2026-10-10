import session from 'express-session';
import type { NextFunction, Request, Response } from 'express';
import connectPgSimple from 'connect-pg-simple';
import { config } from './config';
import { logger } from './utils/logger';

// Session store + middleware shared by the Express app (app.ts) and the
// Socket.io handshake (socket.ts), so sockets authenticate against the exact
// same server-side sessions as HTTP requests.

const PgSession = connectPgSimple(session);

// Sessions — stored in PostgreSQL via connect-pg-simple.
// Log errors so we can diagnose DB connection drops that would otherwise
// silently cause "Invalid username or password" on the login page.
export const sessionStore = new PgSession({
  conString: config.databaseUrl,
  tableName: 'session',
  createTableIfMissing: false,
});
sessionStore.on('error', (err: Error) => {
  logger.error(err, 'Session store error — sessions may fail until DB connection recovers');
});

/** Name of the session cookie (express-session default). */
export const SESSION_COOKIE_NAME = 'connect.sid';

export const sessionMiddleware = session({
  store: sessionStore,
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Secure:
    //   FORCE_HTTPS=true      → always (explicit HTTPS reverse-proxy setup).
    //   NODE_ENV=production   → 'auto': Secure whenever the request reached
    //                           the server over HTTPS (req.secure, which honours
    //                           X-Forwarded-Proto through `trust proxy`). A
    //                           strict `true` would make express-session refuse
    //                           to send the cookie at all on a plain-HTTP
    //                           install (the default docker-compose serves
    //                           http://host:3000), i.e. nobody could sign in.
    //   development           → off (local http://localhost).
    secure: config.forceHttps ? true : (config.nodeEnv === 'production' ? 'auto' : false),
    httpOnly: true,
    maxAge: config.sessionMaxAge,
    // First-party cookie, as in Obliance: sent on same-site requests and
    // top-level navigations (SSO redirects back from Obligate), never from a
    // cross-site frame or a cross-site POST.
    sameSite: 'lax',
  },
});

/**
 * Earlier versions set the session cookie with `Partitioned` (CHIPS) on
 * FORCE_HTTPS deployments. A partitioned cookie is a different cookie from
 * the unpartitioned one now set: a browser that still holds it sends both,
 * the older (partitioned) one first, and express-session reads the first —
 * a stale id once the user has signed out or in again (sign-in loop). Called
 * whenever a new session id is issued and at sign-out, so the leftover is
 * deleted in the same response. Appended before express-session's own
 * Set-Cookie (written with the headers), so a browser that ignores
 * `Partitioned` deletes first and then stores the new cookie. No-op without
 * FORCE_HTTPS: no partitioned cookie was ever set there.
 */
/**
 * When the browser sends several session cookies (the leftover Partitioned
 * one of an earlier version plus the current one), keep only the LAST one —
 * browsers send the older cookie first — so express-session loads the
 * current session. Returns true when the header was rewritten. Only on
 * FORCE_HTTPS deployments (no partitioned cookie was ever set elsewhere).
 */
export function dedupeSessionCookieHeader(headers: { cookie?: string }): boolean {
  if (!config.forceHttps) return false;
  const raw = headers.cookie;
  if (!raw) return false;
  const prefix = `${SESSION_COOKIE_NAME}=`;
  const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
  const sessionParts = parts.filter((p) => p.startsWith(prefix));
  if (sessionParts.length < 2) return false;
  const others = parts.filter((p) => !p.startsWith(prefix));
  headers.cookie = [...others, sessionParts[sessionParts.length - 1]].join('; ');
  return true;
}

/**
 * Express middleware (before cookieParser / sessionMiddleware): drops the
 * stale duplicate session cookie from the request and deletes the leftover
 * Partitioned cookie in the response, so every route (SSO redirect/callback
 * included) sees the current session.
 */
export function legacySessionCookieGuard(req: Request, res: Response, next: NextFunction): void {
  if (dedupeSessionCookieHeader(req.headers)) clearLegacyPartitionedCookie(res);
  next();
}

export function clearLegacyPartitionedCookie(res: Response | undefined): void {
  if (!config.forceHttps || !res || res.headersSent) return;
  res.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    partitioned: true,
  });
}
