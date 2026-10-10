import type { Knex } from 'knex';
import { db } from '../db';
import type { PermissionLevel, UserPermissions } from '@obliview/shared';
import { permissionSetService } from './permissionSet.service';


/**
 * Tenant a user without any user_tenants row falls back to — mirrors the
 * session fallback at login (`tenant?.id ?? 1`, auth.controller.ts).
 */
const DEFAULT_TENANT_ID = 1;

/** Same values as tenant.service DEFAULT_TENANT_ROLE / normalizeTenantRole —
 *  inlined: tenant.service pulls in the session / socket layer (import cycle). */
const DEFAULT_TENANT_ROLE = 'user';
const normalizeTenantRole = (role: string | null | undefined): string =>
  (!role || role === 'member' ? DEFAULT_TENANT_ROLE : role);

/**
 * Team grants are tenant-bound: a team (user_teams.tenant_id) only ever grants
 * access to groups and monitors of its OWN tenant, and only while the user is
 * still a member of that tenant. Every query below joins user_teams and checks
 * both conditions, so a stale membership or a cross-tenant grant row is inert.
 */
export const permissionService = {
  /**
   * Team IDs a user belongs to. With tenantId, only that tenant's teams.
   */
  async getUserTeamIds(userId: number, tenantId?: number): Promise<number[]> {
    const q = db('team_memberships')
      .join('user_teams', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .select('team_memberships.team_id');
    if (tenantId !== undefined) q.where('user_teams.tenant_id', tenantId);
    const rows = await q;
    return rows.map((r) => r.team_id as number);
  },

  /**
   * Check if user has canCreate on the given tenant: one of their teams OF
   * THAT TENANT carries can_create (and the user is still a member of it).
   * The tenant capability (monitors.manage / groups.manage) is checked
   * separately by requireCanCreate.
   */
  async canCreate(userId: number, isAdmin: boolean, tenantId: number): Promise<boolean> {
    if (isAdmin) return true;
    if (!(await this._isTenantMember(userId, tenantId))) return false;
    const row = await db('user_teams')
      .join('team_memberships', 'user_teams.id', 'team_memberships.team_id')
      .where('team_memberships.user_id', userId)
      .where('user_teams.tenant_id', tenantId)
      .where('user_teams.can_create', true)
      .first('user_teams.id');
    return !!row;
  },

  /**
   * Get the effective permission level for a user on a specific monitor.
   * Returns 'rw', 'ro', or null (no access).
   * Checks: direct monitor permissions + group permissions (with inheritance
   * via closure table), counting only the teams of the monitor's tenant.
   */
  async getMonitorPermission(
    userId: number,
    monitorId: number,
    isAdmin: boolean,
  ): Promise<PermissionLevel | null> {
    if (isAdmin) return 'rw';

    const monitorRow = await db('monitors').where({ id: monitorId }).select('group_id', 'tenant_id').first();
    if (!monitorRow) return null;
    const tenantId: number = monitorRow.tenant_id;
    if (!(await this._isTenantMember(userId, tenantId))) return null;

    // Direct monitor permission
    const directLevel = await this._getHighestPermission(userId, 'monitor', monitorId, tenantId);

    // Group permission (inherited via closure table)
    let groupLevel: PermissionLevel | null = null;
    if (monitorRow.group_id) {
      groupLevel = await this._getGroupPermissionViaClosure(userId, monitorRow.group_id, tenantId);
    }

    const level = this._highest(directLevel, groupLevel);
    if (level) return level;

    // General group of the monitor's tenant: readable by every member
    if (monitorRow.group_id && await this._isGeneralGroupForUser(userId, monitorRow.group_id, tenantId)) {
      return 'ro';
    }
    return null;
  },

  /**
   * Check if user can read a monitor.
   */
  async canReadMonitor(userId: number, monitorId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getMonitorPermission(userId, monitorId, isAdmin);
    return perm !== null;
  },

  /**
   * Check if user can write (edit/delete) a monitor.
   */
  async canWriteMonitor(userId: number, monitorId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getMonitorPermission(userId, monitorId, isAdmin);
    return perm === 'rw';
  },

  /**
   * Get effective permission for a user on a group.
   * Checks direct group permissions + ancestor permissions via closure table,
   * counting only the teams of the group's tenant.
   */
  async getGroupPermission(
    userId: number,
    groupId: number,
    isAdmin: boolean,
  ): Promise<PermissionLevel | null> {
    if (isAdmin) return 'rw';

    const groupRow = await db('monitor_groups').where({ id: groupId }).select('tenant_id').first();
    if (!groupRow) return null;
    const tenantId: number = groupRow.tenant_id;
    if (!(await this._isTenantMember(userId, tenantId))) return null;

    const level = await this._getGroupPermissionViaClosure(userId, groupId, tenantId);
    if (level) return level;

    // General groups are readable by every member of the group's tenant
    if (await this._isGeneralGroupForUser(userId, groupId, tenantId)) return 'ro';
    return null;
  },

  async canReadGroup(userId: number, groupId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, isAdmin);
    return perm !== null;
  },

  async canWriteGroup(userId: number, groupId: number, isAdmin: boolean): Promise<boolean> {
    const perm = await this.getGroupPermission(userId, groupId, isAdmin);
    return perm === 'rw';
  },

  /**
   * Get all monitor IDs visible to a user.
   * Returns 'all' for admins.
   */
  async getVisibleMonitorIds(userId: number, isAdmin: boolean): Promise<number[] | 'all'> {
    if (isAdmin) return 'all';

    const tenantIds = await this._getUserTenantIds(userId);

    // Monitors via group permissions (inherited through closure table)
    const groupMonitors = await this._teamGrants(userId, tenantIds)
      .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
      .join('monitors', function () {
        this.on('monitors.group_id', 'group_closure.descendant_id')
          .andOn('monitors.tenant_id', 'user_teams.tenant_id');
      })
      .where('team_permissions.scope', 'group')
      .distinct('monitors.id');

    // Monitors via direct monitor permissions
    const directMonitors = await this._teamGrants(userId, tenantIds)
      .join('monitors', function () {
        this.on('monitors.id', 'team_permissions.scope_id')
          .andOn('monitors.tenant_id', 'user_teams.tenant_id');
      })
      .where('team_permissions.scope', 'monitor')
      .distinct('monitors.id');

    // Monitors in general groups (of the user's own tenants)
    const generalMonitors = await this._generalMonitorsQuery(userId);

    const ids = new Set<number>();
    for (const r of groupMonitors) ids.add(r.id);
    for (const r of directMonitors) ids.add(r.id);
    for (const r of generalMonitors) ids.add(r.id);

    return [...ids];
  },

  /**
   * Get all group IDs visible to a user.
   * A group is visible if the user has any permission on it, any ancestor has permission,
   * or any monitor inside it has a direct permission.
   * Returns 'all' for admins.
   */
  async getVisibleGroupIds(userId: number, isAdmin: boolean): Promise<number[] | 'all'> {
    if (isAdmin) return 'all';

    const tenantIds = await this._getUserTenantIds(userId);

    // Groups with direct group permissions (same tenant as the team)
    const groupPerms = await this._teamGrants(userId, tenantIds)
      .join('monitor_groups', function () {
        this.on('monitor_groups.id', 'team_permissions.scope_id')
          .andOn('monitor_groups.tenant_id', 'user_teams.tenant_id');
      })
      .where('team_permissions.scope', 'group')
      .distinct('monitor_groups.id');
    const permGroupIds = groupPerms.map((r) => r.id as number);

    // All descendants of those groups
    let descendantIds: number[] = [];
    if (permGroupIds.length > 0) {
      const descRows = await db('group_closure')
        .whereIn('ancestor_id', permGroupIds)
        .select('descendant_id');
      descendantIds = descRows.map((r) => r.descendant_id);
    }

    // Groups that contain monitors with direct monitor permissions
    const monitorGroupRows = await this._teamGrants(userId, tenantIds)
      .join('monitors', function () {
        this.on('monitors.id', 'team_permissions.scope_id')
          .andOn('monitors.tenant_id', 'user_teams.tenant_id');
      })
      .where('team_permissions.scope', 'monitor')
      .whereNotNull('monitors.group_id')
      .distinct('monitors.group_id');
    const monitorGroupIds = monitorGroupRows.map((r) => r.group_id as number);

    // Ancestor groups of monitorGroupIds and permGroupIds (for tree navigation)
    let ancestorIds: number[] = [];
    const navIds = [...monitorGroupIds, ...permGroupIds];
    if (navIds.length > 0) {
      const ancRows = await db('group_closure')
        .whereIn('descendant_id', navIds)
        .select('ancestor_id');
      ancestorIds = ancRows.map((r) => r.ancestor_id);
    }

    // General groups (of the user's own tenants)
    const generalRows = await db('monitor_groups')
      .where({ is_general: true })
      .whereIn('tenant_id', tenantIds)
      .select('id');
    const generalIds = generalRows.map((r) => r.id);

    const ids = new Set<number>();
    for (const id of descendantIds) ids.add(id);
    for (const id of monitorGroupIds) ids.add(id);
    for (const id of ancestorIds) ids.add(id);
    for (const id of generalIds) ids.add(id);

    return [...ids];
  },

  /**
   * Build the EFFECTIVE UserPermissions object for the current user on the
   * active tenant. Sent to the client on login/session check so the UI can
   * adapt with plain key lookups:
   *   - each group grant is expanded to all its descendants (group_closure),
   *     the highest level winning;
   *   - every monitor inside a granted group gets a `monitor:<id>` key, merged
   *     with the direct monitor grants;
   *   - general groups (and their monitors) are at least 'ro';
   *   - tenantCapabilities: the capabilities of the user's tenant role.
   * Only the teams of `tenantId` count.
   */
  async getUserPermissions(userId: number, isAdmin: boolean, tenantId: number): Promise<UserPermissions> {
    const tenantCapabilities = await this.listUserTenantCapabilities(userId, isAdmin, tenantId);
    if (isAdmin) {
      return { canCreate: true, teams: [], permissions: {}, tenantCapabilities };
    }

    const permissions: Record<string, PermissionLevel> = {};
    const put = (key: string, level: PermissionLevel) => {
      const existing = permissions[key];
      if (!existing || (existing === 'ro' && level === 'rw')) permissions[key] = level;
    };

    if (!(await this._isTenantMember(userId, tenantId))) {
      return { canCreate: false, teams: [], permissions, tenantCapabilities };
    }

    const teamIds = await this.getUserTeamIds(userId, tenantId);
    const canCreate = await this.canCreate(userId, false, tenantId);

    if (teamIds.length > 0) {
      // Group grants → every descendant group of the same tenant
      const groupRows = await db('team_permissions')
        .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
        .join('monitor_groups', 'monitor_groups.id', 'group_closure.descendant_id')
        .whereIn('team_permissions.team_id', teamIds)
        .where('team_permissions.scope', 'group')
        .where('monitor_groups.tenant_id', tenantId)
        .select('group_closure.descendant_id as id', 'team_permissions.level') as Array<{ id: number; level: PermissionLevel }>;
      const groupLevels = new Map<number, PermissionLevel>();
      for (const r of groupRows) {
        put(`group:${r.id}`, r.level);
        groupLevels.set(r.id, permissions[`group:${r.id}`]);
      }

      // Monitors inside the granted groups inherit the group's level
      const groupIds = [...groupLevels.keys()];
      if (groupIds.length > 0) {
        const monitorRows = await db('monitors')
          .whereIn('group_id', groupIds)
          .where('tenant_id', tenantId)
          .select('id', 'group_id') as Array<{ id: number; group_id: number }>;
        for (const m of monitorRows) {
          const level = groupLevels.get(m.group_id);
          if (level) put(`monitor:${m.id}`, level);
        }
      }

      // Direct monitor grants (monitor of the same tenant)
      const monitorGrants = await db('team_permissions')
        .join('monitors', 'monitors.id', 'team_permissions.scope_id')
        .whereIn('team_permissions.team_id', teamIds)
        .where('team_permissions.scope', 'monitor')
        .where('monitors.tenant_id', tenantId)
        .select('monitors.id', 'team_permissions.level') as Array<{ id: number; level: PermissionLevel }>;
      for (const r of monitorGrants) put(`monitor:${r.id}`, r.level);
    }

    // General groups of the tenant (and their monitors) are readable by members
    const generalGroups = await db('monitor_groups')
      .where({ is_general: true, tenant_id: tenantId })
      .pluck('id') as number[];
    for (const gid of generalGroups) put(`group:${gid}`, 'ro');
    if (generalGroups.length > 0) {
      const generalMonitors = await db('monitors')
        .whereIn('group_id', generalGroups)
        .where('tenant_id', tenantId)
        .pluck('id') as number[];
      for (const mid of generalMonitors) put(`monitor:${mid}`, 'ro');
    }

    return { canCreate, teams: teamIds, permissions, tenantCapabilities };
  },

  /**
   * Get user IDs that have at least read access to a specific monitor.
   * Used for Socket.io broadcasts. Only users who are still members of the
   * monitor's tenant are returned (platform admins excepted), and only the
   * teams of that tenant count.
   */
  async getUsersWithMonitorAccess(monitorId: number): Promise<number[]> {
    const monitorRow = await db('monitors').where({ id: monitorId }).select('group_id', 'tenant_id').first();
    if (!monitorRow) return [];
    const monitorTenantId: number = monitorRow.tenant_id;

    // Team members of the monitor's tenant, still members of that tenant
    const teamMembers = () => db('team_memberships')
      .join('team_permissions', 'team_memberships.team_id', 'team_permissions.team_id')
      .join('user_teams', 'user_teams.id', 'team_permissions.team_id')
      .join('users', 'users.id', 'team_memberships.user_id')
      .where('user_teams.tenant_id', monitorTenantId)
      .where((qb) => this._memberOfTenantClause(qb, monitorTenantId));

    // Users via direct monitor permission
    const directUsers = await teamMembers()
      .where('team_permissions.scope', 'monitor')
      .where('team_permissions.scope_id', monitorId)
      .distinct('team_memberships.user_id');

    const userIds = new Set<number>(directUsers.map((r) => r.user_id));

    // Users via group permission (inherited)
    if (monitorRow.group_id) {
      const groupUsers = await teamMembers()
        .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
        .where('team_permissions.scope', 'group')
        .where('group_closure.descendant_id', monitorRow.group_id)
        .distinct('team_memberships.user_id');
      for (const r of groupUsers) userIds.add(r.user_id);
    }

    // Users who can see general groups
    if (monitorRow.group_id) {
      const isGeneral = await db('monitor_groups')
        .where({ id: monitorRow.group_id, is_general: true, tenant_id: monitorTenantId })
        .first();
      if (isGeneral) {
        // Every active member of the monitor's tenant can see general group
        // monitors — never users of other tenants. Users without any
        // user_tenants row count as members of the default tenant (same
        // fallback as _getUserTenantIds).
        for (const id of await this.getTenantMemberUserIds(monitorTenantId)) userIds.add(id);
      }
    }

    return [...userIds];
  },

  /**
   * Active members of a tenant (user_tenants), plus — on the default tenant —
   * the local accounts without any user_tenants row (legacy fallback, never
   * SSO accounts). Audience of the tenant's general groups.
   */
  async getTenantMemberUserIds(tenantId: number): Promise<number[]> {
    const rows = await db('users')
      .where('users.is_active', true)
      .where(function () {
        this.whereExists(
          db('user_tenants')
            .whereRaw('user_tenants.user_id = users.id')
            .where('user_tenants.tenant_id', tenantId),
        );
        if (tenantId === DEFAULT_TENANT_ID) {
          this.orWhere(function () {
            this.whereNotExists(db('user_tenants').whereRaw('user_tenants.user_id = users.id'))
              .whereRaw("users.foreign_source IS DISTINCT FROM 'obligate'");
          });
        }
      })
      .pluck('users.id') as number[];
    return rows.map(Number);
  },

  // ── Private helpers ──

  /**
   * Tenant ids the user is a member of (user_tenants).
   * "General" group visibility is confined to these tenants — it must never
   * expose a group to users of other tenants.
   * A user with no user_tenants row at all (e.g. a local account created via
   * POST /api/users and never assigned to a tenant) is treated as a member of
   * the default tenant — the tenant their session falls back to at login —
   * so they keep seeing that tenant's general groups. SSO accounts
   * (foreign_source 'obligate') never get that fallback: Obligate grants
   * their workspaces, and none granted means none.
   */
  async _getUserTenantIds(userId: number): Promise<number[]> {
    const rows = await db('user_tenants').where({ user_id: userId }).select('tenant_id');
    if (rows.length === 0) {
      const u = await db('users').where({ id: userId }).first('foreign_source') as { foreign_source: string | null } | undefined;
      return u && u.foreign_source !== 'obligate' ? [DEFAULT_TENANT_ID] : [];
    }
    return rows.map((r) => r.tenant_id as number);
  },

  async _isTenantMember(userId: number, tenantId: number): Promise<boolean> {
    return (await this._getUserTenantIds(userId)).includes(tenantId);
  },

  /**
   * SQL counterpart of _isTenantMember for a query that has `users` joined:
   * platform admin, member of the tenant, or (default tenant only) member of
   * no tenant at all.
   */
  _memberOfTenantClause(qb: Knex.QueryBuilder, tenantId: number): void {
    qb.where('users.role', 'admin')
      .orWhereExists(
        db('user_tenants')
          .whereRaw('user_tenants.user_id = users.id')
          .where('user_tenants.tenant_id', tenantId),
      );
    if (tenantId === DEFAULT_TENANT_ID) {
      qb.orWhere(function () {
        this.whereNotExists(db('user_tenants').whereRaw('user_tenants.user_id = users.id'))
          .whereRaw("users.foreign_source IS DISTINCT FROM 'obligate'");
      });
    }
  },

  /**
   * Tenant role (permission_set slug, normalised) of the user on a tenant, or
   * null when not a member. A non-SSO account without any user_tenants row is
   * a 'user' of the default tenant (same fallback as _getUserTenantIds).
   */
  async _tenantRole(userId: number, tenantId: number): Promise<string | null> {
    const ut = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('role') as { role: string | null } | undefined;
    if (ut) return normalizeTenantRole(ut.role);
    if (tenantId !== DEFAULT_TENANT_ID) return null;
    return (await this._getUserTenantIds(userId)).includes(DEFAULT_TENANT_ID) ? DEFAULT_TENANT_ROLE : null;
  },

  /**
   * team_permissions rows of the user's teams, restricted to the teams of the
   * tenants the user still belongs to. `user_teams` is joined so callers can
   * bind the granted resource to the team's tenant.
   */
  _teamGrants(userId: number, tenantIds: number[]): Knex.QueryBuilder {
    return db('team_permissions')
      .join('team_memberships', 'team_permissions.team_id', 'team_memberships.team_id')
      .join('user_teams', 'user_teams.id', 'team_permissions.team_id')
      .where('team_memberships.user_id', userId)
      .whereIn('user_teams.tenant_id', tenantIds);
  },

  /**
   * True when groupId is a general group in one of the user's tenants.
   * When expectedTenantId is given (the monitor's tenant), the group must also
   * belong to that tenant, so a monitor attached to a foreign general group
   * never becomes readable through it.
   */
  async _isGeneralGroupForUser(userId: number, groupId: number, expectedTenantId?: number): Promise<boolean> {
    const q = db('monitor_groups')
      .where({ id: groupId, is_general: true })
      .whereIn('tenant_id', await this._getUserTenantIds(userId));
    if (expectedTenantId !== undefined) q.where('tenant_id', expectedTenantId);
    const row = await q.first('id');
    return !!row;
  },

  /**
   * Monitors sitting in a general group of one of the user's tenants
   * (monitor and group must share that tenant).
   */
  async _generalMonitorsQuery(userId: number): Promise<{ id: number }[]> {
    const tenantIds = await this._getUserTenantIds(userId);
    return db('monitors')
      .join('monitor_groups', function () {
        this.on('monitors.group_id', 'monitor_groups.id')
          .andOn('monitors.tenant_id', 'monitor_groups.tenant_id');
      })
      .where('monitor_groups.is_general', true)
      .whereIn('monitor_groups.tenant_id', tenantIds)
      .select('monitors.id');
  },

  /**
   * Highest permission level granted by the user's teams of `tenantId` for a
   * specific scope+scopeId.
   */
  async _getHighestPermission(
    userId: number,
    scope: string,
    scopeId: number,
    tenantId: number,
  ): Promise<PermissionLevel | null> {
    const rows = await this._teamGrants(userId, [tenantId])
      .where('team_permissions.scope', scope)
      .where('team_permissions.scope_id', scopeId)
      .select('team_permissions.level');

    if (rows.length === 0) return null;
    return rows.some((r: { level: PermissionLevel }) => r.level === 'rw') ? 'rw' : 'ro';
  },

  /**
   * Highest group permission for a user on a group, checking all ancestors
   * via closure table. Only the teams of the group's tenant count.
   */
  async _getGroupPermissionViaClosure(
    userId: number,
    groupId: number,
    tenantId: number,
  ): Promise<PermissionLevel | null> {
    const rows = await this._teamGrants(userId, [tenantId])
      .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
      .where('team_permissions.scope', 'group')
      .where('group_closure.descendant_id', groupId)
      .select('team_permissions.level');

    if (rows.length === 0) return null;
    return rows.some((r: { level: PermissionLevel }) => r.level === 'rw') ? 'rw' : 'ro';
  },

  _highest(a: PermissionLevel | null, b: PermissionLevel | null): PermissionLevel | null {
    if (a === 'rw' || b === 'rw') return 'rw';
    if (a === 'ro' || b === 'ro') return 'ro';
    return null;
  },

  // ── Tenant-wide capabilities (permission_sets) ─────────────────────────────
  //
  // user_tenants.role carries a permission_set slug (e.g. 'admin', 'user',
  // 'viewer', or a custom slug). The set's `capabilities` JSONB array decides
  // which tenant-wide gates the user passes (settings, users.manage,
  // notifications…). Tenant role 'admin' short-circuits the check. Teams
  // decide WHERE a user may act; the tenant role decides WHAT.

  async userHasTenantCapability(
    userId: number,
    tenantId: number,
    capability: string,
  ): Promise<boolean> {
    const role = await this._tenantRole(userId, tenantId);
    if (!role) return false;
    if (role === 'admin') return true;

    const set = await db('permission_sets')
      .where({ slug: role })
      .first() as { capabilities: unknown } | undefined;
    if (!set) return false;
    return parseCapabilities(set.capabilities).includes(capability);
  },

  /**
   * Every capability the user holds on a tenant — for /auth/me so the client
   * can render its gates without round-trips. Platform admins and the tenant
   * role 'admin' get the whole catalogue; a role whose slug matches no
   * permission set gets nothing (fail closed).
   */
  async listUserTenantCapabilities(userId: number, isAdmin: boolean, tenantId: number): Promise<string[]> {
    const all = permissionSetService.getAvailableCapabilities().map((c) => c.key);
    if (isAdmin) return all;
    const role = await this._tenantRole(userId, tenantId);
    if (!role) return [];
    if (role === 'admin') return all;
    const set = await db('permission_sets').where({ slug: role }).first() as { capabilities: unknown } | undefined;
    if (!set) return [];
    return parseCapabilities(set.capabilities);
  },

  /**
   * Combined check: user belongs to a team that has the requested capability
   * on the monitor's scope (direct or inherited via group closure), AND has
   * at least read access to the monitor.
   *
   * Used when a per-device action needs both reach (team scope) and a fine
   * capability flag (team_permissions.capabilities JSONB).
   * NOTE: currently unused — team_permissions.capabilities is never written.
   */
  async canUseCapability(
    userId: number,
    monitorId: number,
    isAdmin: boolean,
    capability: string,
  ): Promise<boolean> {
    if (isAdmin) return true;

    const monitorRow = await db('monitors').where({ id: monitorId }).select('group_id', 'tenant_id').first();
    if (!monitorRow) return false;
    const tenantId: number = monitorRow.tenant_id;
    if (!(await this._isTenantMember(userId, tenantId))) return false;

    // Direct monitor scope
    const directRows = await this._teamGrants(userId, [tenantId])
      .where('team_permissions.scope', 'monitor')
      .where('team_permissions.scope_id', monitorId)
      .select('team_permissions.capabilities') as Array<{ capabilities: string | string[] | null }>;

    if (this._anyCapabilityMatch(directRows, capability)) return true;

    // Group scope (inherited via closure table)
    if (monitorRow.group_id) {
      const groupRows = await this._teamGrants(userId, [tenantId])
        .join('group_closure', 'group_closure.ancestor_id', 'team_permissions.scope_id')
        .where('team_permissions.scope', 'group')
        .where('group_closure.descendant_id', monitorRow.group_id)
        .select('team_permissions.capabilities') as Array<{ capabilities: string | string[] | null }>;

      if (this._anyCapabilityMatch(groupRows, capability)) return true;
    }

    return false;
  },

  _anyCapabilityMatch(
    rows: Array<{ capabilities: string | string[] | null }>,
    capability: string,
  ): boolean {
    for (const r of rows) {
      if (r.capabilities == null) continue;
      if (parseCapabilities(r.capabilities).includes(capability)) return true;
    }
    return false;
  },
};

/** JSONB capabilities column → string[] (tolerates a JSON string or garbage). */
function parseCapabilities(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String) : [];
}
