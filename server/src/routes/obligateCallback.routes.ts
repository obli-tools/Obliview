import { Router } from 'express';
import type { Request } from 'express';
import crypto from 'crypto';
import { MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';
import { db } from '../db';
import { obligateService, type ObligateRoster } from '../services/obligate.service';
import { tenantService } from '../services/tenant.service';
import { appConfigService } from '../services/appConfig.service';
import { permissionSetService } from '../services/permissionSet.service';
import { permissionService } from '../services/permission.service';
import { logger } from '../utils/logger';
import { killSessionsForUser, forgetSessionUser } from '../services/userSessions.service';
import { regenerateSession } from '../utils/session';
import { auditService } from '../services/audit.service';
import { deviceIdentityService } from '../services/deviceIdentity.service';
import { clearLegacyPartitionedCookie } from '../session';
import { sessionHash } from '../utils/sessionHash';

const router = Router();

/**
 * Public origin used to build the OAuth redirect_uri (/auth/sso-redirect and
 * /auth/callback must agree on it). Host / X-Forwarded-* are client-controlled,
 * so the origin they name is only accepted when it is one this app is really
 * published under — otherwise a forged Host would make us exchange, with our
 * own key, a code that Obligate issued for an attacker's redirect_uri.
 */
function resolvePublicOrigin(req: Request): string | null {
  const protocol = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host) return null;
  const origin = obligateService.verifyPublicOrigin(`${protocol}://${host}`);
  if (!origin) {
    logger.warn({ protocol, host },
      'Obligate SSO: request origin is not the public URL of this app (APP_URL, else CLIENT_ORIGIN)');
  }
  return origin;
}

/**
 * Tenant + team memberships of an SSO identity as Obligate grants them (the
 * verified assertion at sign-in, Obligate's roster on a confirmed sync).
 *
 * Upserts the granted user_tenants rows (role = the permission set slug
 * Obligate sends, kept as-is: an unknown slug resolves to no capabilities —
 * fail-closed) and reconciles the team memberships of each granted tenant:
 * teams are mono-tenant, so Obligate's flat list of team NAMES is matched
 * per tenant (the same name in another tenant never cross-contaminates).
 * A platform admin keeps a master-tenant 'admin' row (deterministic landing
 * tenant, listed with the master's users, like the local bootstrap admin).
 *
 * With `prune` — og_ accounts, whose access Obligate owns — also removes what
 * Obligate no longer grants: user_tenants rows (including the master-tenant
 * 'admin' row of a platform admin who is one no longer) and every team
 * membership in those tenants.
 * Returns true when anything of a no-longer-granted tenant was removed (a
 * tenant row or a team membership): an open session may sit on that tenant,
 * the caller ends the user's sessions.
 */
async function applySsoMemberships(
  localUserId: number,
  grant: { tenants: unknown; teams: unknown },
  platformRole: 'admin' | 'user',
  prune: boolean,
): Promise<boolean> {
  const tenants = Array.isArray(grant.tenants) ? grant.tenants as Array<{ slug?: unknown; role?: unknown } | null> : [];
  const teams = Array.isArray(grant.teams) ? (grant.teams as unknown[]).filter((n): n is string => typeof n === 'string') : [];
  const keep = new Set<number>();

  for (const t of tenants) {
    if (!t || typeof t.slug !== 'string') continue;
    const tenant = await db('tenants').where({ slug: t.slug }).first('id') as { id: number } | undefined;
    if (!tenant) continue;
    keep.add(tenant.id);
    const role = typeof t.role === 'string' && t.role.length > 0 ? t.role : 'user';
    await db('user_tenants')
      .insert({ user_id: localUserId, tenant_id: tenant.id, role })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role });

    // Team memberships of THIS tenant = the granted names found in it.
    const wantedTeamIds = teams.length
      ? await db('user_teams').where({ tenant_id: tenant.id }).whereIn('name', teams).pluck('id') as number[]
      : [];
    const currentTeamIds = await db('team_memberships')
      .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
      .where({ 'team_memberships.user_id': localUserId, 'user_teams.tenant_id': tenant.id })
      .pluck('team_memberships.team_id') as number[];
    const toAdd = wantedTeamIds.filter((id) => !currentTeamIds.includes(id));
    const toRemove = currentTeamIds.filter((id) => !wantedTeamIds.includes(id));
    if (toAdd.length > 0) {
      await db('team_memberships')
        .insert(toAdd.map((team_id) => ({ user_id: localUserId, team_id })))
        .onConflict(['user_id', 'team_id'])
        .ignore();
    }
    if (toRemove.length > 0) {
      await db('team_memberships').where({ user_id: localUserId }).whereIn('team_id', toRemove).del();
    }
  }

  // Platform admin ("All tenants" admin at Obligate): a master-tenant
  // membership, so tenant resolution is deterministic. God view itself comes
  // from users.role = 'admin'.
  if (platformRole === 'admin') {
    keep.add(MASTER_TENANT_ID);
    await db('user_tenants')
      .insert({ user_id: localUserId, tenant_id: MASTER_TENANT_ID, role: 'admin' })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role: 'admin' });
  }

  logger.info({ userId: localUserId, tenantIds: [...keep], teams }, 'Obligate SSO: synced tenant + team memberships');

  if (!prune) return false;
  const keepIds = [...keep];
  const staleTenants = await db('user_tenants')
    .where({ user_id: localUserId })
    .modify((q) => { if (keepIds.length) q.whereNotIn('tenant_id', keepIds); })
    .pluck('tenant_id') as number[];
  const staleTeamIds = await db('team_memberships')
    .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
    .where({ 'team_memberships.user_id': localUserId })
    .modify((q) => { if (keepIds.length) q.whereNotIn('user_teams.tenant_id', keepIds); })
    .pluck('team_memberships.team_id') as number[];
  if (staleTeamIds.length > 0) {
    await db('team_memberships').where({ user_id: localUserId }).whereIn('team_id', staleTeamIds).del();
    logger.info({ userId: localUserId, teamIds: staleTeamIds }, 'Obligate SSO: team memberships of tenants no longer granted — removed');
  }
  if (staleTenants.length > 0) {
    await db('user_tenants').where({ user_id: localUserId }).whereIn('tenant_id', staleTenants).del();
    logger.info({ userId: localUserId, tenantIds: staleTenants }, 'Obligate SSO: tenant access no longer granted by Obligate — removed');
  }
  return staleTenants.length > 0 || staleTeamIds.length > 0;
}

/**
 * GET /auth/callback?code=xxx&state=xxx
 * Called by Obligate after successful authentication.
 * Exchanges the code for user info, auto-provisions, creates session, redirects.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (typeof code !== 'string' || !code) {
      res.status(400).json({ success: false, error: 'Missing code' });
      return;
    }

    // SSO switched off by an admin: no SSO session, even with a valid code
    if (!(await appConfigService.getObligateConfig()).enabled) {
      res.redirect('/login?error=sso_failed');
      return;
    }

    // Validate CSRF state parameter (RFC 6749 §10.12)
    const expectedState = req.session?.oauthState;
    if (!expectedState || !state || state !== expectedState) {
      logger.warn({ expectedState: !!expectedState, receivedState: !!state }, 'Obligate callback: state mismatch — possible CSRF');
      res.redirect('/login?error=sso_failed');
      return;
    }
    // Clear used state
    delete req.session.oauthState;

    // Build the redirect_uri that was used in the authorize request
    const origin = resolvePublicOrigin(req);
    if (!origin) {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const redirectUri = `${origin}/auth/callback`;

    // Exchange code with Obligate
    logger.info({ redirectUri }, 'Obligate callback: exchanging code');
    const assertion = await obligateService.exchangeCode(code, redirectUri);
    if (!assertion) {
      logger.warn('Obligate callback: exchange returned null — code invalid/expired or redirect_uri mismatch');
      res.redirect('/login?error=sso_failed');
      return;
    }
    logger.info({ obligateUserId: assertion.obligateUserId, username: assertion.username }, 'Obligate callback: exchange OK');
    if (!Number.isInteger(assertion.obligateUserId) || assertion.obligateUserId <= 0) {
      logger.warn({ obligateUserId: assertion.obligateUserId }, 'Obligate callback: invalid obligateUserId in assertion');
      res.redirect('/login?error=sso_failed');
      return;
    }

    // Find or create local user.
    // The local account is resolved from OUR link records only. Obligate's
    // linkedLocalUserId is just its copy of the id we reported through
    // report-provision: it is cross-checked, never trusted on its own, so a
    // stale or rewritten value can't open a session on an unrelated local
    // account (e.g. a local admin).
    let localUserId = await obligateService.getLinkedLocalUserId(assertion.obligateUserId) ?? 0;
    const needsProvision = localUserId === 0;

    if (assertion.linkedLocalUserId && assertion.linkedLocalUserId !== localUserId) {
      logger.warn(
        { obligateUserId: assertion.obligateUserId, claimedLocalUserId: assertion.linkedLocalUserId, linkedLocalUserId: localUserId || null },
        'Obligate callback: linkedLocalUserId does not match the local SSO link — ignored',
      );
    }

    const platformRole: 'admin' | 'user' = assertion.role === 'admin' ? 'admin' : 'user';
    // og_ account (Obligate owns its access): memberships pruned to the grant
    let ssoOwned = needsProvision;
    // Platform admin → user since the last sign-in: the other sessions end
    let demoted = false;

    if (!needsProvision) {
      const prev = await db('users').where({ id: localUserId })
        .first('role', 'foreign_source') as { role: string; foreign_source: string | null } | undefined;
      ssoOwned = prev?.foreign_source === 'obligate';
      demoted = prev?.role === 'admin' && platformRole !== 'admin';
      await db('users').where({ id: localUserId }).update({
        role: platformRole,
        // Obligate alone manages SSO accounts' activation (blocked locally) and
        // only issues assertions for active users with access to this app — so
        // a successful login also repairs a missed 'reactivate' push
        is_active: true,
        email: assertion.email,
        display_name: assertion.displayName,
        updated_at: new Date(),
      });
      // The session guard caches role / is_active: drop it so the role just
      // written is the one the next requests see.
      forgetSessionUser(localUserId);
      // Make sure the link row exists and points to this account (idempotent;
      // repairs accounts that were resolved through users.foreign_id)
      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });
      // Repair Obligate's pointer when it drifted (missing, stale or tampered)
      if (assertion.linkedLocalUserId !== localUserId) {
        obligateService.reportProvision(assertion.obligateUserId, localUserId).catch(() => {});
      }
    } else {
      // Create new local user (foreign_source='obligate', no password)
      // SSO users skip local enrollment — mark as fully enrolled immediately
      const [newUser] = await db('users')
        .insert({
          username: `og_${assertion.username}`,
          display_name: assertion.displayName || assertion.username,
          email: assertion.email,
          role: platformRole,
          is_active: true,
          foreign_source: 'obligate',
          foreign_id: assertion.obligateUserId,
          enrollment_version: 999,
        })
        .returning('id') as Array<{ id: number }>;
      localUserId = newUser.id;

      // Record in sso_foreign_users (upsert in case stale record existed)
      await db('sso_foreign_users')
        .insert({ foreign_source: 'obligate', foreign_user_id: assertion.obligateUserId, local_user_id: localUserId })
        .onConflict(['foreign_source', 'foreign_user_id'])
        .merge({ local_user_id: localUserId });

      // Report new local ID back to Obligate
      obligateService.reportProvision(assertion.obligateUserId, localUserId).catch(() => {});
    }

    // Tenants + team memberships, as Obligate grants them (every SSO login).
    // For an og_ account, what Obligate no longer grants is removed too —
    // tenant rows (incl. the master-tenant admin row of an ex-platform admin)
    // and the team memberships of those tenants.
    const accessRemoved = await applySsoMemberships(
      localUserId, { tenants: assertion.tenants, teams: assertion.teams }, platformRole, ssoOwned,
    );
    if (demoted || accessRemoved) {
      // Open sessions keep their role and tenant: end them (and the sockets in
      // tenant admin rooms), as a local demotion does. The current pre-login
      // session has no userId yet, so it is not touched; this sign-in gets a
      // new session below.
      await killSessionsForUser(localUserId, demoted ? 'sso-login demotion' : 'sso-login tenant access removed');
    }

    // An SSO-owned non-admin whose grant resolves to no workspace here must
    // not sign in: with zero user_tenants rows every layer would otherwise
    // treat the account as a member of the master tenant.
    if (ssoOwned && platformRole !== 'admin') {
      const hasTenant = await db('user_tenants').where({ user_id: localUserId }).first('tenant_id');
      if (!hasTenant) {
        logger.warn({ userId: localUserId, obligateUserId: assertion.obligateUserId },
          'Obligate SSO: no granted tenant exists here — sign-in refused');
        await killSessionsForUser(localUserId, 'sso-login no tenant granted');
        res.redirect('/login?error=sso_no_tenant');
        return;
      }
    }

    // Sync preferences from Obligate (theme, language, toast settings)
    if (assertion.preferences) {
      const prefUpdate: Record<string, unknown> = {};
      if (assertion.preferences.preferredLanguage) prefUpdate.preferred_language = assertion.preferences.preferredLanguage;
      if (assertion.preferences.profilePhotoUrl !== undefined) prefUpdate.avatar = assertion.preferences.profilePhotoUrl;
      if (Object.keys(prefUpdate).length > 0) {
        await db('users').where({ id: localUserId }).update(prefUpdate);
      }
      const uiPrefs: Record<string, unknown> = {};
      if (assertion.preferences.preferredTheme) uiPrefs.preferredTheme = assertion.preferences.preferredTheme;
      if (assertion.preferences.toastEnabled !== undefined) uiPrefs.toastEnabled = assertion.preferences.toastEnabled;
      if (assertion.preferences.toastPosition) uiPrefs.toastPosition = assertion.preferences.toastPosition;
      if (assertion.preferences.anonymousMode !== undefined) uiPrefs.anonymousMode = assertion.preferences.anonymousMode;
      if (Object.keys(uiPrefs).length > 0) {
        const existingRow = await db('users').where({ id: localUserId }).select('preferences').first() as { preferences: unknown } | undefined;
        const existing = (typeof existingRow?.preferences === 'string' ? JSON.parse(existingRow.preferences) : existingRow?.preferences) ?? {};
        await db('users').where({ id: localUserId }).update({
          preferences: JSON.stringify({ ...existing, ...uiPrefs }),
        });
      }
    }

    // New session id before it gains privileges (session fixation). The state
    // check above already consumed oauthState; requestedTenantSlug is read below.
    await regenerateSession(req, ['requestedTenantSlug']);

    // Establish session
    req.session.userId = localUserId;
    const user = await db('users').where({ id: localUserId }).first() as { username: string; role: string } | undefined;
    if (user) {
      req.session.username = user.username;
      // Platform role straight from the verified assertion (already written to
      // users.role above) — not re-read, so a concurrent sso-user-sync call
      // can't slip a different role into this new session.
      req.session.role = assertion.role === 'admin' ? 'admin' : 'user';
    }

    // Set tenant — cross-app handoff: prefer the slug requested by the
    // source Obli* app (set in /auth/sso-redirect from `?tenant=<slug>`)
    // when the user has access to a tenant of that slug. Otherwise fall
    // back to the first available tenant.
    //
    // Platform admins (assertion.role === 'admin') have implicit access to
    // every tenant — that access is NOT materialised in user_tenants rows,
    // so the regular JOIN on user_tenants would always miss for them.  For
    // those users we only check that a tenant with the requested slug
    // exists; the role-based access check downstream handles authorization.
    let resolvedTenantId: number | null = null;
    const requestedSlug = req.session.requestedTenantSlug;
    const isPlatformAdmin = assertion.role === 'admin';
    if (requestedSlug) {
      let match: { id: number } | undefined;
      if (isPlatformAdmin) {
        match = await db('tenants').where({ slug: requestedSlug }).select('id').first() as { id: number } | undefined;
      } else {
        match = await db('tenants as t')
          .join('user_tenants as ut', 'ut.tenant_id', 't.id')
          .where({ 't.slug': requestedSlug, 'ut.user_id': localUserId })
          .select('t.id')
          .first() as { id: number } | undefined;
      }
      if (match) {
        resolvedTenantId = match.id;
        logger.info({ userId: localUserId, slug: requestedSlug, isPlatformAdmin },
          'Cross-app handoff: tenant matched');
      } else {
        logger.info({ userId: localUserId, slug: requestedSlug, isPlatformAdmin },
          'Cross-app handoff: requested tenant not accessible, falling back');
      }
      // Always clear so the slug does not leak into a subsequent login that
      // did not originate from a cross-app pill click.
      delete req.session.requestedTenantSlug;
    }

    if (resolvedTenantId === null) {
      const tenant = await tenantService.getFirstTenantForUser(localUserId);
      resolvedTenantId = tenant?.id ?? 1;
    }
    req.session.currentTenantId = resolvedTenantId;
    await auditService.logReq(req, 'auth.login', {
      resourceType: 'user',
      resourceId: localUserId,
      details: { method: 'sso' },
    });

    logger.info(`Obligate SSO: user ${assertion.username} (obligate #${assertion.obligateUserId}) → local #${localUserId}`);

    // Save session, then redirect via HTML meta refresh to ensure Set-Cookie header
    // is fully processed by the browser before navigation occurs.
    req.session.save((err) => {
      if (err) { logger.error(err, 'Session save failed'); res.redirect('/login?error=sso_failed'); return; }
      logger.info({ session: sessionHash(req.sessionID), userId: req.session.userId }, 'Session saved, redirecting to /');
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#8b949e;font-family:-apple-system,BlinkMacSystemFont,sans-serif}.s{text-align:center}.d{width:28px;height:28px;border:2.5px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:r .6s linear infinite;margin:0 auto 14px}@keyframes r{to{transform:rotate(360deg)}}</style></head><body><div class="s"><div class="d"></div><div>Signing in...</div></div></body></html>`);
    });
  } catch (err) {
    logger.error(err, 'Obligate callback error');
    res.redirect('/login?error=sso_failed');
  }
});

/**
 * GET /auth/sso-redirect
 * Server-side redirect to Obligate authorize endpoint (browser redirect).
 * `client_id` is Obligate's PUBLIC client id — the sha256 hex of our API key —
 * never the raw key: this route is public and its Location header ends up in
 * browser history and access logs. Requires an Obligate that accepts the
 * sha256 form (appService.getAppByClientId). Also: nothing is sent while SSO
 * is disabled, the redirect_uri only ever uses a trusted public origin
 * (resolvePublicOrigin), and the Bearer-authenticated endpoints below
 * re-check every change with Obligate instead of trusting it.
 */
router.get('/sso-redirect', async (req, res) => {
  try {
    // The login page only comes here when SSO is enabled — don't hand out an
    // authorize URL (which carries the key) when it isn't
    if (!(await appConfigService.getObligateConfig()).enabled) {
      res.redirect('/login');
      return;
    }

    // Cross-app tenant handoff: the source Obli* app appends ?tenant=<slug>
    // when the user clicks the topbar switcher pill. Stashed in the session
    // below so /auth/callback can apply it once the user comes back from
    // Obligate. Validate against the same regex the tenants table enforces —
    // anything else is dropped silently (defence-in-depth, untrusted input).
    const requestedTenant = req.query.tenant;
    const tenantSlug = typeof requestedTenant === 'string' && /^[a-z0-9-]{1,64}$/.test(requestedTenant)
      ? requestedTenant : null;
    if (requestedTenant !== undefined && !tenantSlug) {
      logger.warn({ raw: String(requestedTenant) }, 'Cross-app handoff: rejected ?tenant= (regex failed)');
    }

    const raw = await appConfigService.getObligateRaw();
    if (!raw.url || !raw.apiKey) {
      res.redirect('/login');
      return;
    }
    // Verify Obligate is reachable before redirecting (prevents redirect loop when Gate is down)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const healthRes = await fetch(`${raw.url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) { res.redirect('/login?error=sso_failed'); return; }
    } catch {
      res.redirect('/login?error=sso_failed');
      return;
    }
    const selfUrl = resolvePublicOrigin(req);
    if (!selfUrl) {
      // Reached through a host this app isn't published under (LAN IP, second
      // DNS name, other URL typed in ObliTools…): restart the flow on the
      // canonical public origin, where the state cookie, the session and a
      // trusted redirect_uri all live. Only once (`canon=1`): if even that
      // request isn't recognised, the proxy hides the public host — give up.
      const retried = req.query.canon === '1';
      const canonical = retried ? null : obligateService.getCanonicalOrigin();
      if (canonical) {
        const target = new URL('/auth/sso-redirect', canonical);
        target.searchParams.set('canon', '1');
        if (tenantSlug) target.searchParams.set('tenant', tenantSlug);
        logger.info({ canonical }, 'sso-redirect: untrusted host — restarting SSO on the canonical origin');
        res.redirect(target.toString());
        return;
      }
      if (retried) {
        logger.error('sso-redirect: canonical origin not recognised either — make the reverse proxy forward the public host (X-Forwarded-Host) or fix APP_URL / CLIENT_ORIGIN');
      }
      res.redirect('/login?error=sso_failed');
      return;
    }
    // Delete a leftover Partitioned session cookie of an earlier version
    // before the CSRF state is stored: otherwise the browser would send it
    // first on /auth/callback and the state would be looked up in a dead
    // session (sso_failed loop). Appended before express-session's cookie.
    clearLegacyPartitionedCookie(res);
    if (tenantSlug) {
      req.session.requestedTenantSlug = tenantSlug;
      logger.info({ slug: tenantSlug }, 'Cross-app handoff: slug captured in /sso-redirect');
    }
    // Safety: never redirect to ourselves (misconfigured obligate_url pointing to this app)
    if (raw.url.replace(/\/$/, '') === selfUrl) {
      logger.error({ obligateUrl: raw.url, selfUrl }, 'sso-redirect: obligate_url points to this app — aborting to prevent loop');
      res.redirect('/login?error=sso_misconfigured');
      return;
    }
    const redirectUri = `${selfUrl}/auth/callback`;
    // Generate CSRF state token and store in session (RFC 6749 §10.12)
    const oauthState = crypto.randomBytes(32).toString('hex');
    req.session.oauthState = oauthState;
    const clientId = crypto.createHash('sha256').update(raw.apiKey).digest('hex');
    const obligateUrl = `${raw.url}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(oauthState)}`;
    logger.info({ obligateUrl: raw.url, redirectUri }, 'sso-redirect: redirecting to Obligate');
    // Save session before redirect to ensure state is persisted
    req.session.save(() => {
      res.redirect(obligateUrl);
    });
  } catch {
    res.redirect('/login');
  }
});

/**
 * GET /api/auth/app-info
 * Called by Obligate (Bearer auth) to discover teams + tenants for mapping UI.
 *
 * Returns only what Obligate's permission-group mapping UI uses: tenant
 * slug/name, team name + tenant, permission set slug/name/isDefault. No
 * internal ids, no capability matrix — the Bearer secret may be the API key,
 * which may have leaked.
 */
router.get('/app-info', async (req, res) => {
  try {
    // Reverse auth: Obligate calls us with the inbound secret (default: the API key)
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) {
      res.status(401).json({ success: false, error: 'Invalid API key' });
      return;
    }

    // Teams are mono-tenant: one mapping target per (tenant, team name).
    // Names are unique per tenant in practice; distinct keeps the list clean
    // if two teams of one tenant share a name (one mapping target for Obligate).
    const allTeams = await db('user_teams')
      .join('tenants', 'user_teams.tenant_id', 'tenants.id')
      .distinct('user_teams.name', 'tenants.slug as tenant_slug', 'tenants.name as tenant_name')
      .orderBy('tenants.name')
      .orderBy('user_teams.name') as Array<{ name: string; tenant_slug: string; tenant_name: string }>;

    // Fetch all tenants
    const tenants = await db('tenants')
      .select('name', 'slug')
      .orderBy('name') as Array<{ name: string; slug: string }>;

    // Permission sets: Obligate offers them as role choices (slug + label)
    const permissionSets = (await permissionSetService.getAll())
      .map((p) => ({ slug: p.slug, name: p.name, isDefault: p.isDefault }));

    res.json({
      success: true,
      data: {
        roles: ['admin', 'user'],
        teams: allTeams.map(t => ({ name: t.name, tenantSlug: t.tenant_slug, tenantName: t.tenant_name })),
        tenants: tenants.map(t => ({ slug: t.slug, name: t.name })),
        permissionSets,
      },
    });
  } catch (err) {
    logger.error(err, 'app-info error');
    res.status(500).json({ success: false, error: 'Failed to fetch app info' });
  }
});

/**
 * GET /api/auth/dashboard-stats
 * Called by Obligate (Bearer auth) to display stats on the Obligate dashboard.
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    const [up, down, paused, agents] = await Promise.all([
      db('monitors').where({ status: 'up', is_active: true }).count('id as c').first(),
      db('monitors').where({ status: 'down', is_active: true }).count('id as c').first(),
      db('monitors').where({ is_active: false }).count('id as c').first(),
      db('agent_devices').where({ status: 'approved' }).count('id as c').first(),
    ]);
    res.json({ success: true, data: { stats: [
      { label: 'Monitors Up', value: Number((up as any)?.c ?? 0), color: '#2ea043' },
      { label: 'Monitors Down', value: Number((down as any)?.c ?? 0), color: '#f85149' },
      { label: 'Paused', value: Number((paused as any)?.c ?? 0), color: '#8b949e' },
      { label: 'Agents', value: Number((agents as any)?.c ?? 0), color: '#58a6ff' },
    ] } });
  } catch { res.json({ success: true, data: null }); }
});

/**
 * GET /api/auth/sso-config
 * Returns Obligate SSO config for the LoginPage (public, no auth required).
 */
router.get('/sso-config', async (_req, res) => {
  try {
    const config = await obligateService.getSsoConfig();
    res.json({ success: true, data: config });
  } catch (err) {
    res.json({ success: true, data: { obligateUrl: null, obligateReachable: false, obligateEnabled: false } });
  }
});

/**
 * GET /api/auth/sso-logout-url
 * Returns the Obligate logout URL so the client can redirect there after local logout.
 */
router.get('/sso-logout-url', async (req, res) => {
  try {
    const cfg = await appConfigService.getObligateRaw();
    if (!cfg.url) {
      res.json({ success: true, data: null });
      return;
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const redirectUri = `${protocol}://${host}/login`;
    const logoutUrl = `${cfg.url}/logout?redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.json({ success: true, data: logoutUrl });
  } catch {
    res.json({ success: true, data: null });
  }
});

/**
 * GET /api/auth/connected-apps
 * Returns list of connected apps from Obligate, scoped to the apps the
 * current user actually has access to (via at least one
 * permission_group_app_mapping in Obligate). Apps the user has no
 * permission on are not returned, so the topbar app switcher hides them
 * entirely instead of showing greyed-out pills.
 */
router.get('/connected-apps', async (req, res) => {
  try {
    if (!req.session?.userId) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    // Obligate keys users by `obligate_user_id` (= local users.foreign_id when
    // foreign_source = 'obligate'). Local-only users have no foreign_id; for
    // them we fall back to the legacy unfiltered list — they wouldn't have
    // SSO access to other apps anyway, but returning an empty array would
    // hide every cross-app pill which is worse UX than the current state.
    const local = await db('users')
      .where({ id: req.session.userId })
      .select('foreign_source', 'foreign_id')
      .first() as { foreign_source: string | null; foreign_id: number | null } | undefined;
    const obligateUserId = local?.foreign_source === 'obligate' && local.foreign_id
      ? local.foreign_id
      : null;
    const apps = await obligateService.getConnectedApps(obligateUserId);
    res.json({ success: true, data: apps });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

/**
 * GET /api/auth/device-links?uuid=xxx
 * Returns cross-app links for a device UUID via Obligate.
 *
 * Only for an agent device the caller may read, in its current tenant (a
 * platform admin on the master tenant: any tenant) — the links name the
 * device in the other apps, and are fetched with our API key. Anything else
 * answers an empty list, like a device without links.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/device-links', async (req, res) => {
  try {
    const userId = req.session?.userId;
    if (!userId) { res.status(401).json({ success: false }); return; }
    const uuid = req.query.uuid;
    const tenantId = req.session.currentTenantId;
    if (typeof uuid !== 'string' || !UUID_RE.test(uuid) || !tenantId) { res.json({ success: true, data: [] }); return; }

    const isAdmin = req.session.role === 'admin';
    const q = db('agent_devices').where({ uuid });
    if (!(isAdmin && isMasterTenant(tenantId))) q.where({ tenant_id: tenantId });
    const device = await q.first('id', 'uuid') as { id: number; uuid: string } | undefined;
    if (!device) { res.json({ success: true, data: [] }); return; }

    // Non-admins: read access to the device's agent monitor (direct, team or
    // group permission — the same rule as the monitor itself).
    if (!isAdmin) {
      const monitorIds = await db('monitors')
        .where({ agent_device_id: device.id, type: 'agent' })
        .pluck('id') as number[];
      let canRead = false;
      for (const monitorId of monitorIds) {
        if ((await permissionService.getMonitorPermission(userId, monitorId, false)) !== null) { canRead = true; break; }
      }
      if (!canRead) { res.json({ success: true, data: [] }); return; }
    }

    // Identity v2: the other apps may still know this machine by one of its
    // previous IDs (they migrate on their own schedule) — ask for each.
    const uuids = (await deviceIdentityService.allUuidsOf(device)).slice(0, 4);
    // One link per app (type + origin): the one of the CURRENT ID wins
    // (uuids[0], Promise.all keeps the order) — an app may still hold a link
    // registered under a previous ID, with an older path (Oblimap /probes/:id
    // then /manage/probes/:id).
    const seen = new Set<string>();
    const appKey = (l: { appType: string; url: string }) => {
      try { return `${l.appType}|${new URL(l.url).origin}`; } catch { return `${l.appType}|${l.url}`; }
    };
    const links = (await Promise.all(uuids.map((u) => obligateService.getDeviceLinks(u)))).flat()
      .filter((l) => { const k = appKey(l); return seen.has(k) ? false : (seen.add(k), true); });
    res.json({ success: true, data: links });
  } catch {
    res.json({ success: true, data: [] });
  }
});

/** A positive integer (a number, or a decimal string), else null. */
function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : NaN);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const SYNC_ACTIONS = ['deactivate', 'reactivate', 'delete', 'update-role', 'credentials-changed'] as const;
type SyncAction = typeof SYNC_ACTIONS[number];

type SyncUser = { id: number; username: string; role: string; is_active: boolean };

/**
 * One outcome of an sso-user-sync push (`sso_sync.<outcome>`), logged with
 * the Obligate id, the account OUR records resolved and the requested action.
 * There is no audit log yet: these log lines are the trail.
 */
function syncLog(
  level: 'info' | 'warn', outcome: string,
  obligateId: number, localId: number | null, action: SyncAction, details: Record<string, unknown> = {},
): void {
  logger[level]({ obligateUserId: obligateId, localUserId: localId, requestedAction: action, ...details },
    `SSO sync: sso_sync.${outcome}`);
}

/**
 * The SSO account OUR records link to this Obligate identity
 * (getLinkedLocalUserId: sso_foreign_users, else users.foreign_id), provided
 * it really is that identity's account (users.foreign_source = 'obligate'
 * AND users.foreign_id = obligateId). Null for anything else: nothing linked,
 * a local account, another identity's account. Never resolved from the
 * remoteUserId pushed by Obligate. `expectedId` (re-checks): null too when
 * the link now names another account than the one the push was resolved to.
 */
async function linkedSsoAccount(
  obligateId: number, expectedId?: number,
): Promise<{ user: SyncUser | null; linkedId: number | null; reason: string }> {
  const linkedId = await obligateService.getLinkedLocalUserId(obligateId);
  if (!linkedId) return { user: null, linkedId: null, reason: 'not_linked' };
  if (expectedId !== undefined && linkedId !== expectedId) return { user: null, linkedId, reason: 'relinked' };
  const row = await db('users').where({ id: linkedId })
    .first('id', 'username', 'role', 'is_active', 'foreign_source', 'foreign_id') as
    (SyncUser & { foreign_source: string | null; foreign_id: number | string | null }) | undefined;
  if (!row || row.foreign_source !== 'obligate' || Number(row.foreign_id) !== obligateId) {
    return { user: null, linkedId, reason: 'not_an_sso_account' };
  }
  return { user: { id: row.id, username: row.username, role: row.role, is_active: row.is_active }, linkedId, reason: '' };
}

/**
 * 'done', or not confirmed (yet): `retry` says why — the route re-checks it
 * (one-shot roster actions) or answers 503 (credentials-changed, which
 * Obligate's persisted queue retries).
 */
type SyncResult = 'done' | {
  retry: 'still_on_roster' | 'identity_still_at_obligate' | 'epoch_unavailable' | 'roster_unavailable' | 'throttled';
};

/** A deactivation Obligate confirmed: the account disabled and every session of it killed. */
async function deactivateConfirmed(localId: number, wasActive: boolean, reason: string): Promise<void> {
  if (wasActive) await db('users').where({ id: localId }).update({ is_active: false, updated_at: new Date() });
  await killSessionsForUser(localId, reason);
}

/**
 * Apply a sync action ONLY as far as Obligate itself (read by us, from the
 * configured Obligate) confirms it:
 *   - deactivate: only when the user is no longer on the roster (may no
 *     longer sign in here);
 *   - reactivate: never applied — a push never re-enables an account. The
 *     next SSO sign-in does it (Obligate only issues an assertion for a user
 *     active and allowed here; /auth/callback sets is_active = true);
 *   - delete: only when the user is off the roster AND Obligate says the
 *     identity is gone (mfa-epoch: its JSON 404). Off the roster but still
 *     known to Obligate: only the deactivation is applied and the deletion is
 *     re-checked (Obligate pushes 'delete' BEFORE removing the user). Obligate
 *     ids are enumerable by any key holder: roster absence alone never
 *     deletes an account;
 *   - update-role: the role is the roster's, never the body's, and it only
 *     DEMOTES — a promotion is carried by the verified assertion of the next
 *     SSO sign-in. A demotion (not an admin on the roster, or off it) is
 *     applied at once, with the tenant access and team memberships Obligate
 *     no longer grants (applySsoMemberships, prune);
 *   - credentials-changed: off the roster → the confirmed deactivation;
 *     still on it → the sessions opened with the old credentials end.
 * `localId` is the account OUR records resolved for obligateId (never the
 * pushed pointer).
 */
async function applyConfirmedSync(
  obligateId: number, localId: number, action: SyncAction, roster: ObligateRoster,
): Promise<SyncResult> {
  const { user } = await linkedSsoAccount(obligateId, localId);
  if (!user) return 'done'; // gone (or re-linked) meanwhile
  const current = roster.get(obligateId);
  const log = (level: 'info' | 'warn', outcome: string, details: Record<string, unknown> = {}) =>
    syncLog(level, outcome, obligateId, localId, action, { username: user.username, ...details });

  switch (action) {
    case 'deactivate': {
      if (current) { log('warn', 'unconfirmed', { reason: 'still_on_roster' }); return 'done'; }
      await deactivateConfirmed(localId, user.is_active !== false, 'sso-sync deactivate');
      log('info', 'deactivated');
      return 'done';
    }
    case 'reactivate': {
      if (!current) { log('warn', 'unconfirmed', { reason: 'not_on_roster' }); return 'done'; }
      if (user.is_active === false) {
        log('info', 'reactivation_deferred', { note: 'the next SSO sign-in re-enables the account' });
      }
      return 'done';
    }
    case 'delete': {
      if (current) return { retry: 'still_on_roster' };
      const e = await obligateService.mfaEpochForPush(obligateId);
      if (e.kind === 'throttled') return { retry: 'throttled' };
      if (e.kind === 'unavailable') return { retry: 'epoch_unavailable' };
      if (e.kind === 'ok') {
        // Still known to Obligate: only the deactivation is confirmed.
        if (user.is_active !== false) {
          await deactivateConfirmed(localId, true, 'sso-sync delete (deactivated, deletion re-checked)');
          log('info', 'deactivated', { deleteDeferred: true });
        }
        return { retry: 'identity_still_at_obligate' };
      }
      // e.kind === 'not_found': off the roster AND gone at Obligate.
      await db('sso_foreign_users').where({ local_user_id: localId }).del();
      await db('users').where({ id: localId }).del();
      // A deleted user's sessions would keep their role (admin bypasses).
      await killSessionsForUser(localId, 'sso-sync delete');
      log('info', 'deleted');
      return 'done';
    }
    case 'update-role': {
      if (current?.role === 'admin') {
        if (user.role !== 'admin') {
          log('warn', 'promotion_deferred', { currentRole: user.role, note: 'the role comes from the next SSO sign-in' });
        }
        return 'done';
      }
      // Not an admin per Obligate (or no access at all): the platform role,
      // the master-tenant admin row and the tenant access Obligate no longer
      // grants go now.
      const wasAdmin = user.role === 'admin';
      if (wasAdmin) {
        await db('users').where({ id: localId }).update({ role: 'user', updated_at: new Date() });
        forgetSessionUser(localId);
      }
      const accessRemoved = await applySsoMemberships(
        localId, { tenants: current?.tenants ?? [], teams: current?.teams ?? [] }, 'user', true,
      );
      if (wasAdmin || accessRemoved) {
        // Sessions cache the platform role and sit on a tenant: end them.
        await killSessionsForUser(localId, wasAdmin ? 'sso-sync demotion' : 'sso-sync tenant access removed');
        log('info', 'demoted', { before: user.role, after: 'user', rosterRole: current?.role ?? null, accessRemoved });
      }
      return 'done';
    }
    case 'credentials-changed': {
      // Persisted, retried carrier of password / TOTP / activation changes
      // made at Obligate — and of deactivations whose one-shot push was lost.
      if (!current) {
        // May no longer sign in here (deactivated, disabled on this app, no
        // longer entitled, deleted): the confirmed deactivation. Never a
        // reactivation — the next SSO sign-in does that.
        await deactivateConfirmed(localId, user.is_active !== false, 'sso-sync credentials-changed (off roster)');
        log('info', 'deactivated', { reason: 'not_on_roster' });
      } else {
        // Password or TOTP changed elsewhere: end the sessions opened with
        // the old credentials (the next request goes through Obligate again).
        await killSessionsForUser(localId, 'sso-sync credentials-changed');
        log('info', 'credentials_changed');
      }
      return 'done';
    }
  }
  return 'done';
}

/**
 * Re-check delays (ms) of a one-shot roster sync change not confirmed yet
 * ('delete' pushed before Obligate removes the user) or not readable (roster /
 * epoch unavailable, PUSH_READ_BUDGET): Obligate never retries those pushes.
 * Not used for credentials-changed, which Obligate retries itself on a 5xx.
 */
const SYNC_RECHECK_DELAYS_MS = [15_000, 60_000, 180_000];
const pendingSyncRechecks = new Set<string>();

/** Keyed on the account OUR records resolved (`localId`), never on the pushed pointer. */
function scheduleSyncRecheck(obligateId: number, localId: number, action: SyncAction): void {
  const key = `${localId}:${action}`;
  if (pendingSyncRechecks.has(key)) return;
  pendingSyncRechecks.add(key);
  const attempt = (i: number): void => {
    if (i >= SYNC_RECHECK_DELAYS_MS.length) {
      pendingSyncRechecks.delete(key);
      syncLog('warn', 'recheck_expired', obligateId, localId, action,
        { note: 'change not confirmed by Obligate in time — not applied' });
      return;
    }
    setTimeout(async () => {
      let outcome: SyncResult = { retry: 'roster_unavailable' };
      try {
        const rr = await obligateService.rosterForPush();
        if (rr.kind === 'ok') outcome = await applyConfirmedSync(obligateId, localId, action, rr.roster);
        else if (rr.kind === 'throttled') outcome = { retry: 'throttled' };
      } catch (err) {
        logger.error(err, 'SSO sync: re-check failed');
      }
      if (outcome === 'done') pendingSyncRechecks.delete(key);
      else attempt(i + 1);
    }, SYNC_RECHECK_DELAYS_MS[i]).unref();
  };
  attempt(0);
}

// Bursts of sync pushes are unusual for a real Obligate (an admin changes one
// user at a time): above this many in a minute, warn once per minute.
const SYNC_BURST_WINDOW_MS = 60_000;
const SYNC_BURST_THRESHOLD = 30;
let syncWindow = { start: 0, count: 0, reported: false };
function noteSyncCall(ip: string | undefined): void {
  const now = Date.now();
  if (now - syncWindow.start > SYNC_BURST_WINDOW_MS) syncWindow = { start: now, count: 0, reported: false };
  syncWindow.count++;
  if (syncWindow.count > SYNC_BURST_THRESHOLD && !syncWindow.reported) {
    syncWindow.reported = true;
    logger.warn({ count: syncWindow.count, windowSeconds: SYNC_BURST_WINDOW_MS / 1000, ip },
      'SSO sync: sso_sync.burst — unusual burst of sso-user-sync calls, check who holds the Obligate API key / inbound secret');
  }
}

/**
 * POST /api/auth/sso-user-sync
 * Called by Obligate (Bearer auth: inbound secret, else API key) when an SSO
 * user is deactivated, reactivated, deleted or role-changed (one-shot pushes,
 * never retried), and — through its persisted, retried queue — when their
 * credentials changed there ('credentials-changed': password, TOTP,
 * activation).
 *
 * The Bearer secret may be public (it may be the API key, which may have
 * leaked), so:
 *   - the local account is resolved from `obligateUserId` and OUR records
 *     only (linkedSsoAccount). Nothing linked, or a link to anything but that
 *     identity's SSO account → untouched, answered success (Obligate stops);
 *   - `remoteUserId` (Obligate's copy of our id) is informational only: it may
 *     be absent or null (Obligate lost or never had the pointer). A present,
 *     non-null value must be a positive integer (400 otherwise); one that
 *     differs from our link is logged and never followed;
 *   - every action only as far as Obligate itself confirms it, read by us
 *     (applyConfirmedSync): the roster, and for 'delete' the MFA epoch too.
 *     A roster action not confirmed yet or not readable → re-checked here;
 *     credentials-changed not readable → 503 (Obligate's queue retries);
 *   - the outbound reads a push starts are coalesced and bounded over time
 *     (obligateService.rosterForPush / mfaEpochForPush, PUSH_READ_BUDGET):
 *     pushes cannot spend this app's request budget at Obligate.
 */
router.post('/sso-user-sync', async (req, res) => {
  try {
    if (!(await obligateService.verifyInboundBearer(req.headers.authorization))) { res.status(401).json({ success: false }); return; }

    // `role` is also sent for 'update-role' but deliberately not read: the
    // role applied comes from Obligate's roster
    const body = (req.body ?? {}) as Record<string, unknown>;
    const obligateId = positiveInt(body.obligateUserId);
    const action = SYNC_ACTIONS.find((a) => a === body.action) as SyncAction | undefined;
    // Informational pointer: absent / null accepted, anything else must be valid.
    const pointerSent = body.remoteUserId !== undefined && body.remoteUserId !== null;
    const pushedPointer = pointerSent ? positiveInt(body.remoteUserId) : null;
    if (!obligateId || !action || (pointerSent && !pushedPointer)) {
      res.status(400).json({ success: false, error: 'Missing fields' });
      return;
    }

    noteSyncCall(req.ip);

    // The account, from OUR records only.
    const { user, linkedId, reason } = await linkedSsoAccount(obligateId);
    if (pushedPointer !== null && linkedId !== null && pushedPointer !== linkedId) {
      // Obligate's pointer is stale, or someone pushes another account's id:
      // never followed.
      logger.warn({ obligateUserId: obligateId, remoteUserId: pushedPointer, linkedLocalUserId: linkedId, action },
        'SSO sync: pushed remoteUserId differs from our link — ignored, the linked account is used');
    }
    if (!user) {
      // Not linked (never signed in here, already deleted), or the link names
      // an account that is not this identity's: left untouched and answered
      // like "already gone" so Obligate doesn't keep retrying.
      syncLog('warn', 'ignored', obligateId, null, action, { remoteUserId: pushedPointer, linkedLocalUserId: linkedId, reason });
      res.json({ success: true });
      return;
    }
    const localId = user.id;

    // The push itself proves nothing: confirm it with Obligate's roster, read
    // by us from the configured Obligate (coalesced, budgeted).
    const rr = await obligateService.rosterForPush();

    if (action === 'credentials-changed') {
      // Obligate's persisted queue retries on a 5xx: no in-memory re-check.
      if (rr.kind !== 'ok') {
        syncLog('warn', rr.kind === 'throttled' ? 'throttled' : 'roster_unavailable', obligateId, localId, action,
          { note: '503, Obligate retries' });
        res.status(503).json({
          success: false,
          error: rr.kind === 'throttled' ? 'Too many sync pushes, retry later' : 'Could not verify the change with Obligate',
        });
        return;
      }
      await applyConfirmedSync(obligateId, localId, action, rr.roster);
      res.json({ success: true });
      return;
    }

    if (rr.kind !== 'ok') {
      scheduleSyncRecheck(obligateId, localId, action);
      syncLog('warn', 'recheck_scheduled', obligateId, localId, action,
        { reason: rr.kind === 'throttled' ? 'throttled' : 'roster_unavailable' });
      res.json({ success: true });
      return;
    }
    const r = await applyConfirmedSync(obligateId, localId, action, rr.roster);
    if (r !== 'done') {
      scheduleSyncRecheck(obligateId, localId, action);
      syncLog('info', 'recheck_scheduled', obligateId, localId, action, { reason: r.retry });
    }

    res.json({ success: true });
  } catch (err) {
    logger.error(err, 'sso-user-sync error');
    res.status(500).json({ success: false, error: 'Sync failed' });
  }
});

export default router;
