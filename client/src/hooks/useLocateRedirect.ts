import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useIsGodView } from '@/hooks/useIsGodView';
import { locateEntity, useTenantStore, type LocateKind } from '@/store/tenantStore';

export type LocateStatus = 'idle' | 'locating' | 'switching' | 'notFound';

export interface LocateRedirectState {
  status: LocateStatus;
  /** Name of the workspace being switched to (status 'switching'). */
  tenantName: string | null;
  /** True while the page should keep its spinner instead of "not found". */
  pending: boolean;
}

/**
 * Cross-tenant deep links (/monitor/42, /group/7, /agents/5) opened while
 * connected to another workspace.
 *
 * When the detail page reports `notFound`, asks the server which workspace the
 * entity lives in (GET /tenants/locate/:kind/:id — answers only when the
 * caller may read it). If it is another workspace, switches the session and
 * reloads the SAME url there; otherwise the page shows its "not found".
 *
 * The God View (platform admin on the master tenant) already sees every
 * workspace and is never redirected: a miss there is a real "not found".
 * No loop: after the switch, a second miss locates the entity in the current
 * workspace and falls through to "not found".
 */
export function useLocateRedirect(kind: LocateKind, id: number, notFound: boolean): LocateRedirectState {
  const isGodView = useIsGodView();
  const location = useLocation();
  const target = `${location.pathname}${location.search}${location.hash}`;
  const [state, setState] = useState<{ key: string; status: LocateStatus; tenantName: string | null } | null>(null);

  const validId = Number.isInteger(id) && id > 0;
  const key = `${kind}:${id}`;
  const active = notFound && validId && !isGodView;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState({ key, status: 'locating', tenantName: null });
    void (async () => {
      const located = await locateEntity(kind, id);
      if (cancelled) return;
      const currentTenantId = located?.currentTenantId ?? useTenantStore.getState().currentTenantId;
      if (!located || located.tenantId === currentTenantId) {
        setState({ key, status: 'notFound', tenantName: null });
        return;
      }
      setState({ key, status: 'switching', tenantName: located.tenantName });
      const switched = await useTenantStore.getState().setCurrentTenant(located.tenantId, target);
      // On success the full page load takes over; keep the spinner until then.
      if (!switched && !cancelled) setState({ key, status: 'notFound', tenantName: null });
    })();
    return () => { cancelled = true; };
    // `target` is read once per lookup: the URL is this entity's page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, kind, id, key]);

  if (!notFound) return { status: 'idle', tenantName: null, pending: false };
  if (!active) return { status: 'notFound', tenantName: null, pending: false };
  // Before the effect's first run for this entity: still looking it up.
  const current = state?.key === key ? state : { status: 'locating' as const, tenantName: null };
  return {
    status: current.status,
    tenantName: current.tenantName,
    pending: current.status === 'locating' || current.status === 'switching',
  };
}
