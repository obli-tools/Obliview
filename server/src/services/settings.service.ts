import type { Knex } from 'knex';
import { db } from '../db';
import type { SettingsScope, ResolvedSettings } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { SETTINGS_KEYS, HARDCODED_DEFAULTS, SETTINGS_DEFINITIONS } from '@obliview/shared';

interface SettingsRow {
  id: number;
  tenant_id: number;
  scope: string;
  scope_id: number | null;
  key: string;
  value: unknown;
  created_at: Date;
  updated_at: Date;
}

export interface SettingOverride {
  key: SettingsKey;
  value: number;
}

/** Effective value of one setting for one monitor (bulk resolution). */
export interface MonitorSettingValue {
  monitorId: number;
  value: number;
  source: SettingsScope | 'default';
}

/** Display name of the workspace (tenant-global) layer. */
const WORKSPACE_SOURCE_NAME = 'Workspace';

/** jsonb settings value → finite number, or null when unusable. */
function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validates one override: known key, within the definition range, and the
 * admin policy (MIN_CHECK_INTERVAL / MIN_RETRY_INTERVAL env vars).
 * Throws an Error whose message the controller maps to a 400.
 */
function assertValidOverride(key: SettingsKey, value: number): void {
  const def = SETTINGS_DEFINITIONS.find((d) => d.key === key);
  if (!def) throw new Error(`Unknown setting key: ${key}`);
  if (!Number.isFinite(value) || value < def.min || value > def.max) {
    throw new Error(`Value for ${key} must be between ${def.min} and ${def.max}`);
  }

  const minCheckInterval = Math.max(1, parseInt(process.env.MIN_CHECK_INTERVAL ?? '10', 10));
  if (key === SETTINGS_KEYS.CHECK_INTERVAL && value < minCheckInterval) {
    throw new Error(`Check interval must be at least ${minCheckInterval}s (admin policy)`);
  }
  const minRetryInterval = Math.max(1, parseInt(process.env.MIN_RETRY_INTERVAL ?? '5', 10));
  if (key === SETTINGS_KEYS.RETRY_INTERVAL && value < minRetryInterval) {
    throw new Error(`Retry interval must be at least ${minRetryInterval}s (admin policy)`);
  }
}

/** A raw settings row of one tenant (used by import / export). */
export interface TenantSettingRow {
  scope: string;
  scopeId: number | null;
  key: string;
  value: unknown;
}

/** Tenant of a group, or null when the group does not exist. */
async function getGroupTenantId(groupId: number): Promise<number | null> {
  const row = await db('monitor_groups').where({ id: groupId }).select('tenant_id').first() as
    { tenant_id: number } | undefined;
  return row?.tenant_id ?? null;
}

/** Tenant of a monitor, or null when the monitor does not exist. */
async function getMonitorTenantId(monitorId: number): Promise<number | null> {
  const row = await db('monitors').where({ id: monitorId }).select('tenant_id').first() as
    { tenant_id: number } | undefined;
  return row?.tenant_id ?? null;
}

function defaultsOnly(): ResolvedSettings {
  const resolved: ResolvedSettings = {} as ResolvedSettings;
  for (const key of Object.values(SETTINGS_KEYS)) {
    resolved[key] = {
      value: HARDCODED_DEFAULTS[key],
      source: 'default',
      sourceId: null,
      sourceName: 'Default',
    };
  }
  return resolved;
}

/**
 * Settings are tenant-scoped since migration 058:
 *   - 'global' means "workspace defaults" (one row set per tenant);
 *   - group / monitor rows carry the tenant of their entity.
 * Inheritance: Hardcoded defaults → tenant global → group ancestors → monitor.
 */
export const settingsService = {
  // ── Raw CRUD ──

  async getByScope(tenantId: number, scope: SettingsScope, scopeId: number | null): Promise<Record<string, number>> {
    const rows = await db<SettingsRow>('settings')
      .where({ tenant_id: tenantId, scope, scope_id: scopeId })
      // Deterministic: should a duplicate ever exist, the most recent row (highest id) wins.
      .orderBy('id', 'asc')
      .select('key', 'value');

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.key] = row.value as number;
    }
    return result;
  },

  /**
   * Raw upsert of one setting, no validation. Global rows (scope_id IS NULL)
   * and scoped rows each have their own PARTIAL unique index (migration 058):
   * PostgreSQL only infers a partial index when ON CONFLICT repeats its
   * predicate, and a plain UNIQUE never fires on a NULL scope_id.
   * `conn` lets import run the upsert inside its transaction.
   */
  async upsert(
    tenantId: number,
    scope: SettingsScope,
    scopeId: number | null,
    key: string,
    value: unknown,
    conn: Knex | Knex.Transaction = db,
  ): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);

    if (scopeId === null) {
      await conn.raw(
        `INSERT INTO settings (tenant_id, scope, scope_id, key, value, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, NOW(), NOW())
         ON CONFLICT (tenant_id, scope, key) WHERE scope_id IS NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [tenantId, scope, key, serialized],
      );
    } else {
      await conn.raw(
        `INSERT INTO settings (tenant_id, scope, scope_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())
         ON CONFLICT (tenant_id, scope, scope_id, key) WHERE scope_id IS NOT NULL
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [tenantId, scope, scopeId, key, serialized],
      );
    }
  },

  async set(tenantId: number, scope: SettingsScope, scopeId: number | null, key: SettingsKey, value: number): Promise<void> {
    assertValidOverride(key, value);
    await this.upsert(tenantId, scope, scopeId, key, value);
  },

  async remove(tenantId: number, scope: SettingsScope, scopeId: number | null, key: SettingsKey): Promise<boolean> {
    const count = await db('settings')
      .where({ tenant_id: tenantId, scope, scope_id: scopeId, key })
      .del();
    return count > 0;
  },

  /**
   * Writes several overrides of one scope. Every value is validated first and
   * the rows are written in one transaction: all of them or none.
   */
  async setBulk(tenantId: number, scope: SettingsScope, scopeId: number | null, overrides: SettingOverride[]): Promise<void> {
    for (const { key, value } of overrides) assertValidOverride(key, value);
    if (overrides.length === 0) return;
    await db.transaction(async (trx) => {
      for (const { key, value } of overrides) {
        await this.upsert(tenantId, scope, scopeId, key, value, trx);
      }
    });
  },

  /**
   * Monitor-scope overrides for many monitors at once (bulk edit): sets
   * `overrides` and removes the `remove` keys on every target, each in its own
   * tenant. Validated up front, written in one transaction.
   */
  async applyMonitorOverrides(
    targets: Array<{ monitorId: number; tenantId: number }>,
    overrides: SettingOverride[],
    remove: SettingsKey[],
  ): Promise<void> {
    for (const { key, value } of overrides) assertValidOverride(key, value);
    if (targets.length === 0 || (overrides.length === 0 && remove.length === 0)) return;
    await db.transaction(async (trx) => {
      for (const { monitorId, tenantId } of targets) {
        for (const { key, value } of overrides) {
          await this.upsert(tenantId, 'monitor', monitorId, key, value, trx);
        }
        if (remove.length > 0) {
          await trx('settings')
            .where({ tenant_id: tenantId, scope: 'monitor', scope_id: monitorId })
            .whereIn('key', remove)
            .del();
        }
      }
    });
  },

  /**
   * Effective value of one setting for every monitor of a tenant, resolved in a
   * single query with the same chain as resolveForMonitor:
   *   monitor override → nearest group ancestor (group itself first) →
   *   workspace (tenant global) → hardcoded default.
   * Duplicate rows (should never exist) resolve like getByScope: highest id wins.
   * `monitorIds` restricts the result to those monitors (e.g. the monitors a
   * proxy agent runs); omitted = every monitor of the tenant.
   */
  async resolveKeyForTenantMonitors(tenantId: number, key: SettingsKey, monitorIds?: number[]): Promise<MonitorSettingValue[]> {
    if (monitorIds && monitorIds.length === 0) return [];
    const result = await db.raw(
      `
      SELECT m.id AS monitor_id,
             mov.value AS monitor_value,
             grv.value AS group_value,
             glv.value AS global_value
        FROM monitors m
        LEFT JOIN LATERAL (
              SELECT s.value
                FROM settings s
               WHERE s.tenant_id = m.tenant_id
                 AND s.scope = 'monitor'
                 AND s.scope_id = m.id
                 AND s.key = ?
               ORDER BY s.id DESC
               LIMIT 1
             ) mov ON TRUE
        LEFT JOIN LATERAL (
              SELECT s.value
                FROM group_closure gc
                JOIN settings s
                  ON s.tenant_id = m.tenant_id
                 AND s.scope = 'group'
                 AND s.scope_id = gc.ancestor_id
                 AND s.key = ?
               WHERE gc.descendant_id = m.group_id
               ORDER BY gc.depth ASC, s.id DESC
               LIMIT 1
             ) grv ON TRUE
        LEFT JOIN LATERAL (
              SELECT s.value
                FROM settings s
               WHERE s.tenant_id = m.tenant_id
                 AND s.scope = 'global'
                 AND s.scope_id IS NULL
                 AND s.key = ?
               ORDER BY s.id DESC
               LIMIT 1
             ) glv ON TRUE
       WHERE m.tenant_id = ?
         ${monitorIds ? 'AND m.id = ANY(?::int[])' : ''}
       ORDER BY m.id
      `,
      monitorIds ? [key, key, key, tenantId, monitorIds] : [key, key, key, tenantId],
    ) as { rows: Array<{ monitor_id: number; monitor_value: unknown; group_value: unknown; global_value: unknown }> };

    const fallback = HARDCODED_DEFAULTS[key];
    return result.rows.map((row) => {
      const monitorValue = toNumber(row.monitor_value);
      if (monitorValue !== null) return { monitorId: row.monitor_id, value: monitorValue, source: 'monitor' as const };
      const groupValue = toNumber(row.group_value);
      if (groupValue !== null) return { monitorId: row.monitor_id, value: groupValue, source: 'group' as const };
      const globalValue = toNumber(row.global_value);
      if (globalValue !== null) return { monitorId: row.monitor_id, value: globalValue, source: 'global' as const };
      return { monitorId: row.monitor_id, value: fallback, source: 'default' as const };
    });
  },

  /** Every settings row of a tenant, in a stable order (export). */
  async listForTenant(tenantId: number): Promise<TenantSettingRow[]> {
    const rows = await db<SettingsRow>('settings')
      .where({ tenant_id: tenantId })
      .orderBy('scope')
      .orderBy('scope_id')
      .orderBy('key')
      .orderBy('id')
      .select('scope', 'scope_id', 'key', 'value');
    return rows.map((r) => ({ scope: r.scope, scopeId: r.scope_id, key: r.key, value: r.value }));
  },

  /** Tenant owning a settings scope entity — null when it does not exist. */
  async getScopeTenantId(scope: 'group' | 'monitor', scopeId: number): Promise<number | null> {
    return scope === 'group' ? getGroupTenantId(scopeId) : getMonitorTenantId(scopeId);
  },

  // ── Inheritance Resolution ──

  /**
   * Resolve all settings for a given scope, walking up the hierarchy:
   *   Hardcoded defaults → Workspace (tenant) global → Group ancestors (root→leaf) → Monitor
   *
   * Each resolved value tracks its source for UI display.
   * `tenantId` defaults to the monitor's own tenant.
   * `includeOwn = false` stops before the monitor layer: what the monitor
   * inherits (shown as the placeholder of an empty override field).
   */
  async resolveForMonitor(
    monitorId: number,
    groupId: number | null,
    tenantId?: number,
    includeOwn = true,
  ): Promise<ResolvedSettings> {
    const effectiveTenantId = tenantId ?? await getMonitorTenantId(monitorId);

    // 1. Start with hardcoded defaults
    const resolved = defaultsOnly();
    // Unknown monitor → nothing to inherit from.
    if (effectiveTenantId === null) return resolved;

    const allKeys = Object.values(SETTINGS_KEYS);

    // 2. Apply the tenant's global (workspace) overrides
    const globalOverrides = await this.getByScope(effectiveTenantId, 'global', null);
    for (const key of allKeys) {
      if (globalOverrides[key] !== undefined) {
        resolved[key] = {
          value: globalOverrides[key],
          source: 'global',
          sourceId: null,
          sourceName: WORKSPACE_SOURCE_NAME,
        };
      }
    }

    // 3. Apply group chain (root → leaf) if monitor is in a group
    if (groupId !== null) {
      // Get ancestors ordered by depth DESC (root first → direct parent last)
      const ancestorRows = await db('group_closure')
        .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
        .where('group_closure.descendant_id', groupId)
        .orderBy('group_closure.depth', 'desc')
        .select('monitor_groups.id', 'monitor_groups.name', 'group_closure.depth');

      for (const ancestor of ancestorRows) {
        const groupOverrides = await this.getByScope(effectiveTenantId, 'group', ancestor.id);
        for (const key of allKeys) {
          if (groupOverrides[key] !== undefined) {
            resolved[key] = {
              value: groupOverrides[key],
              source: 'group',
              sourceId: ancestor.id,
              sourceName: ancestor.name,
            };
          }
        }
      }
    }

    if (!includeOwn) return resolved;

    // 4. Apply monitor-level overrides
    const monitorOverrides = await this.getByScope(effectiveTenantId, 'monitor', monitorId);
    for (const key of allKeys) {
      if (monitorOverrides[key] !== undefined) {
        resolved[key] = {
          value: monitorOverrides[key],
          source: 'monitor',
          sourceId: monitorId,
          sourceName: 'This monitor',
        };
      }
    }

    return resolved;
  },

  /**
   * Resolve settings for a group level (for display in group settings UI).
   * Chain: Hardcoded → Workspace (tenant) global → Ancestor groups (root→parent)
   * Does NOT include the group's own overrides as resolved — returns them separately.
   * `tenantId` defaults to the group's own tenant.
   */
  async resolveForGroup(groupId: number, tenantId?: number): Promise<{ resolved: ResolvedSettings; overrides: Record<string, number> }> {
    const effectiveTenantId = tenantId ?? await getGroupTenantId(groupId);
    const allKeys = Object.values(SETTINGS_KEYS);

    // 1. Start with hardcoded defaults
    const resolved = defaultsOnly();
    if (effectiveTenantId === null) return { resolved, overrides: {} };

    // 2. Global (workspace)
    const globalOverrides = await this.getByScope(effectiveTenantId, 'global', null);
    for (const key of allKeys) {
      if (globalOverrides[key] !== undefined) {
        resolved[key] = {
          value: globalOverrides[key],
          source: 'global',
          sourceId: null,
          sourceName: WORKSPACE_SOURCE_NAME,
        };
      }
    }

    // 3. Ancestors (root→parent, excluding self)
    const ancestorRows = await db('group_closure')
      .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
      .where('group_closure.descendant_id', groupId)
      .where('group_closure.depth', '>', 0) // exclude self
      .orderBy('group_closure.depth', 'desc')
      .select('monitor_groups.id', 'monitor_groups.name', 'group_closure.depth');

    for (const ancestor of ancestorRows) {
      const groupOvr = await this.getByScope(effectiveTenantId, 'group', ancestor.id);
      for (const key of allKeys) {
        if (groupOvr[key] !== undefined) {
          resolved[key] = {
            value: groupOvr[key],
            source: 'group',
            sourceId: ancestor.id,
            sourceName: ancestor.name,
          };
        }
      }
    }

    // 4. Get this group's own overrides (separate, not merged into resolved)
    const overrides = await this.getByScope(effectiveTenantId, 'group', groupId);

    return { resolved, overrides };
  },

  /**
   * Resolve for the global (workspace) scope of a tenant:
   * hardcoded defaults + that tenant's global overrides.
   */
  async resolveGlobal(tenantId: number): Promise<{ resolved: ResolvedSettings; overrides: Record<string, number> }> {
    const resolved = defaultsOnly();
    const overrides = await this.getByScope(tenantId, 'global', null);
    return { resolved, overrides };
  },
};
