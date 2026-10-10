import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Bell, FolderOpen, FolderTree, Inbox, PauseCircle, Server, ShieldAlert, Wrench,
} from 'lucide-react';
import { MASTER_TENANT_ID } from '@obliview/shared';
import type { GroupTreeNode, Monitor } from '@obliview/shared';
import { groupsApi, type GroupSummaryStats } from '@/api/groups.api';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsGodView } from '@/hooks/useIsGodView';
import { useTenantCollapse } from '@/hooks/useTenantCollapse';
import { TenantBucketHeader } from '@/components/common/TenantBucketHeader';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { effectiveStatus } from '@/utils/monitorStatus';
import { anonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

/** Live counts of one summary row (a group subtree, or the ungrouped monitors). */
type RowCounts = Pick<
  GroupSummaryStats,
  'monitors' | 'up' | 'down' | 'alert' | 'paused' | 'maintenance' | 'ssl' | 'agentsOnline' | 'agentsTotal'
>;

const EMPTY: RowCounts = {
  monitors: 0, up: 0, down: 0, alert: 0, paused: 0, maintenance: 0, ssl: 0, agentsOnline: 0, agentsTotal: 0,
};

/** Client-side counts of the ungrouped monitors (same rules as GET /groups/stats?counts=1). */
function countMonitors(monitors: Monitor[]): RowCounts {
  const c: RowCounts = { ...EMPTY };
  for (const m of monitors) {
    if (m.type === 'agent') {
      c.agentsTotal++;
      if (m.status === 'up' || m.status === 'alert') c.agentsOnline++;
      continue;
    }
    c.monitors++;
    switch (effectiveStatus(m)) {
      case 'up': c.up++; break;
      case 'down': c.down++; break;
      case 'alert': c.alert++; break;
      case 'paused': c.paused++; break;
      case 'maintenance': c.maintenance++; break;
      case 'ssl_warning':
      case 'ssl_expired': c.ssl++; break;
      default: break;
    }
  }
  return c;
}

function sortNodes(nodes: GroupTreeNode[]): GroupTreeNode[] {
  return [...nodes].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** /monitors deep link (group + optional status, tenant for the ungrouped rows). */
function monitorsLink(groupId: number | 'none', status?: string, tenantId?: number): string {
  const p = new URLSearchParams();
  p.set('groupId', String(groupId));
  if (status) p.set('status', status);
  if (tenantId != null) p.set('tenants', String(tenantId));
  return `/monitors?${p.toString()}`;
}

interface GroupSummaryTreeProps {
  /** The monitors of the store (ungrouped counts + refresh trigger on status changes). */
  monitors: Monitor[];
  /** Header action (e.g. "Create group"), rendered at the right of the title. */
  action?: ReactNode;
}

/**
 * Dashboard "By group" summary — Obliance DashboardPage GroupCard / group
 * view: every root group with its children indented below, each with live
 * counts (descendants included) from GET /groups/stats?counts=1. Every count
 * links to the filtered monitor list (/monitors?groupId=&status=). In God
 * View the roots are bucketed by tenant.
 */
export function GroupSummaryTree({ monitors, action }: GroupSummaryTreeProps) {
  const { t } = useTranslation();
  const isGodView = useIsGodView();
  const tree = useGroupStore((s) => s.tree);
  const tenants = useTenantStore((s) => s.tenants);
  const { isCollapsed, toggle } = useTenantCollapse();

  const [stats, setStats] = useState<Record<number, GroupSummaryStats> | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetch on mount, every 60 s, and (debounced) when a monitor status changes.
  const statusSignature = useMemo(
    () => monitors.map((m) => `${m.id}:${m.status}:${m.inMaintenance ? 1 : 0}:${m.groupId ?? ''}`).join('|'),
    [monitors],
  );
  const inFlight = useRef(false);
  const load = useRef(async () => {});
  load.current = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const data = await groupsApi.getSummaryStats();
      setStats(data);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
    }
  };
  useEffect(() => {
    load.current();
    const timer = setInterval(() => { load.current(); }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const firstSignature = useRef(true);
  useEffect(() => {
    if (firstSignature.current) { firstSignature.current = false; return; }
    const timer = setTimeout(() => { load.current(); }, 3_000);
    return () => clearTimeout(timer);
  }, [statusSignature, tree]);

  const countsOf = (id: number): RowCounts => stats?.[id] ?? EMPTY;
  const hasContent = (c: RowCounts) => c.monitors + c.agentsTotal > 0;

  // Ungrouped monitors, per tenant in God View (key 0 = single bucket).
  const ungroupedByTenant = useMemo(() => {
    const map = new Map<number, Monitor[]>();
    for (const m of monitors) {
      if (m.groupId !== null) continue;
      const key = isGodView ? (m.tenantId ?? 0) : 0;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return map;
  }, [monitors, isGodView]);

  // ── One summary row ──
  const renderRow = (opts: {
    key: string;
    name: string;
    to: string;
    depth: number;
    counts: RowCounts;
    link: (status?: string) => string;
    ungrouped?: boolean;
  }) => {
    const { counts: c, depth } = opts;
    const healthy = c.up;
    const ratio = c.monitors > 0 ? healthy / c.monitors : 1;
    const ratioColor = c.down > 0 ? 'text-status-down' : ratio >= 0.95 ? 'text-status-up' : 'text-amber-400';
    const barColor = c.down > 0 ? 'bg-status-down' : ratio >= 0.95 ? 'bg-status-up' : 'bg-amber-400';
    const metric = (status: string, value: number, icon: ReactNode, cls: string, title: string) =>
      value > 0 ? (
        <Link
          to={opts.link(status)}
          title={title}
          className={cn('flex items-center gap-1 font-mono text-[12px] hover:opacity-80 coarse:min-h-10', cls)}
        >
          {icon} {value}
        </Link>
      ) : null;

    return (
      <div
        key={opts.key}
        className="pl-[var(--gi-sm)] sm:pl-[var(--gi)]"
        style={{
          ['--gi' as string]: `${Math.min(depth, 4) * 18}px`,
          ['--gi-sm' as string]: `${Math.min(depth, 4) * 8}px`,
        } as CSSProperties}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-3 rounded-lg px-4 py-2.5 max-sm:flex-wrap max-sm:gap-y-2 max-sm:px-3',
            depth > 0 ? 'bg-bg-tertiary' : 'bg-bg-primary/40',
          )}
        >
          <Link
            to={opts.to}
            className="flex min-w-0 items-center gap-2 hover:opacity-90 max-sm:flex-1 coarse:min-h-10"
          >
            {opts.ungrouped
              ? <Inbox size={depth > 0 ? 14 : 16} className="shrink-0 text-text-muted" />
              : <FolderOpen size={depth > 0 ? 14 : 16} className="shrink-0 text-accent" />}
            <span className={cn('min-w-0 truncate text-[14px] font-semibold', opts.ungrouped ? 'text-text-muted' : 'text-text-primary')}>
              {opts.name}
            </span>
          </Link>

          {c.monitors > 0 && (
            <Link
              to={opts.link()}
              className="ml-1 flex items-center gap-1.5 hover:opacity-80"
              title={t('dashboard.groupUpTotal', '{{up}} up of {{total}} monitors', { up: healthy, total: c.monitors })}
            >
              <span className="font-mono text-[12px]">
                <span className={ratioColor}>{healthy}</span>
                <span className="text-text-muted"> / {c.monitors}</span>
              </span>
            </Link>
          )}

          {c.monitors > 0 && (
            <div className="mx-2 h-1.5 min-w-0 max-w-[240px] flex-1 overflow-hidden rounded bg-white/[0.04] max-sm:hidden">
              <div className={cn('h-full', barColor)} style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
          )}

          <div className="ml-auto flex shrink-0 items-center gap-3 max-sm:ml-0 max-sm:w-full max-sm:flex-wrap">
            {metric('down', c.down, <AlertTriangle size={13} />, 'text-status-down',
              t('dashboard.groupDown', '{{count}} down', { count: c.down }))}
            {metric('alert', c.alert, <Bell size={13} />, 'text-orange-500',
              t('dashboard.groupAlert', '{{count}} in alert', { count: c.alert }))}
            {metric('ssl', c.ssl, <ShieldAlert size={13} />, 'text-status-ssl-warning',
              t('dashboard.groupSsl', '{{count}} certificate issue(s)', { count: c.ssl }))}
            {metric('maintenance', c.maintenance, <Wrench size={13} />, 'text-status-maintenance',
              t('dashboard.groupMaintenance', '{{count}} in maintenance', { count: c.maintenance }))}
            {metric('paused', c.paused, <PauseCircle size={13} />, 'text-status-paused',
              t('dashboard.groupPaused', '{{count}} paused', { count: c.paused }))}
            {c.agentsTotal > 0 && (
              <Link
                to={opts.to}
                className="flex items-center gap-1 font-mono text-[12px] text-text-muted hover:text-text-secondary coarse:min-h-10"
                title={t('dashboard.groupAgents', '{{online}} of {{total}} agents online', { online: c.agentsOnline, total: c.agentsTotal })}
              >
                <Server size={13} />
                <span className={c.agentsOnline < c.agentsTotal ? 'text-amber-400' : 'text-status-up'}>{c.agentsOnline}</span>
                <span>/ {c.agentsTotal}</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderNode = (node: GroupTreeNode, depth: number): ReactNode => {
    const c = countsOf(node.id);
    if (stats && !hasContent(c)) return null;
    const children = sortNodes(node.children).map((child) => renderNode(child, depth + 1)).filter(Boolean);
    return (
      <div key={`g-${node.id}`} className="flex flex-col gap-2">
        {renderRow({
          key: `row-${node.id}`,
          name: anonymize(node.name),
          to: `/group/${node.id}`,
          depth,
          counts: c,
          link: (status) => monitorsLink(node.id, status),
        })}
        {children}
      </div>
    );
  };

  const renderUngrouped = (tenantKey: number, tenantId?: number): ReactNode => {
    const list = ungroupedByTenant.get(tenantKey) ?? [];
    const nonAgents = list.filter((m) => m.type !== 'agent');
    if (nonAgents.length === 0) return null;
    return renderRow({
      key: `ungrouped-${tenantKey}`,
      name: t('dashboard.sectionUngrouped'),
      to: monitorsLink('none', undefined, tenantId),
      depth: 0,
      counts: countMonitors(nonAgents),
      link: (status) => monitorsLink('none', status, tenantId),
      ungrouped: true,
    });
  };

  // ── Buckets ──
  const roots = sortNodes(tree);
  const tenantIds = new Set<number>();
  if (isGodView) {
    for (const r of roots) tenantIds.add(r.tenantId);
    for (const key of ungroupedByTenant.keys()) if (key > 0) tenantIds.add(key);
  }
  const bucketed = isGodView && tenantIds.size > 1;

  let body: ReactNode;
  if (bucketed) {
    const nameOf = (id: number) => tenants.find((tn) => tn.id === id)?.name ?? '';
    const ordered = [...tenantIds].sort((a, b) => {
      if (a === MASTER_TENANT_ID) return -1;
      if (b === MASTER_TENANT_ID) return 1;
      return nameOf(a).localeCompare(nameOf(b));
    });
    const buckets = ordered.map((tid) => {
      const nodes = roots.filter((r) => r.tenantId === tid).map((r) => renderNode(r, 0)).filter(Boolean);
      const ungrouped = renderUngrouped(tid, tid);
      if (nodes.length === 0 && !ungrouped) return null;
      const monitorTotal = roots
        .filter((r) => r.tenantId === tid)
        .reduce((sum, r) => sum + countsOf(r.id).monitors, 0)
        + (ungroupedByTenant.get(tid) ?? []).filter((m) => m.type !== 'agent').length;
      const collapsed = isCollapsed(tid);
      return (
        <div key={`tenant-${tid}`} className="flex flex-col gap-2">
          <TenantBucketHeader
            tenantId={tid}
            variant="bar"
            className="rounded-lg"
            collapsed={collapsed}
            onToggle={() => toggle(tid)}
            countLabel={t('dashboard.tenantMonitorCount', '{{count}} monitor(s)', { count: monitorTotal })}
          />
          {!collapsed && (
            <>
              {nodes}
              {ungrouped}
            </>
          )}
        </div>
      );
    }).filter(Boolean);
    body = buckets.length > 0 ? buckets : null;
  } else {
    const nodes = roots.map((r) => renderNode(r, 0)).filter(Boolean);
    const ungrouped = renderUngrouped(0);
    body = nodes.length > 0 || ungrouped ? <>{nodes}{ungrouped}</> : null;
  }

  return (
    <section className="rounded-[14px] bg-bg-secondary p-5 shadow-card max-sm:p-3">
      <div className="mb-4 flex items-center gap-3 max-sm:flex-wrap max-sm:gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <FolderTree size={16} className="shrink-0 text-accent" />
          <div>
            <div className="text-[15px] font-semibold text-text-primary">
              {t('dashboard.groupView', 'By group')}
            </div>
            <div className="font-mono text-[11px] tracking-wider text-text-muted">
              {t('dashboard.groupViewSub', 'up / total · down · alert · cert · maintenance · paused · agents')}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {action}
          <Link to="/monitors" className="font-mono text-[12px] text-accent transition-opacity hover:opacity-80 coarse:py-2">
            {t('dashboard.allMonitors', 'All monitors')} →
          </Link>
        </div>
      </div>

      {failed && !stats && (
        <div className="mb-3 text-xs text-status-down">
          {t('dashboard.groupStatsError', 'Could not load the group counts.')}
        </div>
      )}

      {!stats && !failed ? (
        <div className="flex justify-center py-6">
          <LoadingSpinner />
        </div>
      ) : body ?? (
        <div className="py-6 text-center text-sm text-text-muted">
          {t('dashboard.noGroups', 'No group yet — your monitors will appear here once grouped.')}
        </div>
      )}
    </section>
  );
}
