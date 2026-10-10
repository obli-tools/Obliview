import { useCallback, useEffect, useState } from 'react';

/**
 * Cross-component collapse state for God View tenant buckets.
 *
 * The Sidebar (monitors + agents) and the agent admin table all render the
 * same tenant headers — collapsing one mirrors the others so the layout stays
 * coherent as the user scans. Persisted in localStorage under a single key.
 */
const LS_KEY = 'obliview:tenantCollapsed';
const EVT_NAME = 'obliview:tenantCollapsed';

function readSet(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as number[];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function writeSet(s: Set<number>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...s]));
  } catch { /* quota / private-mode — ignore */ }
}

export function useTenantCollapse() {
  const [collapsed, setCollapsed] = useState<Set<number>>(readSet);

  // Sync across components in the same tab (storage event only fires across tabs).
  useEffect(() => {
    const handler = () => setCollapsed(readSet());
    window.addEventListener(EVT_NAME, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(EVT_NAME, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const isCollapsed = useCallback((tenantId: number) => collapsed.has(tenantId), [collapsed]);

  const toggle = useCallback((tenantId: number) => {
    const next = new Set(collapsed);
    if (next.has(tenantId)) next.delete(tenantId);
    else next.add(tenantId);
    writeSet(next);
    setCollapsed(next);
    window.dispatchEvent(new Event(EVT_NAME));
  }, [collapsed]);

  return { isCollapsed, toggle };
}
