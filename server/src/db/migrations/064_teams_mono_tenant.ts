import type { Knex } from 'knex';

/**
 * Teams become strictly mono-tenant (same model as Obliance).
 *
 * A team only ever grants access inside its own tenant (user_teams.tenant_id):
 * its permissions may only target groups / monitors of that tenant and its
 * members must belong to that tenant (user_tenants). To give a user access to
 * N tenants, an admin creates N teams.
 *
 * Until now:
 *   - "global" teams (047: user_teams.is_global + team_tenant_scopes) were
 *     meant to push one team to several tenants;
 *   - the grant tree of the god view let a local team hold permissions on
 *     another tenant's groups / monitors;
 *   - permission checks ignored the team's tenant, so all of the above was
 *     effective for any member who could open the target tenant.
 *
 * Step 0 materialises the legacy "no user_tenants row = member of the master
 * tenant" fallback: every non-admin account without any row gets a
 * (MASTER_TENANT_ID, 'user') row (SSO accounts excepted: Obligate grants
 * their workspaces at sign-in), so the split, the checks below and the
 * mono-tenant membership rule (team.service.setMembers) all agree on it.
 *
 * This migration splits every team per tenant, without losing any access:
 *
 *   For each team S (home tenant H = S.tenant_id):
 *     needed tenants = tenants of the entities S's permissions point to
 *                      ∪ (S global ? team_tenant_scopes(S) : ∅)
 *                      ∪ (S can_create ? tenants of S's members : ∅)
 *     For each needed tenant T ≠ H:
 *       - create a team in T with S's name (suffixed with H's slug when T
 *         already has a team of that name), description and can_create;
 *       - move S's permissions whose group / monitor belongs to T onto it;
 *       - copy the memberships of S's members that have user_tenants in T.
 *     S itself stays in H (same id / uuid, so SSO name matching and exports
 *     are unaffected) and keeps its members and its H-scoped permissions.
 *     Permissions whose entity no longer exists stay on S untouched.
 *
 * Then is_global and team_tenant_scopes are dropped, and the global
 * UNIQUE(name) of user_teams (013) is replaced by UNIQUE(tenant_id, name) —
 * the same name now legitimately exists once per tenant.
 *
 * Non-lossy check (throws → the whole migration rolls back):
 *   Effective grant before = (user, scope, scope_id, max level) through ANY of
 *   the user's teams, for an existing entity of tenant E, user in E.
 *   Effective grant after  = same, but only through teams of tenant E
 *   (the mono-tenant rule enforced by permission.service).
 *   Every "before" grant must exist "after" at the same or a higher level.
 *   Likewise can_create: it used to be tenant-agnostic (membership in ANY
 *   can_create team allowed creation in every tenant the user could open),
 *   so every (member of a can_create team, tenant of that member) pair must
 *   still have can_create through a team of that tenant.
 */

/** Value of MASTER_TENANT_ID (@obliview/shared) — migrations stay self-contained. */
const MASTER_TENANT_ID = 1;

interface TeamRow {
  id: number;
  name: string;
  description: string | null;
  can_create: boolean;
  tenant_id: number;
  is_global?: boolean;
}

interface PermRow {
  id: number;
  team_id: number;
  scope: string;
  scope_id: number;
  level: string;
  capabilities?: unknown;
}

const levelRank = (l: string): number => (l === 'rw' ? 2 : 1);

/**
 * (user, scope, scope_id) → max level, keyed "u:scope:id".
 * `teamTenantMustMatch` = true applies the mono-tenant rule.
 */
async function effectiveGrants(knex: Knex, teamTenantMustMatch: boolean): Promise<Map<string, number>> {
  const rows: Array<{ user_id: number; scope: string; scope_id: number; level: string }> = await knex.raw(`
    SELECT tm.user_id, tp.scope, tp.scope_id, tp.level
    FROM team_permissions tp
    JOIN user_teams t        ON t.id = tp.team_id
    JOIN team_memberships tm ON tm.team_id = tp.team_id
    JOIN (
      SELECT 'group'::text AS scope, id, tenant_id FROM monitor_groups
      UNION ALL
      SELECT 'monitor'::text AS scope, id, tenant_id FROM monitors
    ) e ON e.scope = tp.scope AND e.id = tp.scope_id
    JOIN user_tenants ut ON ut.user_id = tm.user_id AND ut.tenant_id = e.tenant_id
    ${teamTenantMustMatch ? 'WHERE t.tenant_id = e.tenant_id' : ''}
  `).then((r: { rows: Array<{ user_id: number; scope: string; scope_id: number; level: string }> }) => r.rows);

  const out = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.user_id}:${r.scope}:${r.scope_id}`;
    out.set(key, Math.max(out.get(key) ?? 0, levelRank(r.level)));
  }
  return out;
}

/** Name for the split team in `tenantId`, unique within that tenant. */
async function freeTeamName(
  knex: Knex,
  tenantId: number,
  baseName: string,
  homeSlug: string,
): Promise<string> {
  const taken = async (name: string) =>
    !!(await knex('user_teams').where({ tenant_id: tenantId, name }).first('id'));

  if (!(await taken(baseName))) return baseName;
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? ` (${homeSlug})` : ` (${homeSlug} ${i})`;
    const candidate = baseName.slice(0, 255 - suffix.length) + suffix;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error(`[064] could not find a free team name for "${baseName}" in tenant ${tenantId}`);
}

export async function up(knex: Knex): Promise<void> {
  const hasIsGlobal = await knex.schema.hasColumn('user_teams', 'is_global');
  const hasScopes = await knex.schema.hasTable('team_tenant_scopes');
  const hasCapabilities = await knex.schema.hasColumn('team_permissions', 'capabilities');

  // ── 0. Legacy accounts without any tenant row belong to the master tenant ──
  const backfilled = await knex.raw(`
    INSERT INTO user_tenants (user_id, tenant_id, role)
    SELECT u.id, ?, 'user'
    FROM users u
    WHERE u.role <> 'admin'
      AND u.foreign_source IS DISTINCT FROM 'obligate'  -- SSO accounts: Obligate grants their tenants
      AND EXISTS (SELECT 1 FROM tenants WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM user_tenants ut WHERE ut.user_id = u.id)
  `, [MASTER_TENANT_ID, MASTER_TENANT_ID]) as { rowCount?: number };

  // ── 0b. Snapshot of what users can do today ───────────────────────────────
  const before = await effectiveGrants(knex, false);

  // (user, tenant) pairs that had can_create: membership in ANY can_create
  // team, for every tenant the user can open (pre-064 canCreate ignored the
  // team's tenant).
  const createBefore = new Set<string>();
  {
    const rows: Array<{ user_id: number; tenant_id: number }> = await knex.raw(`
      SELECT DISTINCT tm.user_id, ut.tenant_id
      FROM user_teams t
      JOIN team_memberships tm ON tm.team_id = t.id
      JOIN user_tenants ut ON ut.user_id = tm.user_id
      WHERE t.can_create = true
    `).then((r: { rows: Array<{ user_id: number; tenant_id: number }> }) => r.rows);
    for (const r of rows) createBefore.add(`${r.user_id}:${r.tenant_id}`);
  }

  // ── 1. Tenant of every group / monitor ────────────────────────────────────
  const groupTenant = new Map<number, number>();
  for (const r of await knex('monitor_groups').select('id', 'tenant_id')) groupTenant.set(r.id, r.tenant_id);
  const monitorTenant = new Map<number, number>();
  for (const r of await knex('monitors').select('id', 'tenant_id')) monitorTenant.set(r.id, r.tenant_id);
  const entityTenant = (p: PermRow): number | undefined =>
    p.scope === 'group' ? groupTenant.get(p.scope_id)
      : p.scope === 'monitor' ? monitorTenant.get(p.scope_id)
        : undefined;

  const tenantSlug = new Map<number, string>();
  for (const r of await knex('tenants').select('id', 'slug')) tenantSlug.set(r.id, r.slug);

  // user → tenants
  const userTenants = new Map<number, Set<number>>();
  for (const r of await knex('user_tenants').select('user_id', 'tenant_id')) {
    if (!userTenants.has(r.user_id)) userTenants.set(r.user_id, new Set());
    userTenants.get(r.user_id)!.add(r.tenant_id);
  }

  // Global UNIQUE(name) must go before same-name teams can be created.
  await knex.raw('ALTER TABLE user_teams DROP CONSTRAINT IF EXISTS user_teams_name_unique');

  // ── 2. Split every team per tenant ────────────────────────────────────────
  const teams: TeamRow[] = await knex('user_teams').select('*').orderBy('id');
  let created = 0;
  let moved = 0;

  for (const team of teams) {
    const home = team.tenant_id;
    const perms: PermRow[] = await knex('team_permissions').where({ team_id: team.id }).orderBy('id');

    const permsByTenant = new Map<number, PermRow[]>();
    for (const p of perms) {
      const tid = entityTenant(p);
      if (tid === undefined || tid === home) continue; // orphan or already local
      if (!permsByTenant.has(tid)) permsByTenant.set(tid, []);
      permsByTenant.get(tid)!.push(p);
    }

    const needed = new Set<number>(permsByTenant.keys());
    if (hasIsGlobal && team.is_global && hasScopes) {
      const scoped = await knex('team_tenant_scopes').where({ team_id: team.id }).select('tenant_id');
      for (const s of scoped) if (s.tenant_id !== home) needed.add(s.tenant_id);
    }
    const memberIds: number[] = (await knex('team_memberships').where({ team_id: team.id }).select('user_id'))
      .map((r: { user_id: number }) => r.user_id);
    // can_create was tenant-agnostic: keep it in every tenant of its members.
    if (team.can_create) {
      for (const uid of memberIds) {
        for (const tid of userTenants.get(uid) ?? []) if (tid !== home) needed.add(tid);
      }
    }
    if (needed.size === 0) continue;

    for (const tid of [...needed].sort((a, b) => a - b)) {
      const name = await freeTeamName(knex, tid, team.name, tenantSlug.get(home) ?? `tenant-${home}`);
      const [inserted] = await knex('user_teams')
        .insert({
          name,
          description: team.description,
          can_create: team.can_create,
          tenant_id: tid,
        })
        .returning('id');
      const newId: number = typeof inserted === 'object' ? inserted.id : inserted;
      created++;

      const tenantPerms = permsByTenant.get(tid) ?? [];
      if (tenantPerms.length > 0) {
        await knex('team_permissions').insert(
          tenantPerms.map((p) => ({
            team_id: newId,
            scope: p.scope,
            scope_id: p.scope_id,
            level: p.level,
            ...(hasCapabilities
              ? { capabilities: p.capabilities == null ? null : JSON.stringify(p.capabilities) }
              : {}),
          })),
        );
        await knex('team_permissions').whereIn('id', tenantPerms.map((p) => p.id)).del();
        moved += tenantPerms.length;
      }

      const members = memberIds.filter((uid) => userTenants.get(uid)?.has(tid));
      if (members.length > 0) {
        await knex('team_memberships').insert(members.map((uid) => ({ team_id: newId, user_id: uid })));
      }
    }
  }

  // ── 3. Non-lossy verification ─────────────────────────────────────────────
  const after = await effectiveGrants(knex, true);
  const lost: string[] = [];
  for (const [key, lvl] of before) {
    if ((after.get(key) ?? 0) < lvl) lost.push(`${key}:${lvl === 2 ? 'rw' : 'ro'}`);
  }
  if (lost.length > 0) {
    throw new Error(
      `[064] teams mono-tenant split would lose ${lost.length} effective permission(s) `
      + `(user:scope:id:level): ${lost.slice(0, 20).join(', ')}${lost.length > 20 ? ', …' : ''}`,
    );
  }

  if (createBefore.size > 0) {
    const rows: Array<{ user_id: number; tenant_id: number }> = await knex('team_memberships as tm')
      .join('user_teams as t', 't.id', 'tm.team_id')
      .where('t.can_create', true)
      .distinct('tm.user_id', 't.tenant_id');
    const createAfter = new Set(rows.map((r) => `${r.user_id}:${r.tenant_id}`));
    const lostCreate = [...createBefore].filter((k) => !createAfter.has(k));
    if (lostCreate.length > 0) {
      throw new Error(
        `[064] teams mono-tenant split would lose can_create for (user:tenant): ${lostCreate.slice(0, 20).join(', ')}`,
      );
    }
  }

  // ── 4. Drop the global-team schema ────────────────────────────────────────
  if (hasScopes) await knex.schema.dropTable('team_tenant_scopes');
  if (hasIsGlobal) {
    await knex.schema.alterTable('user_teams', (t) => {
      t.dropColumn('is_global');
    });
  }

  await knex.schema.alterTable('user_teams', (t) => {
    t.unique(['tenant_id', 'name'], { indexName: 'user_teams_tenant_id_name_unique' });
  });

  if ((backfilled.rowCount ?? 0) > 0) {
    // eslint-disable-next-line no-console
    console.log(`[064] ${backfilled.rowCount} account(s) without a workspace row attached to the master tenant`);
  }
  if (created > 0 || moved > 0) {
    // eslint-disable-next-line no-console
    console.log(`[064] teams mono-tenant: ${created} team(s) created, ${moved} permission(s) moved to their tenant's team`);
  }
}

export async function down(knex: Knex): Promise<void> {
  // The split is not reversed (it is not lossy, and merging teams back could
  // widen access). Only the schema is restored, empty.
  await knex.schema.alterTable('user_teams', (t) => {
    t.dropUnique(['tenant_id', 'name'], 'user_teams_tenant_id_name_unique');
  });

  // Restore 013's global UNIQUE(name) only when it still holds.
  const dup = await knex('user_teams').select('name').groupBy('name').havingRaw('COUNT(*) > 1').first();
  if (!dup) {
    await knex.schema.alterTable('user_teams', (t) => {
      t.unique(['name'], { indexName: 'user_teams_name_unique' });
    });
  }

  if (!(await knex.schema.hasColumn('user_teams', 'is_global'))) {
    await knex.schema.alterTable('user_teams', (t) => {
      t.boolean('is_global').defaultTo(false).notNullable();
    });
  }
  if (!(await knex.schema.hasTable('team_tenant_scopes'))) {
    await knex.schema.createTable('team_tenant_scopes', (t) => {
      t.integer('team_id').notNullable().references('id').inTable('user_teams').onDelete('CASCADE');
      t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
      t.primary(['team_id', 'tenant_id']);
    });
  }
}
