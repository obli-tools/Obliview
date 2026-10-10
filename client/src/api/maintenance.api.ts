import type {
  MaintenanceWindow,
  CreateMaintenanceWindowRequest,
  UpdateMaintenanceWindowRequest,
  ApiResponse,
} from '@obliview/shared';
import apiClient from './client';

const BASE = '/maintenance';

export const maintenanceApi = {
  /** List all windows, optionally filtered by scope type/id */
  async list(params?: { scopeType?: string; scopeId?: number }): Promise<MaintenanceWindow[]> {
    const res = await apiClient.get<ApiResponse<MaintenanceWindow[]>>(BASE, { params });
    return res.data.data ?? [];
  },

  async getById(id: number): Promise<MaintenanceWindow> {
    const res = await apiClient.get<ApiResponse<MaintenanceWindow>>(`${BASE}/${id}`);
    return res.data.data!;
  },

  async create(data: CreateMaintenanceWindowRequest): Promise<MaintenanceWindow> {
    const res = await apiClient.post<ApiResponse<MaintenanceWindow>>(BASE, data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateMaintenanceWindowRequest): Promise<MaintenanceWindow> {
    const res = await apiClient.put<ApiResponse<MaintenanceWindow>>(`${BASE}/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`${BASE}/${id}`);
  },

  /**
   * Get all effective windows (local + inherited) for a scope entity.
   * Each window includes source, isDisabledHere, canDisable, canEnable, etc.
   */
  async getEffective(scopeType: 'monitor' | 'agent' | 'group', scopeId: number): Promise<MaintenanceWindow[]> {
    const res = await apiClient.get<ApiResponse<MaintenanceWindow[]>>(`${BASE}/effective/${scopeType}/${scopeId}`);
    return res.data.data ?? [];
  },

  /**
   * Disable an inherited window at the given scope.
   */
  async disableForScope(windowId: number, scopeType: 'group' | 'monitor' | 'agent', scopeId: number): Promise<void> {
    await apiClient.post(`${BASE}/${windowId}/disable`, { scopeType, scopeId });
  },

  /**
   * Re-enable a previously disabled inherited window at the given scope.
   */
  async enableForScope(windowId: number, scopeType: 'group' | 'monitor' | 'agent', scopeId: number): Promise<void> {
    await apiClient.delete(`${BASE}/${windowId}/disable`, { data: { scopeType, scopeId } });
  },
};
