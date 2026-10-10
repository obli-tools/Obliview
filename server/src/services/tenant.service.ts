import type { Knex } from 'knex';
import { db } from '../db';
import type { Tenant, TenantRole, TenantWithRole } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import { killSessionsForUser } from './userSessions.service';

/** Default tenant role for new memberships: the seeded 'user' permission set (049). */
export const DEFAULT_TENANT_ROLE: TenantRole = 'user';

/** 'admin' is always a valid tenant role: it short-circuits the capability
 *  matrix (permission.service), whether or not an 'admin' set row exists. */
const ADMIN_TENANT_ROLE: TenantRole = 'admin';

/**
 * Read-side normalisation of user_tenants.role. Empty values and the legacy
 * 'member' role (pre-053 vocabulary, migrated by 053 and 059) are reported
 * as the default 'user' permission set.
 */
export function normalizeTenantRole(role: string | null | undefined): TenantRole {
  return !role || role === 'member' ? DEFAULT_TENANT_ROLE : role;
}

/**
 * Validates tenant roles before they are written to user_tenants.role.
 * Since migration 053 the column holds a permission_set slug, so each value
 * must be 'admin' or an existing permission_sets.slug. Missing values default
 * to 'user', and the legacy 'member' is accepted as an alias of 'user'.
 * Throws AppError(400) on the first malformed or unknown role.
 * Returns the normalised roles, in input order.
 */
export async function resolveTenantRoles(roles: unknown[]): Promise<TenantRole[]> {
  const normalised = roles.map((role) => {
    if (role === undefined || role === null || role === '') return DEFAULT_TENANT_ROLE;
    if (typeof role !== 'string') throw new AppError(400, 'role must be a string');
    return normalizeTenantRole(role.trim());
  });

  const toCheck = [...new Set(normalised.filter((r) => r !== ADMIN_TENANT_ROLE))];
  if (toCheck.length > 0) {
    const rows = await db('permission_sets')
      .whereIn('slug', toCheck)
      .select<{ slug: string }[]>('slug');
    const known = new Set(rows.map((r) => r.slug));
    const unknown = toCheck.find((r) => !known.has(r));
    if (unknown !== undefined) {
      throw new AppError(400, `Unknown role '${unknown}': must be 'admin' or an existing permission set`);
    }
  }

  return normalised;
}

/** Single-value variant of resolveTenantRoles(). */
export async function resolveTenantRole(role: unknown): Promise<TenantRole> {
  const [resolved] = await resolveTenantRoles([role]);
  return resolved;
}

/**
 * Team memberships the user may no longer hold: teams are mono-tenant, so a
 * membership in a team of a tenant the user does not belong to any more
 * would keep its grants (team_permissions) on that tenant's groups and
 * monitors. Run inside the transaction that changes the user's user_tenants
 * rows, after the change. Returns the number of memberships removed.
 */
export async function pruneTeamMembershipsOutsideTenants(
  trx: Knex.Transaction,
  userId: number,
): Promise<number> {
  const rows = await trx('user_tenants').where({ user_id: userId }).pluck('tenant_id') as number[];
  // No membership at all: legacy account of the master tenant (auth fallback).
  const tenantIds = rows.length > 0 ? rows.map(Number) : [MASTER_TENANT_ID];
  return trx('team_memberships')
    .where('user_id', userId)
    .whereIn('team_id', trx('user_teams').whereNotIn('tenant_id', tenantIds).select('id'))
    .del();
}

/** Ends a user's sessions after a loss of workspace access — except for
 *  platform admins, who keep access to every workspace. */
export async function killSessionsAfterTenantLoss(userId: number): Promise<void> {
  const target = await db('users').where({ id: userId }).first('role') as { role: string } | undefined;
  if (target && target.role !== 'admin') {
    await killSessionsForUser(userId, 'tenant_access_removed');
  }
}

/**
 * A non-admin account left without any user_tenants row would fall back to
 * the master tenant (implicit membership of legacy accounts). After an
 * explicit loss of its last workspace (tenant removal, tenant deletion, empty
 * assignment, SSO prune) that fallback would WIDEN its access, so the account
 * is deactivated instead: no team memberships, no sessions, is_active=false.
 * A platform admin re-enables it after granting a workspace.
 * Returns the ids that were deactivated.
 */
export async function deactivateTenantlessUsers(userIds: number[], reason: string): Promise<number[]> {
  const ids = [...new Set(userIds.map(Number))];
  if (ids.length === 0) return [];
  const tenantless = await db('users')
    .whereIn('id', ids)
    .whereNot('role', 'admin')
    .whereNotExists(db('user_tenants').whereRaw('user_tenants.user_id = users.id'))
    .pluck('id') as number[];
  for (const userId of tenantless) {
    await db.transaction(async (trx) => {
      await trx('team_memberships').where({ user_id: userId }).del();
      await trx('users').where({ id: userId }).update({ is_active: false, updated_at: new Date() });
    });
    await killSessionsForUser(userId, reason);
    logger.warn({ userId, reason }, 'user lost its last workspace: account deactivated');
  }
  return tenantless;
}

/** Rows keyed by (scope, scope_id) that reference a group, monitor or agent
 *  device without a foreign key: removed explicitly when a tenant goes. */
const SCOPED_TABLES: ReadonlyArray<{ table: string; scopeColumn: string }> = [
  { table: 'settings', scopeColumn: 'scope' },
  { table: 'notification_bindings', scopeColumn: 'scope' },
  { table: 'remediation_bindings', scopeColumn: 'scope' },
  { table: 'maintenance_window_disables', scopeColumn: 'scope_type' },
  { table: 'maintenance_windows', scopeColumn: 'scope_type' },
  { table: 'team_permissions', scopeColumn: 'scope' },
];

interface TenantRow {
  id: number;
  name: string;
  slug: string;
  agent_update_policy?: string | null; // migration 068
  created_at: Date;
  updated_at: Date;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  email: string | null;
}

function rowToTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    agentUpdatePolicy: isAgentUpdatePolicy(row.agent_update_policy) ? row.agent_update_policy : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export const tenantService = {
  async getAll(): Promise<Tenant[]> {
    const rows = await db('tenants').select<TenantRow[]>('*').orderBy('id');
    return rows.map(rowToTenant);
  },

  async getById(id: number): Promise<Tenant | null> {
    const row = await db('tenants').where({ id }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async getBySlug(slug: string): Promise<Tenant | null> {
    const row = await db('tenants').where({ slug }).first<TenantRow>();
    return row ? rowToTenant(row) : null;
  },

  async create(data: { name: string; slug: string }): Promise<Tenant> {
    return db.transaction(async (trx) => {
      const [row] = await trx('tenants')
        .insert({ name: data.name, slug: data.slug })
        .returning('*');
      const tenant = row as TenantRow;
      // Global settings are per workspace: seed the new one from the master
      // tenant (same as migration 058 step c) so it does not silently run on
      // the hardcoded defaults. Notification bindings are deliberately NOT
      // copied — they are tenant-scoped to stop cross-tenant alert leaks.
      await trx.raw(
        `INSERT INTO settings (tenant_id, scope, scope_id, key, value, created_at, updated_at)
         SELECT ?, s.scope, NULL, s.key, s.value, NOW(), NOW()
           FROM settings s
          WHERE s.tenant_id = ? AND s.scope_id IS NULL
         ON CONFLICT (tenant_id, scope, key) WHERE scope_id IS NULL DO NOTHING`,
        [tenant.id, MASTER_TENANT_ID],
      );
      return rowToTenant(tenant);
    });
  },

  async update(id: number, data: { name?: string; slug?: string }): Promise<Tenant | null> {
    const [row] = await db('tenants')
      .where({ id })
      .update({ ...data, updated_at: db.fn.now() })
      .returning('*');
    return row ? rowToTenant(row as TenantRow) : null;
  },

  /**
   * Orchestrated tenant deletion. The tenant_id FKs cascade the owned rows
   * (groups, monitors, devices, channels…), but not:
   *   - the running monitor workers and the agents' WebSocket channels;
   *   - rows keyed by (scope, scope_id) without FK (settings, bindings,
   *     maintenance disables, team grants);
   *   - smtp_servers (FK ON DELETE SET NULL would turn them platform-level);
   *   - sessions whose active workspace is the deleted tenant.
   * Returns false when the tenant does not exist.
   */
  async delete(id: number): Promise<boolean> {
    const tenant = await db('tenants').where({ id }).first('id');
    if (!tenant) return false;

    // (1) Everything the tenant owns.
    const [monitorIds, groupIds, devices] = await Promise.all([
      db('monitors').where({ tenant_id: id }).pluck('id') as Promise<number[]>,
      db('monitor_groups').where({ tenant_id: id }).pluck('id') as Promise<number[]>,
      db('agent_devices').where({ tenant_id: id }).select('id', 'uuid') as Promise<Array<{ id: number; uuid: string }>>,
    ]);
    const deviceIds = devices.map((d) => d.id);
    // Members, collected before the CASCADE removes their user_tenants rows.
    const memberIds = await db('user_tenants').where({ tenant_id: id }).pluck('user_id') as number[];
    const deviceUuids = devices.map((d) => d.uuid).filter(Boolean);

    // (2) Stop the workers and close the agents' command channels before the
    // rows disappear (a worker would keep probing, then fail on the FK).
    // Lazy imports: these modules depend on half the service layer.
    try {
      const { MonitorWorkerManager } = await import('../workers/MonitorWorkerManager');
      const wm = MonitorWorkerManager.getInstance();
      for (const monitorId of monitorIds) await wm.stopMonitor(monitorId);
    } catch (err) {
      logger.warn({ err, tenantId: id }, 'tenant delete: could not stop monitor workers');
    }
    const { agentHub } = await import('./agentHub.service');
    agentHub.disconnectDevices(deviceUuids);

    // (3) Application-level references, then the tenant row (CASCADE).
    const byScope: Array<[string, number[]]> = [
      ['group', groupIds],
      ['monitor', monitorIds],
      ['agent', deviceIds],
    ];
    await db.transaction(async (trx) => {
      for (const { table, scopeColumn } of SCOPED_TABLES) {
        for (const [scope, ids] of byScope) {
          if (ids.length === 0) continue;
          await trx(table).where(scopeColumn, scope).whereIn('scope_id', ids).del();
        }
      }
      await trx('smtp_servers').where({ tenant_id: id }).del();
      await trx('tenants').where({ id }).delete();
    });

    // (4) Sessions on the deleted workspace: drop the key, the next
    // /auth/me falls back to the user's first remaining tenant.
    await db.raw(
      `UPDATE session
          SET sess = ((sess::jsonb) - 'currentTenantId')::json
        WHERE (sess::jsonb ->> 'currentTenantId') = ?`,
      [String(id)],
    );

    // (5) In-memory state keyed by the deleted entities.
    try {
      const { groupNotificationService } = await import('./groupNotification.service');
      for (const groupId of groupIds) groupNotificationService.removeGroup(groupId);
      for (const monitorId of monitorIds) groupNotificationService.removeMonitor(monitorId);
    } catch (err) {
      logger.warn({ err, tenantId: id }, 'tenant delete: could not clear group notification state');
    }
    agentHub.syncAllProxyMonitors().catch(() => {});

    // (6) Exclusive members of the deleted tenant: no implicit master fallback.
    await deactivateTenantlessUsers(memberIds, 'tenant deleted');

    logger.info(
      { tenantId: id, monitors: monitorIds.length, groups: groupIds.length, devices: deviceIds.length },
      'tenant deleted',
    );
    return true;
  },

  /** Returns the first tenant accessible by userId (lowest id). */
  async getFirstTenantForUser(userId: number): Promise<Tenant | null> {
    const row = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .first<TenantRow & { role: string }>('tenants.*');
    return row ? rowToTenant(row) : null;
  },

  /** Returns all tenants accessible by userId, with tenant-level role. */
  async getTenantsForUser(userId: number): Promise<TenantWithRole[]> {
    const rows = await db('tenants')
      .join('user_tenants', 'tenants.id', 'user_tenants.tenant_id')
      .where('user_tenants.user_id', userId)
      .orderBy('tenants.id')
      .select<(TenantRow & { role: string })[]>('tenants.*', 'user_tenants.role');
    return rows.map((r) => ({ ...rowToTenant(r), role: normalizeTenantRole(r.role) }));
  },

  /** Check if user has access to a specific tenant. */
  async userHasAccess(userId: number, tenantId: number): Promise<boolean> {
    const row = await db('user_tenants')
      .where({ user_id: userId, tenant_id: tenantId })
      .first('user_id');
    return !!row;
  },

  async getMembers(tenantId: number): Promise<(UserRow & { tenantRole: string })[]> {
    return db('users')
      .join('user_tenants', 'users.id', 'user_tenants.user_id')
      .where('user_tenants.tenant_id', tenantId)
      .select<(UserRow & { tenantRole: string })[]>(
        'users.id',
        'users.username',
        'users.display_name',
        'users.role',
        'users.is_active',
        'users.email',
        db.raw('user_tenants.role as "tenantRole"'),
      )
      .orderBy('users.username');
  },

  /** `role` must already be validated with resolveTenantRole(). */
  async addUser(tenantId: number, userId: number, role: TenantRole): Promise<void> {
    await db('user_tenants')
      .insert({ tenant_id: tenantId, user_id: userId, role })
      .onConflict(['user_id', 'tenant_id'])
      .merge({ role });
  },

  /**
   * Removes the user from the tenant. Their memberships in that tenant's
   * teams go in the same transaction (teams are mono-tenant: a membership
   * left behind kept its grants on the tenant's groups and monitors), then
   * their sessions are ended (platform admins excepted).
   * Returns false when the user was not a member.
   */
  async removeUser(tenantId: number, userId: number): Promise<boolean> {
    const removed = await db.transaction(async (trx) => {
      const count = await trx('user_tenants').where({ tenant_id: tenantId, user_id: userId }).delete();
      await pruneTeamMembershipsOutsideTenants(trx, userId);
      return count > 0;
    });
    if (removed) {
      await killSessionsAfterTenantLoss(userId);
      await deactivateTenantlessUsers([userId], 'last tenant membership removed');
    }
    return removed;
  },

  /** `role` must already be validated with resolveTenantRole().
   *  Returns false when the user is not a member of the tenant. */
  async updateUserRole(tenantId: number, userId: number, role: TenantRole): Promise<boolean> {
    const count = await db('user_tenants')
      .where({ tenant_id: tenantId, user_id: userId })
      .update({ role });
    return count > 0;
  },
};
