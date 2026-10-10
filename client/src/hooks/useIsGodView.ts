import { MASTER_TENANT_ID, isMasterTenant } from '@obliview/shared';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';

/**
 * True when the active tenant is the master/Default tenant (pure tenant
 * check, no role check — same contract as Obliance's useIsMasterTenant).
 * Use it for things that only make sense on the master tenant (e.g. the
 * workspace administration), combined with your own role check.
 */
export function useIsMasterTenant(): boolean {
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  return isMasterTenant(currentTenantId);
}

/**
 * God View: a platform admin connected to the master tenant. Only then do the
 * listing endpoints fan out across every tenant (shared/src/tenants.ts), so
 * this — not useIsMasterTenant() alone — is what gates tenant buckets, tenant
 * badges and tenant filters in lists.
 *
 * Replaces the inline `user?.role === 'admin' && isMasterTenant(currentTenantId)`.
 */
export function useIsGodView(): boolean {
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const isMaster = useIsMasterTenant();
  return isAdmin && isMaster;
}

export { MASTER_TENANT_ID };
