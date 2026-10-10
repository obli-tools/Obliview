import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Search, X, ChevronRight, Folder, FolderTree, List, SortAsc, SortDesc, Pencil, Pause, Play, Trash2,
} from 'lucide-react';
import { MASTER_TENANT_ID, MONITOR_TYPE_LABELS } from '@obliview/shared';
import type { GroupTreeNode, Monitor, MonitorType } from '@obliview/shared';
import toast from 'react-hot-toast';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { monitorsApi } from '@/api/monitors.api';
import { useIsGodView } from '@/hooks/useIsGodView';
import { useTenantCollapse } from '@/hooks/useTenantCollapse';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { TenantBucketHeader } from '@/components/common/TenantBucketHeader';
import { TenantBadge } from '@/components/common/TenantBadge';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Checkbox } from '@/components/common/Checkbox';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { BulkEditModal } from '@/components/monitors/BulkEditModal';
import { effectiveStatus, STATUS_SORT_ORDER } from '@/utils/monitorStatus';
import { anonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

// ── Filter model ─────────────────────────────────────────────────────────────
// Status chips read the EFFECTIVE status (utils/monitorStatus.ts): a monitor
// in a maintenance window is 'maintenance', never 'down'. 'ssl' covers both
// certificate states.
export const MONITOR_STATUS_FILTERS = ['up', 'down', 'alert', 'maintenance', 'paused', 'ssl'] as const;
export type MonitorStatusFilter = (typeof MONITOR_STATUS_FILTERS)[number];

const STATUS_DOT: Record<MonitorStatusFilter, string> = {
  up: 'bg-status-up',
  down: 'bg-status-down',
  alert: 'bg-orange-500',
  maintenance: 'bg-status-maintenance',
  paused: 'bg-status-paused',
  ssl: 'bg-status-ssl-warning',
};

/** Status-filter key of a monitor (null = not covered by a chip: pending, inactive…). */
function statusKey(m: Monitor): MonitorStatusFilter | null {
  const s = effectiveStatus(m);
  if (s === 'ssl_warning' || s === 'ssl_expired') return 'ssl';
  return (MONITOR_STATUS_FILTERS as readonly string[]).includes(s) ? (s as MonitorStatusFilter) : null;
}

type SortField = 'status' | 'name' | 'type' | 'group' | 'uptime' | 'response';
type SortDir = 'asc' | 'desc';
type ViewMode = 'flat' | 'tree';
const SORT_FIELDS: readonly SortField[] = ['status', 'name', 'type', 'group', 'uptime', 'response'];

/** URL value of the group filter for "no group". */
const UNGROUPED = 'none';

function parseList(raw: string | null): string[] {
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * Filter state backed by URL search params (?groupId=&status=&type=&tenants=
 * plus q / view / sort / dir) or, when `syncUrl` is false, by a local copy
 * initialised from the same params.
 */
function useFilterParams(syncUrl: boolean) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [local, setLocal] = useState(() => new URLSearchParams(searchParams));
  const params = syncUrl ? searchParams : local;

  const update = useCallback((patch: Record<string, string | null>) => {
    const apply = (prev: URLSearchParams) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }
      return next;
    };
    if (syncUrl) setSearchParams(apply, { replace: true });
    else setLocal(apply);
  }, [syncUrl, setSearchParams]);

  return { params, update };
}

// ── Tree helpers ─────────────────────────────────────────────────────────────

function indexTree(nodes: GroupTreeNode[], map = new Map<number, GroupTreeNode>()): Map<number, GroupTreeNode> {
  for (const n of nodes) {
    map.set(n.id, n);
    indexTree(n.children, map);
  }
  return map;
}

function collectIds(node: GroupTreeNode, out: Set<number>): Set<number> {
  out.add(node.id);
  for (const c of node.children) collectIds(c, out);
  return out;
}

/** Flattened tree for the group picker (depth for the indentation). */
function flattenTree(nodes: GroupTreeNode[], depth = 0, out: Array<{ node: GroupTreeNode; depth: number }> = []) {
  const sorted = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  for (const n of sorted) {
    out.push({ node: n, depth });
    flattenTree(n.children, depth + 1, out);
  }
  return out;
}

function sortNodes(nodes: GroupTreeNode[]): GroupTreeNode[] {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

// ── Component ────────────────────────────────────────────────────────────────

export interface MonitorTableProps {
  /**
   * Lock the table on a group (and its subgroups), e.g. on a group page. The
   * group filter is then neither shown nor read from the URL.
   */
  groupId?: number;
  /** Read and write the filters in the URL (default true). */
  syncUrl?: boolean;
  className?: string;
}

const COLUMN_COUNT = 7;

/**
 * Filterable list of the monitors the caller can see (agents excluded: they
 * live in /agents). Status / type / tenant chips, search, sort, an optional
 * tree view by group, selection with the bulk bar. Filters are initialised
 * from and kept in sync with the URL (?groupId=&status=&type=&tenants=), so
 * dashboard counts can deep-link here.
 */
export function MonitorTable({ groupId: fixedGroupId, syncUrl = true, className }: MonitorTableProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isGodView = useIsGodView();
  const tenants = useTenantStore((s) => s.tenants);
  const { isCollapsed: tenantCollapsed, toggle: toggleTenantCollapsed } = useTenantCollapse();

  const monitorsMap = useMonitorStore((s) => s.monitors);
  const summary = useMonitorStore((s) => s.summary);
  const loaded = useMonitorStore((s) => s.loaded);
  const loadError = useMonitorStore((s) => s.error);
  const fetchMonitors = useMonitorStore((s) => s.fetchMonitors);
  const fetchSummary = useMonitorStore((s) => s.fetchSummary);
  const tree = useGroupStore((s) => s.tree);
  const fetchTree = useGroupStore((s) => s.fetchTree);
  const { canWriteMonitor, hasCapability, isAdmin } = useAuthStore();
  // Subscribe to the permission map so the per-row write check re-renders.
  useAuthStore((s) => s.permissions);

  useEffect(() => {
    fetchMonitors();
    fetchTree();
    fetchSummary();
    const timer = setInterval(() => { fetchSummary(); }, 60_000);
    return () => clearInterval(timer);
  }, [fetchMonitors, fetchTree, fetchSummary]);

  // ── Filters (URL) ──
  const { params, update } = useFilterParams(syncUrl);
  const search = params.get('q') ?? '';
  const statusFilters = useMemo(
    () => new Set(parseList(params.get('status')).filter((s): s is MonitorStatusFilter =>
      (MONITOR_STATUS_FILTERS as readonly string[]).includes(s))),
    [params],
  );
  const typeFilters = useMemo(() => new Set(parseList(params.get('type'))), [params]);
  const tenantFilters = useMemo(
    () => new Set(parseList(params.get('tenants')).map(Number).filter((n) => Number.isInteger(n) && n > 0)),
    [params],
  );
  const urlGroup = params.get('groupId');
  const groupParam: number | typeof UNGROUPED | null = fixedGroupId != null
    ? fixedGroupId
    : urlGroup === UNGROUPED
      ? UNGROUPED
      : urlGroup && Number.isInteger(Number(urlGroup)) && Number(urlGroup) > 0
        ? Number(urlGroup)
        : null;
  const view: ViewMode = params.get('view') === 'tree' ? 'tree' : 'flat';
  const sortParam = params.get('sort') as SortField | null;
  const sortField: SortField = sortParam && SORT_FIELDS.includes(sortParam) ? sortParam : 'status';
  const sortDir: SortDir = params.get('dir') === 'desc' ? 'desc' : 'asc';

  // ── Debounced search (the input is controlled locally) ──
  const [searchInput, setSearchInput] = useState(search);
  useEffect(() => { setSearchInput(search); }, [search]);
  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => update({ q: searchInput || null }), 250);
    return () => clearTimeout(timer);
  }, [searchInput, search, update]);

  // ── Groups ──
  const groupIndex = useMemo(() => indexTree(tree), [tree]);
  const groupScope = useMemo<Set<number> | null>(() => {
    if (groupParam === null || groupParam === UNGROUPED) return null;
    const node = groupIndex.get(groupParam);
    return node ? collectIds(node, new Set()) : new Set([groupParam]);
  }, [groupParam, groupIndex]);
  const groupOptions = useMemo(() => flattenTree(tree), [tree]);

  // ── Data pipeline ──
  // base: non-agent monitors in the group / tenant scope (chip counts read it
  // after the search + type filters, so a chip shows what clicking it yields).
  const base = useMemo(() => {
    const all = Array.from(monitorsMap.values()).filter((m) => m.type !== 'agent');
    return all.filter((m) => {
      if (groupParam === UNGROUPED && m.groupId !== null) return false;
      if (groupScope && (m.groupId === null || !groupScope.has(m.groupId))) return false;
      if (isGodView && tenantFilters.size > 0 && (m.tenantId == null || !tenantFilters.has(m.tenantId))) return false;
      return true;
    });
  }, [monitorsMap, groupParam, groupScope, isGodView, tenantFilters]);

  const needle = search.trim().toLowerCase();
  const matchesSearch = useCallback((m: Monitor) => {
    if (!needle) return true;
    return [m.name, m.url, m.hostname, m.description, m.agentDeviceName]
      .some((v) => typeof v === 'string' && v.toLowerCase().includes(needle));
  }, [needle]);

  const afterSearch = useMemo(() => base.filter(matchesSearch), [base, matchesSearch]);

  const statusCounts = useMemo(() => {
    const c: Record<MonitorStatusFilter, number> = { up: 0, down: 0, alert: 0, maintenance: 0, paused: 0, ssl: 0 };
    for (const m of afterSearch) {
      if (typeFilters.size > 0 && !typeFilters.has(m.type)) continue;
      const k = statusKey(m);
      if (k) c[k]++;
    }
    return c;
  }, [afterSearch, typeFilters]);

  const typeCounts = useMemo(() => {
    const c = new Map<MonitorType, number>();
    for (const m of afterSearch) {
      if (statusFilters.size > 0) {
        const k = statusKey(m);
        if (!k || !statusFilters.has(k)) continue;
      }
      c.set(m.type, (c.get(m.type) ?? 0) + 1);
    }
    // Keep a selected type visible even at 0 so it can be cleared.
    for (const tf of typeFilters) if (!c.has(tf as MonitorType)) c.set(tf as MonitorType, 0);
    return [...c.entries()].sort((a, b) =>
      (MONITOR_TYPE_LABELS[a[0]] ?? a[0]).localeCompare(MONITOR_TYPE_LABELS[b[0]] ?? b[0]));
  }, [afterSearch, statusFilters, typeFilters]);

  const filtered = useMemo(() => afterSearch.filter((m) => {
    if (typeFilters.size > 0 && !typeFilters.has(m.type)) return false;
    if (statusFilters.size > 0) {
      const k = statusKey(m);
      if (!k || !statusFilters.has(k)) return false;
    }
    return true;
  }), [afterSearch, typeFilters, statusFilters]);

  const groupName = useCallback(
    (id: number | null) => (id == null ? '' : groupIndex.get(id)?.name ?? ''),
    [groupIndex],
  );

  const compare = useCallback((a: Monitor, b: Monitor): number => {
    const byName = a.name.localeCompare(b.name);
    let d = 0;
    switch (sortField) {
      case 'status':
        d = (STATUS_SORT_ORDER[effectiveStatus(a)] ?? 99) - (STATUS_SORT_ORDER[effectiveStatus(b)] ?? 99);
        break;
      case 'name': d = byName; break;
      case 'type': d = (MONITOR_TYPE_LABELS[a.type] ?? a.type).localeCompare(MONITOR_TYPE_LABELS[b.type] ?? b.type); break;
      case 'group': {
        const ga = groupName(a.groupId);
        const gb = groupName(b.groupId);
        // Ungrouped last in ascending order.
        d = ga && gb ? ga.localeCompare(gb) : ga ? -1 : gb ? 1 : 0;
        break;
      }
      case 'uptime':
        d = (summary[a.id]?.uptimePct ?? -1) - (summary[b.id]?.uptimePct ?? -1);
        break;
      case 'response':
        d = (summary[a.id]?.avgResponseTime ?? Number.MAX_SAFE_INTEGER)
          - (summary[b.id]?.avgResponseTime ?? Number.MAX_SAFE_INTEGER);
        break;
    }
    if (sortDir === 'desc') d = -d;
    return d || byName;
  }, [sortField, sortDir, summary, groupName]);

  const sorted = useMemo(() => [...filtered].sort(compare), [filtered, compare]);

  // ── Selection ──
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const canDelete = isAdmin() || hasCapability('monitors.manage');
  const isWritable = useCallback((m: Monitor) => canWriteMonitor(m.id, m.groupId), [canWriteMonitor]);
  const writableVisible = useMemo(() => sorted.filter(isWritable), [sorted, isWritable]);
  const canSelect = writableVisible.length > 0 || selectedIds.size > 0;

  // Drop ids that left the store (deleted, moved out of visibility).
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<number>();
      for (const id of prev) {
        const m = monitorsMap.get(id);
        if (m && m.type !== 'agent') next.add(id); else changed = true;
      }
      return changed ? next : prev;
    });
  }, [monitorsMap]);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allSelected = writableVisible.length > 0 && writableVisible.every((m) => selectedIds.has(m.id));
  const someSelected = writableVisible.some((m) => selectedIds.has(m.id));
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) for (const m of writableVisible) next.delete(m.id);
      else for (const m of writableVisible) next.add(m.id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkPause = async (pause: boolean) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      await monitorsApi.bulkPause(ids, pause);
      toast.success(pause
        ? t('dashboard.bulkPauseSuccess', { count: ids.length })
        : t('dashboard.bulkResumeSuccess', { count: ids.length }));
      clearSelection();
      fetchMonitors();
    } catch {
      toast.error(pause ? t('dashboard.bulkPauseFailed') : t('dashboard.bulkResumeFailed'));
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!(await confirm({ message: t('dashboard.confirmBulkDelete', { count: ids.length }), danger: true }))) return;
    setBulkBusy(true);
    try {
      await monitorsApi.bulkDelete(ids);
      toast.success(t('dashboard.bulkDeleteSuccess', { count: ids.length }));
      clearSelection();
      fetchMonitors();
    } catch {
      toast.error(t('dashboard.bulkDeleteFailed'));
    } finally {
      setBulkBusy(false);
    }
  };

  // ── Filter actions ──
  const setStatusList = (list: string[]) => update({ status: list.join(',') || null });
  const toggleStatus = (key: MonitorStatusFilter) => setStatusList(toggleInList([...statusFilters], key));
  const toggleType = (key: string) => update({ type: toggleInList([...typeFilters], key).join(',') || null });
  const setTenantList = (next: Set<number>) => update({ tenants: [...next].join(',') || null });
  const setGroup = (value: string) => update({ groupId: value || null });
  const setView = (v: ViewMode) => update({ view: v === 'tree' ? 'tree' : null });
  const toggleSort = (field: SortField) => {
    if (field === sortField) update({ dir: sortDir === 'asc' ? 'desc' : null });
    else update({ sort: field === 'status' ? null : field, dir: null });
  };
  const activeFilterCount = statusFilters.size + typeFilters.size + (isGodView ? tenantFilters.size : 0)
    + (search.trim() ? 1 : 0) + (fixedGroupId == null && groupParam !== null ? 1 : 0);
  const clearAll = () => {
    setSearchInput('');
    update({ q: null, status: null, type: null, tenants: null, ...(fixedGroupId == null ? { groupId: null } : {}) });
  };

  const availableTenantIds = useMemo(() => {
    const ids = new Set<number>();
    for (const m of monitorsMap.values()) if (m.type !== 'agent' && m.tenantId != null) ids.add(m.tenantId);
    return [...ids];
  }, [monitorsMap]);

  // ── Tree view: collapse state (local to this table) ──
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const toggleGroupRow = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const byGroup = useMemo(() => {
    const map = new Map<number | null, Monitor[]>();
    for (const m of sorted) {
      const key = m.groupId != null && groupIndex.has(m.groupId) ? m.groupId : null;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return map;
  }, [sorted, groupIndex]);

  const subtreeCount = useMemo(() => {
    const memo = new Map<number, number>();
    const count = (node: GroupTreeNode): number => {
      const cached = memo.get(node.id);
      if (cached != null) return cached;
      let n = byGroup.get(node.id)?.length ?? 0;
      for (const c of node.children) n += count(c);
      memo.set(node.id, n);
      return n;
    };
    for (const node of groupIndex.values()) count(node);
    return memo;
  }, [byGroup, groupIndex]);

  // ── Rendering ──
  const thCls = 'px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide whitespace-nowrap';
  const sortHeader = (field: SortField, label: string) => (
    <th key={field} className={thCls} aria-sort={sortField === field ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className={cn(
          'inline-flex items-center gap-1 uppercase tracking-wide hover:text-text-primary coarse:min-h-10',
          sortField === field && 'text-text-primary',
        )}
      >
        {label}
        {sortField === field && (sortDir === 'asc' ? <SortAsc size={12} /> : <SortDesc size={12} />)}
      </button>
    </th>
  );

  const renderMonitorRow = (m: Monitor, depth = 0): ReactNode => {
    const writable = isWritable(m);
    const s = summary[m.id];
    const eff = effectiveStatus(m);
    const target = m.url ?? m.hostname ?? m.agentDeviceName ?? '';
    return (
      <tr key={`m-${m.id}`} className={cn('hover:bg-bg-hover', selectedIds.has(m.id) && 'bg-accent/5')}>
        <td className="px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-3" style={depth > 0 ? { paddingLeft: `${Math.min(depth, 6) * 16}px` } : undefined}>
            {canSelect && (
              <Checkbox
                checked={selectedIds.has(m.id)}
                disabled={!writable}
                onCheckedChange={() => toggleSelect(m.id)}
                aria-label={t('monitorList.selectMonitor', 'Select {{name}}', { name: m.name })}
                title={writable ? undefined : t('monitorList.readOnly', 'Read-only')}
              />
            )}
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <Link to={`/monitor/${m.id}`} className="truncate font-medium text-text-primary hover:text-accent">
                  {anonymize(m.name)}
                </Link>
                <TenantBadge tenantId={m.tenantId} />
              </div>
              {target && (
                <div className="max-w-[320px] truncate text-xs text-text-muted">{anonymize(target)}</div>
              )}
            </div>
          </div>
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap">
          <MonitorStatusBadge status={m.status} size="sm" inMaintenance={eff === 'maintenance'} />
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap text-text-secondary">{MONITOR_TYPE_LABELS[m.type] ?? m.type}</td>
        <td className="px-4 py-2.5 whitespace-nowrap text-text-muted">
          {view === 'flat' && m.groupId != null && groupIndex.has(m.groupId) ? (
            <Link to={`/group/${m.groupId}`} className="hover:text-accent">{anonymize(groupName(m.groupId))}</Link>
          ) : view === 'flat' ? '—' : ''}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-text-secondary">
          {s ? `${s.uptimePct.toFixed(2)}%` : '—'}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-text-secondary">
          {s?.avgResponseTime != null ? `${Math.round(s.avgResponseTime)} ms` : '—'}
        </td>
        <td className="px-4 py-2.5 whitespace-nowrap text-right">
          {writable && (
            <Link
              to={`/monitor/${m.id}/edit`}
              className="inline-flex rounded p-1 text-text-muted hover:bg-bg-tertiary hover:text-text-primary coarse:p-2.5"
              title={t('common.edit')}
              aria-label={t('common.edit')}
            >
              <Pencil size={14} />
            </Link>
          )}
        </td>
      </tr>
    );
  };

  const renderGroupNode = (node: GroupTreeNode, depth: number, rows: ReactNode[]) => {
    const n = subtreeCount.get(node.id) ?? 0;
    if (n === 0) return;
    const key = `g:${node.id}`;
    const collapsed = collapsedGroups.has(key);
    const own = byGroup.get(node.id) ?? [];
    const down = countDownInSubtree(node);
    rows.push(
      <tr key={key} className="bg-bg-tertiary/40">
        <td colSpan={COLUMN_COUNT} className="px-3 py-0">
          <button
            type="button"
            onClick={() => toggleGroupRow(key)}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-2 py-2 text-left hover:text-text-primary coarse:min-h-10"
            style={{ paddingLeft: `${Math.min(depth, 6) * 16}px` }}
          >
            <ChevronRight size={14} className={cn('shrink-0 text-text-muted transition-transform', !collapsed && 'rotate-90')} />
            <Folder size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 truncate text-sm font-semibold text-text-secondary">{anonymize(node.name)}</span>
            <span className="shrink-0 text-xs text-text-muted">
              {t('monitorList.monitorCount', '{{count}} monitor(s)', { count: n })}
            </span>
            {down > 0 && (
              <span className="shrink-0 text-xs font-semibold text-status-down">
                {t('monitorList.downCount', '{{count}} down', { count: down })}
              </span>
            )}
          </button>
        </td>
      </tr>,
    );
    if (collapsed) return;
    for (const m of own) rows.push(renderMonitorRow(m, depth + 1));
    for (const child of sortNodes(node.children)) renderGroupNode(child, depth + 1, rows);
  };

  // Down monitors of a subtree (for the group row hint).
  function countDownInSubtree(node: GroupTreeNode): number {
    let n = (byGroup.get(node.id) ?? []).filter((m) => effectiveStatus(m) === 'down').length;
    for (const c of node.children) n += countDownInSubtree(c);
    return n;
  }

  const renderUngrouped = (monitors: Monitor[], key: string, rows: ReactNode[]) => {
    if (monitors.length === 0) return;
    const collapsed = collapsedGroups.has(key);
    rows.push(
      <tr key={key} className="bg-bg-tertiary/40">
        <td colSpan={COLUMN_COUNT} className="px-3 py-0">
          <button
            type="button"
            onClick={() => toggleGroupRow(key)}
            aria-expanded={!collapsed}
            className="flex w-full items-center gap-2 py-2 text-left coarse:min-h-10"
          >
            <ChevronRight size={14} className={cn('shrink-0 text-text-muted transition-transform', !collapsed && 'rotate-90')} />
            <span className="text-sm font-semibold text-text-muted">{t('dashboard.sectionUngrouped')}</span>
            <span className="text-xs text-text-muted">
              {t('monitorList.monitorCount', '{{count}} monitor(s)', { count: monitors.length })}
            </span>
          </button>
        </td>
      </tr>,
    );
    if (!collapsed) for (const m of monitors) rows.push(renderMonitorRow(m, 1));
  };

  const renderTreeRows = (): ReactNode[] => {
    const rows: ReactNode[] = [];
    const ungrouped = byGroup.get(null) ?? [];
    // Locked / filtered on one group: that group is the only root.
    const scopedRoot = groupParam !== null && groupParam !== UNGROUPED ? groupIndex.get(groupParam) : undefined;
    if (scopedRoot) {
      renderGroupNode(scopedRoot, 0, rows);
      return rows;
    }
    const roots = sortNodes(tree);

    // God View with several tenants present: a tenant level above the roots.
    const tenantIds = new Set<number>();
    for (const m of sorted) if (m.tenantId != null) tenantIds.add(m.tenantId);
    if (isGodView && tenantIds.size > 1) {
      const nameOf = (id: number) => tenants.find((tn) => tn.id === id)?.name ?? '';
      const ordered = [...tenantIds].sort((a, b) => {
        if (a === MASTER_TENANT_ID) return -1;
        if (b === MASTER_TENANT_ID) return 1;
        return nameOf(a).localeCompare(nameOf(b));
      });
      for (const tid of ordered) {
        const count = sorted.filter((m) => m.tenantId === tid).length;
        const collapsed = tenantCollapsed(tid);
        rows.push(
          <tr key={`t-${tid}`} className="bg-accent/5">
            <td colSpan={COLUMN_COUNT} className="px-3 py-0">
              <TenantBucketHeader
                tenantId={tid}
                variant="row"
                collapsed={collapsed}
                onToggle={() => toggleTenantCollapsed(tid)}
                countLabel={t('monitorList.monitorCount', '{{count}} monitor(s)', { count })}
              />
            </td>
          </tr>,
        );
        if (collapsed) continue;
        for (const root of roots) if (root.tenantId === tid) renderGroupNode(root, 0, rows);
        renderUngrouped(ungrouped.filter((m) => m.tenantId === tid), `u:${tid}`, rows);
      }
      return rows;
    }

    for (const root of roots) renderGroupNode(root, 0, rows);
    renderUngrouped(ungrouped, 'u:all', rows);
    return rows;
  };

  const chipCls = (on: boolean) => cn(
    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors coarse:min-h-10 coarse:px-3',
    on ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-bg-tertiary hover:text-text-primary',
  );

  const statusLabels: Record<MonitorStatusFilter, string> = {
    up: t('monitorList.status.up', 'Up'),
    down: t('monitorList.status.down', 'Down'),
    alert: t('monitorList.status.alert', 'Alert'),
    maintenance: t('monitorList.status.maintenance', 'Maintenance'),
    paused: t('monitorList.status.paused', 'Paused'),
    ssl: t('monitorList.status.ssl', 'SSL'),
  };

  const scopedGroupName = typeof groupParam === 'number' ? groupName(groupParam) : '';

  if (!loaded && monitorsMap.size === 0) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const rows = view === 'tree' ? renderTreeRows() : sorted.map((m) => renderMonitorRow(m));

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      {/* ── Sticky toolbar ── */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-col gap-2 bg-bg-primary px-1 pb-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('monitorList.searchPlaceholder', 'Search name, URL, host…')}
              aria-label={t('common.search')}
              className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-8 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => { setSearchInput(''); update({ q: null }); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text-primary"
                aria-label={t('monitorList.clearSearch', 'Clear search')}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {fixedGroupId == null && groupOptions.length > 0 && (
            <select
              value={groupParam === null ? '' : String(groupParam)}
              onChange={(e) => setGroup(e.target.value)}
              aria-label={t('monitorList.groupFilter', 'Group')}
              className="max-w-[240px] rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">{t('monitorList.allGroups', 'All groups')}</option>
              <option value={UNGROUPED}>{t('dashboard.sectionUngrouped')}</option>
              {groupOptions.map(({ node, depth }) => (
                <option key={node.id} value={node.id}>
                  {`${'  '.repeat(depth)}${anonymize(node.name)}`}
                </option>
              ))}
            </select>
          )}

          <SegmentedTabs<ViewMode>
            fill={false}
            size="sm"
            value={view}
            onChange={setView}
            ariaLabel={t('monitorList.viewMode', 'View')}
            tabs={[
              { id: 'flat', label: t('monitorList.viewFlat', 'List'), icon: <List size={13} /> },
              { id: 'tree', label: t('monitorList.viewTree', 'By group'), icon: <FolderTree size={13} /> },
            ]}
          />
        </div>

        {/* Status + type chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {MONITOR_STATUS_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilters.has(key)}
              onClick={() => toggleStatus(key)}
              className={chipCls(statusFilters.has(key))}
            >
              <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[key])} />
              {statusLabels[key]}
              <span className="opacity-60">{statusCounts[key]}</span>
            </button>
          ))}
          {typeCounts.length > 1 || typeFilters.size > 0 ? (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              {typeCounts.map(([type, count]) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={typeFilters.has(type)}
                  onClick={() => toggleType(type)}
                  className={chipCls(typeFilters.has(type))}
                >
                  {MONITOR_TYPE_LABELS[type] ?? type}
                  <span className="opacity-60">{count}</span>
                </button>
              ))}
            </>
          ) : null}
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="ml-1 text-xs text-accent hover:underline coarse:min-h-10 coarse:px-2"
            >
              {t('monitorList.clearFilters', 'Clear filters')}
            </button>
          )}
        </div>

        {/* God View: tenant chips */}
        <TenantFilterChips
          value={isGodView ? tenantFilters : new Set()}
          onChange={setTenantList}
          availableTenantIds={availableTenantIds}
        />

        {/* Bulk bar */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-bg-tertiary p-2.5">
            <span className="text-sm text-text-secondary">
              {t(selectedIds.size === 1 ? 'dashboard.selectedCount_one' : 'dashboard.selectedCount_other', { count: selectedIds.size })}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setBulkEditOpen(true)} disabled={bulkBusy}>
              <Pencil size={14} className="mr-1.5" />
              {t('dashboard.editSelected')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => handleBulkPause(true)} disabled={bulkBusy}>
              <Pause size={14} className="mr-1.5" />
              {t('dashboard.pause')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => handleBulkPause(false)} disabled={bulkBusy}>
              <Play size={14} className="mr-1.5" />
              {t('dashboard.resume')}
            </Button>
            {/* DELETE /monitors/bulk needs 'monitors.manage' */}
            {canDelete && (
              <Button variant="danger" size="sm" onClick={handleBulkDelete} disabled={bulkBusy}>
                <Trash2 size={14} className="mr-1.5" />
                {t('dashboard.bulkDelete')}
              </Button>
            )}
            <button
              type="button"
              onClick={clearSelection}
              className="ml-auto text-xs text-text-muted hover:text-text-primary coarse:min-h-10 coarse:px-2"
            >
              {t('dashboard.cancelSelection')}
            </button>
          </div>
        )}
      </div>

      {/* Active group scope (URL filter, not the locked prop) */}
      {fixedGroupId == null && groupParam !== null && (
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Folder size={12} className="text-accent" />
          {groupParam === UNGROUPED
            ? t('dashboard.sectionUngrouped')
            : t('monitorList.inGroup', 'In {{name}} and its subgroups', { name: anonymize(scopedGroupName) || `#${groupParam}` })}
          <button type="button" onClick={() => setGroup('')} className="text-accent hover:underline">
            {t('monitorList.showAllGroups', 'Show all groups')}
          </button>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-status-down/30 bg-status-down-bg px-4 py-2.5 text-sm text-text-secondary">
          {t('dashboard.refreshError', 'Could not refresh the monitor list — showing the last known state.')}
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-lg bg-bg-secondary px-6 py-12 text-center text-sm text-text-muted">
          {base.length === 0
            ? t('monitorList.empty', 'No monitors here yet.')
            : t('monitorList.noMatch', 'No monitor matches these filters.')}
          {activeFilterCount > 0 && (
            <div className="mt-2">
              <button type="button" onClick={clearAll} className="text-accent hover:underline">
                {t('monitorList.clearFilters', 'Clear filters')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <TableScroll className="rounded-lg bg-bg-secondary" stickyFirstCol>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className={cn(thCls, 'px-3')}>
                  <div className="flex items-center gap-3">
                    {canSelect && (
                      <Checkbox
                        ref={selectAllRef}
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label={allSelected ? t('monitorList.deselectAll', 'Deselect all') : t('monitorList.selectAll', 'Select all')}
                        title={allSelected ? t('monitorList.deselectAll', 'Deselect all') : t('monitorList.selectAll', 'Select all')}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleSort('name')}
                      className={cn(
                        'inline-flex items-center gap-1 uppercase tracking-wide hover:text-text-primary coarse:min-h-10',
                        sortField === 'name' && 'text-text-primary',
                      )}
                    >
                      {t('common.name')}
                      {sortField === 'name' && (sortDir === 'asc' ? <SortAsc size={12} /> : <SortDesc size={12} />)}
                    </button>
                  </div>
                </th>
                {sortHeader('status', t('common.status'))}
                {sortHeader('type', t('common.type'))}
                {view === 'flat' ? sortHeader('group', t('common.group')) : <th className={thCls} />}
                {sortHeader('uptime', t('monitorList.colUptime', 'Uptime 24h'))}
                {sortHeader('response', t('monitorList.colResponse', 'Avg resp.'))}
                <th className={cn(thCls, 'text-right')}>
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">{rows}</tbody>
          </table>
        </TableScroll>
      )}

      <div className="text-xs text-text-muted">
        {t('monitorList.shownCount', '{{shown}} of {{total}} monitors', { shown: sorted.length, total: base.length })}
      </div>

      {bulkEditOpen && (
        <BulkEditModal
          monitorIds={Array.from(selectedIds)}
          isAgentSelection={false}
          onClose={() => setBulkEditOpen(false)}
        />
      )}
    </div>
  );
}
