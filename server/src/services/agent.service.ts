import type { Server as SocketIOServer } from 'socket.io';
import type { Knex } from 'knex';
import * as fs from 'fs';
import * as path from 'path';
import { db } from '../db';
import type {
  AgentApiKey, AgentDevice, AgentDisplayConfig, AgentGroupConfig, AgentRuntimeStatus, AgentThresholds,
  AgentTransferResult, AgentUpdatePolicy, NotificationTypeConfig,
} from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS, SOCKET_EVENTS, prettifySensorLabel } from '@obliview/shared';
import { heartbeatService } from './heartbeat.service';
import { notificationService } from './notification.service';
import { monitorService } from './monitor.service';
import { permissionService } from './permission.service';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import { obligateService } from './obligate.service';
import { noteAgentHeartbeat, mayOfferAgentUpdate } from './agentNt6.service';
import { maintenanceService } from './maintenance.service';
import { agentUpdateRollout, isLegacyAutoUpdate } from './agentUpdateRollout.service';
import { agentUpdatePolicyService, getPolicyLookups, resolveWithLookups } from './agentUpdatePolicy.service';
import { isAgentUpdatePolicy } from '../utils/agentUpdate';
import type { MonitorWorkerManager } from '../workers/MonitorWorkerManager';

// ── Socket.io instance (set from index.ts) ──────────────────
let _io: SocketIOServer | null = null;
export function setAgentServiceIO(io: SocketIOServer): void {
  _io = io;
}

// ============================================================
// Row ↔ Model helpers
// ============================================================

interface AgentApiKeyRow {
  id: number;
  name: string;
  key: string;
  tenant_id: number;
  created_by: number | null;
  created_at: Date;
  last_used_at: Date | null;
  device_count?: string | number;
  // migration 067
  default_group_id: number | null;
  default_group_name?: string | null;
}

interface AgentDeviceRow {
  id: number;
  uuid: string;
  hostname: string;
  name: string | null;
  ip: string | null;
  os_info: unknown;
  agent_version: string | null;
  api_key_id: number | null;
  status: string;
  heartbeat_monitoring: boolean;
  check_interval_seconds: number;
  agent_max_missed_pushes: number | null;  // migration 021
  approved_by: number | null;
  approved_at: Date | null;
  group_id: number | null;
  created_at: Date;
  updated_at: Date;
  // migration 025
  sensor_display_names: unknown;
  // migration 026
  override_group_settings: boolean;
  // migration 032
  display_config: unknown;
  // migration 033
  pending_command: string | null;
  uninstall_commanded_at: Date | null;
  // migration 039
  tenant_id: number;
  // migration 040
  updating_since: Date | null;
  // migration 042
  notification_types: unknown;
  // migration 048
  notification_cooldown_seconds: number | null;
  // migration 050
  notes: string | null;
  // migration 052
  device_type: string;
  // migration 067
  update_requested_at: Date | null;
  update_sent_at: Date | null;
  update_error_at: Date | null;
  update_error: string | null;
  target_version: string | null;
  uninstall_requested_at: Date | null;
  transfer_from_api_key_id: number | null;
  // migration 068
  update_policy?: string | null;
}

function rowToApiKey(row: AgentApiKeyRow): AgentApiKey {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    tenantId: row.tenant_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    deviceCount: row.device_count ? Number(row.device_count) : undefined,
    defaultGroupId: row.default_group_id ?? null,
    ...(row.default_group_name !== undefined ? { defaultGroupName: row.default_group_name ?? null } : {}),
  };
}

function rowToDevice(row: AgentDeviceRow, groupConfig?: AgentGroupConfig | null, groupThresholds?: AgentThresholds | null): AgentDevice {
  const override = row.override_group_settings ?? false;

  // Compute effective (resolved) settings, honouring group inheritance when override=false.
  let resolvedSettings: AgentDevice['resolvedSettings'];
  if (!override && groupConfig) {
    resolvedSettings = {
      checkIntervalSeconds: groupConfig.pushIntervalSeconds ?? row.check_interval_seconds,
      heartbeatMonitoring:  groupConfig.heartbeatMonitoring  ?? (row.heartbeat_monitoring ?? true),
      maxMissedPushes:      groupConfig.maxMissedPushes      ?? (row.agent_max_missed_pushes ?? 2),
    };
  } else {
    resolvedSettings = {
      checkIntervalSeconds: row.check_interval_seconds,
      heartbeatMonitoring:  row.heartbeat_monitoring ?? true,
      maxMissedPushes:      row.agent_max_missed_pushes ?? 2,
    };
  }

  const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
  const device: Omit<AgentDevice, 'runtimeStatus'> = {
    id: row.id,
    uuid: row.uuid,
    hostname: row.hostname,
    tenantId: row.tenant_id as number,
    name: row.name ?? null,
    ip: row.ip,
    osInfo: typeof row.os_info === 'string' ? JSON.parse(row.os_info) : (row.os_info as AgentDevice['osInfo']),
    agentVersion: row.agent_version,
    apiKeyId: row.api_key_id,
    deviceType: (row.device_type || 'agent') as AgentDevice['deviceType'],
    status: row.status as AgentDevice['status'],
    approvalStatus: row.status as AgentDevice['status'],
    heartbeatMonitoring: row.heartbeat_monitoring ?? true,
    checkIntervalSeconds: row.check_interval_seconds,
    notificationCooldownSeconds: row.notification_cooldown_seconds ?? null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    groupId: row.group_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sensorDisplayNames: (row.sensor_display_names as Record<string, string> | null) ?? null,
    overrideGroupSettings: override,
    resolvedSettings,
    groupSettings: groupConfig ?? null,
    groupThresholds: groupThresholds ?? null,
    displayConfig: (typeof row.display_config === 'string'
      ? JSON.parse(row.display_config)
      : (row.display_config as AgentDisplayConfig | null)) ?? null,
    pendingCommand: row.pending_command ?? null,
    uninstallCommandedAt: row.uninstall_commanded_at ? row.uninstall_commanded_at.toISOString() : null,
    updatingSince: row.updating_since ? row.updating_since.toISOString() : null,
    uninstallRequestedAt: iso(row.uninstall_requested_at),
    updateRequestedAt: iso(row.update_requested_at),
    updateSentAt: iso(row.update_sent_at),
    updateErrorAt: iso(row.update_error_at),
    updateError: row.update_error ?? null,
    targetVersion: row.target_version ?? null,
    updatePolicy: isAgentUpdatePolicy(row.update_policy) ? row.update_policy : null,
    notes: row.notes ?? null,
    notificationTypes: row.notification_types
      ? (typeof row.notification_types === 'string'
          ? JSON.parse(row.notification_types)
          : row.notification_types as NotificationTypeConfig)
      : null,
  };
  // Without the agent monitor status / maintenance state this is a
  // best-effort value; withRuntime() refines it (listing, detail, events).
  return { ...device, runtimeStatus: deriveRuntimeStatus(device, undefined, false) };
}

// ── Runtime status (the approval state stays in status / approvalStatus) ──

/** A device that pushed within this many push intervals (+30 s) counts as online. */
const ONLINE_GRACE_INTERVALS = 2;

/**
 * After a tenant transfer, how long the device's FORMER key (plus its UUID)
 * still receives the new key. Past that, the pending reconfigure is dropped
 * (cleanupStaleTransfers) and the agent must be re-installed with a key of
 * its new workspace, or transferred again.
 */
const TRANSFER_RECONFIGURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A handed-out update keeps the device in 'updating' at most this long while
 * the agent keeps pushing on its old version (still downloading, or the update
 * failed): past it the normal offline / threshold detection applies again,
 * and the stuck-update cleanup turns the request into update_error.
 */
const UPDATE_GRACE_MS = 3 * 60 * 1000;

/** Last contact we can rely on: the live push snapshot, else updated_at (bumped by every push). */
function lastContactMs(device: Pick<AgentDevice, 'id' | 'updatedAt'>): number {
  const snap = agentPushData.get(device.id);
  if (snap) return snap.receivedAt.getTime();
  const t = Date.parse(device.updatedAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Derive the runtime state of a device. Precedence:
 * pending_uninstall > suspended (suspended / refused) > updating >
 * maintenance > alert / offline (agent monitor status) > update_error >
 * online > recent contact (pending approval, monitor still 'pending').
 * A failed update never masks an offline or alerting device.
 */
export function deriveRuntimeStatus(
  device: Omit<AgentDevice, 'runtimeStatus'> | AgentDevice,
  monitorStatus: string | null | undefined,
  inMaintenance: boolean,
): AgentRuntimeStatus {
  if (device.pendingCommand === 'uninstall' || device.uninstallCommandedAt || device.uninstallRequestedAt) {
    return 'pending_uninstall';
  }
  if (device.status === 'suspended' || device.status === 'refused') return 'suspended';
  if (device.updatingSince || monitorStatus === 'updating') return 'updating';
  if (inMaintenance || monitorStatus === 'maintenance') return 'maintenance';
  if (device.status === 'approved') {
    if (monitorStatus === 'alert') return 'alert';
    if (monitorStatus === 'down' || monitorStatus === 'inactive' || monitorStatus === 'paused') return 'offline';
  }
  if (device.updateErrorAt) return 'update_error';
  if (device.status === 'approved' && monitorStatus === 'up') return 'online';
  // Pending approval, or an agent monitor that has not seen its first push.
  const interval = Math.max(device.resolvedSettings?.checkIntervalSeconds ?? device.checkIntervalSeconds ?? 60, 30);
  const fresh = Date.now() - lastContactMs(device) < interval * ONLINE_GRACE_INTERVALS * 1000 + 30_000;
  return fresh ? 'online' : 'offline';
}

/**
 * Attach the runtime state (and inMaintenance) to devices: one query for
 * the agent monitor statuses, one batched maintenance resolution.
 */
async function withRuntime(devices: AgentDevice[]): Promise<AgentDevice[]> {
  if (devices.length === 0) return devices;
  const ids = devices.map((d) => d.id);
  const [monitorRows, inMaintenanceIds, policyLookups] = await Promise.all([
    db('monitors')
      .where({ type: 'agent' })
      .whereIn('agent_device_id', ids)
      .orderBy('id')
      .select('agent_device_id', 'status') as Promise<Array<{ agent_device_id: number; status: string }>>,
    maintenanceService.getInMaintenanceAgentIds(
      devices.map((d) => ({ id: d.id, groupId: d.groupId, tenantId: d.tenantId })),
    ),
    // Agent update policy (global -> workspace -> group chain -> agent), cached lookups.
    getPolicyLookups(),
  ]);
  const statusByDevice = new Map<number, string>();
  for (const r of monitorRows) {
    if (!statusByDevice.has(r.agent_device_id)) statusByDevice.set(r.agent_device_id, r.status);
  }
  return devices.map((d) => {
    const inMaintenance = inMaintenanceIds.has(d.id);
    const policy = resolveWithLookups(
      { tenantId: d.tenantId, groupId: d.groupId, updatePolicy: d.updatePolicy ?? null },
      policyLookups,
    );
    return {
      ...d,
      inMaintenance,
      resolvedUpdatePolicy: policy.effective,
      inheritedUpdatePolicy: policy.inherited,
      runtimeStatus: deriveRuntimeStatus(d, statusByDevice.get(d.id), inMaintenance),
    };
  });
}

/** Parse a JSON/JSONB column that may come back as text (legacy rows) or as an object. */
function parseJsonColumn<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

// ── Group agent config (root → leaf cascade) ────────────────

const NOTIFICATION_TYPE_KEYS: (keyof NotificationTypeConfig)[] = ['global', 'down', 'up', 'alert', 'update'];

/**
 * Apply one group level of agent_group_config over what the ancestors above it
 * resolved to. Called root first → direct group last, so every non-null value
 * of a deeper group overrides its ancestors. notificationTypes merge per key.
 */
function applyGroupConfigLevel(
  acc: Partial<AgentGroupConfig> | null,
  cfg: Partial<AgentGroupConfig> | null | undefined,
): Partial<AgentGroupConfig> | null {
  if (!cfg) return acc;
  const next: Partial<AgentGroupConfig> = acc ? { ...acc } : {};
  if (cfg.pushIntervalSeconds         != null) next.pushIntervalSeconds         = cfg.pushIntervalSeconds;
  if (cfg.heartbeatMonitoring         != null) next.heartbeatMonitoring         = cfg.heartbeatMonitoring;
  if (cfg.maxMissedPushes             != null) next.maxMissedPushes             = cfg.maxMissedPushes;
  if (cfg.notificationCooldownSeconds != null) next.notificationCooldownSeconds = cfg.notificationCooldownSeconds;
  if (cfg.notificationTypes && typeof cfg.notificationTypes === 'object') {
    const types: NotificationTypeConfig = next.notificationTypes
      ? { ...next.notificationTypes }
      : { global: null, down: null, up: null, alert: null, update: null };
    for (const key of NOTIFICATION_TYPE_KEYS) {
      const v = cfg.notificationTypes[key];
      if (v !== null && v !== undefined) types[key] = v;
    }
    next.notificationTypes = types;
  }
  return next;
}

/** Fill the fields no group in the chain sets with null (= "not set by the group chain"). */
function finalizeGroupConfig(acc: Partial<AgentGroupConfig> | null): AgentGroupConfig | null {
  if (!acc) return null;
  return {
    pushIntervalSeconds:         acc.pushIntervalSeconds         ?? null,
    heartbeatMonitoring:         acc.heartbeatMonitoring         ?? null,
    maxMissedPushes:             acc.maxMissedPushes             ?? null,
    notificationCooldownSeconds: acc.notificationCooldownSeconds ?? null,
    notificationTypes:           acc.notificationTypes           ?? null,
  };
}

// ── Agent thresholds (per-metric cascade) ───────────────────

const THRESHOLD_METRIC_KEYS: (keyof AgentThresholds)[] = ['cpu', 'memory', 'disk', 'netIn', 'netOut', 'temp'];

/**
 * Lay `layer` over `acc`, one metric slot at a time: a metric present in the
 * layer replaces the whole slot below it; metrics the layer does not define
 * keep the value inherited from below.
 */
function overlayThresholds(
  acc: Partial<AgentThresholds> | null,
  layer: Partial<AgentThresholds> | null | undefined,
): Partial<AgentThresholds> | null {
  if (!layer || typeof layer !== 'object') return acc;
  let next = acc;
  for (const key of THRESHOLD_METRIC_KEYS) {
    const slot = layer[key];
    if (slot && typeof slot === 'object') {
      next = { ...(next ?? {}), [key]: slot };
    }
  }
  return next;
}

/** Full thresholds: `base` with every layer overlaid per metric, in order (last layer wins). */
function mergeAgentThresholds(
  base: AgentThresholds,
  ...layers: Array<Partial<AgentThresholds> | null | undefined>
): AgentThresholds {
  let acc: Partial<AgentThresholds> | null = { ...base };
  for (const layer of layers) acc = overlayThresholds(acc, layer);
  return acc as AgentThresholds;
}

/**
 * A device threshold override as stored on monitors.agent_thresholds: only the
 * known metric slots, or null when there is nothing to override (NULL = inherit
 * the live cascade defaults ← group chain).
 */
function normalizeThresholdOverride(value: unknown): Partial<AgentThresholds> | null {
  const parsed = parseJsonColumn<Partial<AgentThresholds>>(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return overlayThresholds(null, parsed);
}

/**
 * Resolve the effective agent group config by traversing the full ancestor chain
 * root→leaf (depth DESC → root first, direct group last).
 * Each level that has a non-null value overrides the previous, so the most-specific
 * group (direct parent) wins — mirrors AgentMonitorWorker and settingsService logic.
 */
async function resolveGroupAgentConfig(groupId: number): Promise<AgentGroupConfig | null> {
  const ancestorRows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', groupId)
    .orderBy('group_closure.depth', 'desc') // root first → direct group last
    .select('monitor_groups.agent_group_config') as { agent_group_config: unknown }[];

  let resolved: Partial<AgentGroupConfig> | null = null;
  for (const row of ancestorRows) {
    resolved = applyGroupConfigLevel(resolved, parseJsonColumn<Partial<AgentGroupConfig>>(row.agent_group_config));
  }
  return finalizeGroupConfig(resolved);
}

/**
 * Resolve the effective agent thresholds by traversing the full ancestor chain
 * root→leaf. Each level overlays its thresholds per metric, so the
 * most-specific group wins. Returns only what the group chain defines (null
 * when no group in the chain sets thresholds) — callers merge it over
 * DEFAULT_AGENT_THRESHOLDS.
 */
async function resolveGroupAgentThresholds(groupId: number): Promise<AgentThresholds | null> {
  const ancestorRows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .where('group_closure.descendant_id', groupId)
    .orderBy('group_closure.depth', 'desc')
    .select('monitor_groups.agent_thresholds') as { agent_thresholds: unknown }[];

  let resolved: Partial<AgentThresholds> | null = null;
  for (const row of ancestorRows) {
    resolved = overlayThresholds(resolved, parseJsonColumn<Partial<AgentThresholds>>(row.agent_thresholds));
  }
  return resolved as AgentThresholds | null;
}

/**
 * Batch resolver: fetch config + thresholds for many group ids in a SINGLE
 * closure join, then merge per-group in JS. Replaces N × 2 closure queries
 * with 1 for the /agent/devices listing hot path.
 *
 * The per-group `resolveGroupAgentConfig` / `resolveGroupAgentThresholds`
 * helpers stay for single-device paths where the extra IN-list would be
 * wasted overhead. Both use the same merge helpers, so they always agree.
 */
async function resolveGroupAgentConfigAndThresholdsBatch(
  groupIds: number[],
): Promise<{
  configMap: Map<number, AgentGroupConfig | null>;
  thresholdsMap: Map<number, AgentThresholds | null>;
}> {
  const configMap = new Map<number, AgentGroupConfig | null>();
  const thresholdsMap = new Map<number, AgentThresholds | null>();
  if (groupIds.length === 0) return { configMap, thresholdsMap };

  const rows = await db('group_closure')
    .join('monitor_groups', 'monitor_groups.id', 'group_closure.ancestor_id')
    .whereIn('group_closure.descendant_id', groupIds)
    .orderBy('group_closure.descendant_id')
    .orderBy('group_closure.depth', 'desc')
    .select(
      'group_closure.descendant_id',
      'monitor_groups.agent_group_config',
      'monitor_groups.agent_thresholds',
    ) as Array<{
      descendant_id: number;
      agent_group_config: unknown;
      agent_thresholds: unknown;
    }>;

  // Accumulate root → leaf (order enforced by depth DESC above).
  const configAcc = new Map<number, Partial<AgentGroupConfig> | null>();
  const thresholdsAcc = new Map<number, Partial<AgentThresholds> | null>();

  for (const r of rows) {
    configAcc.set(
      r.descendant_id,
      applyGroupConfigLevel(
        configAcc.get(r.descendant_id) ?? null,
        parseJsonColumn<Partial<AgentGroupConfig>>(r.agent_group_config),
      ),
    );
    thresholdsAcc.set(
      r.descendant_id,
      overlayThresholds(
        thresholdsAcc.get(r.descendant_id) ?? null,
        parseJsonColumn<Partial<AgentThresholds>>(r.agent_thresholds),
      ),
    );
  }

  for (const gid of groupIds) {
    configMap.set(gid, finalizeGroupConfig(configAcc.get(gid) ?? null));
    thresholdsMap.set(gid, (thresholdsAcc.get(gid) ?? null) as AgentThresholds | null);
  }

  return { configMap, thresholdsMap };
}

/** Row → AgentDevice with its group config + thresholds resolved through the closure chain. */
async function hydrateDevice(row: AgentDeviceRow): Promise<AgentDevice> {
  const [groupConfig, groupThresholds] = await Promise.all([
    row.group_id ? resolveGroupAgentConfig(row.group_id) : null,
    row.group_id ? resolveGroupAgentThresholds(row.group_id) : null,
  ]);
  return rowToDevice(row, groupConfig, groupThresholds);
}

/** Many rows → AgentDevices, resolving every distinct group in one closure join. */
async function loadDevicesByIds(ids: number[]): Promise<AgentDevice[]> {
  if (ids.length === 0) return [];
  const rows = await db('agent_devices').whereIn('id', ids) as AgentDeviceRow[];
  const groupIds = [...new Set(rows.map(r => r.group_id).filter((id): id is number => id !== null))];
  const { configMap, thresholdsMap } = await resolveGroupAgentConfigAndThresholdsBatch(groupIds);
  return rows.map(r => rowToDevice(
    r,
    r.group_id !== null ? (configMap.get(r.group_id) ?? null) : null,
    r.group_id !== null ? (thresholdsMap.get(r.group_id) ?? null) : null,
  ));
}

/**
 * An agent device may only sit in a group of its own workspace — otherwise it
 * would inherit another tenant's notification channels, thresholds, agent
 * config and maintenance windows.
 */
async function assertGroupInDeviceTenant(groupId: number, tenantId: number): Promise<void> {
  const row = await db('monitor_groups')
    .where({ id: groupId })
    .select('tenant_id')
    .first() as { tenant_id: number } | undefined;
  if (!row) {
    throw new AppError(400, 'Group not found');
  }
  if (row.tenant_id !== tenantId) {
    throw new AppError(400, 'Group belongs to another workspace');
  }
}

/**
 * Default group of an API key (agent_api_keys.default_group_id), used when an
 * approval names no group. Ignored (null) unless it is a group of the
 * device's own workspace.
 */
async function keyDefaultGroupId(apiKeyId: number | null, tenantId: number): Promise<number | null> {
  if (apiKeyId === null) return null;
  const row = await db('agent_api_keys as k')
    .join('monitor_groups as g', 'g.id', 'k.default_group_id')
    .where({ 'k.id': apiKeyId, 'g.tenant_id': tenantId })
    .select('g.id')
    .first() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Restrict a by-id query to a tenant scope (getEffectiveTenantScope): null =
 * God View / internal caller (no restriction), otherwise the row must belong
 * to that workspace — a device of another workspace is treated as missing.
 */
function scopeToTenant<Q extends Knex.QueryBuilder>(
  query: Q,
  tenantScope: number | null,
  column = 'tenant_id',
): Q {
  if (tenantScope !== null) query.where(column, tenantScope);
  return query;
}

// ============================================================
// Live updates
// ============================================================

function emitToTenantAdmins(tenantId: number, event: string, payload: unknown): void {
  if (_io) _io.to(`tenant:${tenantId}:admin`).emit(event, payload);
}

/** Agent lifecycle events: platform admins (admin room) and the workspace's
 *  agents.manage holders (`tenant:X:agents`, joined in socket.ts). Socket.io
 *  de-duplicates sockets across the rooms of one to([...]). */
function emitToAgentManagers(tenantId: number, event: string, payload: unknown): void {
  if (_io) _io.to([`tenant:${tenantId}:admin`, `tenant:${tenantId}:agents`]).emit(event, payload);
}

// Users with team access to an agent monitor (permissionService
// .getUsersWithMonitorAccess), cached: pushes arrive every few seconds per
// agent and the lookup is several joins.
const AUDIENCE_TTL_MS = 30_000;
const AUDIENCE_MAX_ENTRIES = 10_000;
// The promise is cached, so the events of one push share a single lookup.
const monitorAudienceCache = new Map<number, { userIds: Promise<number[]>; at: number }>();

function getAgentMonitorAudience(monitorId: number): Promise<number[]> {
  const now = Date.now();
  const hit = monitorAudienceCache.get(monitorId);
  if (hit && now - hit.at < AUDIENCE_TTL_MS) return hit.userIds;
  const userIds = permissionService.getUsersWithMonitorAccess(monitorId);
  if (monitorAudienceCache.size >= AUDIENCE_MAX_ENTRIES) monitorAudienceCache.clear();
  monitorAudienceCache.set(monitorId, { userIds, at: now });
  // A failed lookup is not kept: the next event retries.
  userIds.catch(() => {
    if (monitorAudienceCache.get(monitorId)?.userIds === userIds) monitorAudienceCache.delete(monitorId);
  });
  return userIds;
}

/**
 * Agent live events: the tenant's admins first (synchronously, lowest
 * latency), then every non-admin user with team access to the agent monitor
 * through their `user:<id>` room — the same audience as
 * BaseMonitorWorker.emitToVisibleUsers. Sockets already in the admin room are
 * excluded so nobody receives an event twice. Never throws.
 */
function emitToAgentAudience(tenantId: number, monitorId: number, event: string, payload: unknown): void {
  if (!_io) return;
  const io = _io;
  const managerRooms = [`tenant:${tenantId}:admin`, `tenant:${tenantId}:agents`];
  io.to(managerRooms).emit(event, payload);
  getAgentMonitorAudience(monitorId)
    .then((userIds) => {
      if (userIds.length === 0) return;
      io.to(userIds.map((id) => `user:${id}`)).except(managerRooms).emit(event, payload);
    })
    .catch((err) => logger.error(err, `Failed to resolve the live audience of agent monitor ${monitorId}`));
}

/**
 * AGENT_DEVICE_UPDATED carries the full device (with `id`), so listeners can
 * replace their copy as-is. `deviceId` is kept as an alias for listeners that
 * still patch by it.
 */
function emitDeviceUpdated(device: AgentDevice): void {
  emitDevicesUpdated([device]);
}

/**
 * Batch form of emitDeviceUpdated: the runtime state (runtimeStatus,
 * inMaintenance) is resolved once for all of them, so every event carries
 * the full device as GET /agent/devices/:id returns it.
 */
function emitDevicesUpdated(devices: AgentDevice[]): void {
  if (!_io || devices.length === 0) return;
  const send = (list: AgentDevice[]) => {
    for (const d of list) {
      emitToAgentManagers(d.tenantId, SOCKET_EVENTS.AGENT_DEVICE_UPDATED, { ...d, deviceId: d.id });
    }
  };
  withRuntime(devices)
    .then(send)
    .catch((err) => {
      logger.error(err, 'Failed to resolve agent runtime status for a live update');
      send(devices);
    });
}

/**
 * Mirror agent-monitor row changes to the dashboards (same payloads as
 * monitors.controller), each to the admins of the monitor's own tenant.
 */
async function emitAgentMonitorChanges(monitorIds: number[], createdIds: number[] = []): Promise<void> {
  if (!_io || monitorIds.length === 0) return;
  try {
    const created = new Set(createdIds);
    const tenantRows = await db('monitors')
      .whereIn('id', monitorIds)
      .select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
    const monitors = await monitorService.getByIds(monitorIds);
    const tenantByMonitor = new Map(tenantRows.map(r => [r.id, r.tenant_id]));
    for (const monitor of monitors) {
      const tenantId = tenantByMonitor.get(monitor.id);
      if (tenantId === undefined) continue;
      if (created.has(monitor.id)) {
        emitToTenantAdmins(tenantId, SOCKET_EVENTS.MONITOR_CREATED, { monitor });
      } else {
        emitToTenantAdmins(tenantId, SOCKET_EVENTS.MONITOR_UPDATED, { monitorId: monitor.id, changes: monitor });
      }
    }
  } catch (err) {
    logger.error(err, 'Failed to emit agent monitor changes');
  }
}

// ============================================================
// Agent monitor workers (AgentMonitorWorker = offline watchdog + single
// notification dispatcher for agents)
// ============================================================

/**
 * MonitorWorkerManager is required lazily: MonitorWorkerManager → AgentMonitorWorker
 * → agent.service would otherwise form an import cycle at module load. Returns null
 * when the manager is not initialised (scripts) — workers are then reconciled by
 * startAll() at the next boot.
 */
function getWorkerManager(): MonitorWorkerManager | null {
  try {
    const mod = require('../workers/MonitorWorkerManager') as typeof import('../workers/MonitorWorkerManager');
    return mod.MonitorWorkerManager.getInstance();
  } catch {
    return null;
  }
}

/** Upper bound for the post-approval wait (agent push intervals are minutes, not hours). */
const MAX_WORKER_GRACE_INTERVAL_S = 900;

/** Delayed worker starts (approval / reinstatement grace), keyed by monitor id. */
const scheduledWorkerStarts = new Map<number, ReturnType<typeof setTimeout>>();
/** Monitor ids whose worker is being started right now (dedupes concurrent pushes). */
const startingWorkers = new Set<number>();
/** Monitor ids being deleted — never (re)start a worker for them. */
const retiringMonitors = new Set<number>();

function cancelScheduledWorkerStart(monitorId: number): void {
  const timer = scheduledWorkerStarts.get(monitorId);
  if (timer) {
    clearTimeout(timer);
    scheduledWorkerStarts.delete(monitorId);
  }
}

/**
 * Start the worker of an agent monitor if it is not running yet. Idempotent and
 * cheap when it already runs (one Map lookup); concurrent calls are deduped.
 * Only active, non-paused agent monitors are started.
 */
async function ensureAgentWorker(monitorId: number): Promise<void> {
  const wm = getWorkerManager();
  if (!wm) return;
  if (wm.isRunning(monitorId)) {
    cancelScheduledWorkerStart(monitorId);
    return;
  }
  if (startingWorkers.has(monitorId) || retiringMonitors.has(monitorId)) return;
  startingWorkers.add(monitorId);
  try {
    cancelScheduledWorkerStart(monitorId);
    const monitor = await monitorService.getById(monitorId);
    if (!monitor || monitor.type !== 'agent' || !monitor.isActive || monitor.status === 'paused') return;
    // Only an approved device gets a watchdog (a device refused/suspended
    // during the approval grace must not start reporting DOWN).
    const device = monitor.agentDeviceId
      ? await db('agent_devices').where({ id: monitor.agentDeviceId }).select('status').first() as { status: string } | undefined
      : undefined;
    if (device?.status !== 'approved') return;
    if (wm.isRunning(monitorId) || retiringMonitors.has(monitorId)) return;
    await wm.startMonitor(monitor);
  } catch (err) {
    logger.error(err, `Failed to start agent monitor worker ${monitorId} — retrying in 60 s`);
    if (!retiringMonitors.has(monitorId)) scheduleAgentWorkerStart(monitorId, 60_000);
  } finally {
    startingWorkers.delete(monitorId);
  }
}

function scheduleAgentWorkerStart(monitorId: number, delayMs: number): void {
  cancelScheduledWorkerStart(monitorId);
  const timer = setTimeout(() => {
    scheduledWorkerStarts.delete(monitorId);
    void ensureAgentWorker(monitorId);
  }, delayMs);
  timer.unref?.();
  scheduledWorkerStarts.set(monitorId, timer);
}

/**
 * Arm the offline watchdog of a freshly approved / reinstated agent.
 *
 * A pending agent pushes at its slow pending interval (300 s by default) and
 * a suspended one is not recorded, so starting the worker right away would
 * find no fresh push and confirm a false DOWN after the retry window (~60 s).
 * Instead: start now if the agent pushed recently; otherwise wait until its
 * next expected push. The push path starts the worker on the first push while
 * the delayed start is pending, and the timer covers an agent that never
 * comes back (real offline detection).
 */
function armAgentWorker(deviceId: number, monitorId: number, lastIntervalSeconds: number, newIntervalSeconds: number): void {
  const snapshot = agentPushData.get(deviceId);
  const freshWindowMs = Math.max(newIntervalSeconds, 30) * 2 * 1000;
  if (snapshot && Date.now() - snapshot.receivedAt.getTime() < freshWindowMs) {
    void ensureAgentWorker(monitorId);
    return;
  }
  const waitSeconds = Math.min(Math.max(lastIntervalSeconds, newIntervalSeconds, 30), MAX_WORKER_GRACE_INTERVAL_S) + 30;
  scheduleAgentWorkerStart(monitorId, waitSeconds * 1000);
}

/** Stop the workers of these monitors (and cancel any pending delayed start). */
async function stopAgentWorkers(monitorIds: number[]): Promise<void> {
  const wm = getWorkerManager();
  for (const id of monitorIds) {
    cancelScheduledWorkerStart(id);
    if (!wm) continue;
    try {
      await wm.stopMonitor(id);
    } catch (err) {
      logger.error(err, `Failed to stop monitor worker ${id}`);
    }
  }
}

/**
 * Reload the workers of these monitors so their cached config (group → channels
 * and maintenance windows, name) is refreshed. Monitors whose worker is not
 * running are left alone — they get a fresh config when they start.
 */
async function restartRunningWorkers(monitorIds: number[]): Promise<void> {
  const wm = getWorkerManager();
  if (!wm) return;
  for (const id of monitorIds) {
    if (!wm.isRunning(id)) continue;
    try {
      await wm.restartMonitor(id);
    } catch (err) {
      logger.error(err, `Failed to restart monitor worker ${id}`);
    }
  }
}

/**
 * Push the device's resolved config to its command channel right away (e.g.
 * after approval, so the agent leaves its slow pending interval now instead of
 * at its next pending heartbeat). agentHub imports this module, hence the lazy
 * require.
 */
function nudgeAgentConfig(device: AgentDevice): void {
  try {
    const { agentHub } = require('./agentHub.service') as typeof import('./agentHub.service');
    agentHub.pushConfig(device.uuid, { checkIntervalSeconds: device.resolvedSettings.checkIntervalSeconds });
  } catch (err) {
    logger.debug({ err, deviceId: device.id }, 'Could not push config to agent');
  }
}

/**
 * Delete devices and their agent monitors. Workers are stopped BEFORE the rows
 * go (a worker on a deleted monitor only dies on its next FK error otherwise).
 */
async function purgeDevices(devices: Array<{ id: number; tenant_id: number }>): Promise<void> {
  if (devices.length === 0) return;
  const ids = devices.map(d => d.id);
  const tenantByDevice = new Map(devices.map(d => [d.id, d.tenant_id]));

  const monitorRows = await db('monitors')
    .whereIn('agent_device_id', ids)
    .select('id', 'agent_device_id') as Array<{ id: number; agent_device_id: number }>;
  const monitorIds = monitorRows.map(r => r.id);

  // Monitors that used one of these devices as their proxy fall back to local
  // checks (FK ON DELETE SET NULL); their workers must reload that change.
  const proxiedRows = await db('monitors')
    .whereIn('proxy_agent_device_id', ids)
    .select('id') as Array<{ id: number }>;
  const proxiedIds = proxiedRows.map(r => r.id).filter(id => !monitorIds.includes(id));

  for (const id of monitorIds) retiringMonitors.add(id);
  try {
    await stopAgentWorkers(monitorIds);
    await db.transaction(async (trx) => {
      await trx('monitors').whereIn('agent_device_id', ids).del();
      await trx('agent_devices').whereIn('id', ids).del();
    });
  } finally {
    for (const id of monitorIds) retiringMonitors.delete(id);
  }

  for (const id of ids) agentPushData.delete(id);
  await restartRunningWorkers(proxiedIds);

  for (const r of monitorRows) {
    const tid = tenantByDevice.get(r.agent_device_id);
    if (tid !== undefined) emitToTenantAdmins(tid, SOCKET_EVENTS.MONITOR_DELETED, { monitorId: r.id });
  }
  for (const id of ids) {
    const tid = tenantByDevice.get(id);
    if (tid !== undefined) emitToAgentManagers(tid, SOCKET_EVENTS.AGENT_DEVICE_DELETED, { deviceId: id });
  }
}

// ============================================================
// Push payload types
// ============================================================

export interface AgentMetrics {
  cpu?: {
    percent: number;
    cores?: number[];
    model?: string;
    freqMhz?: number;
  };
  memory?: {
    totalMb: number;
    usedMb: number;
    percent: number;
    cachedMb?: number;
    buffersMb?: number;
    swapTotalMb?: number;
    swapUsedMb?: number;
  };
  disks?: Array<{
    mount: string;
    totalGb: number;
    usedGb: number;
    percent: number;
    readBytesPerSec?: number;
    writeBytesPerSec?: number;
  }>;
  network?: {
    inBytesPerSec: number;
    outBytesPerSec: number;
    interfaces?: Array<{ name: string; inBytesPerSec: number; outBytesPerSec: number }>;
  };
  loadAvg?: number;
  temps?: Array<{ label: string; celsius: number }>;
  gpus?: Array<{
    model: string;
    utilizationPct: number;
    vramUsedMb: number;
    vramTotalMb: number;
    tempCelsius?: number;
    engines?: Array<{ label: string; pct: number }>;
  }>;
  fans?: Array<{ label: string; rpm: number; maxRpm?: number }>;
}

export interface AgentPushPayload {
  hostname: string;
  agentVersion: string;
  /** 'agent' (default Go agent) or 'proxy' (Obliview proxy stub) */
  deviceType?: 'agent' | 'proxy';
  /**
   * Agent build line ('modern' | 'nt6', agent/build_flavor.go). Absent from
   * agents built before the nt6 line (they always download the modern MSI).
   */
  agentBuild?: string;
  osInfo?: {
    platform: string;
    distro?: string | null;
    release?: string | null;
    arch: string;
  };
  metrics: AgentMetrics;
}

export interface AgentPushResponse {
  /**
   * 'conflict': the device UUID is already registered in another workspace
   * (UUIDs are globally unique) — the push endpoint answers 409.
   */
  status: 'ok' | 'pending' | 'unauthorized' | 'conflict';
  config?: { checkIntervalSeconds: number };
  /**
   * Legacy fleet-wide self-update (AGENT_LEGACY_AUTO_UPDATE=true only):
   * latest agent version + autoUpdate:true, only ever sent to APPROVED
   * devices. By default agents are updated by the admin-paced 'update'
   * command instead (agentUpdateRollout.service).
   */
  latestVersion?: string;
  autoUpdate?: boolean;
  /**
   * One-shot command for the agent to execute (AgentCommand: 'uninstall',
   * 'update', 'reconfigure'), with its payload ('update': { targetVersion },
   * 'reconfigure': { apiKey }). A command is always sent with status 'ok' or
   * 'pending' (HTTP 200 / 202) — the statuses agents act on — including to a
   * refused / suspended device being uninstalled and to an agent that still
   * uses its former workspace's key after a transfer.
   */
  command?: string;
  commandPayload?: Record<string, unknown>;
  /** Human-readable reason, set with status 'conflict'. */
  error?: string;
}

// ── In-memory snapshot: indexed by deviceId ─────────────────
export interface AgentPushSnapshot {
  monitorId: number;
  receivedAt: Date;
  metrics: AgentMetrics;
  violations: string[];
  /**
   * Stable per-metric keys, same order as `violations` ('cpu', 'ram',
   * 'disk:<mount>', 'net_in', 'net_out', 'temp:<label>', 'gpu:<i>:<model>').
   * Used for client dedup and by AgentMonitorWorker → BaseMonitorWorker to
   * build per-metric live alerts (stableKey `agent-<deviceId>-<metricKey>`).
   */
  violationKeys: string[];
  overallStatus: 'up' | 'alert';
}

/**
 * Live push snapshots (only real pushes — never rebuilt from the DB, so the
 * offline watchdog's post-restart grace period keeps working).
 */
export const agentPushData = new Map<number, AgentPushSnapshot>();

/**
 * Best-effort metric key for a violation message of a heartbeat written before
 * keys were persisted. Fixed-name metrics are recognised; renamed disks and
 * sensors cannot be mapped back to their raw key.
 */
function deriveViolationKey(message: string, index: number): string {
  if (message.startsWith('CPU:')) return 'cpu';
  if (message.startsWith('RAM:')) return 'ram';
  if (message.startsWith('Net In:')) return 'net_in';
  if (message.startsWith('Net Out:')) return 'net_out';
  return `unknown_${index}`;
}

// ============================================================
// Thresholds resolution (exposed by GET /agent/devices/:id/thresholds-resolved)
// ============================================================

export interface DeviceThresholdsResolution {
  /** What the device is evaluated against: defaults ← group chain ← device override, per metric. */
  resolved: AgentThresholds;
  /** The device's own override slots (null = inherits everything). */
  override: Partial<AgentThresholds> | null;
  /** What the device inherits without an override: defaults ← group chain. */
  groupResolved: AgentThresholds;
}

/**
 * Resolve the live threshold cascade of a device. Returns null when the device
 * does not exist.
 */
export async function resolveDeviceThresholds(deviceId: number): Promise<DeviceThresholdsResolution | null> {
  const device = await db('agent_devices')
    .where({ id: deviceId })
    .select('id', 'group_id')
    .first() as { id: number; group_id: number | null } | undefined;
  if (!device) return null;

  const groupChain = device.group_id ? await resolveGroupAgentThresholds(device.group_id) : null;
  const monitor = await db('monitors')
    .where({ agent_device_id: deviceId, type: 'agent' })
    .orderBy('id')
    .select('agent_thresholds')
    .first() as { agent_thresholds: unknown } | undefined;

  const override = normalizeThresholdOverride(monitor?.agent_thresholds);
  const groupResolved = mergeAgentThresholds(DEFAULT_AGENT_THRESHOLDS, groupChain);
  const resolved = mergeAgentThresholds(groupResolved, override);
  return { resolved, override, groupResolved };
}

// ============================================================
// Agent Service
// ============================================================

export const agentService = {

  // ── API Keys ────────────────────────────────────────────

  async listKeys(tenantId: number | null): Promise<AgentApiKey[]> {
    const query = db('agent_api_keys as k')
      .leftJoin('agent_devices as d', 'k.id', 'd.api_key_id')
      .leftJoin('monitor_groups as g', 'g.id', 'k.default_group_id')
      .groupBy('k.id', 'g.name')
      .select('k.*', 'g.name as default_group_name', db.raw('COUNT(d.id) as device_count'))
      .orderBy('k.created_at', 'desc');
    if (tenantId !== null) query.where({ 'k.tenant_id': tenantId });
    const rows = await query as AgentApiKeyRow[];
    return rows.map(rowToApiKey);
  },

  /** defaultGroupId must be a group of the key's workspace (400 otherwise). */
  async createKey(
    name: string,
    createdBy: number,
    tenantId: number,
    defaultGroupId: number | null = null,
  ): Promise<AgentApiKey> {
    if (defaultGroupId !== null) await assertGroupInDeviceTenant(defaultGroupId, tenantId);
    const [row] = await db('agent_api_keys')
      .insert({ name, created_by: createdBy, tenant_id: tenantId, default_group_id: defaultGroupId })
      .returning('*') as AgentApiKeyRow[];
    return rowToApiKey(row);
  },

  /**
   * Rename a key and / or set its default group (validated against the key's
   * own workspace). Returns null when the key is outside tenantScope.
   */
  async updateKey(
    id: number,
    data: { name?: string; defaultGroupId?: number | null },
    tenantScope: number | null = null,
  ): Promise<AgentApiKey | null> {
    const key = await scopeToTenant(db('agent_api_keys').where({ id }), tenantScope)
      .select('id', 'tenant_id')
      .first() as { id: number; tenant_id: number } | undefined;
    if (!key) return null;
    if (data.defaultGroupId !== undefined && data.defaultGroupId !== null) {
      await assertGroupInDeviceTenant(data.defaultGroupId, key.tenant_id);
    }
    const update: Record<string, unknown> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.defaultGroupId !== undefined) update.default_group_id = data.defaultGroupId;
    if (Object.keys(update).length > 0) {
      await db('agent_api_keys').where({ id }).update(update);
    }
    const keys = await this.listKeys(key.tenant_id);
    return keys.find((k) => k.id === id) ?? null;
  },

  async deleteKey(id: number, tenantScope: number | null = null): Promise<boolean> {
    const key = await scopeToTenant(db('agent_api_keys').where({ id }), tenantScope)
      .select('id')
      .first() as { id: number } | undefined;
    if (!key) return false;
    // A device mid-transfer still authenticates with its former key and is
    // handed the new one: deleting either would strand it (ON DELETE SET NULL).
    const inTransfer = await db('agent_devices')
      .whereNotNull('transfer_from_api_key_id')
      .where((w) => w.where('api_key_id', id).orWhere('transfer_from_api_key_id', id))
      .count<{ count: string }[]>('id as count')
      .first();
    if (Number(inTransfer?.count ?? 0) > 0) {
      throw new AppError(409, 'This API key is used by a device whose workspace transfer is not complete yet');
    }
    const count = await db('agent_api_keys').where({ id }).del();
    return count > 0;
  },

  // ── Devices ─────────────────────────────────────────────

  async listDevices(tenantId: number | null, status?: AgentDevice['status']): Promise<AgentDevice[]> {
    const query = db('agent_devices')
      .select('*')
      .orderBy('created_at', 'desc');
    if (tenantId !== null) query.where({ tenant_id: tenantId });
    if (status) query.where({ status });
    const rows = await query as AgentDeviceRow[];

    // Batch resolve config + thresholds for every unique group in ONE closure
    // join, instead of the previous 2 queries per group in parallel. On a
    // God-View listing with hundreds of distinct groups this cut hundreds of
    // parallel closure queries down to a single IN-list join.
    const uniqueGroupIds = [...new Set(rows.map(r => r.group_id).filter((id): id is number => id !== null))];
    const { configMap, thresholdsMap } = await resolveGroupAgentConfigAndThresholdsBatch(uniqueGroupIds);

    return rows.map(r => rowToDevice(
      r,
      r.group_id !== null ? (configMap.get(r.group_id) ?? null) : null,
      r.group_id !== null ? (thresholdsMap.get(r.group_id) ?? null) : null,
    ));
  },

  /**
   * Keep the devices whose agent monitor is in `visibleMonitorIds`
   * (permissionService.getVisibleMonitorIds). Devices without an agent
   * monitor (pending / refused) are dropped.
   */
  async filterDevicesByVisibleMonitors(devices: AgentDevice[], visibleMonitorIds: number[]): Promise<AgentDevice[]> {
    if (devices.length === 0 || visibleMonitorIds.length === 0) return [];
    const visible = new Set(visibleMonitorIds);
    const rows = await db('monitors')
      .where({ type: 'agent' })
      .whereIn('agent_device_id', devices.map((d) => d.id))
      .select('id', 'agent_device_id') as Array<{ id: number; agent_device_id: number }>;
    const allowed = new Set(rows.filter((r) => visible.has(r.id)).map((r) => r.agent_device_id));
    return devices.filter((d) => allowed.has(d.id));
  },

  /**
   * Approved devices of a workspace, lightweight, for the monitor proxy
   * picker. `agentMonitorIds` restricts the list to the devices whose agent
   * monitor is in it (null = every approved device).
   */
  async listProxyCandidates(
    tenantId: number,
    agentMonitorIds: number[] | null,
  ): Promise<Array<{ id: number; name: string | null; hostname: string; deviceType: AgentDevice['deviceType']; monitorId: number | null }>> {
    if (agentMonitorIds !== null && agentMonitorIds.length === 0) return [];
    const query = db('agent_devices as d')
      .where({ 'd.tenant_id': tenantId, 'd.status': 'approved' })
      .select('d.id', 'd.name', 'd.hostname', 'd.device_type')
      .select(db.raw("(SELECT MIN(m2.id) FROM monitors m2 WHERE m2.agent_device_id = d.id AND m2.type = 'agent') AS monitor_id"))
      .orderByRaw('LOWER(COALESCE(d.name, d.hostname))');
    if (agentMonitorIds !== null) {
      query.whereExists(
        db('monitors as m')
          .whereRaw('m.agent_device_id = d.id')
          .where('m.type', 'agent')
          .whereIn('m.id', agentMonitorIds),
      );
    }
    const rows = await query as Array<{ id: number; name: string | null; hostname: string; device_type: string | null; monitor_id: number | null }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name ?? null,
      hostname: r.hostname,
      deviceType: (r.device_type || 'agent') as AgentDevice['deviceType'],
      monitorId: r.monitor_id ?? null,
    }));
  },

  /** tenantScope: null = any workspace (God View / internal callers). */
  async getDeviceById(id: number, tenantScope: number | null = null): Promise<AgentDevice | null> {
    const row = await scopeToTenant(db('agent_devices').where({ id }), tenantScope).first() as AgentDeviceRow | undefined;
    if (!row) return null;
    return hydrateDevice(row);
  },

  async getDeviceByUuid(uuid: string, tenantId?: number): Promise<AgentDevice | null> {
    const query = db('agent_devices').where({ uuid });
    if (tenantId !== undefined) query.where({ tenant_id: tenantId });
    const row = await query.first() as AgentDeviceRow | undefined;
    if (!row) return null;
    return hydrateDevice(row);
  },

  /**
   * agent_devices.group_id is authoritative: a group change is mirrored to the
   * device's agent monitor (notification bindings, maintenance, RBAC and the
   * dashboard read the monitor group) and its running worker is reloaded.
   */
  async updateDevice(id: number, data: {
    status?: AgentDevice['status'];
    groupId?: number | null;
    checkIntervalSeconds?: number;
    approvedBy?: number;
    approvedAt?: Date;
    name?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: AgentDisplayConfig | null;
    notificationTypes?: NotificationTypeConfig | null;
    notificationCooldownSeconds?: number | null;
    notes?: string | null;
    /** Device level of the update policy (null = inherit). */
    updatePolicy?: AgentUpdatePolicy | null;
  }, tenantScope: number | null = null): Promise<AgentDevice | null> {
    const current = await scopeToTenant(db('agent_devices').where({ id }), tenantScope)
      .select('tenant_id', 'group_id', 'name')
      .first() as { tenant_id: number; group_id: number | null; name: string | null } | undefined;
    if (!current) return null;

    if (data.groupId !== undefined && data.groupId !== null) {
      await assertGroupInDeviceTenant(data.groupId, current.tenant_id);
    }

    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.status !== undefined) update.status = data.status;
    if (data.groupId !== undefined) update.group_id = data.groupId;
    if (data.checkIntervalSeconds !== undefined) update.check_interval_seconds = data.checkIntervalSeconds;
    if (data.notificationCooldownSeconds !== undefined) update.notification_cooldown_seconds = data.notificationCooldownSeconds;
    if (data.approvedBy !== undefined) update.approved_by = data.approvedBy;
    if (data.approvedAt !== undefined) update.approved_at = data.approvedAt;
    if (data.name !== undefined) update.name = data.name;
    if (data.heartbeatMonitoring !== undefined) update.heartbeat_monitoring = data.heartbeatMonitoring;
    if (data.sensorDisplayNames !== undefined) update.sensor_display_names = data.sensorDisplayNames;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    if (data.displayConfig !== undefined) update.display_config = data.displayConfig;
    if ('notificationTypes' in data) update.notification_types = data.notificationTypes
      ? JSON.stringify(data.notificationTypes)
      : null;
    if (data.notes !== undefined) update.notes = data.notes;
    if (data.updatePolicy !== undefined) update.update_policy = data.updatePolicy;

    const { row, monitorIds } = await db.transaction(async (trx) => {
      const [updatedRow] = await trx('agent_devices')
        .where({ id })
        .update(update)
        .returning('*') as AgentDeviceRow[];
      if (!updatedRow) return { row: undefined, monitorIds: [] as number[] };

      // Keep the agent monitor in step with the device: group (single source
      // of truth = the device) and display name.
      const monitorUpdate: Record<string, unknown> = {};
      if (data.groupId !== undefined) monitorUpdate.group_id = updatedRow.group_id;
      if (data.name !== undefined) monitorUpdate.name = updatedRow.name ?? updatedRow.hostname;
      let touched: number[] = [];
      if (Object.keys(monitorUpdate).length > 0) {
        monitorUpdate.updated_at = new Date();
        const rows = await trx('monitors')
          .where({ agent_device_id: id, type: 'agent' })
          .update(monitorUpdate)
          .returning('id') as Array<{ id: number }>;
        touched = rows.map(r => r.id);
      }
      return { row: updatedRow, monitorIds: touched };
    });
    if (!row) return null;

    // Running workers cache the group (notification channels, maintenance
    // windows) and the name — reload them when either actually changed.
    const groupChanged = data.groupId !== undefined && row.group_id !== current.group_id;
    const nameChanged = data.name !== undefined && row.name !== current.name;
    if (monitorIds.length > 0 && (groupChanged || nameChanged)) {
      await restartRunningWorkers(monitorIds);
    }

    const device = await hydrateDevice(row);

    // Broadcast so the admin list and the sidebar update without polling —
    // scoped to the tenant this device belongs to.
    emitDeviceUpdated(device);
    if (monitorIds.length > 0) {
      await emitAgentMonitorChanges(monitorIds);
    }

    return device;
  },

  async deleteDevice(id: number, tenantScope: number | null = null): Promise<boolean> {
    const device = await scopeToTenant(db('agent_devices').where({ id }), tenantScope)
      .select('id', 'tenant_id')
      .first() as { id: number; tenant_id: number } | undefined;
    if (!device) return false;
    await purgeDevices([device]);
    return true;
  },

  // ── Bulk operations ──────────────────────────────────────────────────────

  /** Ids outside tenantScope (null = any workspace) are ignored. Returns the devices deleted. */
  async bulkDeleteDevices(ids: number[], tenantScope: number | null = null): Promise<Array<{ id: number; tenant_id: number }>> {
    if (ids.length === 0) return [];
    // Grab tenant assignments before the delete so we can scope emissions to
    // the right admin room (deleted rows can't tell us their tenant).
    const rows = await scopeToTenant(db('agent_devices').whereIn('id', ids), tenantScope)
      .select('id', 'tenant_id') as Array<{ id: number; tenant_id: number }>;
    if (rows.length === 0) return [];
    await purgeDevices(rows);
    return rows;
  },

  /**
   * Bulk edit. Field changes apply to every selected device; a status change
   * is applied per device according to its CURRENT status and never recreates
   * an existing agent monitor (heartbeat history, threshold override and
   * monitor-scoped bindings are preserved):
   *   - 'approved': pending → approval (monitor created only if none exists),
   *                 suspended → reinstatement, approved/refused → unchanged;
   *   - 'suspended': approved → suspension, others → unchanged.
   */
  async bulkUpdateDevices(ids: number[], data: {
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
    /** User id stamped as approved_by + monitor.created_by when status='approved'. */
    approvedBy?: number;
  }, tenantScope: number | null = null): Promise<Array<{ id: number; tenant_id: number }>> {
    if (ids.length === 0) return [];

    // Ids outside tenantScope (null = any workspace) are ignored.
    const rows = await scopeToTenant(db('agent_devices').whereIn('id', ids), tenantScope)
      .select('id', 'status', 'tenant_id') as Array<{ id: number; status: AgentDevice['status']; tenant_id: number }>;
    if (rows.length === 0) return [];
    const deviceIds = rows.map(r => r.id);

    // Tenant guard: a group can only be assigned within one workspace.
    if (data.groupId !== undefined && data.groupId !== null) {
      const tenants = await db('agent_devices')
        .whereIn('id', deviceIds)
        .distinct('tenant_id') as Array<{ tenant_id: number }>;
      if (tenants.length !== 1) {
        throw new AppError(400, 'Cannot bulk-assign group across multiple tenants');
      }
      await assertGroupInDeviceTenant(data.groupId, tenants[0].tenant_id);
    }

    // 1. Field changes for every selected device (+ group mirrored to the agent monitors).
    const update: Record<string, unknown> = {};
    if (data.groupId !== undefined)               update.group_id                = data.groupId;
    if (data.heartbeatMonitoring !== undefined)   update.heartbeat_monitoring    = data.heartbeatMonitoring;
    if (data.overrideGroupSettings !== undefined) update.override_group_settings = data.overrideGroupSettings;
    let movedMonitorIds: number[] = [];
    if (Object.keys(update).length > 0) {
      update.updated_at = new Date();
      movedMonitorIds = await db.transaction(async (trx) => {
        await trx('agent_devices').whereIn('id', deviceIds).update(update);
        if (data.groupId === undefined) return [];
        const moved = await trx('monitors')
          .whereIn('agent_device_id', deviceIds)
          .andWhere({ type: 'agent' })
          .update({ group_id: data.groupId, updated_at: new Date() })
          .returning('id') as Array<{ id: number }>;
        return moved.map(r => r.id);
      });
    }

    // 2. Status transitions, one device at a time (each one atomic).
    if (data.status === 'approved') {
      for (const r of rows) {
        try {
          if (r.status === 'pending') {
            // undefined group = keep the device's (possibly just updated) group.
            await this.approveDevice(r.id, data.approvedBy ?? null, undefined, undefined, { emit: false });
          } else if (r.status === 'suspended') {
            await this.reinstateDevice(r.id, { emit: false });
          }
          // approved / refused: unchanged.
        } catch (err) {
          logger.error(err, `Bulk approve: device ${r.id} could not be approved/reinstated`);
        }
      }
    } else if (data.status === 'suspended') {
      for (const r of rows) {
        if (r.status !== 'approved') continue;
        try {
          await this.suspendDevice(r.id, { emit: false });
        } catch (err) {
          logger.error(err, `Bulk suspend: device ${r.id} could not be suspended`);
        }
      }
    }

    // 3. Moved monitors: reload running workers so their cached group refreshes.
    await restartRunningWorkers(movedMonitorIds);

    // 4. Live updates — full devices, each to its own tenant's admins.
    const devices = await loadDevicesByIds(deviceIds);
    emitDevicesUpdated(devices);
    await emitAgentMonitorChanges(movedMonitorIds);
    return rows.map((r) => ({ id: r.id, tenant_id: r.tenant_id }));
  },

  // ── Runtime state / live updates ────────────────────────────────────────

  /** Attach runtimeStatus + inMaintenance (see withRuntime). */
  async withRuntime(devices: AgentDevice[]): Promise<AgentDevice[]> {
    return withRuntime(devices);
  },

  /** Emit AGENT_DEVICE_UPDATED (full device) for these ids. */
  async emitDevicesByIds(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    emitDevicesUpdated(await loadDevicesByIds([...new Set(ids)]));
  },

  // ── Uninstall ────────────────────────────────────────────────────────────
  // An uninstall is queued (pending_command='uninstall', uninstall_requested_at)
  // and delivered on the device's next contact, whatever its approval state
  // (a suspended or refused device can be uninstalled too). A device with an
  // open command channel gets it right away. Delivery sets
  // uninstall_commanded_at, which starts the 10-minute auto-delete countdown
  // (cleanupUninstalledDevices). Until then it can be cancelled.

  /**
   * Request the uninstall of devices within tenantScope (null = any
   * workspace). Ids outside the scope are ignored. A waiting agent update or
   * a pending tenant-transfer reconfigure command is superseded — the
   * transfer marker is kept, so an agent still on its former key first gets
   * its new key, then the uninstall on its next call-in. Proxy stubs are
   * skipped (the proxy ignores 'uninstall': it must be stopped by hand and
   * the device deleted). Returns the ids concerned, the proxies skipped and
   * how many were delivered immediately over the WS channel.
   */
  async requestUninstall(
    ids: number[],
    tenantScope: number | null = null,
  ): Promise<{ deviceIds: number[]; skippedIds: number[]; deliveredNow: number }> {
    if (ids.length === 0) return { deviceIds: [], skippedIds: [], deliveredNow: 0 };
    const allRows = await scopeToTenant(db('agent_devices').whereIn('id', ids), tenantScope)
      .select('id', 'uuid', 'device_type') as Array<{ id: number; uuid: string; device_type: string | null }>;
    const skippedIds = allRows.filter((r) => r.device_type === 'proxy').map((r) => r.id);
    const rows = allRows.filter((r) => r.device_type !== 'proxy');
    if (rows.length === 0) return { deviceIds: [], skippedIds, deliveredNow: 0 };

    const { agentHub } = require('./agentHub.service') as typeof import('./agentHub.service');
    const now = new Date();
    const queuedIds: number[] = [];
    const deliveredIds: number[] = [];
    for (const r of rows) {
      if (agentHub.pushCommand(r.uuid, 'uninstall')) deliveredIds.push(r.id);
      else queuedIds.push(r.id);
    }

    const common = {
      uninstall_requested_at: now,
      update_requested_at: null,
      update_sent_at: null,
      updated_at: now,
    };
    await db.transaction(async (trx) => {
      if (queuedIds.length > 0) {
        await trx('agent_devices').whereIn('id', queuedIds)
          .update({ ...common, pending_command: 'uninstall', uninstall_commanded_at: null });
      }
      if (deliveredIds.length > 0) {
        // An open channel only exists on the device's current key: any
        // transfer is complete.
        await trx('agent_devices').whereIn('id', deliveredIds)
          .update({
            ...common,
            pending_command: null,
            uninstall_commanded_at: now,
            transfer_from_api_key_id: null,
            transfer_requested_at: null,
          });
      }
    });

    const deviceIds = rows.map((r) => r.id);
    await this.emitDevicesByIds(deviceIds);
    logger.info({ deviceIds, skippedIds, deliveredNow: deliveredIds.length }, 'Agent uninstall requested');
    return { deviceIds, skippedIds, deliveredNow: deliveredIds.length };
  },

  /**
   * Cancel a requested uninstall: the queued command is dropped and, when it
   * was already delivered, the auto-delete countdown stops (the agent may
   * already be gone — it simply re-appears if it keeps pushing). Returns the
   * device, or null when it is outside tenantScope.
   */
  async cancelUninstall(id: number, tenantScope: number | null = null): Promise<AgentDevice | null> {
    const row = await scopeToTenant(db('agent_devices').where({ id }), tenantScope)
      .select('id', 'pending_command', 'transfer_from_api_key_id')
      .first() as { id: number; pending_command: string | null; transfer_from_api_key_id: number | null } | undefined;
    if (!row) return null;
    const update: Record<string, unknown> = {
      uninstall_requested_at: null,
      uninstall_commanded_at: null,
      updated_at: new Date(),
    };
    // A transfer still in progress gets its 'reconfigure' back.
    if (row.pending_command === 'uninstall') {
      update.pending_command = row.transfer_from_api_key_id ? 'reconfigure' : null;
    }
    await db('agent_devices').where({ id }).update(update);
    const device = await this.getDeviceById(id);
    if (device) emitDeviceUpdated(device);
    return device;
  },

  // ── Tenant transfer ──────────────────────────────────────────────────────

  /**
   * Move devices to another workspace (platform admins). The devices must be
   * in tenantScope (null = God View), the key in the target workspace.
   *
   * One transaction: device → target tenant + key, no group, 'reconfigure'
   * queued (transfer_from_api_key_id = the key the agent still uses); its
   * agent monitor → target tenant, no group; the tenant-bound side data of
   * the device / agent monitor is purged (notification bindings, maintenance
   * windows and opt-outs, live alerts, team permissions, remediation
   * bindings) and its monitor settings re-homed; monitors of the source
   * workspace proxied through it fall back to local checks.
   * Then the 'reconfigure' {apiKey} command is pushed to a connected agent
   * (otherwise it is delivered when the agent next calls in with its old key,
   * within TRANSFER_RECONFIGURE_TTL_MS).
   *
   * The agent is NOT handed the chosen workspace key: a dedicated key is
   * minted in the target workspace for each transfer batch (named after the
   * chosen key, with its default group), so a leaked hand-out can be revoked
   * without touching the rest of the target fleet.
   */
  async transferDevices(
    ids: number[],
    tenantScope: number | null,
    targetTenantId: number,
    targetApiKeyId: number,
    actorUserId: number,
  ): Promise<AgentTransferResult & { transferredIds: number[]; sourceTenantIds: number[]; transferKeyId: number | null }> {
    const empty = { transferred: 0, skipped: ids.length, failed: 0, transferredIds: [], sourceTenantIds: [], transferKeyId: null };
    const tenant = await db('tenants').where({ id: targetTenantId }).select('id').first();
    if (!tenant) throw new AppError(400, 'Target workspace not found');
    const chosenKey = await db('agent_api_keys')
      .where({ id: targetApiKeyId, tenant_id: targetTenantId })
      .select('id', 'name', 'default_group_id')
      .first() as { id: number; name: string; default_group_id: number | null } | undefined;
    if (!chosenKey) throw new AppError(400, 'Target API key not found in the target workspace');

    if (ids.length === 0) return empty;
    const rows = await scopeToTenant(db('agent_devices').whereIn('id', ids), tenantScope)
      .whereNot('tenant_id', targetTenantId)
      .select('id', 'uuid', 'tenant_id', 'api_key_id', 'transfer_from_api_key_id') as Array<{
        id: number; uuid: string; tenant_id: number; api_key_id: number | null; transfer_from_api_key_id: number | null;
      }>;
    if (rows.length === 0) return empty;

    // Dedicated, revocable key for this transfer batch.
    const minted = await this.createKey(
      `Transfer (${chosenKey.name}) ${new Date().toISOString().slice(0, 10)}`.slice(0, 255),
      actorUserId,
      targetTenantId,
      chosenKey.default_group_id ?? null,
    );
    const key = { id: minted.id, key: minted.key };

    const result: AgentTransferResult = { transferred: 0, skipped: ids.length - rows.length, failed: 0 };
    const moved: Array<{ id: number; uuid: string; tenant_id: number; monitorIds: number[]; proxiedIds: number[] }> = [];

    for (const r of rows) {
      let monitorIds: number[] = [];
      let workersStopped = false;
      try {
        const monitorRows = await db('monitors')
          .where({ agent_device_id: r.id, type: 'agent' })
          .select('id') as Array<{ id: number }>;
        monitorIds = monitorRows.map((m) => m.id);
        // Workers cache tenant / group / channels: stop them first, re-armed below.
        for (const id of monitorIds) retiringMonitors.add(id);
        let proxiedIds: number[] = [];
        try {
          workersStopped = true;
          await stopAgentWorkers(monitorIds);
          proxiedIds = await db.transaction(async (trx) => {
            const now = new Date();
            await trx('agent_devices').where({ id: r.id }).update({
              tenant_id: targetTenantId,
              api_key_id: key.id,
              group_id: null,
              pending_command: 'reconfigure',
              // A device re-transferred before applying its reconfigure still
              // uses the key it had before the first transfer.
              transfer_from_api_key_id: r.transfer_from_api_key_id ?? r.api_key_id,
              transfer_requested_at: now,
              uninstall_requested_at: null,
              uninstall_commanded_at: null,
              update_requested_at: null,
              update_sent_at: null,
              updated_at: now,
            });
            if (monitorIds.length > 0) {
              await trx('monitors').whereIn('id', monitorIds)
                .update({ tenant_id: targetTenantId, group_id: null, updated_at: now });
            }
            // Identity v2: the device's previous UUIDs follow it.
            await trx('agent_device_uuid_aliases').where({ device_id: r.id })
              .update({ tenant_id: targetTenantId });

            // Tenant-bound side data (channels, windows, teams, actions belong to the source workspace).
            const scopeOf = (q: Knex.QueryBuilder, col: string, idCol: string) => q.where((w) => {
              w.where({ [col]: 'agent' }).where(idCol, r.id);
              if (monitorIds.length > 0) w.orWhere((m) => m.where({ [col]: 'monitor' }).whereIn(idCol, monitorIds));
            });
            await scopeOf(trx('notification_bindings'), 'scope', 'scope_id').del();
            await scopeOf(trx('maintenance_window_disables'), 'scope_type', 'scope_id').del();
            await scopeOf(trx('maintenance_windows'), 'scope_type', 'scope_id').del();
            await trx('live_alerts').where((w) => {
              w.where('agent_device_id', r.id);
              if (monitorIds.length > 0) w.orWhereIn('monitor_id', monitorIds);
            }).del();
            if (monitorIds.length > 0) {
              await trx('team_permissions').where({ scope: 'monitor' }).whereIn('scope_id', monitorIds).del();
              await trx('remediation_bindings').where({ scope: 'monitor' }).whereIn('scope_id', monitorIds).del();
              await trx('settings').where({ scope: 'monitor' }).whereIn('scope_id', monitorIds)
                .update({ tenant_id: targetTenantId });
            }
            // A proxy must belong to the monitor's workspace.
            const proxied = await trx('monitors')
              .where({ proxy_agent_device_id: r.id })
              .whereNot('tenant_id', targetTenantId)
              .update({ proxy_agent_device_id: null, updated_at: now })
              .returning('id') as Array<{ id: number }>;
            return proxied.map((p) => p.id);
          });
        } finally {
          for (const id of monitorIds) retiringMonitors.delete(id);
        }
        result.transferred++;
        moved.push({ id: r.id, uuid: r.uuid, tenant_id: r.tenant_id, monitorIds, proxiedIds });
      } catch (err) {
        logger.error({ err, deviceId: r.id }, 'Agent tenant transfer failed for device');
        result.failed++;
        // The transaction rolled back: the device is still in its source
        // workspace, but its workers were stopped above. Re-arm them, or the
        // offline watchdog stays dead until the next server restart. (The
        // inner finally already cleared retiringMonitors.)
        if (workersStopped && monitorIds.length > 0) {
          try {
            const device = await this.getDeviceById(r.id);
            const interval = device?.resolvedSettings.checkIntervalSeconds ?? 60;
            for (const id of monitorIds) armAgentWorker(r.id, id, interval, interval);
          } catch (rearmErr) {
            logger.error({ err: rearmErr, deviceId: r.id }, 'Agent tenant transfer: failed to re-arm workers');
          }
        }
      }
    }

    const { agentHub } = require('./agentHub.service') as typeof import('./agentHub.service');
    for (const m of moved) {
      // Re-arm the offline watchdog with the new tenant / no group.
      const device = await this.getDeviceById(m.id);
      const interval = device?.resolvedSettings.checkIntervalSeconds ?? 60;
      for (const monitorId of m.monitorIds) armAgentWorker(m.id, monitorId, interval, interval);
      await restartRunningWorkers(m.proxiedIds);

      // The open channel is still bound to the old workspace: hand the agent
      // its new key, then drop the channel (it reconnects with the new key).
      if (agentHub.pushCommand(m.uuid, 'reconfigure', { apiKey: key.key })) {
        agentHub.disconnectDevices([m.uuid]);
      }

      // Source workspace: the device and its monitor are gone.
      emitToAgentManagers(m.tenant_id, SOCKET_EVENTS.AGENT_DEVICE_DELETED, { deviceId: m.id });
      for (const monitorId of m.monitorIds) {
        emitToTenantAdmins(m.tenant_id, SOCKET_EVENTS.MONITOR_DELETED, { monitorId });
      }
    }
    if (moved.length > 0) {
      const allMonitorIds = moved.flatMap((m) => m.monitorIds);
      await emitAgentMonitorChanges(allMonitorIds, allMonitorIds);
      await this.emitDevicesByIds(moved.map((m) => m.id));
      try {
        agentHub.syncAllProxyMonitors().catch(() => {});
      } catch { /* hub not ready */ }
    }

    if (moved.length === 0) {
      // Nothing moved: the minted key is unused.
      await db('agent_api_keys').where({ id: key.id }).del().catch(() => {});
    }

    return {
      ...result,
      transferredIds: moved.map((m) => m.id),
      sourceTenantIds: [...new Set(moved.map((m) => m.tenant_id))],
      transferKeyId: moved.length > 0 ? key.id : null,
    };
  },

  /**
   * After a tenant transfer: the 'reconfigure' payload for an agent that
   * still calls in with its FORMER key (only that key — any other key of the
   * old workspace gets nothing), within TRANSFER_RECONFIGURE_TTL_MS of the
   * transfer. Whatever command is queued (reconfigure, or an uninstall
   * requested since) is delivered once the agent calls in with the new key.
   * null when there is nothing to deliver.
   */
  async getTransferReconfigure(deviceUuid: string, apiKeyId: number): Promise<{ apiKey: string } | null> {
    const row = await db('agent_devices as d')
      .join('agent_api_keys as k', 'k.id', 'd.api_key_id')
      .where({ 'd.uuid': deviceUuid, 'd.transfer_from_api_key_id': apiKeyId })
      .where('d.transfer_requested_at', '>', new Date(Date.now() - TRANSFER_RECONFIGURE_TTL_MS))
      .select('d.id', 'k.key')
      .first() as { id: number; key: string } | undefined;
    if (!row) return null;
    logger.warn({ deviceUuid, deviceId: row.id, fromApiKeyId: apiKeyId },
      'Tenant transfer: handing the new workspace key to an agent on its former key');
    return { apiKey: row.key };
  },

  /**
   * Cleanup job: transfers whose agent never called in with its new key
   * within TRANSFER_RECONFIGURE_TTL_MS. The former key stops receiving the
   * new one (the agent must be re-installed or transferred again).
   */
  async cleanupStaleTransfers(): Promise<void> {
    const cutoff = new Date(Date.now() - TRANSFER_RECONFIGURE_TTL_MS);
    const rows = await db('agent_devices')
      .whereNotNull('transfer_from_api_key_id')
      .where((w) => w.whereNull('transfer_requested_at').orWhere('transfer_requested_at', '<', cutoff))
      .update({
        pending_command: db.raw("CASE WHEN pending_command = 'reconfigure' THEN NULL ELSE pending_command END"),
        transfer_from_api_key_id: null,
        transfer_requested_at: null,
        updated_at: new Date(),
      })
      .returning(['id', 'hostname']) as Array<{ id: number; hostname: string }>;
    if (rows.length === 0) return;
    for (const r of rows) {
      logger.warn(`Agent ${r.id} (${r.hostname}): tenant transfer never completed — pending reconfigure dropped.`);
    }
    await this.emitDevicesByIds(rows.map((r) => r.id));
  },

  /**
   * Cleanup job: auto-delete devices whose 'uninstall' command was delivered
   * more than 10 minutes ago (they've had enough time to uninstall and stop pushing).
   * Should be called periodically (e.g. every 5 minutes).
   */
  async cleanupUninstalledDevices(): Promise<void> {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    const rows = await db('agent_devices')
      .whereNotNull('uninstall_commanded_at')
      .where('uninstall_commanded_at', '<', cutoff)
      .select('id') as { id: number }[];

    if (rows.length === 0) return;

    const ids = rows.map(r => r.id);
    await this.bulkDeleteDevices(ids);
    logger.info(`Agent cleanup: auto-deleted ${ids.length} device(s) after uninstall command.`);
  },

  /** Suspend a device: set status=suspended, pause the agent monitor and stop its worker. */
  async suspendDevice(id: number, opts: { emit?: boolean } = {}): Promise<void> {
    const exists = await db('agent_devices').where({ id }).select('id').first();
    if (!exists) return;

    const now = new Date();
    const monitorIds = await db.transaction(async (trx) => {
      await trx('agent_devices').where({ id }).update({ status: 'suspended', updated_at: now });
      const rows = await trx('monitors')
        .where({ agent_device_id: id, type: 'agent' })
        .update({ is_active: false, status: 'paused', updated_at: now })
        .returning('id') as Array<{ id: number }>;
      return rows.map(r => r.id);
    });

    // Rows first, workers second: a push racing with the suspension now gets
    // 'unauthorized' and the push-path self-heal skips paused monitors, so
    // nothing can restart the worker behind our back.
    await stopAgentWorkers(monitorIds);

    const device = await this.getDeviceById(id);
    if (!device) return;
    await emitAgentMonitorChanges(monitorIds);
    if (opts.emit !== false) emitDeviceUpdated(device);
  },

  /**
   * Reinstate a suspended device: status back to approved, agent monitor
   * re-activated (status 'pending' until the first push) and its offline
   * watchdog armed. Also re-activates the paused agent monitor of an approved
   * device. Pending and refused devices go through approval instead.
   */
  async reinstateDevice(id: number, opts: { emit?: boolean } = {}): Promise<void> {
    const before = await this.getDeviceById(id);
    if (!before) return;
    if (before.status !== 'suspended' && before.status !== 'approved') return;

    const now = new Date();
    const { monitorIds, createdIds } = await db.transaction(async (trx) => {
      await trx('agent_devices').where({ id }).update({ status: 'approved', updated_at: now });

      const reactivate = trx('monitors').where({ agent_device_id: id, type: 'agent' });
      if (before.status === 'approved') {
        // Already approved: only touch a monitor that is actually paused/inactive.
        reactivate.andWhere((q) => q.where('is_active', false).orWhere('status', 'paused'));
      }
      const touched = await reactivate
        .update({ is_active: true, status: 'pending', updated_at: now })
        .returning('id') as Array<{ id: number }>;
      if (touched.length > 0) return { monitorIds: touched.map(r => r.id), createdIds: [] as number[] };

      const existing = await trx('monitors').where({ agent_device_id: id, type: 'agent' }).first('id');
      if (existing) return { monitorIds: [] as number[], createdIds: [] as number[] };

      // Self-heal: a suspended device without its agent monitor gets one back.
      const [created] = await trx('monitors')
        .insert({
          name: before.name ?? before.hostname,
          type: 'agent',
          group_id: before.groupId,
          is_active: true,
          status: 'pending',
          agent_device_id: id,
          agent_thresholds: null,
          created_by: before.approvedBy,
          tenant_id: before.tenantId,
        })
        .returning('*') as Array<{ id: number }>;
      return { monitorIds: [created.id], createdIds: [created.id] };
    });

    if (monitorIds.length > 0) {
      // Restart with a fresh config, once the agent is pushing again.
      await stopAgentWorkers(monitorIds);
      const interval = before.resolvedSettings.checkIntervalSeconds;
      for (const monitorId of monitorIds) armAgentWorker(id, monitorId, interval, interval);
      await emitAgentMonitorChanges(monitorIds, createdIds);
    }

    if (opts.emit !== false) {
      const device = await this.getDeviceById(id);
      if (device) emitDeviceUpdated(device);
    }
  },

  // ── Approval ─────────────────────────────────────────────

  /**
   * Approve a device: status=approved and ONE agent monitor.
   *
   * - groupId: number/null assigns/clears the group; undefined keeps the
   *   device's current group (bulk approve). The group must belong to the
   *   device's workspace.
   * - Thresholds are NOT snapshotted: the monitor gets agent_thresholds=NULL
   *   (live cascade defaults ← group chain) unless customThresholds is passed.
   * - Re-approval keeps the existing agent monitor (history, bindings and any
   *   explicit override survive); only duplicate agent monitors are removed.
   * - The offline watchdog is armed (see armAgentWorker).
   */
  async approveDevice(
    deviceId: number,
    approvedBy: number | null,
    groupId: number | null | undefined,
    customThresholds?: Partial<AgentThresholds> | null,
    opts: { emit?: boolean } = {},
  ): Promise<AgentDevice | null> {
    const before = await this.getDeviceById(deviceId);
    if (!before) return null;

    // undefined = keep the device's group, else the default group of the API
    // key it enrolled with (explicit null = no group).
    const effectiveGroupId = groupId !== undefined
      ? groupId
      : (before.groupId ?? await keyDefaultGroupId(before.apiKeyId, before.tenantId));
    if (effectiveGroupId !== null) {
      await assertGroupInDeviceTenant(effectiveGroupId, before.tenantId);
    }

    const wasApproved = before.status === 'approved';
    const existing = await db('monitors')
      .where({ agent_device_id: deviceId, type: 'agent' })
      .orderBy('id')
      .select('id', 'is_active', 'status') as Array<{ id: number; is_active: boolean; status: string }>;
    const kept = existing[0] ?? null;
    const duplicateIds = existing.slice(1).map(r => r.id);

    const override = customThresholds === undefined ? undefined : normalizeThresholdOverride(customThresholds);
    const name = before.name ?? before.hostname;
    const now = new Date();

    for (const id of duplicateIds) retiringMonitors.add(id);
    let result: { monitorId: number; created: boolean };
    try {
      // Stop duplicate workers BEFORE their rows are deleted.
      await stopAgentWorkers(duplicateIds);
      result = await db.transaction(async (trx) => {
        await trx('agent_devices').where({ id: deviceId }).update({
          status: 'approved',
          group_id: effectiveGroupId,
          approved_by: approvedBy,
          approved_at: now,
          check_interval_seconds: 60, // reset from the pending interval
          updated_at: now,
        });

        if (duplicateIds.length > 0) {
          await trx('monitors').whereIn('id', duplicateIds).del();
        }

        if (kept) {
          const monitorUpdate: Record<string, unknown> = { name, group_id: effectiveGroupId, updated_at: now };
          if (!wasApproved || !kept.is_active || kept.status === 'paused') {
            monitorUpdate.is_active = true;
            monitorUpdate.status = 'pending';
          }
          if (override !== undefined) {
            monitorUpdate.agent_thresholds = override ? JSON.stringify(override) : null;
          }
          await trx('monitors').where({ id: kept.id }).update(monitorUpdate);
          return { monitorId: kept.id, created: false };
        }

        const [row] = await trx('monitors')
          .insert({
            name,
            type: 'agent',
            group_id: effectiveGroupId,
            is_active: true,
            status: 'pending',
            agent_device_id: deviceId,
            // NULL = inherit the live cascade; only an explicit override is stored.
            agent_thresholds: override ? JSON.stringify(override) : null,
            created_by: approvedBy,
            tenant_id: before.tenantId,
          })
          .returning('*') as Array<{ id: number }>;
        return { monitorId: row.id, created: true };
      });
    } finally {
      for (const id of duplicateIds) retiringMonitors.delete(id);
    }

    const device = await this.getDeviceById(deviceId);
    if (!device) return null;

    const wm = getWorkerManager();
    if (wasApproved && !result.created && wm?.isRunning(result.monitorId)) {
      // Re-approval of a live device: just reload the worker (group/name may have changed).
      await restartRunningWorkers([result.monitorId]);
    } else {
      // A stale worker (e.g. a refused device's) restarts with a fresh config.
      await stopAgentWorkers([result.monitorId]);
      armAgentWorker(
        deviceId,
        result.monitorId,
        before.resolvedSettings.checkIntervalSeconds,
        device.resolvedSettings.checkIntervalSeconds,
      );
    }

    // Let a connected agent switch to its approved push interval right away.
    nudgeAgentConfig(device);

    await emitAgentMonitorChanges([result.monitorId], result.created ? [result.monitorId] : []);
    if (opts.emit !== false) emitDeviceUpdated(device);

    return device;
  },

  // ── Update device thresholds ─────────────────────────────

  /**
   * Set the threshold override of a device (stored on its agent monitor).
   * Only the metric slots present are overridden; null (or an empty object)
   * clears the override so the device inherits defaults ← group chain again.
   */
  async updateDeviceThresholds(
    deviceId: number,
    thresholds: Partial<AgentThresholds> | null,
  ): Promise<boolean> {
    const override = normalizeThresholdOverride(thresholds);
    const count = await db('monitors')
      .where({ agent_device_id: deviceId, type: 'agent' })
      .update({
        agent_thresholds: override ? JSON.stringify(override) : null,
        updated_at: new Date(),
      });
    return count > 0;
  },

  /** See resolveDeviceThresholds(). */
  async resolveDeviceThresholds(deviceId: number): Promise<DeviceThresholdsResolution | null> {
    return resolveDeviceThresholds(deviceId);
  },

  // ── Latest metrics ───────────────────────────────────────

  getLatestMetrics(deviceId: number): AgentPushSnapshot | null {
    return agentPushData.get(deviceId) ?? null;
  },

  /**
   * Reconstruct the latest AgentPushSnapshot from the most recent heartbeat in DB.
   * Used as fallback when in-memory Map is empty (e.g. after server restart).
   * The result is NOT cached in agentPushData: that map is the offline
   * watchdog's view of real pushes, and a stale DB snapshot in it would bypass
   * the worker's post-restart grace period (false DOWN after a restart).
   */
  async getMetricsFromDB(deviceId: number, tenantScope: number | null = null): Promise<AgentPushSnapshot | null> {
    // Find the agent monitor for this device (in the caller's workspace)
    const monitor = await scopeToTenant(db('monitors').where({ agent_device_id: deviceId, type: 'agent' }), tenantScope)
      .orderBy('id')
      .select('id')
      .first() as { id: number } | undefined;

    if (!monitor) return null;

    // Get the most recent heartbeat
    const hb = await db('heartbeats')
      .where({ monitor_id: monitor.id })
      .orderBy('created_at', 'desc')
      .select('status', 'message', 'value', 'created_at')
      .first() as { status: string; message: string; value: string | null; created_at: Date } | undefined;

    if (!hb || !hb.value) return null;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(hb.value);
    } catch {
      return null;
    }

    const fullMetrics = parsed._full as AgentMetrics | undefined;
    const violations = Array.isArray(parsed._violations)
      ? (parsed._violations as unknown[]).filter((v): v is string => typeof v === 'string')
      : [];

    if (!fullMetrics) return null;

    // Keys are persisted since W1-C (`_violationKeys`); older rows get a best-effort derivation.
    const storedKeys = Array.isArray(parsed._violationKeys) &&
      (parsed._violationKeys as unknown[]).length === violations.length &&
      (parsed._violationKeys as unknown[]).every(k => typeof k === 'string')
      ? parsed._violationKeys as string[]
      : null;
    const violationKeys = storedKeys ?? violations.map((v, i) => deriveViolationKey(v, i));

    return {
      monitorId: monitor.id,
      receivedAt: hb.created_at,
      metrics: fullMetrics,
      violations,
      violationKeys,
      // Derive from violations array (still serialised in `_violations`).
      // Heartbeat rows now always store reachability ('up' on push), so
      // `hb.status` no longer carries the alert flag — only the JSON value does.
      overallStatus: (violations.length > 0 ? 'alert' : 'up') as 'up' | 'alert',
    };
  },

  // ── Push endpoint logic ───────────────────────────────────

  async handlePush(
    apiKeyId: number,
    tenantId: number,
    deviceUuid: string,
    clientIp: string,
    payload: AgentPushPayload,
  ): Promise<AgentPushResponse> {
    // A frame with neither hostname nor version is a config probe (agentHub
    // sends one when a command channel opens, before the agent's own first
    // heartbeat). It may deliver config / queued commands, but must not
    // register a device, blank its metadata or record an empty metrics sample.
    const isProbe = !payload?.hostname && !payload?.agentVersion;

    let device = await this.getDeviceByUuid(deviceUuid, tenantId);

    if (!device) {
      // Device UUIDs are globally unique: one registered in another workspace
      // cannot be registered here (the INSERT would violate the constraint).
      const owner = await db('agent_devices')
        .where({ uuid: deviceUuid })
        .select('tenant_id')
        .first() as { tenant_id: number } | undefined;
      if (owner) {
        // Transferred to another workspace and still on its former key: hand
        // it the new key ('reconfigure'), only when it presents that former key.
        const reconfigure = await this.getTransferReconfigure(deviceUuid, apiKeyId);
        if (reconfigure) {
          return { status: 'pending', command: 'reconfigure', commandPayload: reconfigure };
        }
        logger.warn({ deviceUuid, tenantId }, 'Agent push rejected: device UUID is registered in another workspace');
        return { status: 'conflict', error: 'device registered in another workspace' };
      }
      if (isProbe) {
        // The agent's first real heartbeat (sent right after connecting) registers it.
        return { status: 'pending' };
      }

      // Register new device as pending
      let inserted: AgentDeviceRow | undefined;
      try {
        [inserted] = await db('agent_devices')
          .insert({
            uuid: deviceUuid,
            hostname: payload.hostname,
            ip: clientIp,
            os_info: payload.osInfo ? JSON.stringify(payload.osInfo) : null,
            agent_version: payload.agentVersion,
            device_type: payload.deviceType || 'agent',
            api_key_id: apiKeyId,
            tenant_id: tenantId,
            status: 'pending',
            check_interval_seconds: 300, // pending: check every 5min
          })
          .returning('*') as AgentDeviceRow[];
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err;
        // Unique violation: a concurrent first frame registered it (same
        // workspace), or another workspace took the UUID in the meantime.
        device = await this.getDeviceByUuid(deviceUuid, tenantId);
        if (!device) {
          logger.warn({ deviceUuid, tenantId }, 'Agent push rejected: device UUID is registered in another workspace');
          return { status: 'conflict', error: 'device registered in another workspace' };
        }
      }
      if (inserted) {
        device = rowToDevice(inserted);
        logger.info(`New agent device ${device.id} (${device.hostname}) registered — pending approval.`);
        // Approval requests show up live in the admin list.
        emitDeviceUpdated(device);
      }
    } else if (!isProbe) {
      const now = new Date();
      const metadataUpdate: Record<string, unknown> = {
        hostname: payload.hostname,
        ip: clientIp,
        agent_version: payload.agentVersion,
        os_info: payload.osInfo ? JSON.stringify(payload.osInfo) : null,
        device_type: payload.deviceType || 'agent',
        updated_at: now,
      };
      const lifecyclePatch: Partial<AgentDevice> = {};

      // Admin-paced update outcome. Success = the agent runs the target, the
      // version this server ships now (redeployed meanwhile), or any new
      // version while an update was in flight.
      const updateState = !!(device.updateRequestedAt || device.updateSentAt || device.updateErrorAt);
      const latest = updateState ? this.getAgentVersion().version : null;
      const reachedTarget = !!device.targetVersion && payload.agentVersion === device.targetVersion;
      const reachedLatest = !!latest && latest !== '0.0.0' && !!payload.agentVersion && payload.agentVersion === latest;
      const versionChanged = !!payload.agentVersion && !!device.agentVersion && payload.agentVersion !== device.agentVersion;
      const updateSucceeded = reachedTarget || reachedLatest || (!!device.updateSentAt && versionChanged);
      const updateInFlight = !!device.updateSentAt && !updateSucceeded;
      // Still pushing on the old version well after the hand-out: stop
      // suppressing alerts (update_sent_at stays, so the stuck-update cleanup
      // still turns the request into update_error 'timeout').
      const stillOnOldVersion = updateInFlight
        && Date.now() - new Date(device.updateSentAt as string).getTime() > UPDATE_GRACE_MS;
      if ((device.updateRequestedAt || device.updateSentAt) && updateSucceeded) {
        Object.assign(metadataUpdate, { update_requested_at: null, update_sent_at: null, target_version: null });
        Object.assign(lifecyclePatch, { updateRequestedAt: null, updateSentAt: null, targetVersion: null });
        logger.info(`Agent ${device.id} (${device.hostname}) updated to ${payload.agentVersion}.`);
      }
      // A failed update is cleared once the agent runs the target / latest
      // version, or any new one (after a legacy or manual update).
      if (device.updateErrorAt && (reachedTarget || reachedLatest || versionChanged)) {
        Object.assign(metadataUpdate, { update_error_at: null, update_error: null });
        Object.assign(lifecyclePatch, { updateErrorAt: null, updateError: null });
        if (!device.updateRequestedAt || updateSucceeded) {
          metadataUpdate.target_version = null;
          lifecyclePatch.targetVersion = null;
        }
      }
      // Clear updating_since (agent came back after an update) — except while
      // an update handed out by the rollout has not reached its version yet
      // and is still within its grace (the agent keeps pushing while it
      // downloads; the stuck-update cleanup turns a never-completed one into
      // update_error).
      if (device.updatingSince && (!updateInFlight || stillOnOldVersion)) {
        metadataUpdate.updating_since = null;
        lifecyclePatch.updatingSince = null;
        logger.info(stillOnOldVersion
          ? `Agent ${device.id} (${device.hostname}) still runs ${payload.agentVersion} after its update was handed out — resuming normal detection.`
          : `Agent ${device.id} (${device.hostname}) came back online after update.`);
      }
      await db('agent_devices')
        .where({ id: device.id })
        .update(metadataUpdate);

      // Apply metadata changes in-memory (avoid redundant DB round-trip)
      device = {
        ...device,
        ...lifecyclePatch,
        hostname: payload.hostname,
        ip: clientIp,
        agentVersion: payload.agentVersion ?? device.agentVersion,
        deviceType: payload.deviceType || 'agent',
        osInfo: payload.osInfo
          ? { platform: payload.osInfo.platform, distro: payload.osInfo.distro ?? null, release: payload.osInfo.release ?? null, arch: payload.osInfo.arch }
          : device.osInfo,
        updatedAt: now.toISOString(),
      };
      if (Object.keys(lifecyclePatch).length > 0) emitDeviceUpdated(device);
    }

    // After the branches above, device is always assigned (insert, race re-read or existing)
    const dev = device as AgentDevice;

    if (!isProbe) {
      // Windows NT 6.x tracking for the modern-MSI → nt6-MSI download
      // substitution of pre-nt6-line agents (services/agentNt6.service.ts).
      noteAgentHeartbeat({ ip: clientIp, deviceUuid, os: payload.osInfo ?? null });
      // Register/update device UUID with Obligate for cross-app linking (non-blocking, idempotent)
      obligateService.registerDeviceLink(deviceUuid, `/agents/${dev.id}`).catch(() => {});
    }

    // Consume the pending command BEFORE the refused / suspended early return:
    // an uninstall must reach a suspended or refused device too.
    //  - 'uninstall': delivered once; uninstall_commanded_at starts the
    //    10-minute auto-delete countdown (cleanupUninstalledDevices);
    //  - 'reconfigure': the agent already calls in with the key of its new
    //    workspace (it found the device here) — the transfer is complete;
    //  - anything else (legacy free-form commands): dropped.
    // Any call-in here is with the device's current key: a pending transfer
    // is complete, the former key stops receiving the new one.
    let command: string | undefined;
    let commandPayload: Record<string, unknown> | undefined;
    if (dev.pendingCommand) {
      const now = new Date();
      const commandUpdate: Record<string, unknown> = {
        pending_command: null,
        transfer_from_api_key_id: null,
        transfer_requested_at: null,
        updated_at: now,
      };
      if (dev.pendingCommand === 'uninstall' && dev.deviceType === 'proxy') {
        // The proxy ignores 'uninstall' (a legacy queued command): never
        // start the auto-delete countdown of a proxy that keeps running.
        commandUpdate.uninstall_requested_at = null;
        logger.warn({ deviceId: dev.id }, 'Dropping queued uninstall of a proxy device');
      } else if (dev.pendingCommand === 'uninstall') {
        command = 'uninstall';
        commandUpdate.uninstall_commanded_at = now;
        if (!dev.uninstallRequestedAt) commandUpdate.uninstall_requested_at = now;
      } else if (dev.pendingCommand === 'reconfigure') {
        logger.info(`Agent ${dev.id} (${dev.hostname}) reconfigured for its new workspace.`);
      } else {
        logger.warn({ deviceId: dev.id, command: dev.pendingCommand }, 'Dropping unsupported queued agent command');
      }
      await db('agent_devices').where({ id: dev.id }).update(commandUpdate);
      void this.emitDevicesByIds([dev.id]).catch(() => {});
    }

    // Refused / suspended devices: nothing but a queued uninstall (sent with
    // 'pending' / 202, a status every agent acts on).
    if (dev.status === 'refused' || dev.status === 'suspended') {
      return command ? { status: 'pending', command } : { status: 'unauthorized' };
    }

    // Handle pending devices — never offered an update.
    if (dev.status === 'pending') {
      return {
        status: 'pending',
        // Use resolvedSettings so group-inherited intervals are honoured.
        config: { checkIntervalSeconds: dev.resolvedSettings.checkIntervalSeconds },
        ...(command ? { command } : {}),
      };
    }

    // Device is approved → store single heartbeat
    if (dev.status === 'approved') {
      if (!isProbe) {
        await this._storeMetricsAsHeartbeat(dev, payload);
      }

      const agentBuild = typeof payload.agentBuild === 'string' ? payload.agentBuild : null;
      // A pre-nt6-line agent on Windows 7 / 2008 R2 is only told about an
      // update when the nt6 MSI can be served in place of the modern one
      // (which refuses that OS after the agent has stopped its service).
      const mayUpdate = mayOfferAgentUpdate(payload.osInfo ?? dev.osInfo, agentBuild);

      // Admin-paced update waiting for this device: hand it out now if the
      // rollout pace allows (agentUpdateRollout.claimForDevice).
      if (!command && !dev.pendingCommand && dev.updateRequestedAt && !dev.updateSentAt) {
        try {
          const claim = await agentUpdateRollout.claimForDevice(dev.id, payload.osInfo ?? dev.osInfo, agentBuild);
          if (claim?.kind === 'claimed') {
            command = 'update';
            commandPayload = { targetVersion: claim.targetVersion };
            logger.info(`Agent ${dev.id} (${dev.hostname}): update to ${claim.targetVersion} delivered.`);
          }
          if (claim) void this.emitDevicesByIds([dev.id]).catch(() => {});
        } catch (err) {
          logger.error(err, `Agent ${dev.id}: update claim failed`);
        }
      }

      // Legacy fleet-wide self-update, opt-in only (AGENT_LEGACY_AUTO_UPDATE),
      // and never for a device whose update policy is 'off' (frozen, or an
      // unresolvable policy: fail closed).
      const legacyUpdate = isLegacyAutoUpdate() && mayUpdate
        && (await agentUpdatePolicyService.resolveDevice({
          tenantId: dev.tenantId, groupId: dev.groupId, updatePolicy: dev.updatePolicy ?? null,
        })).effective.policy !== 'off';

      return {
        status: 'ok',
        // Use resolvedSettings so group-inherited intervals are honoured.
        config: { checkIntervalSeconds: dev.resolvedSettings.checkIntervalSeconds },
        ...(legacyUpdate
          ? { latestVersion: this.getAgentVersion().version, autoUpdate: true }
          : {}),
        // An admin-paced update also carries latestVersion (= its target, no
        // autoUpdate flag): agents that predate the 'update' command install
        // it through their latestVersion path.
        ...(command === 'update' && typeof commandPayload?.targetVersion === 'string'
          ? { latestVersion: commandPayload.targetVersion }
          : {}),
        ...(command ? { command } : {}),
        ...(commandPayload ? { commandPayload } : {}),
      };
    }

    return { status: 'unauthorized' };
  },

  /**
   * Evaluate all metric thresholds and store ONE heartbeat for the device's monitor.
   *
   * No notification or live alert is sent from here: AgentMonitorWorker →
   * BaseMonitorWorker is the single dispatcher for agents (maintenance windows,
   * retries, cooldown debounce, notification types, per-metric live alerts built
   * from snapshot.violationKeys).
   */
  async _storeMetricsAsHeartbeat(
    device: AgentDevice,
    payload: AgentPushPayload,
  ): Promise<void> {
    // Find the single agent monitor for this device
    const monitor = await db('monitors')
      .where({ agent_device_id: device.id, type: 'agent', is_active: true })
      .orderBy('id')
      .select('id', 'agent_thresholds', 'status')
      .first() as { id: number; agent_thresholds: unknown; status: string } | undefined;

    if (!monitor) {
      logger.warn(`No active agent monitor found for device ${device.id} (${device.hostname})`);
      return;
    }

    // Live threshold cascade, merged per metric:
    //   DEFAULT_AGENT_THRESHOLDS ← group chain (root → leaf) ← device override slots.
    // A metric present in the device override wins; every other metric follows
    // the group, so editing group thresholds re-evaluates on the next push.
    // Note: overrideGroupSettings controls checkInterval/heartbeat/maxMissedPushes only.
    const thresholds: AgentThresholds = mergeAgentThresholds(
      DEFAULT_AGENT_THRESHOLDS,
      device.groupThresholds,
      normalizeThresholdOverride(monitor.agent_thresholds),
    );
    const m: AgentMetrics = payload.metrics ?? {};

    // Evaluate each threshold and build violation list.
    // violations[i] = human-readable message, violationKeys[i] = stable metric key for client dedup.
    const violations: string[] = [];
    const violationKeys: string[] = [];

    if (thresholds.cpu.enabled && m.cpu !== undefined) {
      if (this._isThresholdExceeded(m.cpu.percent, thresholds.cpu)) {
        violations.push(`CPU: ${m.cpu.percent.toFixed(1)}% ${thresholds.cpu.op} ${thresholds.cpu.threshold}%`);
        violationKeys.push('cpu');
      }
    }

    if (thresholds.memory.enabled && m.memory !== undefined) {
      if (this._isThresholdExceeded(m.memory.percent, thresholds.memory)) {
        violations.push(`RAM: ${m.memory.percent.toFixed(1)}% ${thresholds.memory.op} ${thresholds.memory.threshold}%`);
        violationKeys.push('ram');
      }
    }

    if (thresholds.disk.enabled && m.disks) {
      for (const disk of m.disks) {
        if (this._isThresholdExceeded(disk.percent, thresholds.disk)) {
          const diskName = device.displayConfig?.drives?.renames?.[disk.mount] ?? disk.mount;
          violations.push(`Disk ${diskName}: ${disk.percent.toFixed(1)}% ${thresholds.disk.op} ${thresholds.disk.threshold}%`);
          violationKeys.push(`disk:${disk.mount}`); // raw mount (stable, not affected by rename)
        }
      }
    }

    if (thresholds.netIn.enabled && m.network !== undefined) {
      if (this._isThresholdExceeded(m.network.inBytesPerSec, thresholds.netIn)) {
        // Convert bytes/sec → Mbps (1 Mbps = 125 000 bytes/sec)
        const current = (m.network.inBytesPerSec / 125_000).toFixed(1);
        const limit   = (thresholds.netIn.threshold  / 125_000).toFixed(0);
        violations.push(`Net In: ${current} Mbps ${thresholds.netIn.op} ${limit} Mbps`);
        violationKeys.push('net_in');
      }
    }

    if (thresholds.netOut.enabled && m.network !== undefined) {
      if (this._isThresholdExceeded(m.network.outBytesPerSec, thresholds.netOut)) {
        const current = (m.network.outBytesPerSec / 125_000).toFixed(1);
        const limit   = (thresholds.netOut.threshold / 125_000).toFixed(0);
        violations.push(`Net Out: ${current} Mbps ${thresholds.netOut.op} ${limit} Mbps`);
        violationKeys.push('net_out');
      }
    }

    // Temperature thresholds: global + per-sensor overrides
    if (thresholds.temp?.globalEnabled) {
      const tempT = thresholds.temp;
      // Gather all sensors: regular temps + GPU temps
      const sensors: Array<{ key: string; label: string; celsius: number }> = [];
      if (m.temps) {
        for (const s of m.temps) {
          sensors.push({ key: `temp:${s.label}`, label: s.label, celsius: s.celsius });
        }
      }
      if (m.gpus) {
        m.gpus.forEach((gpu, i) => {
          if (gpu.tempCelsius !== undefined) {
            sensors.push({
              key: `gpu:${i}:${gpu.model}`,
              label: `GPU ${i} – ${gpu.model}`,
              celsius: gpu.tempCelsius,
            });
          }
        });
      }
      for (const sensor of sensors) {
        const override = tempT.overrides?.[sensor.key];
        // Per-sensor override active → use its settings; otherwise fall back to global
        const active = override?.enabled
          ? { op: override.op, threshold: override.threshold }
          : { op: tempT.op, threshold: tempT.threshold };
        if (this._isThresholdExceeded(sensor.celsius, active)) {
          const displayLabel = device.sensorDisplayNames?.[sensor.key] ?? prettifySensorLabel(sensor.label);
          violations.push(
            `Temp ${displayLabel}: ${sensor.celsius.toFixed(1)}°C ${active.op} ${active.threshold}°C`,
          );
          violationKeys.push(sensor.key); // already stable: "temp:CPU Package", "gpu:0:RTX 4090", etc.
        }
      }
    }

    const overallStatus: 'up' | 'alert' = violations.length > 0 ? 'alert' : 'up';
    const message = violations.length > 0 ? violations.join('; ') : 'All metrics OK';

    // Update in-memory snapshot
    const snapshot: AgentPushSnapshot = {
      monitorId: monitor.id,
      receivedAt: new Date(),
      metrics: m,
      violations,
      violationKeys,
      overallStatus,
    };
    agentPushData.set(device.id, snapshot);

    // End of an approval / reinstatement grace: the first push starts the
    // offline watchdog. Only monitors armed by armAgentWorker() are started
    // here — never a monitor MonitorWorkerManager.startAll() may be starting
    // concurrently at boot. Awaited BEFORE the status write below, so the
    // worker's first beat starts from 'pending' and treats an initial alert
    // as a real transition.
    if (monitor.status !== 'paused' && scheduledWorkerStarts.has(monitor.id)) {
      await ensureAgentWorker(monitor.id);
    }

    // ── Emit real-time updates FIRST (before DB writes) for lowest latency ──
    // Scoped to the device's tenant only — the previous role:admin fan-out
    // leaked full CPU/memory/disks/network/temps payloads to every admin in
    // every tenant on every push (~10-60 MB/min cross-tenant).
    // Team members with access to the agent monitor get them too (user rooms).
    if (_io) {
      emitToAgentAudience(device.tenantId, monitor.id, 'agentPush', {
        deviceId: device.id,
        monitorId: monitor.id,
        agentVersion: payload.agentVersion,
        metrics: m,
        violations,
        overallStatus,
        receivedAt: snapshot.receivedAt.toISOString(),
      });
      // A paused monitor stays paused (its status is not written below either).
      if (monitor.status !== 'paused') {
        emitToAgentAudience(device.tenantId, monitor.id, SOCKET_EVENTS.MONITOR_STATUS_CHANGE, {
          monitorId: monitor.id,
          newStatus: overallStatus,
        });
      }
      emitToAgentAudience(device.tenantId, monitor.id, SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
        deviceId: device.id,
        status: overallStatus,
        violations,
        violationKeys,
      });
    }

    // ── DB persistence (fire-and-forget — errors logged, don't block response) ──
    const heartbeatValue = JSON.stringify({
      cpu: m.cpu?.percent,
      memory: m.memory?.percent,
      disks: m.disks?.map(d => ({ mount: d.mount, percent: d.percent })),
      netIn: m.network?.inBytesPerSec,
      netOut: m.network?.outBytesPerSec,
      loadAvg: m.loadAvg,
      _full: m,
      _violations: violations,
      _violationKeys: violationKeys,
    });

    Promise.all([
      // The arrival of a push proves the agent is reachable — write 'up' to
      // the heartbeat row regardless of threshold violations.  The monitor's
      // persisted status (below) keeps `overallStatus` so the dashboard pill
      // and sidebar badge still light up orange on alert.
      heartbeatService.create({
        monitorId: monitor.id,
        status: 'up',
        message,
        value: heartbeatValue,
      }).then(heartbeat => {
        // Emit MONITOR_HEARTBEAT after insert so the heartbeat has an id/timestamp
        // — tenant-scoped, same reasoning as the block above.
        if (_io) {
          // monitorStatus = the monitor's logical status: the heartbeat row is
          // always 'up', but an agent over a threshold stays 'alert'.
          emitToAgentAudience(device.tenantId, monitor.id, SOCKET_EVENTS.MONITOR_HEARTBEAT, {
            monitorId: monitor.id,
            heartbeat,
            monitorStatus: monitor.status === 'paused' ? 'paused' : overallStatus,
          });
        }
      }),
      // A paused monitor stays paused (pushes still feed the metrics view).
      monitor.status === 'paused'
        ? Promise.resolve()
        : db('monitors')
          .where({ id: monitor.id })
          .update({ status: overallStatus, updated_at: new Date() }),
    ]).catch(err => logger.error(err, `Failed to persist heartbeat/status for device ${device.id}`));
  },

  /**
   * Returns true if the threshold condition is triggered (i.e. metric is in violation).
   */
  _isThresholdExceeded(value: number, t: { threshold: number; op: string }): boolean {
    switch (t.op) {
      case '>':  return value > t.threshold;
      case '<':  return value < t.threshold;
      case '>=': return value >= t.threshold;
      case '<=': return value <= t.threshold;
      default:   return false;
    }
  },

  // ── Version / download endpoints ─────────────────────────

  getAgentVersion(): { version: string } {
    // 1. Try agent/VERSION (plain text "X.Y.Z\n") — present in both dev and prod
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../agent/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `var agentVersion = "x.y.z"` from agent/main.go
    // (main.go now uses `var agentVersion = "dev"` as default — skip "dev")
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../agent/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+agentVersion\s*=\s*"([^"]+)"/);
      if (match?.[1] && match[1] !== 'dev') return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },

  /**
   * Mark a device as "updating" — called when the agent notifies us it is
   * about to self-update.  Sets updating_since to NOW() and emits the
   * AGENT_STATUS_CHANGED event so the UI shows the "UPDATING" badge immediately.
   */
  async setDeviceUpdating(deviceId: number, tenantId: number): Promise<void> {
    await db('agent_devices')
      .where({ id: deviceId })
      .update({ updating_since: new Date(), updated_at: new Date() });

    const device = await db('agent_devices').where({ id: deviceId }).select('hostname', 'name').first() as
      { hostname: string; name: string | null } | undefined;
    const label = device?.name ?? device?.hostname ?? `#${deviceId}`;
    logger.info(`Agent ${deviceId} (${label}) is self-updating.`);

    // Notify connected admins in this tenant immediately (and the team
    // members who can see the agent monitor).
    if (_io && tenantId) {
      const payload = { deviceId, status: 'updating', violations: [], violationKeys: [] };
      const monitor = await db('monitors')
        .where({ agent_device_id: deviceId, type: 'agent' })
        .orderBy('id')
        .select('id')
        .first() as { id: number } | undefined;
      if (monitor) emitToAgentAudience(tenantId, monitor.id, SOCKET_EVENTS.AGENT_STATUS_CHANGED, payload);
      else emitToAgentManagers(tenantId, SOCKET_EVENTS.AGENT_STATUS_CHANGED, payload);
    }
    // Full device (runtimeStatus 'updating') for the lists and the detail page.
    await this.emitDevicesByIds([deviceId]);

    // Send "update" notification if the update type is enabled for this device
    notificationService.sendForAgent(deviceId, label, 'updating', 'up', [], 'update').catch(
      (err) => logger.error(err, `Failed to send update notification for device ${deviceId}`),
    );
  },

  /**
   * Cleanup job: devices stuck in the updating state for more than 10
   * minutes (no push with the target version) get update_error ('timeout'):
   * updating_since and the outstanding rollout request are cleared (the
   * device's slot frees; target_version is kept for display) and the normal
   * offline detection takes over. Each affected device is emitted.
   */
  async cleanupStuckUpdating(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 10 * 60 * 1000); // 10 minutes ago
    // Stuck: in 'updating' for 10 minutes, or an update handed out 10
    // minutes ago that never completed (the agent kept pushing on its old
    // version, so handlePush already cleared updating_since).
    const rows = await db('agent_devices')
      .where((w) => w
        .where('updating_since', '<', cutoff)
        .orWhere((q) => q
          .where('update_sent_at', '<', cutoff)
          .where((u) => u.whereNull('updating_since').orWhere('updating_since', '<', cutoff))))
      .update({
        updating_since: null,
        update_requested_at: null,
        update_sent_at: null,
        update_error_at: now,
        update_error: 'timeout',
        updated_at: now,
      })
      .returning(['id', 'hostname', 'name']) as { id: number; hostname: string; name: string | null }[];

    if (rows.length === 0) return;

    for (const row of rows) {
      const label = row.name ?? row.hostname;
      logger.warn(`Agent ${row.id} (${label}) update timed out — marked update_error, resuming offline detection.`);
    }
    logger.info(`Agent updating cleanup: ${rows.length} stuck update(s) marked as failed.`);
    await this.emitDevicesByIds(rows.map((r) => r.id));
  },

  getDesktopVersion(): { version: string } {
    // 1. Try obli.tools/VERSION (plain text "X.Y.Z\n")
    try {
      const versionFilePath = path.resolve(__dirname, '../../../../obli.tools/VERSION');
      const v = fs.readFileSync(versionFilePath, 'utf-8').trim();
      if (v) return { version: v };
    } catch { /* not found, try next */ }

    // 2. Dev fallback: parse `const appVersion = "x.y.z"` from obli.tools/main.go
    try {
      const mainGoPath = path.resolve(__dirname, '../../../../obli.tools/main.go');
      const content = fs.readFileSync(mainGoPath, 'utf-8');
      const match = content.match(/(?:var|const)\s+appVersion\s*=\s*"([^"]+)"/);
      if (match?.[1]) return { version: match[1] };
    } catch { /* not found */ }

    return { version: '0.0.0' };
  },
};
