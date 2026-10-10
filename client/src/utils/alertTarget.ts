import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';

const AGENT_ROUTE = /^\/agents\/(\d+)$/;

/**
 * Route a live alert opens. Alerts stored before agent alerts linked to the
 * monitor page point at /agents/:deviceId, which is admin-only: for other
 * users they resolve to that device's agent monitor (read-only view), or '/'
 * when it is not known here (other workspace, store not loaded yet).
 * `crossTenant` = the alert belongs to another workspace than the loaded one.
 */
export function resolveAlertTarget(navigateTo: string | null | undefined, crossTenant = false): string {
  const target = navigateTo || '/';
  const match = AGENT_ROUTE.exec(target);
  if (!match || useAuthStore.getState().isAdmin()) return target;
  if (crossTenant) return '/';
  const deviceId = Number(match[1]);
  for (const m of useMonitorStore.getState().monitors.values()) {
    if (m.agentDeviceId === deviceId) return `/monitor/${m.id}`;
  }
  return '/';
}
