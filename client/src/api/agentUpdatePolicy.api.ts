import apiClient from './client';
import type {
  AgentUpdatePolicy, AgentUpdatePolicyContext, ApiResponse, MonitorGroup,
} from '@obliview/shared';

/**
 * Agent update policy (global -> workspace -> group chain -> agent).
 * The global level rides on /admin/config/agent-global (appConfigApi) and the
 * agent level on PATCH /agent/devices/:id (agentApi.updateDevice).
 */
export const agentUpdatePolicyApi = {
  /** Workspace level: platform admin, or agents.manage in that workspace (read-only). */
  async getTenant(tenantId: number): Promise<AgentUpdatePolicyContext> {
    const res = await apiClient.get<ApiResponse<AgentUpdatePolicyContext>>(`/tenants/${tenantId}/agent-update-policy`);
    return res.data.data!;
  },

  /** Platform admin. null = inherit the global policy. */
  async setTenant(tenantId: number, updatePolicy: AgentUpdatePolicy | null): Promise<AgentUpdatePolicyContext> {
    const res = await apiClient.put<ApiResponse<AgentUpdatePolicyContext>>(
      `/tenants/${tenantId}/agent-update-policy`,
      { updatePolicy },
    );
    return res.data.data!;
  },

  /** Group level (agents.manage on the group's workspace). */
  async getGroup(groupId: number): Promise<AgentUpdatePolicyContext> {
    const res = await apiClient.get<ApiResponse<AgentUpdatePolicyContext>>(`/groups/${groupId}/agent-update-policy`);
    return res.data.data!;
  },

  /** null = inherit. Returns the updated group and its new policy context. */
  async setGroup(groupId: number, updatePolicy: AgentUpdatePolicy | null): Promise<{ group: MonitorGroup; policy: AgentUpdatePolicyContext }> {
    const res = await apiClient.put<ApiResponse<{ group: MonitorGroup; policy: AgentUpdatePolicyContext }>>(
      `/groups/${groupId}/agent-update-policy`,
      { updatePolicy },
    );
    return res.data.data!;
  },
};
