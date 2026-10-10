/** APP_URL, else CLIENT_ORIGIN unless it is a loopback (dev) origin — same rule as Obliance. */
function publicUrlFromEnv(): string {
  const appUrl = (process.env.APP_URL || '').trim();
  if (appUrl) return appUrl.replace(/\/+$/, '');
  const clientOrigin = (process.env.CLIENT_ORIGIN || '').trim();
  try {
    const host = new URL(clientOrigin).hostname;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host)) return '';
  } catch {
    return '';
  }
  return clientOrigin.replace(/\/+$/, '');
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: (process.env.NODE_ENV || 'development') === 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || 'postgres://obliview:changeme@localhost:5432/obliview',

  // Session
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  sessionMaxAge: 7 * 24 * 60 * 60 * 1000, // 7 days

  // CORS
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',

  // HTTPS — set to "true" if behind an HTTPS reverse proxy
  forceHttps: process.env.FORCE_HTTPS === 'true',

  // App name (used as prefix in SMS/push notifications)
  appName: process.env.APP_NAME || 'Obliview',

  // Default admin
  defaultAdminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
  defaultAdminPassword: process.env.DEFAULT_ADMIN_PASSWORD || 'admin123',

  // 2FA bypass — set DISABLE_2FA_FORCE=true to skip forced 2FA requirement
  disable2faForce: process.env.DISABLE_2FA_FORCE === 'true',

  // Optional explicit public URL; CLIENT_ORIGIN is the fallback (see publicUrl)
  appUrl: process.env.APP_URL || '',
  // The public address of this instance: APP_URL, else CLIENT_ORIGIN when it
  // isn't a loopback dev default. Never derived from a request header.
  // Used for SSO redirect_uri, socket.io origin check and password reset links.
  publicUrl: publicUrlFromEnv(),
};

/** Placeholder secrets shipped in this repo (config fallback, compose files, .env.example). */
const PUBLISHED_DEFAULT_SECRETS = new Set([
  'dev-secret-change-me',
  'change-this-in-production',
  'change-this-to-a-random-secret',
  'dev-secret',
]);
const MIN_SECRET_LENGTH = 32;

function secretProblem(name: string, value: string | undefined): string | null {
  if (!value) return `${name} is not set`;
  if (PUBLISHED_DEFAULT_SECRETS.has(value)) return `${name} uses a default value published in the repository`;
  if (value.length < MIN_SECRET_LENGTH) return `${name} is shorter than ${MIN_SECRET_LENGTH} characters`;
  return null;
}

/**
 * Weak-secret check for production (NODE_ENV=production). A session secret
 * that is unset (config falls back to a public default), a published
 * placeholder or shorter than 32 chars lets anyone who reads the repository
 * forge session cookies. Same rule for ENCRYPTION_KEY when it is set.
 *
 * Returns the problems found (empty when fine or not in production). The
 * caller (app.ts) logs them loudly; the server still starts, so an existing
 * deployment is never taken down by this check.
 */
export function weakSecretProblems(): string[] {
  if (config.nodeEnv !== 'production') return [];
  const problems: string[] = [];
  const session = secretProblem('SESSION_SECRET', process.env.SESSION_SECRET);
  if (session) problems.push(session);
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (encryptionKey !== undefined && encryptionKey !== '') {
    const enc = secretProblem('ENCRYPTION_KEY', encryptionKey);
    if (enc) problems.push(enc);
  }
  return problems;
}
