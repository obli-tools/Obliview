import { appConfigService } from './appConfig.service';
import { config } from '../config';
import { logger } from '../utils/logger';
import { safeEqualSecret } from '../utils/safeCompare';
import { db } from '../db';

/** Obliview's brand accent, announced to Obligate (self-info) for every app switcher in the suite. */
export const APP_ACCENT_COLOR = '#2bc4bd';

export interface ObligateUserAssertion {
  obligateUserId: number;
  username: string;
  email: string | null;
  displayName: string | null;
  role: string;
  tenants: Array<{ slug: string; role: string }>;
  teams: string[];
  authSource: 'local' | 'ldap';
  linkedLocalUserId: number | null;
  preferences?: {
    preferredTheme?: string;
    toastEnabled?: boolean;
    toastPosition?: string;
    profilePhotoUrl?: string | null;
    preferredLanguage?: string;
    anonymousMode?: boolean;
    appSpecific?: Record<string, string>;
  };
}

/** How long the connected apps' origins (device-link filter) are cached. */
const APP_ORIGINS_TTL_MS = 60 * 1000;
/** Obligate allows its sso-user-sync pushes 5 s: the outbound reads stay under it. */
const PUSH_READ_TIMEOUT_MS = 4_000;

/** One user of Obligate's roster for this app (GET /api/apps/users). */
export interface ObligateRosterEntry {
  /** The role Obligate gives this user on this app ('admin' = platform admin). */
  role: string;
  /** Tenant grants (slug + permission set slug), as an SSO assertion carries them. */
  tenants: Array<{ slug: string; role: string }>;
  /** Team NAMES, matched per granted tenant. */
  teams: string[];
}
/** Obligate user id → roster entry. */
export type ObligateRoster = Map<number, ObligateRosterEntry>;

/** GET /api/oauth/users/:id/mfa-epoch, as read by us. */
export interface ObligateMfaEpoch {
  mfaEpoch: number;
  /** false when Obligate says the user may not use this app (optional field, default true). */
  active: boolean;
}

/**
 * GET /api/oauth/users/:id/mfa-epoch, three ways:
 *  - 'ok'          the identity is known to Obligate for this app;
 *  - 'not_found'   Obligate's own JSON 404 {success:false}: no such user, or
 *                  no SSO sign-in of the user to this app — for an og_ account
 *                  (which exists here only after such a sign-in): the identity
 *                  is gone at Obligate;
 *  - 'unavailable' anything else (not configured, network, timeout, 5xx,
 *                  another 4xx, a 404 that is not Obligate's JSON — an older
 *                  Obligate without the route —, unreadable 2xx).
 */
export type ObligateEpochRead =
  | { kind: 'ok'; value: ObligateMfaEpoch }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

/** A read started by an inbound sso-user-sync push: 'throttled' = not started (budget, see PUSH_READ_BUDGET). */
export type PushEpochRead = ObligateEpochRead | { kind: 'throttled' };
export type PushRosterRead = { kind: 'ok'; roster: ObligateRoster } | { kind: 'unavailable' } | { kind: 'throttled' };

/**
 * Outbound reads started by inbound sso-user-sync pushes — whose Bearer
 * secret may be public (it may be the API key) — share this budget: a token
 * bucket over time (not only a concurrency cap), so that no stream of pushes,
 * however paced, can spend this app's request budget at Obligate (its
 * apiLimiter: 500 requests per 5 min per client IP, shared with the sign-in
 * code exchange). A read joined to one already in flight or queued costs
 * nothing. Beyond the budget the read is not made ('throttled') and the
 * change is re-checked later.
 * Per Obligate user, a push-triggered epoch read is not repeated within
 * `userGapMs` of the previous one.
 */
export const PUSH_READ_BUDGET = { capacity: 20, refillPerMinute: 12, userGapMs: 10_000 };
let pushReadTokens = PUSH_READ_BUDGET.capacity;
let pushReadRefilledAt = 0;
/** Last time the "budget exhausted" warning was logged (once a minute at most). */
let pushBudgetWarnedAt = 0;
function takePushReadToken(): boolean {
  const now = Date.now();
  const elapsed = pushReadRefilledAt === 0 ? 0 : Math.max(0, now - pushReadRefilledAt);
  pushReadRefilledAt = now;
  pushReadTokens = Math.min(PUSH_READ_BUDGET.capacity, pushReadTokens + (elapsed * PUSH_READ_BUDGET.refillPerMinute) / 60_000);
  if (pushReadTokens < 1) {
    if (now - pushBudgetWarnedAt > 60_000) {
      pushBudgetWarnedAt = now;
      logger.warn({ budget: PUSH_READ_BUDGET },
        'Obligate: inbound sso-user-sync pushes exceed the outbound read budget — reads throttled (check who holds the Obligate API key / inbound secret)');
    }
    return false;
  }
  pushReadTokens -= 1;
  return true;
}
// Epoch reads triggered by pushes (see mfaEpochForPush): per Obligate user,
// one in flight plus one queued, and when the last one ended.
const pushEpochReads = new Map<number, { inflight: Promise<ObligateEpochRead>; queued: Promise<PushEpochRead> | null }>();
const pushEpochDoneAt = new Map<number, number>();
const THROTTLED = { kind: 'throttled' } as const;

// Roster reads (see getAppRoster): at most one in flight, plus one queued
// behind it that every caller arriving meanwhile shares.
let rosterInflight: { promise: Promise<ObligateRoster | null> } | null = null;
let rosterQueued: Promise<ObligateRoster | null> | null = null;

async function fetchRoster(): Promise<ObligateRoster | null> {
  const raw = await appConfigService.getObligateRaw();
  if (!raw.url || !raw.apiKey) return null;
  try {
    const res = await fetch(`${raw.url}/api/apps/users`, {
      headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      signal: AbortSignal.timeout(PUSH_READ_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`Obligate roster fetch failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json() as { success?: boolean; data?: unknown };
    if (!data?.success || !Array.isArray(data.data)) return null;
    const roster: ObligateRoster = new Map();
    for (const item of data.data) {
      const u = item as { obligateUserId?: unknown; role?: unknown; tenants?: unknown; teams?: unknown } | null;
      const id = u?.obligateUserId;
      if (!u || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
      if (typeof u.role !== 'string' || !u.role) continue; // no role = no access here
      const tenants = Array.isArray(u.tenants)
        ? (u.tenants as unknown[])
          .filter((t): t is { slug: string; role: string } =>
            !!t && typeof (t as { slug?: unknown }).slug === 'string' && typeof (t as { role?: unknown }).role === 'string')
          .map((t) => ({ slug: t.slug, role: t.role }))
        : [];
      const teams = Array.isArray(u.teams) ? (u.teams as unknown[]).filter((n): n is string => typeof n === 'string') : [];
      roster.set(id, { role: u.role, tenants, teams });
    }
    return roster;
  } catch (err) {
    logger.warn(err, 'Obligate roster fetch error');
    return null;
  }
}

function startRosterFetch(): Promise<ObligateRoster | null> {
  const entry = { promise: fetchRoster() };
  rosterInflight = entry;
  const clear = () => { if (rosterInflight === entry) rosterInflight = null; };
  entry.promise.then(clear, clear);
  return entry.promise;
}

/** The read queued behind the one in flight (created once, shared). */
function queueRosterFetch(inflight: { promise: Promise<ObligateRoster | null> }): Promise<ObligateRoster | null> {
  if (!rosterQueued) {
    const next = () => {
      rosterQueued = null;
      return startRosterFetch();
    };
    rosterQueued = inflight.promise.then(next, next);
  }
  return rosterQueued;
}

/** Obligate's usual envelope {success, data}; a bare object is read as is. */
function envelopeData(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { success?: unknown; data?: unknown };
  if (b.success === false) return null;
  if (b.data && typeof b.data === 'object' && !Array.isArray(b.data)) return b.data as Record<string, unknown>;
  return b as Record<string, unknown>;
}

/**
 * One uncached GET /api/oauth/users/:id/mfa-epoch (see ObligateEpochRead).
 * Only Obligate's JSON 404 counts as 'not_found': any other failure is
 * 'unavailable', so an outage never reads as "the identity is gone".
 */
async function readMfaEpoch(obligateUserId: number): Promise<ObligateEpochRead> {
  const unavailable = { kind: 'unavailable' } as const;
  if (!Number.isSafeInteger(obligateUserId) || obligateUserId <= 0) return unavailable;
  const raw = await appConfigService.getObligateRaw();
  if (!raw.url || !raw.apiKey) return unavailable;
  try {
    const res = await fetch(`${raw.url}/api/oauth/users/${encodeURIComponent(String(obligateUserId))}/mfa-epoch`, {
      headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      signal: AbortSignal.timeout(PUSH_READ_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { success?: unknown } | null;
    if (res.status === 404 && body && typeof body === 'object' && body.success === false) {
      logger.info({ obligateUserId }, 'Obligate mfa-epoch: 404 — no such user, or no SSO sign-in of the user to this app');
      return { kind: 'not_found' };
    }
    if (!res.ok) {
      logger.warn({ obligateUserId, status: res.status }, 'Obligate mfa-epoch: non-2xx');
      return unavailable;
    }
    const data = envelopeData(body);
    const mfaEpoch = data?.mfaEpoch;
    if (!data || typeof mfaEpoch !== 'number' || !Number.isSafeInteger(mfaEpoch) || mfaEpoch < 0) return unavailable;
    return { kind: 'ok', value: { mfaEpoch, active: data.active !== false } };
  } catch (err) {
    logger.warn({ err, obligateUserId }, 'Obligate mfa-epoch: unreachable');
    return unavailable;
  }
}

/** Normalised `scheme://host[:port]` of an http(s) URL (lower-case host, no default port), or null. */
function toHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** localhost / loopback origin: for another machine's browser, that is itself. */
function isLoopbackOrigin(origin: string): boolean {
  const { hostname } = new URL(origin);
  return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname);
}

/**
 * This app's public origin: config.publicUrl (APP_URL, else CLIENT_ORIGIN),
 * or the loopback CLIENT_ORIGIN in dev. Null if unparsable.
 */
function publicOrigin(): string | null {
  return toHttpOrigin(config.publicUrl || config.clientOrigin);
}

export const obligateService = {
  /**
   * Check if Obligate is configured and reachable.
   */
  async getSsoConfig(): Promise<{ obligateUrl: string | null; obligateReachable: boolean; obligateEnabled: boolean }> {
    const cfg = await appConfigService.getObligateConfig();
    if (!cfg.url || !cfg.enabled) {
      return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: cfg.enabled };
    }

    // Quick reachability check (2s timeout)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${cfg.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return { obligateUrl: cfg.url, obligateReachable: res.ok, obligateEnabled: true };
    } catch {
      return { obligateUrl: cfg.url, obligateReachable: false, obligateEnabled: true };
    }
  },

  /**
   * Authenticate a server-to-server call made by Obligate to this app
   * (`Authorization: Bearer <secret>`): sso-user-sync, app-info,
   * dashboard-stats.
   *
   * The expected secret is the distinct inbound secret when one is set
   * (OBLIGATE_INBOUND_SECRET, else the Settings value), otherwise the API key
   * (the historical behaviour). Constant-time, and fails closed when nothing
   * is configured.
   *
   * The API key may have leaked (it used to be sent as client_id through the
   * browser): these routes must never grant more than a key holder may do.
   */
  async verifyInboundBearer(authHeader: string | string[] | undefined): Promise<boolean> {
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return false;
    const raw = await appConfigService.getObligateRaw();
    const expected = raw.inboundSecret ?? raw.apiKey;
    return safeEqualSecret(authHeader.slice(7), expected);
  },

  /**
   * Resolve the local account linked to an Obligate identity, from OUR records
   * only: the sso_foreign_users row of that identity (pointing to an account
   * provisioned by the SSO callback), or — for an account whose link row is
   * missing — the account created for that identity (users.foreign_id).
   *
   * Obligate's `linkedLocalUserId` / `remoteUserId` must never be trusted on
   * their own: they are only Obligate's copy of what we reported through
   * report-provision, and can be stale or rewritten by any holder of the API key.
   * Returns null when no local account is linked.
   */
  async getLinkedLocalUserId(obligateUserId: number): Promise<number | null> {
    if (!Number.isInteger(obligateUserId) || obligateUserId <= 0) return null;

    const link = await db('sso_foreign_users as l')
      .join('users as u', 'u.id', 'l.local_user_id')
      .where({ 'l.foreign_source': 'obligate', 'l.foreign_user_id': obligateUserId, 'u.foreign_source': 'obligate' })
      .first('u.id') as { id: number } | undefined;
    if (link) return link.id;

    const provisioned = await db('users')
      .where({ foreign_source: 'obligate', foreign_id: obligateUserId })
      .orderBy('id', 'desc')
      .first('id') as { id: number } | undefined;
    return provisioned?.id ?? null;
  },

  /**
   * Obligate's current roster for this app (GET /api/apps/users): every
   * Obligate user who may sign in here right now (active, not disabled on this
   * app, with a role), keyed by Obligate user id, with the role, tenants and
   * teams Obligate gives them on this app (what an SSO assertion carries).
   * Fetched live from the configured Obligate URL, so it can't be forged by
   * whoever calls our inbound endpoints.
   *
   * At most one read in flight. A caller arriving while one runs waits for the
   * NEXT read (shared by every caller arriving meanwhile): the running one may
   * have started before the change being confirmed was made in Obligate. So a
   * burst costs Obligate at most one read at a time; pushes go through
   * rosterForPush(), which also bounds the reads over time.
   * Returns null when Obligate is not configured or doesn't answer.
   */
  getAppRoster(): Promise<ObligateRoster | null> {
    if (!rosterInflight) return startRosterFetch();
    return queueRosterFetch(rosterInflight);
  },

  /**
   * getAppRoster() for an inbound sso-user-sync push or its re-check: same
   * coalescing, and starting a NEW read (none in flight, or no read queued
   * yet) takes a token of PUSH_READ_BUDGET — 'throttled' when none is left
   * (nothing is sent to Obligate). Joining a queued read is free.
   */
  async rosterForPush(): Promise<PushRosterRead> {
    let p: Promise<ObligateRoster | null>;
    if (!rosterInflight) {
      if (!takePushReadToken()) return THROTTLED;
      p = startRosterFetch();
    } else if (rosterQueued) {
      p = rosterQueued;
    } else {
      if (!takePushReadToken()) return THROTTLED;
      p = queueRosterFetch(rosterInflight);
    }
    const roster = await p.catch(() => null);
    return roster ? { kind: 'ok', roster } : { kind: 'unavailable' };
  },

  /** The user's MFA epoch at Obligate, with the three outcomes (see ObligateEpochRead). Uncached. */
  readMfaEpochDetailed(obligateUserId: number): Promise<ObligateEpochRead> {
    return readMfaEpoch(obligateUserId);
  },

  /**
   * readMfaEpochDetailed() started by an inbound sso-user-sync push, whose
   * secret may be public — it must not be an outbound-call amplifier:
   *   - concurrent pushes for one user share one read in flight plus ONE
   *     queued read (started once the running one ended, so every caller gets
   *     a read begun after its own push arrived);
   *   - otherwise, no new read for a user within PUSH_READ_BUDGET.userGapMs of
   *     the previous one, and every new read takes a token of the global
   *     PUSH_READ_BUDGET: 'throttled' (nothing sent) beyond them.
   */
  mfaEpochForPush(obligateUserId: number): Promise<PushEpochRead> {
    const id = obligateUserId;
    const start = (): Promise<PushEpochRead> => {
      if (!takePushReadToken()) {
        pushEpochReads.delete(id); // (a queued start: its slot ends here)
        return Promise.resolve(THROTTLED);
      }
      const p = readMfaEpoch(id).catch((): ObligateEpochRead => ({ kind: 'unavailable' }));
      const entry: { inflight: Promise<ObligateEpochRead>; queued: Promise<PushEpochRead> | null } = { inflight: p, queued: null };
      pushEpochReads.set(id, entry);
      void p.then(() => {
        if (pushEpochDoneAt.size >= 10_000) pushEpochDoneAt.clear();
        pushEpochDoneAt.set(id, Date.now());
        if (pushEpochReads.get(id) === entry && !entry.queued) pushEpochReads.delete(id);
      });
      return p;
    };
    const slot = pushEpochReads.get(id);
    if (slot) {
      if (!slot.queued) slot.queued = slot.inflight.then(() => start());
      return slot.queued;
    }
    const last = pushEpochDoneAt.get(id);
    if (last !== undefined && Date.now() - last < PUSH_READ_BUDGET.userGapMs) return Promise.resolve(THROTTLED);
    return start();
  },

  /**
   * Check the public origin a browser reached us through — derived from the
   * Host / X-Forwarded-* request headers, which any client can forge — against
   * the origin this app is really published under (APP_URL, else CLIENT_ORIGIN).
   * Matching is on host[:port], or on the hostname alone when the candidate
   * has no port (nginx's `$host`, forwarded by client/nginx.conf, drops it).
   * Only the trusted origin is returned — its scheme and port win over the
   * headers — so a forged Host can never put a foreign redirect_uri in play.
   * Exception: when that origin is loopback (dev: Vite on :5173,
   * API on :3001), any loopback candidate is kept as-is — a code sent to the
   * browser's own machine can't reach an attacker.
   * Null when the host doesn't match.
   */
  verifyPublicOrigin(candidate: string): string | null {
    const origin = toHttpOrigin(candidate);
    const trusted = publicOrigin();
    if (!origin || !trusted) return null;
    if (isLoopbackOrigin(trusted) && isLoopbackOrigin(origin)) return origin;
    const { host, hostname, port } = new URL(origin);
    const t = new URL(trusted);
    return t.host === host || (port === '' && t.hostname === hostname) ? trusted : null;
  },

  /**
   * Where to restart the SSO flow when the browser reached us through a host
   * this app isn't published under (LAN IP, second DNS name, other URL typed
   * in ObliTools…): APP_URL, else CLIENT_ORIGIN. Null when loopback (it would point
   * the browser at its own machine — e.g. the docker-compose default
   * CLIENT_ORIGIN=http://localhost).
   */
  getCanonicalOrigin(): string | null {
    const origin = publicOrigin();
    return origin && !isLoopbackOrigin(origin) ? origin : null;
  },

  /**
   * Exchange an authorization code with Obligate for user info.
   */
  async exchangeCode(code: string, redirectUri: string): Promise<ObligateUserAssertion | null> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      logger.warn('Obligate exchange failed: not configured');
      return null;
    }

    try {
      const res = await fetch(`${raw.url}/api/oauth/token/exchange`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${raw.apiKey}`,
        },
        body: JSON.stringify({ code, redirect_uri: redirectUri }),
      });

      if (!res.ok) {
        logger.warn(`Obligate exchange failed: HTTP ${res.status}`);
        return null;
      }

      const data = await res.json() as { success: boolean; data?: ObligateUserAssertion };
      if (!data.success || !data.data) return null;

      return data.data;
    } catch (err) {
      logger.error(err, 'Obligate exchange error');
      return null;
    }
  },

  /**
   * Report a provisioned user back to Obligate.
   */
  async reportProvision(obligateUserId: number, remoteUserId: number): Promise<void> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      await fetch(`${raw.url}/api/apps/report-provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${raw.apiKey}`,
        },
        body: JSON.stringify({ obligateUserId, remoteUserId }),
      });
    } catch (err) {
      logger.error(err, 'Failed to report provision to Obligate');
    }
  },

  /**
   * Register a device UUID + path with Obligate for cross-app linking.
   * Throttled: only calls Obligate once every 10 minutes per UUID.
   * Failed attempts don't update the throttle so the next push retries.
   */
  _linkThrottle: new Map<string, number>(),
  async registerDeviceLink(uuid: string, appPath: string): Promise<void> {
    const now = Date.now();
    if (now - (this._linkThrottle.get(uuid) ?? 0) < 10 * 60 * 1000) return;

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetch(`${raw.url}/api/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${raw.apiKey}`,
        },
        body: JSON.stringify({ uuid, path: appPath }),
      });
      if (res.ok) this._linkThrottle.set(uuid, now);
    } catch { /* non-critical — will retry on next push */ }
  },

  /**
   * Get cross-app links for a device UUID from Obligate.
   */
  async getDeviceLinks(uuid: string): Promise<Array<{ appType: string; name: string; url: string; icon: string | null; color: string | null }>> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];

    try {
      const res = await fetch(`${raw.url}/api/devices/links?uuid=${encodeURIComponent(uuid)}`, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { success: boolean; data?: Array<{ appType: string; name: string; url: string; icon: string | null; color: string | null }> };
      const links = Array.isArray(data.data) ? data.data : [];
      if (links.length === 0) return [];
      // A link is `<app base URL><path>`, and the path is whatever the app
      // registered (POST /api/devices/register, authenticated by an app key
      // alone). A path like "@evil.example/x" or ".evil.example" turns it into
      // a link to another site, shown on our device page: keep only http(s)
      // links without credentials whose origin is the registered base URL of
      // their app.
      const origins = await this.getConnectedAppOrigins();
      return links.filter((l) => {
        if (!l || typeof l.url !== 'string' || typeof l.appType !== 'string') return false;
        try {
          const u = new URL(l.url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
          if (u.username || u.password) return false;
          return origins.get(l.appType)?.has(u.origin) ?? false;
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  },

  /**
   * Origins of the active connected apps, by app type (cached 1 min): what a
   * cross-app device link may point to (see getDeviceLinks).
   */
  _appOriginsCache: null as { at: number; map: Map<string, Set<string>> } | null,
  async getConnectedAppOrigins(): Promise<Map<string, Set<string>>> {
    const now = Date.now();
    if (this._appOriginsCache && now - this._appOriginsCache.at < APP_ORIGINS_TTL_MS) return this._appOriginsCache.map;
    const map = new Map<string, Set<string>>();
    for (const a of await this.getConnectedApps()) {
      const o = typeof a.baseUrl === 'string' ? toHttpOrigin(a.baseUrl) : null;
      if (!o || typeof a.appType !== 'string') continue;
      if (!map.has(a.appType)) map.set(a.appType, new Set());
      map.get(a.appType)!.add(o);
    }
    if (map.size > 0) this._appOriginsCache = { at: now, map };
    return map;
  },

  /**
   * Fetch latest preferences from Obligate and sync to local DB.
   * Throttled: once per 60s per user. Runs in background, never throws.
   */
  _prefThrottle: new Map<number, number>(),
  async syncUserPreferences(localUserId: number, obligateUserId: number): Promise<void> {
    const now = Date.now();
    if (now - (this._prefThrottle.get(localUserId) ?? 0) < 60 * 1000) return;

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return;

    try {
      const res = await fetch(`${raw.url}/api/apps/user-preferences/${obligateUserId}`, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
      });
      if (!res.ok) return;
      this._prefThrottle.set(localUserId, now);

      const { success, data } = await res.json() as { success: boolean; data?: {
        preferredTheme?: string; toastEnabled?: boolean; toastPosition?: string;
        preferredLanguage?: string; anonymousMode?: boolean; profilePhotoUrl?: string | null;
      } };
      if (!success || !data) return;

      // Sync language + avatar columns
      const colUpdate: Record<string, unknown> = {};
      if (data.preferredLanguage) colUpdate.preferred_language = data.preferredLanguage;
      if (data.profilePhotoUrl !== undefined) colUpdate.avatar = data.profilePhotoUrl;
      if (Object.keys(colUpdate).length > 0) {
        await db('users').where({ id: localUserId }).update(colUpdate);
      }

      // Sync UI prefs into preferences JSON
      const uiPrefs: Record<string, unknown> = {};
      if (data.preferredTheme) uiPrefs.preferredTheme = data.preferredTheme;
      if (data.toastEnabled !== undefined) uiPrefs.toastEnabled = data.toastEnabled;
      if (data.toastPosition) uiPrefs.toastPosition = data.toastPosition;
      if (data.anonymousMode !== undefined) uiPrefs.anonymousMode = data.anonymousMode;
      if (Object.keys(uiPrefs).length > 0) {
        const row = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
        const existing = (typeof row?.preferences === 'string' ? JSON.parse(row.preferences) : row?.preferences) ?? {};
        await db('users').where({ id: localUserId }).update({
          preferences: JSON.stringify({ ...existing, ...uiPrefs }),
        });
      }
    } catch { /* non-critical */ }
  },

  /**
   * Get the list of connected apps from Obligate (for cross-app nav buttons).
   *
   * When `obligateUserId` is provided, the Obligate-side endpoint filters the
   * list to only the apps this user has at least one permission mapping on
   * (or all apps when the user is a platform admin). When omitted (local
   * user without an Obligate identity), falls back to the unfiltered list.
   */
  /**
   * Announce Obliview's own branding to Obligate (POST /api/apps/self-info).
   * Obligate stores the announced accent color as-is, so every switcher in
   * the suite shows it with nothing to set by hand. Best-effort: never throws.
   */
  async announceSelfInfo(): Promise<void> {
    try {
      const raw = await appConfigService.getObligateRaw();
      if (!raw.url || !raw.apiKey) return;
      const res = await fetch(`${raw.url}/api/apps/self-info`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${raw.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ color: APP_ACCENT_COLOR }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) logger.warn({ status: res.status }, 'Obligate self-info announce: non-2xx');
    } catch (err) {
      logger.warn({ err }, 'Obligate self-info announce failed');
    }
  },

  async getConnectedApps(
    obligateUserId?: number | null,
  ): Promise<Array<{ appType: string; name: string; baseUrl: string; icon: string | null; color: string | null; self?: true; thirdParty?: boolean }>> {
    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) return [];

    const url = obligateUserId
      ? `${raw.url}/api/apps/connected?userId=${encodeURIComponent(obligateUserId)}`
      : `${raw.url}/api/apps/connected`;

    // Bounded: never hang the caller on a slow Obligate
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${raw.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) return [];
      const data = await res.json() as { success: boolean; data?: Array<{ appType: string; name: string; baseUrl: string; icon: string | null; color: string | null; self?: true; thirdParty?: boolean }> };
      return data.data ?? [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  },
};
