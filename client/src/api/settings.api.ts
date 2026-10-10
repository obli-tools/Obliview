import apiClient from './client';
import type { ResolvedSettings, ApiResponse, SettingsScope } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';

export interface ResolvedWithOverrides {
  resolved: ResolvedSettings;
  overrides: Record<string, number>;
}

/**
 * Monitor scope: `resolved` includes the monitor's own overrides, `inherited`
 * is the chain without them (what an empty override field falls back to).
 */
export interface MonitorResolvedSettings extends ResolvedWithOverrides {
  inherited?: ResolvedSettings;
}

export const settingsApi = {
  /** Workspace defaults — admins only. */
  async getGlobalResolved(): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>('/settings/global/resolved');
    return res.data.data!;
  },

  /** Needs read access to the group. `resolved` excludes the group's own overrides. */
  async getGroupResolved(groupId: number): Promise<ResolvedWithOverrides> {
    const res = await apiClient.get<ApiResponse<ResolvedWithOverrides>>(`/settings/group/${groupId}/resolved`);
    return res.data.data!;
  },

  /** Needs read access to the monitor. */
  async getMonitorResolved(monitorId: number): Promise<MonitorResolvedSettings> {
    const res = await apiClient.get<ApiResponse<MonitorResolvedSettings>>(`/settings/monitor/${monitorId}/resolved`);
    return res.data.data!;
  },

  /** global: admins · group / monitor: RW holders of the entity. */
  async set(scope: SettingsScope, scopeId: string, key: SettingsKey, value: number): Promise<void> {
    await apiClient.put(`/settings/${scope}/${scopeId}`, { key, value });
  },

  async setBulk(
    scope: SettingsScope,
    scopeId: string,
    overrides: Array<{ key: SettingsKey; value: number }>,
  ): Promise<void> {
    await apiClient.put(`/settings/${scope}/${scopeId}/bulk`, { overrides });
  },

  async remove(scope: SettingsScope, scopeId: string, key: SettingsKey): Promise<void> {
    await apiClient.delete(`/settings/${scope}/${scopeId}/${key}`);
  },

  /**
   * Monitor-scope overrides on many monitors in one request (bulk edit):
   * sets `overrides`, removes `remove` (back to inherited). All or nothing —
   * the caller needs RW on every monitor.
   */
  async setMonitorsBulk(
    monitorIds: number[],
    overrides: Array<{ key: SettingsKey; value: number }>,
    remove: SettingsKey[] = [],
  ): Promise<void> {
    await apiClient.put('/settings/monitors/bulk', { monitorIds, overrides, remove });
  },
};
