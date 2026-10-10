import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Read server version from package.json at startup.
// process.cwd() is the server directory in both dev (npx tsx) and Docker (WORKDIR /app/server).
let serverVersion = 'dev';
try {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
  serverVersion = pkg.version;
} catch { /* ignore */ }
import { config, weakSecretProblems } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { captureStepUpProof } from './middleware/captureStepUpProof';
import { sessionUserGuard } from './middleware/sessionUserGuard';
import { require2faSetup } from './middleware/require2faSetup';
import { routes } from './routes';
import { sessionMiddleware, legacySessionCookieGuard } from './session';
import { logger } from './utils/logger';

export function createApp() {
  const app = express();

  // Weak / default secrets in production: logged loudly at every boot. The
  // server still starts (an existing deployment must never be taken down by
  // this check), but sessions signed with a published secret can be forged.
  for (const problem of weakSecretProblems()) {
    logger.error(
      `SECURITY: ${problem}. Set a random value of 32+ characters (e.g. \`openssl rand -hex 32\`) in the environment and restart. Until then, session cookies may be forgeable.`
      + (process.env.ENCRYPTION_KEY
        ? ''
        : ' Stored SSH remediation credentials are encrypted with SESSION_SECRET: when rotating it, set ENCRYPTION_KEY (or SESSION_SECRET_PREVIOUS) to the old value so they stay readable.'),
    );
  }

  // Trust the first reverse proxy hop so req.ip uses X-Forwarded-For.
  // Required for accurate rate limiting when behind Nginx / Nginx Proxy Manager.
  app.set('trust proxy', 1);

  // Security headers.
  // Framing is limited to this app's own origin (X-Frame-Options SAMEORIGIN +
  // CSP frame-ancestors 'self'): a same-site frame (e.g. a sibling
  // subdomain) would receive the SameSite=Lax session cookie and could
  // clickjack signed-in actions. ObliTools hosts the apps in top-level
  // WebView2 windows, not iframes; should an iframe host ever be needed
  // again, list its exact origin in frameAncestors.
  app.use(
    helmet({
      frameguard: { action: 'sameorigin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],  // Tailwind injects inline styles
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'", "wss:", "ws:"],     // Socket.io WebSocket
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    }),
  );
  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
    }),
  );

  // Parsing — cookieParser must come before session (session reads the cookie).
  app.use(express.json({ limit: '1mb' }));
  // A leftover Partitioned session cookie of an earlier version would be
  // read instead of the current one (session.ts): drop / delete it first.
  app.use(legacySessionCookieGuard);
  app.use(cookieParser());

  // Step-up proofs (currentPassword / currentCode) are copied to
  // req.stepUpProof before any validate() can strip them from the body.
  // See middleware/captureStepUpProof.ts.
  app.use(captureStepUpProof);

  // Sessions — stored in PostgreSQL via connect-pg-simple (see session.ts;
  // the same store/middleware also authenticates Socket.io handshakes).
  // MUST be set up before apiLimiter so that req.session.userId is available
  // in the limiter's skip() function (authenticated users are excluded from
  // rate limiting to avoid shared-IP false positives behind a reverse proxy).
  app.use(sessionMiddleware);

  // CSRF guard. The session cookie is SameSite=Lax (session.ts), which keeps
  // it off cross-site POSTs, but a same-site origin (e.g. a sibling
  // subdomain) still gets it: unsafe methods from a browser must come from
  // this app's own origin. Non-browser clients (agents, push heartbeats,
  // server-to-server calls: no Origin and no Sec-Fetch-Site) are not affected.
  const allowedOrigin = config.clientOrigin.replace(/\/+$/, '');
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const sfs = req.headers['sec-fetch-site'];
    if (sfs === 'same-origin' || sfs === 'none') return next();
    const origin = req.headers.origin;
    if (!origin && !sfs) return next();
    if (origin) {
      if (origin.replace(/\/+$/, '') === allowedOrigin) return next();
      try {
        const host = new URL(origin).host;
        const forwardedHost = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim();
        if (host === req.headers.host || (forwardedHost && host === forwardedHost)) return next();
      } catch { /* malformed Origin: rejected below */ }
    }
    res.status(403).json({ success: false, error: 'Cross-site request rejected' });
  });

  // The session's user is re-read (is_active, role — cached 5 s): a session
  // of a disabled or deleted user dies, a demoted admin's session loses the
  // role, even if an in-flight request saved the row back after
  // killSessionsForUser deleted it. See middleware/sessionUserGuard.ts.
  app.use(sessionUserGuard);

  // Rate limiting — runs after session so authenticated users can be skipped.
  // Only unauthenticated endpoints (login page, public health, etc.) are limited.
  app.use(apiLimiter);

  // Obligate SSO callback (browser redirect, NOT under /api)
  const obligateCallback = require('./routes/obligateCallback.routes').default;
  app.use('/auth', obligateCallback);

  // "Force 2FA": a signed-in local user without any second factor only
  // reaches /api/auth/* and its own /api/profile (2FA setup) until one is
  // enabled — 403 { code: '2FA_SETUP_REQUIRED' } otherwise. Runs after
  // sessionUserGuard (dead sessions are already anonymous). See
  // middleware/require2faSetup.ts.
  app.use('/api', require2faSetup);

  // API routes
  app.use('/api', routes);

  // Health check (public — also used by login page to display server version)
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: serverVersion, timestamp: new Date().toISOString() });
  });

  // Obli.tools unified desktop app downloads — serves pre-built binaries from obli.tools/dist/.
  // Whitelist prevents directory traversal; graceful 404 if a file isn't built yet.
  const DESKTOP_FILES: Record<string, string> = {
    'ObliTools.exe':          'ObliTools.exe',          // Windows binary (portable)
    'ObliToolsSetup.msi':     'ObliToolsSetup.msi',     // Windows installer (Start Menu shortcut)
    'ObliTools-arm64.zip':    'ObliTools-arm64.zip',    // macOS Apple Silicon — .app zipped
    'ObliTools-amd64.zip':    'ObliTools-amd64.zip',    // macOS Intel — .app zipped
    'ObliTools-arm64.dmg':    'ObliTools-arm64.dmg',    // macOS Apple Silicon — drag-to-Applications DMG
    'ObliTools-amd64.dmg':    'ObliTools-amd64.dmg',    // macOS Intel — drag-to-Applications DMG
  };
  // process.cwd() = server/ directory (both in dev with npx tsx and in production).
  // Go one level up to reach the project root, then into obli.tools/dist.
  const desktopDistDir = path.resolve(process.cwd(), '..', 'obli.tools', 'dist');

  app.get('/downloads/:filename', (req, res) => {
    const mapped = DESKTOP_FILES[req.params.filename];
    if (!mapped) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const filePath = path.join(desktopDistDir, mapped);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not yet available' });
      return;
    }
    res.download(filePath, mapped);
  });

  // Serve static client build in production
  if (!config.isDev) {
    const clientDist = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // Error handling
  app.use(errorHandler);

  return app;
}
