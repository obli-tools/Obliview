import apiClient from './client';
import type { AppConfig, AgentGlobalConfig, ObligateConfig, ApiResponse } from '@obliview/shared';

/**
 * Obligate config as returned to admins (GET/PUT /admin/config/obligate):
 * flags only, never the API key nor the inbound secret.
 */
export type ObligateConfigView = ObligateConfig & {
  /** A distinct inbound secret is in force (environment or Settings). */
  inboundSecretSet: boolean;
  /** It comes from the OBLIGATE_INBOUND_SECRET environment variable (read-only here). */
  inboundSecretFromEnv: boolean;
};

/**
 * PUT /admin/config/obligate body. `apiKey`: a non-empty value replaces it.
 * `inboundSecret`: a string (min. 16 characters) sets it, null clears it.
 */
export interface ObligateConfigPatch {
  url?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
  inboundSecret?: string | null;
}

export const appConfigApi = {
  async getConfig(): Promise<AppConfig> {
    const res = await apiClient.get<ApiResponse<AppConfig>>('/admin/config');
    return res.data.data!;
  },

  async setConfig(key: keyof AppConfig, value: boolean | number | null): Promise<void> {
    await apiClient.put(`/admin/config/${key}`, { value: String(value ?? '') });
  },

  async getAgentGlobal(): Promise<AgentGlobalConfig> {
    const res = await apiClient.get<ApiResponse<AgentGlobalConfig>>('/admin/config/agent-global');
    return res.data.data!;
  },

  async patchAgentGlobal(patch: Partial<AgentGlobalConfig>): Promise<AgentGlobalConfig> {
    const res = await apiClient.patch<ApiResponse<AgentGlobalConfig>>('/admin/config/agent-global', patch);
    return res.data.data!;
  },

  // ── Obligate SSO gateway ────────────────────────────────────────────────

  async getObligateConfig(): Promise<ObligateConfigView> {
    const res = await apiClient.get<ApiResponse<ObligateConfigView>>('/admin/config/obligate');
    return res.data.data!;
  },

  async patchObligateConfig(patch: ObligateConfigPatch): Promise<ObligateConfigView> {
    const res = await apiClient.put<ApiResponse<ObligateConfigView>>('/admin/config/obligate', patch);
    return res.data.data!;
  },
};
