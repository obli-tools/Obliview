import apiClient from './client';
import type {
  RemediationAction,
  RemediationBinding,
  ResolvedRemediationBindingView,
  ResolvedRemediationBindings,
  RemediationRun,
  CreateRemediationActionRequest,
  UpdateRemediationActionRequest,
  AddRemediationBindingRequest,
  OverrideModeR,
  RemediationTrigger,
  RemediationActionType,
  SshRemediationConfig,
  ApiResponse,
} from '@obliview/shared';

/** Types that execute on, or from, the server — gated by REMEDIATION_ALLOW_SERVER_SCRIPTS */
export const SERVER_EXECUTED_ACTION_TYPES: readonly RemediationActionType[] = ['script', 'ssh', 'docker_restart'];

export function isServerExecutedActionType(type: string): boolean {
  return (SERVER_EXECUTED_ACTION_TYPES as readonly string[]).includes(type);
}

/** GET /remediation/capabilities */
export interface RemediationCapabilities {
  /** Script / SSH / Docker actions may run on this server */
  serverScriptsEnabled: boolean;
  /** The caller may create / update them (platform admin on the master tenant), independently of the flag */
  canManageServerActions: boolean;
}

/** SSH action config with its pinned host key ("SHA256:..."; required on create / edit — absent only on legacy actions) */
export type PinnedSshRemediationConfig = SshRemediationConfig & { hostKeySha256?: string };

export interface SshHostKeyFingerprint {
  /** OpenSSH-style "SHA256:<base64>" */
  fingerprint: string;
  /** Host key algorithm, e.g. "ssh-ed25519" */
  keyType: string | null;
}

export const remediationApi = {
  // ── Capabilities ───────────────────────────────────────────────────────────

  async getCapabilities(): Promise<RemediationCapabilities> {
    const res = await apiClient.get<ApiResponse<RemediationCapabilities>>('/remediation/capabilities');
    return res.data.data!;
  },

  /** Fetch the host key fingerprint of an SSH server (no authentication is attempted) */
  async fetchSshFingerprint(host: string, port?: number): Promise<SshHostKeyFingerprint> {
    const res = await apiClient.post<ApiResponse<SshHostKeyFingerprint>>('/remediation/ssh/fingerprint', { host, port });
    return res.data.data!;
  },

  // ── Actions ────────────────────────────────────────────────────────────────

  async listActions(): Promise<RemediationAction[]> {
    const res = await apiClient.get<ApiResponse<RemediationAction[]>>('/remediation/actions');
    return res.data.data!;
  },

  async createAction(data: CreateRemediationActionRequest): Promise<RemediationAction> {
    const res = await apiClient.post<ApiResponse<RemediationAction>>('/remediation/actions', data);
    return res.data.data!;
  },

  async updateAction(id: number, data: UpdateRemediationActionRequest): Promise<RemediationAction> {
    const res = await apiClient.put<ApiResponse<RemediationAction>>(`/remediation/actions/${id}`, data);
    return res.data.data!;
  },

  async deleteAction(id: number): Promise<void> {
    await apiClient.delete(`/remediation/actions/${id}`);
  },

  // ── Bindings ───────────────────────────────────────────────────────────────

  async getBindings(scope: string, scopeId: number | null): Promise<RemediationBinding[]> {
    const params: Record<string, string | number | null> = { scope };
    if (scopeId !== null) params.scopeId = scopeId;
    const res = await apiClient.get<ApiResponse<RemediationBinding[]>>('/remediation/bindings', { params });
    return res.data.data!;
  },

  /**
   * Actions come back as config-free summaries (id, name, type, enabled).
   * `tenantId` is the target's tenant — the only one whose actions can be bound to it.
   */
  async getResolved(
    scope: 'group' | 'monitor',
    scopeId: number,
    groupId?: number | null,
  ): Promise<ResolvedRemediationBindings> {
    const params: Record<string, string | number | null | undefined> = { scope, scopeId };
    if (groupId != null) params.groupId = groupId;
    const res = await apiClient.get<ApiResponse<ResolvedRemediationBindingView[]> & { tenantId: number }>(
      '/remediation/resolved',
      { params },
    );
    return { bindings: res.data.data!, tenantId: res.data.tenantId };
  },

  async addBinding(data: AddRemediationBindingRequest): Promise<RemediationBinding> {
    const res = await apiClient.post<ApiResponse<RemediationBinding>>('/remediation/bindings', data);
    return res.data.data!;
  },

  async updateBinding(
    id: number,
    data: { overrideMode?: OverrideModeR; triggerOn?: RemediationTrigger; cooldownSeconds?: number },
  ): Promise<RemediationBinding> {
    const res = await apiClient.patch<ApiResponse<RemediationBinding>>(`/remediation/bindings/${id}`, data);
    return res.data.data!;
  },

  async deleteBinding(id: number): Promise<void> {
    await apiClient.delete(`/remediation/bindings/${id}`);
  },

  // ── Run history ────────────────────────────────────────────────────────────

  async getRunsForMonitor(monitorId: number): Promise<RemediationRun[]> {
    const res = await apiClient.get<ApiResponse<RemediationRun[]>>('/remediation/runs', {
      params: { monitorId },
    });
    return res.data.data!;
  },

  async getRunsForAction(actionId: number): Promise<RemediationRun[]> {
    const res = await apiClient.get<ApiResponse<RemediationRun[]>>('/remediation/runs', {
      params: { actionId },
    });
    return res.data.data!;
  },
};
