import apiClient from './client';
import type { ApiResponse } from '@obliview/shared';

export interface AuditLogRow {
  id: number;
  /** null = platform-level action (only listed on the master tenant). */
  tenantId: number | null;
  tenantName: string | null;
  userId: number | null;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  resourcePath: string | null;
  /** Name resolved from the owning table (null once the entity is gone). */
  resourceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AuditLogFilters {
  /** Exact action, or a prefix ending with '.' ('team.' → every team action). */
  action?: string;
  userId?: number;
  resourceType?: string;
  search?: string;
  /** ISO date-time. */
  since?: string;
  /** ISO date-time. */
  until?: string;
  limit?: number;
  offset?: number;
  /** Master tenant only: narrow the cross-tenant feed to one tenant. */
  filterTenantId?: number;
}

function toParams(filters: AuditLogFilters): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null && v !== '') params[k] = String(v);
  }
  return params;
}

export const auditApi = {
  async list(filters: AuditLogFilters = {}): Promise<{ items: AuditLogRow[]; total: number }> {
    const res = await apiClient.get<ApiResponse<{ items: AuditLogRow[]; total: number }>>('/audit-log', {
      params: toParams(filters),
    });
    return res.data.data!;
  },

  async distinctActions(filterTenantId?: number): Promise<string[]> {
    const res = await apiClient.get<ApiResponse<string[]>>('/audit-log/distinct-actions', {
      params: filterTenantId !== undefined ? { filterTenantId: String(filterTenantId) } : undefined,
    });
    return res.data.data ?? [];
  },

  /** Platform admins only. */
  async clear(): Promise<{ deleted: number }> {
    const res = await apiClient.delete<ApiResponse<{ deleted: number }>>('/audit-log');
    return res.data.data!;
  },
};
