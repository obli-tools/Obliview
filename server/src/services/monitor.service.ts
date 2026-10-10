import { db } from '../db';
import type { Monitor, AgentThresholds } from '@obliview/shared';
import { PROXY_SUPPORTED_TYPES, isProxySupportedType } from '@obliview/shared';
import { generateToken } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';

/**
 * Verifies that the given proxy agent device belongs to the expected tenant
 * and can run checks of the given monitor type.
 * Throws 403 AppError on tenant mismatch or missing device (prevents
 * cross-tenant RCE / SSRF via forged `proxyAgentDeviceId` in monitor payloads)
 * and 400 when the device kind (agent_devices.device_type) does not support
 * the monitor type (see PROXY_SUPPORTED_TYPES).
 */
async function assertProxyDeviceInTenant(
  proxyAgentDeviceId: number,
  tenantId: number,
  monitorType: string,
): Promise<void> {
  const row = await db('agent_devices')
    .where({ id: proxyAgentDeviceId })
    .select('tenant_id', 'device_type')
    .first() as { tenant_id: number; device_type: string | null } | undefined;
  if (!row || row.tenant_id !== tenantId) {
    throw new AppError(403, 'Invalid proxy agent device');
  }
  if (!isProxySupportedType(row.device_type, monitorType)) {
    const kind = row.device_type === 'proxy' ? 'proxy' : 'agent';
    throw new AppError(
      400,
      `Monitor type "${monitorType}" cannot run on this ${kind} device ` +
      `(supported: ${PROXY_SUPPORTED_TYPES[kind].join(', ')})`,
      'PROXY_TYPE_UNSUPPORTED',
    );
  }
}

/**
 * Agent monitors are bound to their agent device: their type cannot change
 * and no other monitor can become one (see validators/monitor.schema.ts).
 */
function assertAgentTypeUnchanged(currentType: string, nextType: string | undefined): void {
  if (nextType === undefined || nextType === currentType) return;
  if (currentType === 'agent' || nextType === 'agent') {
    throw new AppError(400, 'The type of an agent monitor cannot be changed, and no monitor can become an agent monitor', 'AGENT_TYPE_LOCKED');
  }
}

/**
 * An agent monitor lives in its device's group (agent_devices.group_id is the
 * source of truth, mirrored to the monitor by agentService). Moving the
 * monitor alone would split the two placements.
 */
function assertNotAgentMove(currentType: string, currentGroupId: number | null, nextGroupId: number | null | undefined): void {
  if (currentType !== 'agent' || nextGroupId === undefined) return;
  if ((nextGroupId ?? null) !== (currentGroupId ?? null)) {
    throw new AppError(409, 'Move the agent device instead', 'AGENT_MONITOR_MOVE');
  }
}

/**
 * Verifies that the given group belongs to the expected tenant. Throws 403
 * AppError on mismatch or missing group. Prevents attaching a monitor to
 * another tenant's group (which would inherit that tenant's notification
 * channels, remediations and settings through the closure chain).
 */
async function assertGroupInTenant(groupId: number, tenantId: number): Promise<void> {
  const row = await db('monitor_groups')
    .where({ id: groupId })
    .select('tenant_id')
    .first() as { tenant_id: number } | undefined;
  if (!row || row.tenant_id !== tenantId) {
    throw new AppError(403, 'Invalid group');
  }
}

// Database row → API model
interface MonitorRow {
  id: number;
  tenant_id: number;
  name: string;
  description: string | null;
  type: string;
  group_id: number | null;
  is_active: boolean;
  status: string;
  interval_seconds: number | null;
  retry_interval_seconds: number | null;
  max_retries: number | null;
  timeout_ms: number | null;
  upside_down: boolean;
  url: string | null;
  method: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  expected_status_codes: number[] | null;
  keyword: string | null;
  keyword_is_present: boolean | null;
  ignore_ssl: boolean;
  json_path: string | null;
  json_expected_value: string | null;
  hostname: string | null;
  port: number | null;
  dns_record_type: string | null;
  dns_resolver: string | null;
  dns_expected_value: string | null;
  ssl_warn_days: number | null;
  smtp_host: string | null;
  smtp_port: number | null;
  docker_host: string | null;
  docker_container_name: string | null;
  game_type: string | null;
  game_host: string | null;
  game_port: number | null;
  push_token: string | null;
  push_max_interval_sec: number | null;
  script_command: string | null;
  script_expected_exit: number | null;
  browser_url: string | null;
  browser_keyword: string | null;
  browser_keyword_is_present: boolean | null;
  browser_wait_for_selector: string | null;
  browser_screenshot_on_failure: boolean;
  value_watcher_url: string | null;
  value_watcher_json_path: string | null;
  value_watcher_operator: string | null;
  value_watcher_threshold: number | null;
  value_watcher_threshold_max: number | null;
  value_watcher_previous_value: string | null;
  value_watcher_headers: Record<string, string> | null;
  // Agent Monitor
  agent_device_id: number | null;
  agent_device_name?: string | null;  // from LEFT JOIN with agent_devices (read queries only)
  agent_thresholds: AgentThresholds | null;
  // Proxy Agent
  proxy_agent_device_id: number | null;
  created_by: number | null;
  created_at: Date;
  updated_at: Date;
}

/** Base query that LEFT JOINs agent_devices to populate agent_device_name. */
function monitorBaseQuery(tenantId?: number) {
  const q = db('monitors')
    .leftJoin('agent_devices as ad', 'monitors.agent_device_id', 'ad.id')
    .select<MonitorRow[]>('monitors.*', db.raw('ad.name as agent_device_name'));
  if (tenantId !== undefined) {
    q.where('monitors.tenant_id', tenantId);
  }
  return q;
}

function rowToMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    type: row.type as Monitor['type'],
    groupId: row.group_id,
    isActive: row.is_active,
    status: row.status as Monitor['status'],
    // Legacy timing columns are no longer the source (migration 061): never
    // echo their stale values (a GET-modify-PUT would turn them into
    // overrides). Timing: GET /api/settings/monitor/:id.
    intervalSeconds: null,
    retryIntervalSeconds: null,
    maxRetries: null,
    timeoutMs: null,
    upsideDown: row.upside_down,
    url: row.url,
    method: row.method,
    headers: row.headers,
    body: row.body,
    expectedStatusCodes: row.expected_status_codes,
    keyword: row.keyword,
    keywordIsPresent: row.keyword_is_present,
    ignoreSsl: row.ignore_ssl,
    jsonPath: row.json_path,
    jsonExpectedValue: row.json_expected_value,
    hostname: row.hostname,
    port: row.port,
    dnsRecordType: row.dns_record_type,
    dnsResolver: row.dns_resolver,
    dnsExpectedValue: row.dns_expected_value,
    sslWarnDays: row.ssl_warn_days,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    dockerHost: row.docker_host,
    dockerContainerName: row.docker_container_name,
    gameType: row.game_type,
    gameHost: row.game_host,
    gamePort: row.game_port,
    pushToken: row.push_token,
    pushMaxIntervalSec: row.push_max_interval_sec,
    scriptCommand: row.script_command,
    scriptExpectedExit: row.script_expected_exit,
    browserUrl: row.browser_url,
    browserKeyword: row.browser_keyword,
    browserKeywordIsPresent: row.browser_keyword_is_present,
    browserWaitForSelector: row.browser_wait_for_selector,
    browserScreenshotOnFailure: row.browser_screenshot_on_failure,
    valueWatcherUrl: row.value_watcher_url,
    valueWatcherJsonPath: row.value_watcher_json_path,
    valueWatcherOperator: row.value_watcher_operator,
    valueWatcherThreshold: row.value_watcher_threshold,
    valueWatcherThresholdMax: row.value_watcher_threshold_max,
    valueWatcherPreviousValue: row.value_watcher_previous_value,
    valueWatcherHeaders: typeof row.value_watcher_headers === 'string' ? JSON.parse(row.value_watcher_headers) : row.value_watcher_headers,
    // Agent Monitor
    agentDeviceId: row.agent_device_id,
    agentDeviceName: row.agent_device_name ?? null,
    agentThresholds: row.agent_thresholds ?? null,
    // Proxy Agent
    proxyAgentDeviceId: row.proxy_agent_device_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// API model → database columns (camelCase → snake_case)
function monitorToRow(data: Partial<Monitor>): Record<string, unknown> {
  const map: Record<string, unknown> = {};

  if (data.name !== undefined) map.name = data.name;
  if (data.description !== undefined) map.description = data.description;
  if (data.type !== undefined) map.type = data.type;
  if (data.groupId !== undefined) map.group_id = data.groupId;
  if (data.isActive !== undefined) map.is_active = data.isActive;
  if (data.status !== undefined) map.status = data.status;
  // intervalSeconds / retryIntervalSeconds / maxRetries / timeoutMs are not
  // written: timing lives in monitor-scope settings (migration 061), the
  // monitors controller translates them (monitorTiming.service).
  if (data.upsideDown !== undefined) map.upside_down = data.upsideDown;
  if (data.url !== undefined) map.url = data.url;
  if (data.method !== undefined) map.method = data.method;
  if (data.headers !== undefined) map.headers = data.headers ? JSON.stringify(data.headers) : null;
  if (data.body !== undefined) map.body = data.body;
  if (data.expectedStatusCodes !== undefined) map.expected_status_codes = data.expectedStatusCodes;
  if (data.keyword !== undefined) map.keyword = data.keyword;
  if (data.keywordIsPresent !== undefined) map.keyword_is_present = data.keywordIsPresent;
  if (data.ignoreSsl !== undefined) map.ignore_ssl = data.ignoreSsl;
  if (data.jsonPath !== undefined) map.json_path = data.jsonPath;
  if (data.jsonExpectedValue !== undefined) map.json_expected_value = data.jsonExpectedValue;
  if (data.hostname !== undefined) map.hostname = data.hostname;
  if (data.port !== undefined) map.port = data.port;
  if (data.dnsRecordType !== undefined) map.dns_record_type = data.dnsRecordType;
  if (data.dnsResolver !== undefined) map.dns_resolver = data.dnsResolver;
  if (data.dnsExpectedValue !== undefined) map.dns_expected_value = data.dnsExpectedValue;
  if (data.sslWarnDays !== undefined) map.ssl_warn_days = data.sslWarnDays;
  if (data.smtpHost !== undefined) map.smtp_host = data.smtpHost;
  if (data.smtpPort !== undefined) map.smtp_port = data.smtpPort;
  if (data.dockerHost !== undefined) map.docker_host = data.dockerHost;
  if (data.dockerContainerName !== undefined) map.docker_container_name = data.dockerContainerName;
  if (data.gameType !== undefined) map.game_type = data.gameType;
  if (data.gameHost !== undefined) map.game_host = data.gameHost;
  if (data.gamePort !== undefined) map.game_port = data.gamePort;
  if (data.pushMaxIntervalSec !== undefined) map.push_max_interval_sec = data.pushMaxIntervalSec;
  if (data.scriptCommand !== undefined) map.script_command = data.scriptCommand;
  if (data.scriptExpectedExit !== undefined) map.script_expected_exit = data.scriptExpectedExit;
  if (data.browserUrl !== undefined) map.browser_url = data.browserUrl;
  if (data.browserKeyword !== undefined) map.browser_keyword = data.browserKeyword;
  if (data.browserKeywordIsPresent !== undefined) map.browser_keyword_is_present = data.browserKeywordIsPresent;
  if (data.browserWaitForSelector !== undefined) map.browser_wait_for_selector = data.browserWaitForSelector;
  if (data.browserScreenshotOnFailure !== undefined) map.browser_screenshot_on_failure = data.browserScreenshotOnFailure;
  if (data.valueWatcherUrl !== undefined) map.value_watcher_url = data.valueWatcherUrl;
  if (data.valueWatcherJsonPath !== undefined) map.value_watcher_json_path = data.valueWatcherJsonPath;
  if (data.valueWatcherOperator !== undefined) map.value_watcher_operator = data.valueWatcherOperator;
  if (data.valueWatcherThreshold !== undefined) map.value_watcher_threshold = data.valueWatcherThreshold;
  if (data.valueWatcherThresholdMax !== undefined) map.value_watcher_threshold_max = data.valueWatcherThresholdMax;
  if (data.valueWatcherPreviousValue !== undefined) map.value_watcher_previous_value = data.valueWatcherPreviousValue;
  if (data.valueWatcherHeaders !== undefined) map.value_watcher_headers = data.valueWatcherHeaders ? JSON.stringify(data.valueWatcherHeaders) : null;
  // Agent Monitor
  if (data.agentDeviceId !== undefined) map.agent_device_id = data.agentDeviceId;
  if (data.agentThresholds !== undefined) map.agent_thresholds = data.agentThresholds ? JSON.stringify(data.agentThresholds) : null;
  // Proxy Agent
  if (data.proxyAgentDeviceId !== undefined) map.proxy_agent_device_id = data.proxyAgentDeviceId;

  return map;
}

/**
 * Tenant scope of a by-id helper:
 *   - number    → only rows of that tenant (WHERE id AND tenant_id);
 *   - null      → God View (platform admin on the master tenant), no filter;
 *   - undefined → no filter either. UNSAFE without tenant scope: reserved to
 *                 workers, jobs and callers that already resolved the tenant.
 */
export type TenantScope = number | null | undefined;

export const monitorService = {
  async getAll(tenantId: number | null): Promise<Monitor[]> {
    const rows = await monitorBaseQuery(tenantId ?? undefined).orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  async getByIds(ids: number[], tenantId?: number): Promise<Monitor[]> {
    if (ids.length === 0) return [];
    const rows = await monitorBaseQuery(tenantId).whereIn('monitors.id', ids).orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  // UNSAFE without tenant scope — worker manager only.
  async getAllActive(): Promise<Monitor[]> {
    const rows = await monitorBaseQuery()
      .where({ 'monitors.is_active': true })
      .whereNot({ 'monitors.status': 'paused' })
      .orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  /** `tenantScope` omitted: UNSAFE without tenant scope (workers / jobs only). */
  async getById(id: number, tenantScope?: number | null): Promise<Monitor | null> {
    const row = await monitorBaseQuery(tenantScope ?? undefined).where({ 'monitors.id': id }).first();
    if (!row) return null;
    return rowToMonitor(row);
  },

  /** Monitors attached to any of the given groups, restricted to one tenant. */
  async getByGroupIds(groupIds: number[], tenantId: number): Promise<Monitor[]> {
    if (groupIds.length === 0) return [];
    const rows = await monitorBaseQuery(tenantId).whereIn('monitors.group_id', groupIds).orderBy('monitors.name');
    return rows.map(rowToMonitor);
  },

  /** Id of the agent monitor backing an agent device of the given tenant (null when none). */
  async getAgentMonitorIdForDevice(deviceId: number, tenantId: number): Promise<number | null> {
    const row = await db('monitors')
      .where({ agent_device_id: deviceId, type: 'agent', tenant_id: tenantId })
      .first('id') as { id: number } | undefined;
    return row?.id ?? null;
  },

  /** Keep only the monitor ids that belong to the given tenant (null = no filter, God View). */
  async filterIdsByTenant(ids: number[], tenantId: number | null): Promise<number[]> {
    if (ids.length === 0 || tenantId === null) return ids;
    const rows = await db('monitors')
      .whereIn('id', ids)
      .where({ tenant_id: tenantId })
      .select('id') as { id: number }[];
    return rows.map((r) => r.id);
  },

  async create(data: Partial<Monitor>, createdBy: number, tenantId: number): Promise<Monitor> {
    // Cross-tenant check: proxy agent device must belong to the monitor's tenant
    // and support the monitor type.
    if (data.proxyAgentDeviceId) {
      await assertProxyDeviceInTenant(data.proxyAgentDeviceId, tenantId, data.type ?? '');
    }
    // Cross-tenant check: the target group must belong to the monitor's tenant.
    if (data.groupId) {
      await assertGroupInTenant(data.groupId, tenantId);
    }

    const rowData = monitorToRow(data);
    rowData.created_by = createdBy;
    rowData.tenant_id = tenantId;

    // Generate push token for push monitors
    if (data.type === 'push') {
      rowData.push_token = generateToken(16);
    }

    const [row] = await db<MonitorRow>('monitors').insert(rowData).returning('*');
    return rowToMonitor(row);
  },

  /** `tenantScope` omitted: UNSAFE without tenant scope (workers / jobs only). */
  async update(id: number, data: Partial<Monitor>, tenantScope?: number | null): Promise<Monitor | null> {
    if (typeof tenantScope === 'number') {
      const owned = await db('monitors').where({ id, tenant_id: tenantScope }).first('id');
      if (!owned) return null;
    }

    // When the type, proxy device or group is being set, fetch the current row:
    //  - agent monitors keep their type and their group (the device owns it);
    //  - the proxy device must be in the monitor's tenant and support its type;
    //  - the target group must be in the monitor's tenant.
    if (data.proxyAgentDeviceId || data.groupId !== undefined || data.type !== undefined) {
      const current = await db('monitors')
        .where({ id })
        .select('tenant_id', 'group_id', 'type', 'proxy_agent_device_id')
        .first() as
        { tenant_id: number; group_id: number | null; type: string; proxy_agent_device_id: number | null } | undefined;
      if (!current) return null;

      assertAgentTypeUnchanged(current.type, data.type);
      assertNotAgentMove(current.type, current.group_id, data.groupId);

      // Proxy device for the resulting row: the newly assigned one, or the
      // current one when only the type changes (null = proxy being cleared).
      const nextProxyId = data.proxyAgentDeviceId !== undefined
        ? data.proxyAgentDeviceId
        : (data.type !== undefined ? current.proxy_agent_device_id : null);
      if (nextProxyId) {
        await assertProxyDeviceInTenant(nextProxyId, current.tenant_id, data.type ?? current.type);
      }
      if (data.groupId && data.groupId !== current.group_id) await assertGroupInTenant(data.groupId, current.tenant_id);
    }

    const rowData = monitorToRow(data);
    rowData.updated_at = new Date();

    const updateQuery = db<MonitorRow>('monitors').where({ id });
    if (typeof tenantScope === 'number') updateQuery.where({ tenant_id: tenantScope });
    const [row] = await updateQuery
      .update(rowData)
      .returning('*');

    if (!row) return null;
    return rowToMonitor(row);
  },

  /** `tenantScope` omitted: UNSAFE without tenant scope (workers / jobs only). */
  async delete(id: number, tenantScope?: number | null): Promise<boolean> {
    const q = db('monitors').where({ id });
    if (typeof tenantScope === 'number') q.where({ tenant_id: tenantScope });
    const count = await q.del();
    return count > 0;
  },

  /**
   * `tenantScope` (number) restricts the update to that tenant's rows —
   * callers filter the ids first (filterIdsByTenant) and reject foreign ones.
   * Omitted: UNSAFE without tenant scope.
   */
  async bulkUpdate(monitorIds: number[], changes: Partial<Monitor>, tenantScope?: number | null): Promise<Monitor[]> {
    if (monitorIds.length === 0) return [];
    const inScope = () => {
      const q = db('monitors').whereIn('id', monitorIds);
      if (typeof tenantScope === 'number') q.where({ tenant_id: tenantScope });
      return q;
    };
    if (changes.type !== undefined || changes.groupId !== undefined || changes.proxyAgentDeviceId) {
      const currents = await inScope()
        .select('id', 'tenant_id', 'type', 'group_id', 'proxy_agent_device_id') as {
          id: number; tenant_id: number; type: string; group_id: number | null; proxy_agent_device_id: number | null;
        }[];

      // Agent monitors keep their type and their group (the device owns it).
      for (const current of currents) {
        assertAgentTypeUnchanged(current.type, changes.type);
        assertNotAgentMove(current.type, current.group_id, changes.groupId);
      }

      // Every resulting (proxy device, monitor type) pair must be runnable:
      // a newly assigned device for all rows, or a type change on rows that
      // keep their current proxy device.
      const proxyChecks = new Map<string, { deviceId: number; type: string }>();
      for (const current of currents) {
        const deviceId = changes.proxyAgentDeviceId !== undefined
          ? changes.proxyAgentDeviceId
          : (changes.type !== undefined ? current.proxy_agent_device_id : null);
        if (!deviceId) continue;
        const type = changes.type ?? current.type;
        proxyChecks.set(`${deviceId}:${type}`, { deviceId, type });
      }

      // Cross-tenant check: ensure all target monitors share the device's / group's tenant.
      if (changes.groupId || proxyChecks.size > 0) {
        const tenantIds = [...new Set(currents.map((c) => c.tenant_id))];
        if (tenantIds.length !== 1) {
          throw new AppError(400, proxyChecks.size > 0
            ? 'Cannot bulk-assign proxy agent across multiple tenants'
            : 'Cannot bulk-assign group across multiple tenants');
        }
        for (const { deviceId, type } of proxyChecks.values()) {
          await assertProxyDeviceInTenant(deviceId, tenantIds[0], type);
        }
        if (changes.groupId) await assertGroupInTenant(changes.groupId, tenantIds[0]);
      }
    }

    const rowData = monitorToRow(changes);
    rowData.updated_at = new Date();

    const rows = await inScope()
      .update(rowData)
      .returning('*') as MonitorRow[];

    return rows.map(rowToMonitor);
  },

  /** `tenantScope` omitted: UNSAFE without tenant scope (BaseMonitorWorker). */
  async updateStatus(id: number, status: string, tenantScope?: number | null): Promise<boolean> {
    const q = db('monitors').where({ id });
    if (typeof tenantScope === 'number') q.where({ tenant_id: tenantScope });
    const count = await q.update({ status, updated_at: new Date() });
    return count > 0;
  },
};
