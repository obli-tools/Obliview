import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Tab state synced to the `?tab=` query parameter, so admin tabs can be
 * deep-linked and survive a reload (Obliance pattern: SecurityPage /
 * AdminDevicesPage read the initial tab from the URL).
 *
 * - An unknown or missing `?tab=` value resolves to `def`.
 * - Switching tabs REPLACES the history entry (no back-button spam) and keeps
 *   every other query parameter.
 *
 *   const TABS = ['users', 'teams', 'permissionSets'] as const;
 *   const [tab, setTab] = useTabParam(TABS, 'users');
 *   <SegmentedTabs tabs={…} value={tab} onChange={setTab} />
 */
export function useTabParam<T extends string>(allowed: readonly T[], def: T): [T, (t: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab = raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : def;

  const setTab = useCallback(
    (next: T) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('tab', next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [tab, setTab];
}
