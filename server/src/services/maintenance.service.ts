import { db } from '../db';
import type { MaintenanceWindow, MaintenanceScopeType } from '@obliview/shared';
import { getPlugin } from '../notifications/registry';
import { config } from '../config';
import { logger } from '../utils/logger';

// ─── DB Row → domain type ───────────────────────────────────────────────────

interface MaintenanceWindowRow {
  id: number;
  name: string;
  scope_type: string;
  scope_id: number | null;
  is_override: boolean;
  schedule_type: string;
  start_at: Date | null;
  end_at: Date | null;
  start_time: string | null;
  end_time: string | null;
  recurrence_type: string | null;
  days_of_week: number[] | null;
  timezone: string;
  notify_channel_ids: number[];
  last_notified_start_at: Date | null;
  last_notified_end_at: Date | null;
  active: boolean;
  tenant_id: number;
  created_at: Date;
}

function rowToWindow(row: MaintenanceWindowRow): MaintenanceWindow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    scopeType: row.scope_type as MaintenanceWindow['scopeType'],
    scopeId: row.scope_id,
    isOverride: row.is_override,
    scheduleType: row.schedule_type as MaintenanceWindow['scheduleType'],
    startAt: row.start_at?.toISOString() ?? null,
    endAt: row.end_at?.toISOString() ?? null,
    startTime: row.start_time,
    endTime: row.end_time,
    recurrenceType: (row.recurrence_type as MaintenanceWindow['recurrenceType']) ?? null,
    daysOfWeek: row.days_of_week,
    timezone: row.timezone,
    notifyChannelIds: row.notify_channel_ids ?? [],
    lastNotifiedStartAt: row.last_notified_start_at?.toISOString() ?? null,
    lastNotifiedEndAt: row.last_notified_end_at?.toISOString() ?? null,
    active: row.active,
    createdAt: row.created_at.toISOString(),
  };
}

// ─── Time helpers ────────────────────────────────────────────────────────────

/**
 * Get the current HH:MM time string in a given IANA timezone.
 */
function getNowTimeInTz(timezone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      // h23, not hour12:false — the latter renders midnight as "24" in some
      // ICU builds, which breaks the HH:MM string comparisons below.
      hourCycle: 'h23',
    }).formatToParts(now);
    const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
    return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
  } catch {
    return '00:00';
  }
}

/**
 * Get the current day of week (0=Mon … 6=Sun) in a given IANA timezone.
 */
function getNowDayOfWeekInTz(timezone: string, now: Date): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).formatToParts(now);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    return map[weekday ?? ''] ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Where a HH:MM time falls relative to a daily [startTime, endTime) range.
 * The end is EXCLUSIVE (a 02:00–04:00 window is over at 04:00).
 *   - 'start-day': inside the range, on the day the range started;
 *   - 'next-day' : inside an overnight range (start > end, e.g. 22:00–02:00),
 *                  after midnight — the range started on the PREVIOUS day;
 *   - null       : outside the range.
 * start === end is a full 24 h range starting at startTime.
 */
function timeRangePosition(currentTime: string, startTime: string, endTime: string): 'start-day' | 'next-day' | null {
  const cur = currentTime.slice(0, 5);
  const start = startTime.slice(0, 5);
  const end = endTime.slice(0, 5);

  if (start < end) {
    return cur >= start && cur < end ? 'start-day' : null;
  }
  // Overnight (start > end) or full day (start === end)
  if (cur >= start) return 'start-day';
  if (cur < end) return 'next-day';
  return null;
}

/**
 * Pure function: check if a single maintenance window is currently active.
 */
export function isWindowActive(window: MaintenanceWindow, now: Date = new Date()): boolean {
  if (!window.active) return false;

  if (window.scheduleType === 'one_time') {
    if (!window.startAt || !window.endAt) return false;
    const start = new Date(window.startAt);
    const end = new Date(window.endAt);
    return now >= start && now <= end;
  }

  // recurring
  if (!window.startTime || !window.endTime) return false;
  const currentTime = getNowTimeInTz(window.timezone, now);
  const position = timeRangePosition(currentTime, window.startTime, window.endTime);
  if (position === null) return false;

  if (window.recurrenceType === 'daily') {
    return true;
  }

  if (window.recurrenceType === 'weekly') {
    if (!window.daysOfWeek || window.daysOfWeek.length === 0) return false;
    const currentDay = getNowDayOfWeekInTz(window.timezone, now);
    // daysOfWeek lists the days a window STARTS on. After midnight of an
    // overnight window (Sat 22:00 → Sun 02:00), test the previous day.
    const startDay = position === 'next-day' ? (currentDay + 6) % 7 : currentDay;
    return window.daysOfWeek.includes(startDay);
  }

  return false;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000; // 60 seconds

interface CacheEntry {
  value: boolean;
  cachedAt: number;
}

const maintenanceCache = new Map<string, CacheEntry>();

function getCached(key: string): boolean | null {
  const entry = maintenanceCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    maintenanceCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key: string, value: boolean): void {
  maintenanceCache.set(key, { value, cachedAt: Date.now() });
}

// ─── Tenant scoping ──────────────────────────────────────────────────────────
// A 'global' window is workspace-wide: it only covers monitors / agents /
// groups of its own tenant (maintenance_windows.tenant_id). The entity's tenant
// is passed in by callers that know it, or looked up here (cached — an
// entity's tenant practically never changes).

type MaintenanceEntityType = 'monitor' | 'agent' | 'group';

const ENTITY_TABLE: Record<MaintenanceEntityType, string> = {
  monitor: 'monitors',
  agent: 'agent_devices',
  group: 'monitor_groups',
};

const entityTenantCache = new Map<string, { tenantId: number | null; cachedAt: number }>();

async function getEntityTenantId(scopeType: MaintenanceEntityType, scopeId: number): Promise<number | null> {
  const key = `${scopeType}:${scopeId}`;
  const now = Date.now();
  const entry = entityTenantCache.get(key);
  if (entry && now - entry.cachedAt <= CACHE_TTL_MS) return entry.tenantId;

  const row = await db(ENTITY_TABLE[scopeType]).where({ id: scopeId }).select('tenant_id').first() as
    { tenant_id: number } | undefined;
  const tenantId = row?.tenant_id ?? null;

  // Lazy prune so a long-lived process cannot grow the map unbounded.
  if (entityTenantCache.size > 5000) {
    for (const [k, v] of entityTenantCache) {
      if (now - v.cachedAt > CACHE_TTL_MS) entityTenantCache.delete(k);
    }
  }
  entityTenantCache.set(key, { tenantId, cachedAt: now });
  return tenantId;
}

/** Fill in missing tenant ids of a batch of entities with a single query. */
async function resolveBatchTenants(
  scopeType: 'monitor' | 'agent',
  items: Array<{ id: number; tenantId?: number | null }>,
): Promise<Map<number, number>> {
  const tenantById = new Map<number, number>();
  const missing: number[] = [];
  for (const item of items) {
    if (item.tenantId !== undefined && item.tenantId !== null) tenantById.set(item.id, item.tenantId);
    else missing.push(item.id);
  }
  if (missing.length > 0) {
    const rows = await db(ENTITY_TABLE[scopeType]).whereIn('id', missing).select('id', 'tenant_id') as
      Array<{ id: number; tenant_id: number }>;
    for (const r of rows) tenantById.set(r.id, r.tenant_id);
  }
  return tenantById;
}

/** Group global windows by their tenant. */
function globalWindowsByTenant(rows: MaintenanceWindowRow[]): Map<number, MaintenanceWindow[]> {
  const byTenant = new Map<number, MaintenanceWindow[]>();
  for (const row of rows) {
    if (row.scope_type !== 'global') continue;
    if (!byTenant.has(row.tenant_id)) byTenant.set(row.tenant_id, []);
    byTenant.get(row.tenant_id)!.push(rowToWindow(row));
  }
  return byTenant;
}

// ─── Background job handles ───────────────────────────────────────────────────

let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let transitionTimer: ReturnType<typeof setInterval> | null = null;

// ─── Core service ─────────────────────────────────────────────────────────────

export const maintenanceService = {
  // ── CRUD ──────────────────────────────────────────────────────────────────

  async list(tenantId: number | null, filters?: { scopeType?: string; scopeId?: number }): Promise<MaintenanceWindow[]> {
    const query = db<MaintenanceWindowRow>('maintenance_windows').orderBy('created_at', 'desc');
    if (tenantId !== null) query.where({ tenant_id: tenantId });
    if (filters?.scopeType) {
      query.where({ scope_type: filters.scopeType });
      // For 'global', scope_id is NULL — do not add a scopeId filter
      if (filters.scopeType !== 'global' && filters?.scopeId !== undefined) {
        query.where({ scope_id: filters.scopeId });
      }
    } else if (filters?.scopeId !== undefined) {
      query.where({ scope_id: filters.scopeId });
    }
    const rows = await query;
    return rows.map(rowToWindow);
  },

  /**
   * Window by id, tenant-gated: `tenantScope` null = god view (any tenant),
   * otherwise WHERE id AND tenant_id — a window of another tenant is "not found".
   */
  async getById(id: number, tenantScope: number | null): Promise<MaintenanceWindow | null> {
    const query = db<MaintenanceWindowRow>('maintenance_windows').where({ id });
    if (tenantScope !== null) query.where({ tenant_id: tenantScope });
    const row = await query.first();
    return row ? rowToWindow(row) : null;
  },

  /** Tenant owning a window — null when it does not exist. */
  async getWindowTenantId(id: number): Promise<number | null> {
    const row = await db<MaintenanceWindowRow>('maintenance_windows').where({ id }).select('tenant_id').first();
    return row?.tenant_id ?? null;
  },

  /** Tenant owning a group / monitor / agent — null when it does not exist (uncached). */
  async getScopeTenantId(scopeType: MaintenanceEntityType, scopeId: number): Promise<number | null> {
    const row = await db(ENTITY_TABLE[scopeType]).where({ id: scopeId }).select('tenant_id').first() as
      { tenant_id: number } | undefined;
    return row?.tenant_id ?? null;
  },

  /**
   * Of `channelIds`, the ones that are NOT owned by / shared to `tenantId`
   * (maintenance start/end notifications may only use the window tenant's channels).
   */
  async getForeignChannelIds(channelIds: number[], tenantId: number): Promise<number[]> {
    const unique = [...new Set(channelIds)];
    if (unique.length === 0) return [];
    const rows = await db('notification_channels')
      .whereIn('notification_channels.id', unique)
      .where(function () {
        this.where('notification_channels.tenant_id', tenantId)
          .orWhereIn(
            'notification_channels.id',
            db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }),
          );
      })
      .select('notification_channels.id') as Array<{ id: number }>;
    const usable = new Set(rows.map((r) => r.id));
    return unique.filter((id) => !usable.has(id));
  },

  async create(data: {
    name: string;
    scopeType: MaintenanceScopeType;
    scopeId?: number | null;
    scheduleType: string;
    startAt?: string | null;
    endAt?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    recurrenceType?: string | null;
    daysOfWeek?: number[] | null;
    timezone?: string;
    notifyChannelIds?: number[];
    lastNotifiedStartAt?: string | null;
    lastNotifiedEndAt?: string | null;
    active?: boolean;
    tenantId: number;
  }): Promise<MaintenanceWindow> {
    const [row] = await db<MaintenanceWindowRow>('maintenance_windows')
      .insert({
        name: data.name,
        scope_type: data.scopeType,
        scope_id: data.scopeId ?? null,
        is_override: false, // deprecated, always false
        schedule_type: data.scheduleType,
        start_at: data.startAt ? new Date(data.startAt) : null,
        end_at: data.endAt ? new Date(data.endAt) : null,
        start_time: data.startTime ?? null,
        end_time: data.endTime ?? null,
        recurrence_type: data.recurrenceType ?? null,
        days_of_week: data.daysOfWeek ?? null,
        timezone: data.timezone ?? 'UTC',
        notify_channel_ids: data.notifyChannelIds ?? [],
        active: data.active ?? true,
        tenant_id: data.tenantId,
      })
      .returning('*');
    maintenanceCache.clear();
    return rowToWindow(row);
  },

  async update(id: number, data: {
    name?: string;
    scopeType?: MaintenanceScopeType;
    scopeId?: number | null;
    scheduleType?: string;
    startAt?: string | null;
    endAt?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    recurrenceType?: string | null;
    daysOfWeek?: number[] | null;
    timezone?: string;
    notifyChannelIds?: number[];
    active?: boolean;
    /** Move the window to another tenant (god view retargeting its scope). */
    tenantId?: number;
  }, tenantScope: number | null): Promise<MaintenanceWindow | null> {
    const patch: Record<string, unknown> = {};
    if (data.tenantId !== undefined) patch.tenant_id = data.tenantId;
    if (data.name !== undefined) patch.name = data.name;
    if (data.scopeType !== undefined) patch.scope_type = data.scopeType;
    if ('scopeId' in data) patch.scope_id = data.scopeId ?? null;
    if (data.scheduleType !== undefined) patch.schedule_type = data.scheduleType;
    if ('startAt' in data) patch.start_at = data.startAt ? new Date(data.startAt) : null;
    if ('endAt' in data) patch.end_at = data.endAt ? new Date(data.endAt) : null;
    if ('startTime' in data) patch.start_time = data.startTime ?? null;
    if ('endTime' in data) patch.end_time = data.endTime ?? null;
    if ('recurrenceType' in data) patch.recurrence_type = data.recurrenceType ?? null;
    if ('daysOfWeek' in data) patch.days_of_week = data.daysOfWeek ?? null;
    if (data.timezone !== undefined) patch.timezone = data.timezone;
    if (data.notifyChannelIds !== undefined) patch.notify_channel_ids = data.notifyChannelIds;
    if (data.active !== undefined) patch.active = data.active;

    if (Object.keys(patch).length === 0) return this.getById(id, tenantScope);

    // WHERE id AND tenant_id (god view: id only). The scope applies to the
    // window's CURRENT tenant, before a god-view retarget moves it.
    const query = db<MaintenanceWindowRow>('maintenance_windows').where({ id });
    if (tenantScope !== null) query.where({ tenant_id: tenantScope });
    const [row] = await query.update(patch).returning('*');

    maintenanceCache.clear();
    return row ? rowToWindow(row) : null;
  },

  /** Delete, tenant-gated (`tenantScope` null = god view). False when nothing matched. */
  async delete(id: number, tenantScope: number | null): Promise<boolean> {
    const query = db('maintenance_windows').where({ id });
    if (tenantScope !== null) query.where({ tenant_id: tenantScope });
    const count = await query.del();
    maintenanceCache.clear();
    return count > 0;
  },

  /**
   * Whether a disable / enable of window `windowId` at an entity is allowed:
   * the window must be visible in `tenantScope` (null = god view), and the
   * entity must belong to the window's own tenant (a window never applies to
   * another tenant's entities, so a cross-tenant disable is meaningless).
   */
  async canToggleWindowForScope(
    windowId: number,
    scopeType: 'group' | 'monitor' | 'agent',
    scopeId: number,
    tenantScope: number | null,
  ): Promise<boolean> {
    const query = db<MaintenanceWindowRow>('maintenance_windows').where({ id: windowId });
    if (tenantScope !== null) query.where({ tenant_id: tenantScope });
    const win = await query.select('tenant_id').first() as { tenant_id: number } | undefined;
    if (!win) return false;
    const entityTenantId = await this.getScopeTenantId(scopeType, scopeId);
    return entityTenantId !== null && entityTenantId === win.tenant_id;
  },

  // ── Disable / Enable ───────────────────────────────────────────────────────

  /**
   * Disable an inherited maintenance window at the given scope.
   * Silently ignores duplicate disables (ON CONFLICT DO NOTHING).
   */
  async disableWindowForScope(
    windowId: number,
    scopeType: 'group' | 'monitor' | 'agent',
    scopeId: number,
    tenantScope: number | null,
  ): Promise<boolean> {
    if (!(await this.canToggleWindowForScope(windowId, scopeType, scopeId, tenantScope))) return false;
    await db('maintenance_window_disables')
      .insert({ window_id: windowId, scope_type: scopeType, scope_id: scopeId })
      .onConflict(['window_id', 'scope_type', 'scope_id'])
      .ignore();
    maintenanceCache.clear();
    return true;
  },

  /**
   * Re-enable a previously disabled inherited maintenance window at the given scope.
   */
  async enableWindowForScope(
    windowId: number,
    scopeType: 'group' | 'monitor' | 'agent',
    scopeId: number,
    tenantScope: number | null,
  ): Promise<boolean> {
    if (!(await this.canToggleWindowForScope(windowId, scopeType, scopeId, tenantScope))) return false;
    await db('maintenance_window_disables')
      .where({ window_id: windowId, scope_type: scopeType, scope_id: scopeId })
      .del();
    maintenanceCache.clear();
    return true;
  },

  // ── Scope queries ──────────────────────────────────────────────────────────

  async getWindowsForScope(scopeType: MaintenanceScopeType, scopeId: number): Promise<MaintenanceWindow[]> {
    const rows = await db<MaintenanceWindowRow>('maintenance_windows')
      .where({ scope_type: scopeType, scope_id: scopeId, active: true });
    return rows.map(rowToWindow);
  },

  /**
   * Get the ancestor group IDs for a given group (including itself).
   */
  async getAncestorGroupIds(groupId: number): Promise<number[]> {
    const rows = await db('group_closure')
      .where('descendant_id', groupId)
      .select('ancestor_id');
    return rows.map((r: { ancestor_id: number }) => r.ancestor_id);
  },

  /**
   * Build the set of disabled window IDs for a given scope entity.
   *
   * Disables come from two sources:
   *   1. Disables placed directly on this entity
   *   2. Disables placed on any ancestor group (propagated down)
   */
  async getDisabledWindowIds(
    scopeType: 'monitor' | 'agent' | 'group',
    scopeId: number,
    ancestorGroupIds: number[],
  ): Promise<Set<number>> {
    const rows = await db('maintenance_window_disables')
      .where(function () {
        this.where({ scope_type: scopeType, scope_id: scopeId });
        if (ancestorGroupIds.length > 0) {
          this.orWhere(function () {
            this.where('scope_type', 'group').whereIn('scope_id', ancestorGroupIds);
          });
        }
      })
      .select('window_id');

    return new Set(rows.map((r: { window_id: number }) => r.window_id));
  },

  /**
   * Build the set of window IDs disabled DIRECTLY at this scope (not via ancestors).
   * Used for the canEnable flag.
   */
  async getDirectlyDisabledWindowIds(
    scopeType: 'monitor' | 'agent' | 'group',
    scopeId: number,
  ): Promise<Set<number>> {
    const rows = await db('maintenance_window_disables')
      .where({ scope_type: scopeType, scope_id: scopeId })
      .select('window_id');
    return new Set(rows.map((r: { window_id: number }) => r.window_id));
  },

  // ── Effective Windows ─────────────────────────────────────────────────────

  /**
   * Get all maintenance windows that apply to a scope entity, with source metadata.
   * Returned sorted: local first, then group (by ancestor proximity), then global.
   * Each window carries: source, sourceId, sourceName, isDisabledHere,
   * canEdit, canDelete, canDisable, canEnable.
   */
  async getEffectiveWindows(
    scopeType: 'monitor' | 'agent' | 'group',
    scopeId: number,
    groupId?: number | null,
    tenantId?: number | null,
  ): Promise<MaintenanceWindow[]> {
    const now = new Date();
    const result: MaintenanceWindow[] = [];

    // Tenant whose global windows apply (the entity's own tenant)
    const entityTenantId = tenantId ?? await getEntityTenantId(scopeType, scopeId);

    // 1. Ancestor group IDs
    const ancestorGroupIds: number[] = groupId
      ? await this.getAncestorGroupIds(groupId)
      : (scopeType === 'group' ? await this.getAncestorGroupIds(scopeId) : []);

    // 2. Disables for this entity (own + ancestor-group disables)
    const disabledIds = await this.getDisabledWindowIds(scopeType, scopeId, ancestorGroupIds);

    // 3. Disables placed directly at this scope (for canEnable)
    const directlyDisabledIds = await this.getDirectlyDisabledWindowIds(scopeType, scopeId);

    // ── Local windows (owned by this scope) ──────────────────────────────────
    const localRows = await db<MaintenanceWindowRow>('maintenance_windows')
      .where({ scope_type: scopeType, scope_id: scopeId, active: true });
    for (const row of localRows) {
      const w = rowToWindow(row);
      result.push({
        ...w,
        isActiveNow: isWindowActive(w, now),
        source: 'local',
        sourceId: scopeId,
        sourceName: undefined,
        isDisabledHere: false,
        canEdit: true,
        canDelete: true,
        canDisable: false,
        canEnable: false,
      });
    }

    // ── Group windows from ancestor groups ────────────────────────────────────
    // For a group scope: ancestors = parent groups only (self already in local)
    const groupAncestorIds = scopeType === 'group'
      ? ancestorGroupIds.filter((id) => id !== scopeId)
      : ancestorGroupIds;

    if (groupAncestorIds.length > 0) {
      const groupRows = await db<MaintenanceWindowRow>('maintenance_windows')
        .where({ scope_type: 'group', active: true })
        .whereIn('scope_id', groupAncestorIds);

      const groupNames = new Map<number, string>();
      try {
        const nameRows = await db('monitor_groups')
          .whereIn('id', groupAncestorIds)
          .select('id', 'name');
        for (const nr of nameRows) groupNames.set(nr.id, nr.name);
      } catch { /* ignore */ }

      for (const row of groupRows) {
        const w = rowToWindow(row);
        const isDisabledHere = disabledIds.has(w.id);
        const isDirectlyDisabled = directlyDisabledIds.has(w.id);
        result.push({
          ...w,
          isActiveNow: isWindowActive(w, now),
          source: 'group',
          sourceId: w.scopeId,
          sourceName: groupNames.get(w.scopeId!) ?? `Group #${w.scopeId}`,
          isDisabledHere,
          canEdit: false,
          canDelete: false,
          canDisable: !isDisabledHere,
          canEnable: isDirectlyDisabled,
        });
      }
    }

    // ── Global windows (workspace-wide: the entity's tenant only) ─────────────
    const globalRows = entityTenantId === null
      ? []
      : await db<MaintenanceWindowRow>('maintenance_windows')
        .where({ scope_type: 'global', active: true, tenant_id: entityTenantId });

    for (const row of globalRows) {
      const w = rowToWindow(row);
      const isDisabledHere = disabledIds.has(w.id);
      const isDirectlyDisabled = directlyDisabledIds.has(w.id);
      result.push({
        ...w,
        isActiveNow: isWindowActive(w, now),
        source: 'global',
        sourceId: null,
        sourceName: 'Global',
        isDisabledHere,
        canEdit: false,
        canDelete: false,
        canDisable: !isDisabledHere,
        canEnable: isDirectlyDisabled,
      });
    }

    return result;
  },

  // ── isInMaintenance (cached, new additive inheritance) ────────────────────

  /**
   * Check whether a monitor or agent is currently in maintenance.
   * Additive logic: global + group + own windows, minus any that are disabled at
   * this scope (directly or via ancestor groups).
   */
  async isInMaintenance(
    scopeType: 'monitor' | 'agent',
    scopeId: number,
    groupId?: number | null,
    tenantId?: number | null,
  ): Promise<boolean> {
    // Global windows only cover the entity's own tenant.
    const entityTenantId = tenantId ?? await getEntityTenantId(scopeType, scopeId);
    const cacheKey = `${scopeType}:${scopeId}:${groupId ?? 'null'}:${entityTenantId ?? 'null'}`;
    const cached = getCached(cacheKey);
    if (cached !== null) return cached;

    const now = new Date();

    // 1. Ancestor group IDs
    const ancestorGroupIds: number[] = groupId
      ? await this.getAncestorGroupIds(groupId)
      : [];

    // 2. Build set of disabled window IDs for this entity
    const disabledIds = await this.getDisabledWindowIds(scopeType, scopeId, ancestorGroupIds);

    const disabledArr = disabledIds.size > 0 ? [...disabledIds] : [-1];

    // 3a. Own windows — always included
    const ownRows = await db<MaintenanceWindowRow>('maintenance_windows')
      .where({ scope_type: scopeType, scope_id: scopeId, active: true });
    const ownWindows = ownRows.map(rowToWindow);
    if (ownWindows.some((w) => isWindowActive(w, now))) {
      setCache(cacheKey, true);
      return true;
    }

    // 3b. Group windows from ancestors (minus disabled)
    if (ancestorGroupIds.length > 0) {
      const groupRows = await db<MaintenanceWindowRow>('maintenance_windows')
        .where({ scope_type: 'group', active: true })
        .whereIn('scope_id', ancestorGroupIds)
        .whereNotIn('id', disabledArr);
      if (groupRows.map(rowToWindow).some((w) => isWindowActive(w, now))) {
        setCache(cacheKey, true);
        return true;
      }
    }

    // 3c. Global windows of the entity's tenant (minus disabled)
    if (entityTenantId !== null) {
      const globalRows = await db<MaintenanceWindowRow>('maintenance_windows')
        .where({ scope_type: 'global', active: true, tenant_id: entityTenantId })
        .whereNotIn('id', disabledArr);
      if (globalRows.map(rowToWindow).some((w) => isWindowActive(w, now))) {
        setCache(cacheKey, true);
        return true;
      }
    }

    setCache(cacheKey, false);
    return false;
  },

  /**
   * Batch check: returns the set of monitor IDs that are currently in maintenance.
   * Used by the monitor list API to avoid N+1 queries.
   */
  /**
   * Batch version of isInMaintenance('agent', …) for a list of devices.
   * Same shape and logic as getInMaintenanceMonitorIds but with scope_type='agent'.
   * Used by /agent/devices to avoid firing ~5 uncached queries per device
   * (N+1 query pattern).
   */
  async getInMaintenanceAgentIds(
    devices: Array<{ id: number; groupId: number | null; tenantId?: number | null }>,
  ): Promise<Set<number>> {
    const result = new Set<number>();
    if (devices.length === 0) return result;
    const now = new Date();

    const allWindows = await db<MaintenanceWindowRow>('maintenance_windows')
      .where({ active: true })
      .select('*');
    const windows = allWindows.map(rowToWindow);
    // Global windows are workspace-wide: index them by tenant.
    const globalsByTenant = globalWindowsByTenant(allWindows);
    const tenantByDevice = await resolveBatchTenants('agent', devices);

    const groupIds = [...new Set(devices.map((d) => d.groupId).filter((g): g is number => g !== null))];
    const ancestorMap = new Map<number, number[]>();
    if (groupIds.length > 0) {
      const closureRows = await db('group_closure')
        .whereIn('descendant_id', groupIds)
        .select('descendant_id', 'ancestor_id');
      for (const row of closureRows) {
        if (!ancestorMap.has(row.descendant_id)) ancestorMap.set(row.descendant_id, []);
        ancestorMap.get(row.descendant_id)!.push(row.ancestor_id);
      }
    }

    const allDeviceIds = devices.map((d) => d.id);
    const allAncestorIds = [...new Set([...ancestorMap.values()].flat())];

    const disableRows = await db('maintenance_window_disables')
      .where(function () {
        this.where('scope_type', 'agent').whereIn('scope_id', allDeviceIds);
        if (allAncestorIds.length > 0) {
          this.orWhere(function () {
            this.where('scope_type', 'group').whereIn('scope_id', allAncestorIds);
          });
        }
      })
      .select('window_id', 'scope_type', 'scope_id');

    const deviceDisables = new Map<number, Set<number>>();
    const groupDisables = new Map<number, Set<number>>();
    for (const row of disableRows) {
      if (row.scope_type === 'agent') {
        if (!deviceDisables.has(row.scope_id)) deviceDisables.set(row.scope_id, new Set());
        deviceDisables.get(row.scope_id)!.add(row.window_id);
      } else if (row.scope_type === 'group') {
        if (!groupDisables.has(row.scope_id)) groupDisables.set(row.scope_id, new Set());
        groupDisables.get(row.scope_id)!.add(row.window_id);
      }
    }

    for (const device of devices) {
      const ancestorIds = device.groupId ? (ancestorMap.get(device.groupId) ?? []) : [];

      const disabledIds = new Set<number>();
      for (const id of (deviceDisables.get(device.id) ?? [])) disabledIds.add(id);
      for (const gid of ancestorIds) {
        for (const id of (groupDisables.get(gid) ?? [])) disabledIds.add(id);
      }

      const ownWindows = windows.filter((w) => w.scopeType === 'agent' && w.scopeId === device.id);
      if (ownWindows.some((w) => isWindowActive(w, now))) { result.add(device.id); continue; }

      const groupWindows = device.groupId
        ? windows.filter((w) =>
            w.scopeType === 'group' &&
            ancestorIds.includes(w.scopeId!) &&
            !disabledIds.has(w.id),
          )
        : [];
      if (groupWindows.some((w) => isWindowActive(w, now))) { result.add(device.id); continue; }

      const deviceTenantId = tenantByDevice.get(device.id);
      const tenantGlobals = deviceTenantId !== undefined ? (globalsByTenant.get(deviceTenantId) ?? []) : [];
      const applicableGlobals = tenantGlobals.filter((w) => !disabledIds.has(w.id));
      if (applicableGlobals.some((w) => isWindowActive(w, now))) { result.add(device.id); continue; }
    }

    return result;
  },

  async getInMaintenanceMonitorIds(
    monitors: Array<{ id: number; groupId: number | null; tenantId?: number | null }>,
  ): Promise<Set<number>> {
    const result = new Set<number>();
    if (monitors.length === 0) return result;
    const now = new Date();

    // Fetch all active windows in one query (including global)
    const allWindows = await db<MaintenanceWindowRow>('maintenance_windows')
      .where({ active: true })
      .select('*');
    const windows = allWindows.map(rowToWindow);

    // Global windows are workspace-wide: index them by tenant.
    const globalsByTenant = globalWindowsByTenant(allWindows);
    const tenantByMonitor = await resolveBatchTenants('monitor', monitors);

    // Build ancestor map for all unique group IDs
    const groupIds = [...new Set(monitors.map((m) => m.groupId).filter((g): g is number => g !== null))];
    const ancestorMap = new Map<number, number[]>();
    if (groupIds.length > 0) {
      const closureRows = await db('group_closure')
        .whereIn('descendant_id', groupIds)
        .select('descendant_id', 'ancestor_id');
      for (const row of closureRows) {
        if (!ancestorMap.has(row.descendant_id)) ancestorMap.set(row.descendant_id, []);
        ancestorMap.get(row.descendant_id)!.push(row.ancestor_id);
      }
    }

    // Fetch all disables for monitors + their ancestor groups in one query
    const allMonitorIds = monitors.map((m) => m.id);
    const allAncestorIds = [...new Set([...ancestorMap.values()].flat())];

    const disableRows = await db('maintenance_window_disables')
      .where(function () {
        this.where('scope_type', 'monitor').whereIn('scope_id', allMonitorIds);
        if (allAncestorIds.length > 0) {
          this.orWhere(function () {
            this.where('scope_type', 'group').whereIn('scope_id', allAncestorIds);
          });
        }
      })
      .select('window_id', 'scope_type', 'scope_id');

    // Build per-monitor and per-group disable sets
    const monitorDisables = new Map<number, Set<number>>();
    const groupDisables = new Map<number, Set<number>>();
    for (const row of disableRows) {
      if (row.scope_type === 'monitor') {
        if (!monitorDisables.has(row.scope_id)) monitorDisables.set(row.scope_id, new Set());
        monitorDisables.get(row.scope_id)!.add(row.window_id);
      } else if (row.scope_type === 'group') {
        if (!groupDisables.has(row.scope_id)) groupDisables.set(row.scope_id, new Set());
        groupDisables.get(row.scope_id)!.add(row.window_id);
      }
    }

    for (const monitor of monitors) {
      const ancestorIds = monitor.groupId ? (ancestorMap.get(monitor.groupId) ?? []) : [];

      // Effective disabled window IDs for this monitor
      const disabledIds = new Set<number>();
      for (const id of (monitorDisables.get(monitor.id) ?? [])) disabledIds.add(id);
      for (const gid of ancestorIds) {
        for (const id of (groupDisables.get(gid) ?? [])) disabledIds.add(id);
      }

      // Own windows — always applicable
      const ownWindows = windows.filter((w) => w.scopeType === 'monitor' && w.scopeId === monitor.id);
      if (ownWindows.some((w) => isWindowActive(w, now))) {
        result.add(monitor.id);
        continue;
      }

      // Group windows from ancestors (minus disabled)
      const groupWindows = monitor.groupId
        ? windows.filter((w) =>
            w.scopeType === 'group' &&
            ancestorIds.includes(w.scopeId!) &&
            !disabledIds.has(w.id)
          )
        : [];
      if (groupWindows.some((w) => isWindowActive(w, now))) {
        result.add(monitor.id);
        continue;
      }

      // Global windows of the monitor's tenant (minus disabled)
      const monitorTenantId = tenantByMonitor.get(monitor.id);
      const tenantGlobals = monitorTenantId !== undefined ? (globalsByTenant.get(monitorTenantId) ?? []) : [];
      const applicableGlobals = tenantGlobals.filter((w) => !disabledIds.has(w.id));
      if (applicableGlobals.some((w) => isWindowActive(w, now))) {
        result.add(monitor.id);
        continue;
      }
    }

    return result;
  },

  // ── Background jobs ────────────────────────────────────────────────────────

  /**
   * Delete one-time windows that expired more than 30 days ago.
   * Windows are kept for 30 days so admins can review past maintenance periods
   * on the Maintenance page (they appear as greyed-out expired entries).
   */
  async cleanupExpiredOneTime(): Promise<void> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db('maintenance_windows')
      .where({ schedule_type: 'one_time' })
      .where('end_at', '<', cutoff)
      .del();
  },

  /**
   * Send start/end notifications for windows that just became active or inactive.
   * Uses last_notified_start_at / last_notified_end_at to deduplicate.
   */
  async checkMaintenanceTransitions(): Promise<void> {
    const rows = await db<MaintenanceWindowRow>('maintenance_windows')
      .where({ active: true })
      .whereRaw('array_length(notify_channel_ids, 1) > 0')
      .select('*');

    const now = new Date();

    for (const row of rows) {
      const window = rowToWindow(row);
      const active = isWindowActive(window, now);

      if (active && !window.lastNotifiedStartAt) {
        await this._sendMaintenanceNotification(window, 'start', row.tenant_id);
        await db('maintenance_windows').where({ id: window.id }).update({
          last_notified_start_at: now,
          last_notified_end_at: null,
        });
      } else if (!active && window.lastNotifiedStartAt && !window.lastNotifiedEndAt) {
        await this._sendMaintenanceNotification(window, 'end', row.tenant_id);
        await db('maintenance_windows').where({ id: window.id }).update({
          last_notified_end_at: now,
        });
      }
    }
  },

  async _sendMaintenanceNotification(window: MaintenanceWindow, event: 'start' | 'end', tenantId?: number): Promise<void> {
    if (window.notifyChannelIds.length === 0) return;
    try {
      // Only channels owned by / shared to the window's tenant may be used.
      const windowTenantId = tenantId ?? await this.getWindowTenantId(window.id);
      if (windowTenantId === null) return;
      const foreign = new Set(await this.getForeignChannelIds(window.notifyChannelIds, windowTenantId));
      const channelIds = window.notifyChannelIds.filter((id) => !foreign.has(id));
      if (channelIds.length === 0) return;

      const message = event === 'start'
        ? `Maintenance window "${window.name}" has started. Alerts are suppressed during this period.`
        : `Maintenance window "${window.name}" has ended. Monitoring resumed.`;

      const payload = {
        monitorName: window.name,
        oldStatus: event === 'start' ? 'up' : 'maintenance',
        newStatus: event === 'start' ? 'maintenance' : 'up',
        message,
        timestamp: new Date().toISOString(),
        appName: config.appName,
      };

      const channels = await db('notification_channels')
        .whereIn('id', channelIds)
        .where({ is_enabled: true });

      for (const ch of channels) {
        const plugin = getPlugin(ch.type);
        if (!plugin) continue;
        try {
          let resolvedConfig: Record<string, unknown> = ch.config;
          if (ch.type === 'smtp' && ch.config?.smtpServerId) {
            const { smtpServerService } = await import('./smtpServer.service');
            const srv = await smtpServerService.getTransportConfig(Number(ch.config.smtpServerId));
            if (srv) resolvedConfig = { ...ch.config, host: srv.host, port: srv.port, secure: srv.secure, username: srv.username, password: srv.password, fromAddress: srv.fromAddress };
          }
          await plugin.send(resolvedConfig, payload);
          logger.info(`[Maintenance] Notification sent (${event}) via ${ch.name} for window "${window.name}"`);
        } catch (err) {
          logger.error(err, `[Maintenance] Failed to notify channel ${ch.id}`);
        }
      }
    } catch (err) {
      logger.error(err, '[MaintenanceService] Failed to send transition notification');
    }
  },

  startJobs(): void {
    cleanupTimer = setInterval(() => {
      this.cleanupExpiredOneTime().catch((err) =>
        console.error('[MaintenanceService] Cleanup job error:', err),
      );
    }, 5 * 60 * 1000);

    transitionTimer = setInterval(() => {
      maintenanceCache.clear();
      this.checkMaintenanceTransitions().catch((err) =>
        console.error('[MaintenanceService] Transition job error:', err),
      );
    }, 60 * 1000);

    console.log('[MaintenanceService] Background jobs started.');
  },

  stopJobs(): void {
    if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
    if (transitionTimer) { clearInterval(transitionTimer); transitionTimer = null; }
  },
};
