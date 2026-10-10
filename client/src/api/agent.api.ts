import apiClient from './client';
import type {
  AgentApiKey, AgentDevice, AgentDisplayConfig, AgentThresholds, AgentUpdatePolicy, AgentUpdateRequestResult,
  ApiResponse, NotificationTypeConfig,
} from '@obliview/shared';
import type { AgentPushSnapshot } from '../types/agent';

/**
 * GET /agent/devices/:id/thresholds-resolved.
 * The device override is sparse: a metric key present in `override` wins over
 * the group chain, every other key is inherited live from `groupResolved`.
 */
export interface ResolvedAgentThresholds {
  /** Effective thresholds used at push time (DEFAULT <- group chain <- device override). */
  resolved: AgentThresholds;
  /** Device-level override slots (null = everything inherited from the group). */
  override: Partial<AgentThresholds> | null;
  /** What the device gets without any override (DEFAULT <- group chain). */
  groupResolved: AgentThresholds;
}

/** What the caller may do on a device (computed by the server). */
export interface AgentDeviceAccess {
  /** RW on the agent monitor: name, notes, display config, sensor names, thresholds. */
  canWrite: boolean;
  /** Platform admin or agents.manage: lifecycle, group, monitoring settings, notification types. */
  canManage: boolean;
}

/** GET /agent/devices/:id — the device plus its agent monitor and the caller's access. */
export type AgentDeviceDetail = AgentFleetDevice & {
  /** The device's agent monitor (null for a device without one). */
  monitorId?: number | null;
  access?: AgentDeviceAccess;
};

/**
 * Runtime status of a device (W4-B, derived server-side from the agent
 * monitor status, updating_since, update_error_at, uninstall_commanded_at,
 * maintenance and suspension). Distinct from the approval status
 * (AgentDevice.status = approvalStatus).
 */
export type AgentRuntimeStatus =
  | 'online'
  | 'offline'
  | 'alert'
  | 'maintenance'
  | 'updating'
  | 'update_error'
  | 'pending_uninstall'
  | 'suspended';

export type AgentApprovalStatus = AgentDevice['status'];

/**
 * Fleet fields served by listDevices / getDevice since W4-B. All optional so
 * the client keeps working against an older server (the UI then derives what
 * it can, see deviceRuntimeStatus in components/agent/DeviceStatusBadge).
 */
export interface AgentFleetFields {
  runtimeStatus?: AgentRuntimeStatus | null;
  approvalStatus?: AgentApprovalStatus;
  /** Set when the last paced update did not come back in time. */
  updateErrorAt?: string | null;
  /** Agent version an update was requested to (admin-paced updates). */
  targetVersion?: string | null;
  updateRequestedAt?: string | null;
}

/** A device as the fleet UI sees it (shared AgentDevice + W4-B fleet fields). */
export type AgentFleetDevice = AgentDevice & AgentFleetFields;

/** An API key with its default group (W4-B: agent_api_keys.default_group_id). */
export type AgentApiKeyWithDefault = AgentApiKey & {
  defaultGroupId?: number | null;
  defaultGroupName?: string | null;
};

/** POST /agent/update-all {preview: true}: what an "update all" would do. */
export interface AgentUpdateRolloutPreview {
  /** Version the outdated agents would be moved to (null = unknown on the server). */
  latestVersion?: string | null;
  /** Outdated approved devices an update-all would queue. */
  targets?: number;
  /** Updates already waiting (one outstanding update per device). */
  alreadyQueued?: number;
  /** Updates handed out and not completed yet. */
  inProgress?: number;
  /** Devices whose last update failed. */
  failed?: number;
  /** Updates handed out per window (server setting, fleet-wide). */
  pace?: number;
  /** Length of a rollout window, in seconds. */
  windowSeconds?: number;
  /** Outdated devices whose update policy is 'off' (frozen, not in targets). */
  frozen?: number;
  /** Outdated devices whose update policy is 'auto' (queued automatically). */
  auto?: number;
}

/**
 * Server shape (shared AgentUpdateRolloutState): `pace` is an object and the
 * waiting updates are `queued`. Normalised to the flat preview the UI reads.
 */
type RawRolloutState = {
  latestVersion?: string | null;
  targets?: number;
  queued?: number;
  inProgress?: number;
  pace?: number | { maxPerWindow?: number; windowSeconds?: number };
  windowSeconds?: number;
  alreadyQueued?: number;
  failed?: number;
  frozen?: number;
  auto?: number;
};

function normalizeRolloutState(raw: RawRolloutState | undefined): AgentUpdateRolloutPreview {
  if (!raw) return {};
  const pace = raw.pace;
  return {
    latestVersion: raw.latestVersion,
    targets: raw.targets,
    alreadyQueued: raw.alreadyQueued ?? (raw.queued != null ? raw.queued + (raw.inProgress ?? 0) : undefined),
    inProgress: raw.inProgress,
    failed: raw.failed,
    pace: typeof pace === 'object' && pace ? pace.maxPerWindow : pace,
    windowSeconds: typeof pace === 'object' && pace ? pace.windowSeconds : raw.windowSeconds,
    frozen: raw.frozen,
    auto: raw.auto,
  };
}

/** POST /agent/update-all: the rollout that was started. */
export interface AgentUpdateRolloutResult extends AgentUpdateRolloutPreview {
  queued?: number;
}

/** POST /agent/devices/batch/transfer: per-batch outcome. */
export interface AgentTransferResult {
  transferred?: number;
  failed?: number;
}

/** GET /agent/proxy-candidates — a device the caller may route checks through. */
export interface AgentProxyCandidate {
  id: number;
  name: string | null;
  hostname: string;
  deviceType: AgentDevice['deviceType'];
}

export const agentApi = {
  // ── API Keys ─────────────────────────────────────────────────────────────

  /**
   * API keys of the current workspace (every workspace in the God View).
   * `tenantId` asks a platform admin's view for one workspace's keys (tenant
   * transfer target); the result is filtered client-side as well, so an older
   * server that ignores the parameter never offers another tenant's key.
   */
  async listKeys(tenantId?: number): Promise<AgentApiKeyWithDefault[]> {
    const params = tenantId != null ? { tenantId } : {};
    const res = await apiClient.get<ApiResponse<AgentApiKeyWithDefault[]>>('/agent/keys', { params });
    const keys = res.data.data ?? [];
    return tenantId != null ? keys.filter((k) => k.tenantId === tenantId) : keys;
  },

  async createKey(name: string, defaultGroupId?: number | null): Promise<AgentApiKeyWithDefault> {
    const res = await apiClient.post<ApiResponse<AgentApiKeyWithDefault>>('/agent/keys', {
      name,
      defaultGroupId: defaultGroupId ?? null,
    });
    return res.data.data!;
  },

  /** PUT /agent/keys/:id: rename and/or set the default group (null clears it). */
  async updateKey(id: number, data: { name?: string; defaultGroupId?: number | null }): Promise<AgentApiKeyWithDefault | null> {
    const res = await apiClient.put<ApiResponse<AgentApiKeyWithDefault>>(`/agent/keys/${id}`, data);
    return res.data.data ?? null;
  },

  async deleteKey(id: number): Promise<void> {
    await apiClient.delete(`/agent/keys/${id}`);
  },

  // ── Devices ───────────────────────────────────────────────────────────────

  /** null when the device is missing or not readable by the caller. */
  async getDeviceById(id: number): Promise<AgentDeviceDetail | null> {
    try {
      const res = await apiClient.get<ApiResponse<AgentDeviceDetail>>(`/agent/devices/${id}`);
      return res.data.data ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Devices of the current workspace: all of them with agents.manage,
   * otherwise only those whose agent monitor the user can see.
   */
  async listDevices(status?: AgentDevice['status']): Promise<AgentFleetDevice[]> {
    const params = status ? { status } : {};
    const res = await apiClient.get<ApiResponse<AgentFleetDevice[]>>('/agent/devices', { params });
    return res.data.data!;
  },

  /**
   * Approved devices the caller may use as a monitor proxy (empty = no proxy
   * picker). `tenantId` (the edited monitor's workspace) only matters in the
   * God View; elsewhere the server uses the current workspace.
   */
  async listProxyCandidates(tenantId?: number): Promise<AgentProxyCandidate[]> {
    const params = tenantId != null ? { tenantId } : {};
    const res = await apiClient.get<ApiResponse<AgentProxyCandidate[]>>('/agent/proxy-candidates', { params });
    return res.data.data ?? [];
  },

  async updateDevice(
    id: number,
    data: {
      status?: AgentDevice['status'];
      groupId?: number | null;
      checkIntervalSeconds?: number;
      /** null clears the device override (inherit the group thresholds). */
      agentThresholds?: Partial<AgentThresholds> | null;
      name?: string | null;
      heartbeatMonitoring?: boolean;
      sensorDisplayNames?: Record<string, string> | null;
      overrideGroupSettings?: boolean;
      displayConfig?: AgentDisplayConfig | null;
      notificationTypes?: NotificationTypeConfig | null;
      notificationCooldownSeconds?: number | null;
      notes?: string | null;
      /** Device level of the update policy (agents.manage); null = inherit. */
      updatePolicy?: AgentUpdatePolicy | null;
    },
  ): Promise<AgentDevice> {
    const res = await apiClient.patch<ApiResponse<AgentDevice>>(`/agent/devices/${id}`, data);
    return res.data.data!;
  },

  async getDeviceMetrics(deviceId: number): Promise<AgentPushSnapshot | null> {
    try {
      const res = await apiClient.get<ApiResponse<AgentPushSnapshot>>(`/agent/devices/${deviceId}/metrics`);
      return res.data.data ?? null;
    } catch {
      return null;
    }
  },

  /**
   * Write the device threshold override. Send only the metric keys that differ
   * from the group; `null` resets the device to the group thresholds.
   */
  async updateDeviceThresholds(deviceId: number, thresholds: Partial<AgentThresholds> | null): Promise<AgentDevice> {
    const res = await apiClient.patch<ApiResponse<AgentDevice>>(`/agent/devices/${deviceId}`, { agentThresholds: thresholds });
    return res.data.data!;
  },

  /** Effective / override / group-inherited thresholds of a device (null when unavailable). */
  async getResolvedThresholds(deviceId: number): Promise<ResolvedAgentThresholds | null> {
    try {
      const res = await apiClient.get<ApiResponse<ResolvedAgentThresholds>>(`/agent/devices/${deviceId}/thresholds-resolved`);
      return res.data.data ?? null;
    } catch {
      return null;
    }
  },

  async deleteDevice(id: number): Promise<void> {
    await apiClient.delete(`/agent/devices/${id}`);
  },

  // ── Device lifecycle (agents.manage) ──────────────────────────────────────
  // The server pushes the command at once when the agent WebSocket is open,
  // otherwise it is drained on the next push. Each call answers with the
  // updated device when the server sends it back.

  /** POST /agent/devices/:id/uninstall: the device turns 'pending_uninstall'. */
  async uninstallDevice(id: number): Promise<AgentFleetDevice | null> {
    const res = await apiClient.post<ApiResponse<AgentFleetDevice>>(`/agent/devices/${id}/uninstall`);
    return res.data.data ?? null;
  },

  /** POST /agent/devices/:id/cancel-uninstall: only while the command was not delivered. */
  async cancelUninstall(id: number): Promise<AgentFleetDevice | null> {
    const res = await apiClient.post<ApiResponse<AgentFleetDevice>>(`/agent/devices/${id}/cancel-uninstall`);
    return res.data.data ?? null;
  },

  /**
   * POST /agent/devices/:id/update: queue a paced update to the latest agent
   * version. The server answers the request counters plus the refreshed device.
   */
  async requestUpdate(id: number): Promise<{ result: AgentUpdateRequestResult; device: AgentFleetDevice | null }> {
    const res = await apiClient.post<ApiResponse<AgentUpdateRequestResult & { device?: AgentFleetDevice | null }>>(`/agent/devices/${id}/update`);
    const { device = null, ...result } = res.data.data
      ?? ({ targetVersion: null, queued: 0, alreadyQueued: 0, upToDate: 0, ineligible: 0, frozen: 0 } as AgentUpdateRequestResult & { device?: AgentFleetDevice | null });
    return { result, device };
  },

  /** POST /agent/devices/batch/transfer: platform admin, move devices to another workspace. */
  async batchTransfer(deviceIds: number[], targetTenantId: number, targetApiKeyId: number): Promise<AgentTransferResult> {
    const res = await apiClient.post<ApiResponse<AgentTransferResult>>('/agent/devices/batch/transfer', {
      deviceIds,
      targetTenantId,
      targetApiKeyId,
    });
    return res.data.data ?? {};
  },

  // ── Fleet updates (agents.manage) ─────────────────────────────────────────

  /** POST /agent/update-all {preview: true}: figures for the confirmation, nothing queued. */
  async previewUpdateAll(): Promise<AgentUpdateRolloutPreview> {
    const res = await apiClient.post<ApiResponse<RawRolloutState>>('/agent/update-all', { preview: true });
    return normalizeRolloutState(res.data.data);
  },

  /**
   * POST /agent/update-all: queue a paced update for every outdated approved
   * agent. The pace is a fleet-wide server setting
   * (AGENT_UPDATE_ROLLOUT_MAX_PER_WINDOW / AGENT_UPDATE_ROLLOUT_WINDOW_SECONDS).
   */
  async startUpdateAll(): Promise<AgentUpdateRolloutResult> {
    const res = await apiClient.post<ApiResponse<RawRolloutState & { queued?: number; state?: RawRolloutState }>>('/agent/update-all', {});
    const data = res.data.data;
    return { ...normalizeRolloutState(data?.state), queued: data?.queued };
  },

  // ── Bulk device operations ────────────────────────────────────────────────

  async bulkDeleteDevices(deviceIds: number[]): Promise<void> {
    await apiClient.delete('/agent/devices/bulk', { data: { deviceIds } });
  },

  /** POST /agent/devices/bulk-uninstall. */
  async bulkUninstall(deviceIds: number[]): Promise<void> {
    await apiClient.post('/agent/devices/bulk-uninstall', { deviceIds });
  },

  /**
   * POST /agent/devices/bulk-update: queue a paced update for each device.
   * Devices whose update policy is 'off' are skipped (result.frozen).
   */
  async bulkRequestUpdate(deviceIds: number[]): Promise<AgentUpdateRequestResult | null> {
    const res = await apiClient.post<ApiResponse<AgentUpdateRequestResult>>('/agent/devices/bulk-update', { deviceIds });
    return res.data.data ?? null;
  },

  async bulkUpdateDevices(
    deviceIds: number[],
    data: {
      groupId?: number | null;
      heartbeatMonitoring?: boolean;
      overrideGroupSettings?: boolean;
      status?: 'approved' | 'suspended';
    },
  ): Promise<void> {
    await apiClient.patch('/agent/devices/bulk', { deviceIds, ...data });
  },

  // ── Agent version ─────────────────────────────────────────────────────────

  async getVersion(): Promise<{ version: string; downloadUrl: string }> {
    const res = await apiClient.get<{ version: string; downloadUrl: string }>('/agent/version');
    return res.data;
  },

  // ── Installer URLs ────────────────────────────────────────────────────────

  getInstallerLinuxUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/linux?key=${encodeURIComponent(apiKey)}`;
  },

  getInstallerMacosUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/macos?key=${encodeURIComponent(apiKey)}`;
  },

  getInstallerFreebsdUrl(apiKey: string): string {
    return `${window.location.origin}/api/agent/installer/freebsd?key=${encodeURIComponent(apiKey)}`;
  },

  getMsiUrl(): string {
    return `${window.location.origin}/api/agent/installer/windows.msi`;
  },

  /** Download URL for the manual-install wizard (.exe with embedded MSI + config tail). */
  getWizardUrl(keyId: number): string {
    return `${window.location.origin}/api/agent/installer/wizard.exe?keyId=${keyId}`;
  },

  /**
   * Whether the manual-install wizard binary has been built on this server.
   * HEAD on the public download route: 404 means "not built". Any other
   * failure (network, 5xx) counts as available, so a transient error does
   * not hide the option.
   */
  async isWizardAvailable(): Promise<boolean> {
    try {
      await apiClient.head('/agent/download/obliview-install-wizard.exe');
      return true;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      return status !== 404;
    }
  },

  /**
   * Whether the Windows 7 / 8.1 / 2008 R2 / 2012 ("nt6", Go 1.20 build) MSI
   * has been built on this server. Same rules as isWizardAvailable: only a
   * 404 means "not built".
   */
  async isNt6MsiAvailable(): Promise<boolean> {
    try {
      await apiClient.head('/agent/download/obliview-agent-nt6.msi');
      return true;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      return status !== 404;
    }
  },
};
