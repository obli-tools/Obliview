import { create } from 'zustand';
import type { TenantWithRole, ApiResponse } from '@obliview/shared';
import apiClient from '../api/client';

/** Entity kinds GET /tenants/locate/:kind/:id can resolve. */
export type LocateKind = 'monitor' | 'group' | 'agent';

export interface LocateResult {
  kind: LocateKind;
  id: number;
  tenantId: number;
  tenantName: string;
  /** The session's tenant when the server answered. */
  currentTenantId: number | null;
}

/**
 * Which workspace a monitor / group / agent belongs to, for deep links opened
 * while connected to another workspace. `null` = not found OR not readable by
 * the caller (the server collapses both into one 404), or a network error.
 */
export async function locateEntity(kind: LocateKind, id: number): Promise<LocateResult | null> {
  try {
    const res = await apiClient.get<ApiResponse<LocateResult>>(`/tenants/locate/${kind}/${id}`);
    return res.data.data ?? null;
  } catch {
    return null;
  }
}

interface TenantState {
  currentTenantId: number | null;
  tenants: TenantWithRole[];
  isLoading: boolean;
  fetchTenants: () => Promise<void>;
  /**
   * Switch the session to another tenant, then load `target` (default '/')
   * with a full page load. Never reloads the current URL implicitly: a
   * tenant-scoped page (/monitor/42, /agents/5, …) of the old tenant would be
   * a dead end — callers that know the target lives in the new tenant (deep
   * link locate, cross-tenant alerts) pass it explicitly.
   * Resolves `false` when the switch was refused (the page stays as is),
   * `true` once the new page load has been started.
   */
  setCurrentTenant: (tenantId: number, target?: string) => Promise<boolean>;
}

export const useTenantStore = create<TenantState>((set) => ({
  currentTenantId: null,
  tenants: [],
  isLoading: false,

  fetchTenants: async () => {
    try {
      set({ isLoading: true });
      const res = await apiClient.get<ApiResponse<TenantWithRole[]>>('/tenants');
      set({ tenants: res.data.data ?? [], isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  setCurrentTenant: async (tenantId: number, target = '/') => {
    try {
      await apiClient.post('/tenant/switch', { tenantId });
    } catch {
      // Switch refused or network error: stay on the current page and tenant.
      return false;
    }
    // Full page load to re-fetch ALL tenant-scoped data (sidebar, monitors,
    // agents, notifications, settings, dashboard stats, etc.). This is more
    // reliable than selectively re-fetching each store. Only same-origin
    // relative paths are accepted as a target; anything else lands on '/'.
    const safeTarget = /^\/(?![/\\])/.test(target) ? target : '/';
    window.location.assign(safeTarget);
    return true;
  },
}));
