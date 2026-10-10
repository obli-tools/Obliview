import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Request, Response } from 'express';
import type { SessionData } from 'express-session';
import type { User } from '@obliview/shared';
import { isMasterTenant } from '@obliview/shared';
import { config } from './config';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { tenantService } from './services/tenant.service';
import { sessionMiddleware, dedupeSessionCookieHeader } from './session';
import { db } from './db';
import { permissionService } from './services/permission.service';
import { AGENTS_MANAGE_CAPABILITY } from './middleware/agentRbac';
import { needs2faSetup } from './middleware/require2faSetup';

/**
 * Coerce a session-stored id to a positive integer, or null.
 * Room names are built from this value, so anything that is not a plain
 * integer (e.g. "5:admin") must be rejected to prevent room-name injection.
 */
function toPositiveInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Operator-configured public origins (APP_URL / CLIENT_ORIGIN), normalized. */
const CONFIGURED_ORIGINS = new Set(
  [config.publicUrl, config.clientOrigin]
    .map((u) => { try { return new URL(u).origin; } catch { return null; } })
    .filter((o): o is string => o !== null),
);

/** Hostname (port stripped) of a Host / X-Forwarded-Host header value, or null. */
function headerHostname(value: string | string[] | undefined): string | null {
  const raw = (Array.isArray(value) ? value[0] : value)?.split(',')[0].trim();
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Cross-Site WebSocket Hijacking guard for the engine.io handshake.
 * Sockets authenticate with the ambient session cookie, and neither the
 * `cors` option nor SameSite stops a WebSocket upgrade from another origin
 * (e.g. a sibling subdomain), so the handshake Origin must be the app itself:
 * a configured origin, or the same hostname the request was sent to (Host /
 * X-Forwarded-Host — nginx strips the port from Host, and cookies are not
 * port-scoped anyway). Browsers always send Origin on WebSocket and
 * cross-origin requests; a missing Origin is a same-origin polling request or
 * a non-browser client, which has no ambient cookie and is refused by the
 * session check below.
 */
function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // includes the opaque "null" origin
  }
  if (CONFIGURED_ORIGINS.has(parsed.origin)) return true;
  const hostname = parsed.hostname;
  if (!hostname) return false;
  return hostname === headerHostname(req.headers.host)
    || hostname === headerHostname(req.headers['x-forwarded-host']);
}

/**
 * Run the Express session middleware on the handshake request so the
 * cookie-based session is loaded exactly as it is for HTTP routes.
 * The response object is a stub: nothing is ever written or saved here.
 */
function loadCookieSession(req: IncomingMessage): Promise<Partial<SessionData> | undefined> {
  return new Promise((resolve, reject) => {
    const expressReq = req as Request;
    // Same as legacySessionCookieGuard (app.ts): read the current session
    // cookie, not a leftover Partitioned one (nothing can be written here).
    dedupeSessionCookieHeader(expressReq.headers);
    sessionMiddleware(expressReq, {} as Response, (err?: unknown) => {
      if (err) reject(err);
      else resolve(expressReq.session);
    });
  });
}

/** The Socket.io server, set once by createSocketServer (see getIO). */
let ioInstance: SocketIOServer | null = null;

/**
 * The Socket.io server, for services that act on live connections outside a
 * request (e.g. userSessions.service disconnecting a revoked user's sockets).
 * Throws before createSocketServer has run (CLI, tests): callers catch.
 */
export function getIO(): SocketIOServer {
  if (!ioInstance) throw new Error('Socket.io not initialized');
  return ioInstance;
}

export function createSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.clientOrigin,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    // Runs on every engine.io handshake (polling and direct WebSocket); later
    // requests reuse the handshake's sid, and socket.request — the source of
    // the session cookie below — is always this checked handshake request.
    allowRequest: (req, callback) => {
      if (isAllowedOrigin(req)) return callback(null, true);
      logger.warn({ origin: req.headers.origin, host: req.headers.host }, 'Socket.io handshake rejected: cross-origin request');
      callback('Origin not allowed', false);
    },
  });

  // Socket.io authentication middleware.
  // Identity is derived ONLY from the server-side session behind the session
  // cookie (web client, withCredentials) — never from client-supplied
  // handshake fields (handshake.auth, userId / tenantId are ignored).
  // Like requireAuth, only a completed login counts: a session still waiting
  // for 2FA only holds pendingMfaUserId, never userId, and is rejected.
  io.use(async (socket, next) => {
    try {
      const sess: Partial<SessionData> | undefined = await loadCookieSession(socket.request);

      const userId = toPositiveInt(sess?.userId);
      if (!sess || userId === null) {
        return next(new Error('Authentication required'));
      }

      const user = await authService.getUserById(userId);
      if (!user || !user.isActive) {
        return next(new Error('Invalid user'));
      }

      // Force 2FA: a user who must set up a second factor gets no live data
      // (no room is joined). The client reconnects once a factor is enabled.
      if (await needs2faSetup(user.id)) {
        return next(new Error('2FA_SETUP_REQUIRED'));
      }

      // Tenant rooms follow the session's current tenant (set by login /
      // POST /tenant/switch). Same access rule as the switch route: platform
      // admins may be on any tenant, others only on tenants they belong to.
      let tenantId = toPositiveInt(sess.currentTenantId);
      if (tenantId !== null && user.role !== 'admin') {
        const hasAccess = await tenantService.userHasAccess(user.id, tenantId);
        if (!hasAccess) {
          logger.warn(`Socket: user ${user.id} has no access to session tenant ${tenantId} — tenant rooms not joined`);
          tenantId = null;
        }
      }

      socket.data.user = user;
      socket.data.tenantId = tenantId;
      next();
    } catch (err) {
      logger.error(err, 'Socket authentication failed');
      next(new Error('Authentication failed'));
    }
  });

  // NOTE: no client → server events are handled. If any are added, take the
  // caller's identity / tenant from socket.data only, never from the payload.
  io.on('connection', (socket) => {
    const user: User = socket.data.user;
    const tenantId: number | null = socket.data.tenantId;
    logger.info(`Socket connected: ${user.username} (id: ${user.id}, tenant: ${tenantId ?? 'none'})`);

    // Join user-specific room
    socket.join(`user:${user.id}`);

    // Join tenant-scoped rooms (only when the session tenant was validated)
    if (tenantId !== null) {
      socket.join(`tenant:${tenantId}`);
      // The session tenant's notification room, even without a user_tenants
      // row (platform admins may work in any tenant).
      socket.join(`tenant:${tenantId}:notifications`);
      if (user.role === 'admin') {
        socket.join(`tenant:${tenantId}:admin`);
      } else {
        // agents.manage holders get the agent lifecycle events (device
        // created / updated / deleted, status) of their workspace.
        // Capability changes apply on the next reconnect.
        const sid = tenantId;
        permissionService.userHasTenantCapability(user.id, sid, AGENTS_MANAGE_CAPABILITY)
          .then((ok) => { if (ok) socket.join(`tenant:${sid}:agents`); })
          .catch((err) => logger.error(err, `Failed to resolve agents.manage for socket of user ${user.id}`));
      }
    }

    // God view: a platform admin on the master tenant lists every tenant's
    // monitors, groups and agents, so they join every tenant's admin and
    // notification rooms (one query). Emit sites keep targeting the entity's
    // own tenant rooms. Only platform admins, who can already read
    // everything, get here — this is not the old global `role:admin` room.
    // Tenants created after the connection are joined on the next reconnect.
    if (tenantId !== null && user.role === 'admin' && isMasterTenant(tenantId)) {
      db('tenants')
        .pluck('id')
        .then((ids: unknown[]) => {
          const rooms: string[] = [];
          for (const raw of ids) {
            const tid = toPositiveInt(raw);
            if (tid !== null) rooms.push(`tenant:${tid}:admin`, `tenant:${tid}:notifications`);
          }
          if (rooms.length > 0) socket.join(rooms);
        })
        .catch((err: unknown) => logger.error(err, 'Failed to join god-view tenant rooms'));
    }
    // NOTE: the legacy `role:admin` room join was removed — it was a global
    // cross-tenant room, and by design any admin from any tenant received
    // every other tenant's monitor / heartbeat / agent-push events. That was
    // a cross-tenant data leak + massive amplification. All emit sites now
    // target `tenant:${id}:admin`
    // directly. If a residual `io.to('role:admin').emit(...)` slips through,
    // it becomes a silent no-op — safe fail-closed behaviour.

    // Join notification rooms for ALL tenants this user belongs to (tenant-wide
    // broadcasts). Live alerts are no longer sent there: they go to
    // tenant:{id}:admin + user:{id} of the users who can read the monitor
    // (liveAlert.service), which reaches them whatever tenant they are on.
    db('user_tenants')
      .where('user_id', user.id)
      .pluck('tenant_id')
      .then((tenantIds: unknown[]) => {
        for (const raw of tenantIds) {
          const tid = toPositiveInt(raw);
          if (tid !== null) socket.join(`tenant:${tid}:notifications`);
        }
      })
      .catch((err: unknown) => logger.error(err, 'Failed to join notification rooms'));

    // All authenticated users join the general room
    socket.join('general');

    socket.on('disconnect', () => {
      logger.debug(`Socket disconnected: ${user.username}`);
    });
  });

  ioInstance = io;
  return io;
}
