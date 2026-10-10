import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Pencil, Pause, Play, Trash2, ArrowLeft, FolderOpen, FolderPlus, RotateCcw, Globe,
  Bell, Activity, Server,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { GroupTreeNode, Heartbeat, Monitor, MonitorGroup, MonitorStatus } from '@obliview/shared';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';
import { useGroupStore } from '@/store/groupStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useAuthStore } from '@/store/authStore';
import { groupsApi } from '@/api/groups.api';
import { monitorsApi } from '@/api/monitors.api';
import { HeartbeatChart } from '@/components/monitors/HeartbeatChart';
import { HeartbeatBar } from '@/components/monitors/HeartbeatBar';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PeriodSelector } from '@/components/common/PeriodSelector';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useLocateRedirect } from '@/hooks/useLocateRedirect';
import { GroupMembersSection } from '@/components/groups/GroupMembersSection';
import { CreateGroupModal } from '@/components/groups/CreateGroupModal';
import { computeWritableGroupIds, canWriteTreeGroup } from '@/components/groups/GroupNode';

// ─────────────────────────────────────────────────────────────────────────────
// Read-only group page. A group is hybrid (migration 054): it can hold
// monitors and agents side by side, so the page renders two independent
// blocks — "Monitors" (non-agent monitors: period stats, heartbeat bar/chart,
// list) and "Agents" (online / alert / offline, list) — and hides only the
// empty one. Every setting lives on /group/:id/edit.
// ─────────────────────────────────────────────────────────────────────────────

const PROBLEM_STATUSES = new Set<MonitorStatus>(['down', 'ssl_expired', 'ssl_warning', 'alert']);

/** In maintenance and not up: shown (and counted) as maintenance, not as a problem. */
const isMaintenance = (m: Monitor) => !!m.inMaintenance && m.status !== 'up';

function findNodeById(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

function collectSubtreeIds(node: GroupTreeNode, into: Set<number> = new Set()): Set<number> {
  into.add(node.id);
  for (const child of node.children) collectSubtreeIds(child, into);
  return into;
}

interface CheckStats {
  up: number;
  problemNames: string[];
  maintenanceNames: string[];
  paused: number;
}

function computeCheckStats(monitors: Monitor[]): CheckStats {
  const stats: CheckStats = { up: 0, problemNames: [], maintenanceNames: [], paused: 0 };
  for (const m of monitors) {
    if (isMaintenance(m)) stats.maintenanceNames.push(m.name);
    else if (m.status === 'up') stats.up++;
    else if (PROBLEM_STATUSES.has(m.status)) stats.problemNames.push(m.name);
    else if (m.status === 'paused') stats.paused++;
  }
  return stats;
}

interface AgentStats {
  online: number;
  alertNames: string[];
  offlineNames: string[];
  maintenanceNames: string[];
  paused: number;
  pending: number;
}

const agentName = (m: Monitor) => m.agentDeviceName ?? m.name;

function computeAgentStats(agents: Monitor[]): AgentStats {
  const stats: AgentStats = { online: 0, alertNames: [], offlineNames: [], maintenanceNames: [], paused: 0, pending: 0 };
  for (const m of agents) {
    if (isMaintenance(m)) stats.maintenanceNames.push(agentName(m));
    else if (m.status === 'up') stats.online++;
    else if (m.status === 'alert') stats.alertNames.push(agentName(m));
    else if (m.status === 'down' || m.status === 'inactive') stats.offlineNames.push(agentName(m));
    else if (m.status === 'paused') stats.paused++;
    else stats.pending++;
  }
  return stats;
}

type GroupDetailStats = Awaited<ReturnType<typeof groupsApi.getDetailStats>>;

function StatCard({
  label, value, valueClass, hint, tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  valueClass?: string;
  hint?: ReactNode;
  tone?: 'neutral' | 'up' | 'down' | 'alert' | 'pending' | 'maintenance';
}) {
  return (
    <div className={cn(
      'rounded-lg border bg-bg-secondary p-4 min-w-0',
      tone === 'neutral' && 'border-border',
      tone === 'up' && 'border-status-up/30',
      tone === 'down' && 'border-status-down/30 bg-status-down-bg',
      tone === 'alert' && 'border-orange-500/30',
      tone === 'pending' && 'border-yellow-500/30',
      tone === 'maintenance' && 'border-status-maintenance/30',
    )}>
      <div className="text-sm text-text-secondary mb-1">{label}</div>
      <div className={cn('text-xl font-mono font-semibold text-text-primary', valueClass)}>{value}</div>
      {hint && <div className="text-xs text-text-muted mt-0.5 truncate">{hint}</div>}
    </div>
  );
}

const STATS_GRID = 'grid gap-4 mb-6 grid-cols-[repeat(auto-fit,minmax(160px,1fr))] max-sm:grid-cols-2 max-sm:gap-3';

export function GroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const groupId = parseInt(id!, 10);
  // Fresh state per group: the route element is reused across /group/:id.
  return <GroupDetailView key={groupId} groupId={groupId} />;
}

function GroupDetailView({ groupId }: { groupId: number }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { isAdmin, canCreateGroup, canWriteGroup, canWriteMonitor, permissions, hasCapability } = useAuthStore();
  const storeGroup = useGroupStore((s) => s.groups.get(groupId));
  const tree = useGroupStore((s) => s.tree);
  const { removeGroup, fetchGroups, fetchTree } = useGroupStore();
  const storeMonitors = useMonitorStore((s) => s.monitors);
  const updateStoreMonitor = useMonitorStore((s) => s.updateMonitor);

  const admin = isAdmin();
  // RW on an ancestor covers this group (server: closure table); the store's
  // canWriteGroup only reads direct grants, which still count while the tree
  // is loading.
  const writableIds = useMemo(
    () => computeWritableGroupIds(tree, admin, permissions?.permissions),
    [tree, admin, permissions],
  );
  const canWrite = canWriteGroup(groupId) || canWriteTreeGroup(writableIds, groupId);

  const [fetchedGroup, setFetchedGroup] = useState<MonitorGroup | null>(null);
  const [snapshot, setSnapshot] = useState<Monitor[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('24h');
  const [periodHeartbeats, setPeriodHeartbeats] = useState<Heartbeat[]>([]);
  const [stats, setStats] = useState<GroupDetailStats | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  // The store copy follows the group:* socket events; the fetched one covers
  // a group outside the loaded list (e.g. another tenant's, for an admin).
  const group = storeGroup ?? fetchedGroup;

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      groupsApi.getById(groupId),
      groupsApi.getMonitors(groupId, true),
    ]).then(([g, m]) => {
      if (cancelled) return;
      if (g.status === 'fulfilled') setFetchedGroup(g.value);
      if (m.status === 'fulfilled') setSnapshot(m.value);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [groupId]);

  // ── Members (live) ─────────────────────────────────────────────────────────
  const node = useMemo(() => findNodeById(tree, groupId), [tree, groupId]);
  const subtreeIds = useMemo(() => (node ? collectSubtreeIds(node) : null), [node]);

  const members = useMemo<Monitor[]>(() => {
    // Live path: the monitor store holds every visible monitor of the tenant
    // (status, pause and maintenance follow the socket) and the tree gives the
    // subtree of this group.
    if (subtreeIds && storeMonitors.size > 0) {
      return [...storeMonitors.values()].filter((m) => m.groupId !== null && subtreeIds.has(m.groupId));
    }
    // Group outside the loaded tree, or store not loaded yet: the server
    // snapshot, overlaid with whatever live state the store already has.
    return snapshot.map((m) => storeMonitors.get(m.id) ?? m);
  }, [subtreeIds, storeMonitors, snapshot]);

  const checkMonitors = useMemo(() => members.filter((m) => m.type !== 'agent'), [members]);
  const agentMonitors = useMemo(() => members.filter((m) => m.type === 'agent'), [members]);
  const hasMonitors = checkMonitors.length > 0;
  const hasAgents = agentMonitors.length > 0;
  const isEmpty = members.length === 0;

  // Period stats + heartbeats (server side: non-agent monitors only)
  useEffect(() => {
    if (!hasMonitors) {
      setPeriodHeartbeats([]);
      setStats(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      groupsApi.getHeartbeats(groupId, period),
      groupsApi.getDetailStats(groupId, period),
    ]).then(([hbs, s]) => {
      if (cancelled) return;
      setPeriodHeartbeats(hbs);
      setStats(s);
    }).catch(() => {
      if (cancelled) return;
      setPeriodHeartbeats([]);
      setStats(null);
    });
    return () => { cancelled = true; };
  }, [groupId, period, hasMonitors]);

  const checkStats = useMemo(() => computeCheckStats(checkMonitors), [checkMonitors]);
  const agentStats = useMemo(() => computeAgentStats(agentMonitors), [agentMonitors]);

  // Deep link to another workspace's group: switch there and reload this URL.
  const locate = useLocateRedirect('group', groupId, !loading && !group);

  if (!group && (loading || locate.pending)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <LoadingSpinner size="lg" />
        {locate.status === 'switching' && locate.tenantName && (
          <p className="text-sm text-text-muted">
            {t('tenant.locate.switching', { tenant: locate.tenantName })}
          </p>
        )}
      </div>
    );
  }

  if (!group) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">{t('groups.notFound', 'Group not found')}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('monitors.backToDashboard')}</Button>
        </Link>
      </div>
    );
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleDelete = async () => {
    if (!(await confirm({ message: t('groups.confirmDelete', { name: group.name }), danger: true }))) return;
    try {
      await groupsApi.delete(groupId);
      removeGroup(groupId);
      fetchGroups();
      fetchTree();
      toast.success(t('groups.deleted'));
      navigate('/');
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedDelete')));
    }
  };

  const handleClearHeartbeats = async () => {
    const ok = await confirm({
      message: t('groups.confirmClear', { name: group.name }),
      confirmLabel: t('groups.detail.clearData'),
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await groupsApi.clearHeartbeats(groupId);
      toast.success(t('groups.cleared', { heartbeats: result.deleted, monitors: result.monitorCount }));
      setPeriodHeartbeats([]);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedClear')));
    }
  };

  // Pause / resume every non-agent monitor of the subtree in one call. Agents
  // are left out: pausing an agent monitor suspends its device (agents page).
  // RW on this group covers its whole subtree (server: closure table); the
  // client permission map only lists direct grants, hence the `canWrite ||`.
  const pausable = checkMonitors.filter((m) => canWrite || canWriteMonitor(m.id, m.groupId));
  const pausedIds = pausable.filter((m) => m.status === 'paused').map((m) => m.id);
  const activeIds = pausable.filter((m) => m.status !== 'paused').map((m) => m.id);
  const hasPaused = pausedIds.length > 0;

  const handleBulkPause = async (pause: boolean) => {
    const ids = pause ? activeIds : pausedIds;
    if (ids.length === 0) {
      toast(t(pause ? 'groups.noActive' : 'groups.noPaused'));
      return;
    }
    setBulkBusy(true);
    try {
      await monitorsApi.bulkPause(ids, pause);
      const status: MonitorStatus = pause ? 'paused' : 'pending';
      const idSet = new Set(ids);
      ids.forEach((mid) => updateStoreMonitor(mid, { status }));
      setSnapshot((prev) => prev.map((m) => (idSet.has(m.id) ? { ...m, status } : m)));
      toast.success(t(pause ? 'groups.pausedAll' : 'groups.resumedAll', { count: ids.length }));
    } catch (err) {
      toast.error(apiErrorMessage(err, t(pause ? 'groups.failedPause' : 'groups.failedResume')));
    } finally {
      setBulkBusy(false);
    }
  };

  // Non-admins need canCreate + 'groups.manage' + write access on the parent (server rule).
  const canCreateSubgroup = admin || (canCreateGroup() && canWrite);
  // DELETE /groups/:id needs 'groups.manage' on top of write access.
  const canDeleteGroup = canWrite && hasCapability('groups.manage');

  const countParts: string[] = [];
  if (hasAgents) {
    countParts.push(t('groups.detail.agentCount', {
      count: agentMonitors.length,
      defaultValue_one: '{{count}} agent',
      defaultValue_other: '{{count}} agents',
    }));
  }
  if (hasMonitors) {
    countParts.push(t('groups.detail.monitorCount', {
      count: checkMonitors.length,
      defaultValue_one: '{{count}} monitor',
      defaultValue_other: '{{count}} monitors',
    }));
  }

  const monitorLink = (m: Monitor) => `/monitor/${m.id}`;
  // /agents/:id is open to everyone who sees the agent (server-side read check).
  const agentLink = (m: Monitor) => (m.agentDeviceId ? `/agents/${m.agentDeviceId}` : `/monitor/${m.id}`);

  return (
    <PageContainer>
      {/* Back button: previous page when there is one (deep links land here
          with no history), else the dashboard. */}
      <button
        type="button"
        onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4 coarse:min-h-10"
      >
        <ArrowLeft size={14} />
        {t('common.back')}
      </button>

      {/* Header — below md the title block takes the full width and the
          actions drop to their own line. */}
      <div className="flex items-start justify-between gap-4 mb-6 max-md:flex-wrap max-md:gap-3">
        <div className="flex items-center gap-4 min-w-0 max-md:basis-full max-sm:gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent/10 max-sm:h-10 max-sm:w-10">
            <FolderOpen size={24} className="text-accent" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold text-text-primary break-words max-sm:text-xl">{anonymize(group.name)}</h1>
              <TenantBadge tenantId={group.tenantId} size="md" />
            </div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {countParts.length > 0 && (
                <span className="inline-flex items-center rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                  {countParts.join(' · ')}
                </span>
              )}
              {group.isGeneral && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                  <Globe size={10} />
                  {t('groups.generalBadge')}
                </span>
              )}
              {group.groupNotifications && (
                <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-[10px] font-medium text-yellow-500">
                  <Bell size={10} />
                  {t('groups.groupedBadge')}
                </span>
              )}
              {group.description && (
                <span className="text-sm text-text-muted">{group.description}</span>
              )}
            </div>
          </div>
        </div>

        {(canWrite || canCreateSubgroup) && (
          <div className="flex items-center gap-2 flex-wrap justify-end max-md:justify-start">
            {canWrite && (
              <Link to={`/group/${groupId}/edit`}>
                <Button variant="secondary" size="sm">
                  <Pencil size={14} className="mr-1.5" />
                  {t('common.edit')}
                </Button>
              </Link>
            )}
            {canCreateSubgroup && (
              <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
                <FolderPlus size={14} className="mr-1.5" />
                {t('groups.newSubgroup', 'New subgroup')}
              </Button>
            )}
            {canWrite && pausable.length > 0 && (hasPaused ? (
              <Button variant="secondary" size="sm" onClick={() => handleBulkPause(false)} loading={bulkBusy}>
                <Play size={14} className="mr-1.5" />
                {t('groups.detail.resumeAll')}
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => handleBulkPause(true)} loading={bulkBusy}>
                <Pause size={14} className="mr-1.5" />
                {t('groups.detail.pauseAll')}
              </Button>
            ))}
            {canWrite && (
              <Button variant="secondary" size="sm" onClick={handleClearHeartbeats}>
                <RotateCcw size={14} className="mr-1.5" />
                {t('groups.detail.clearData')}
              </Button>
            )}
            {canDeleteGroup && (
              <Button variant="danger" size="sm" onClick={handleDelete}>
                <Trash2 size={14} className="mr-1.5" />
                {t('common.delete')}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── Monitors block (non-agent monitors; also shown for an empty group) ── */}
      {(hasMonitors || isEmpty) && (
        <section className="mb-8">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-text-secondary uppercase tracking-wide">
              <Activity size={14} />
              {t('groups.detail.monitors')}
            </h2>
            {hasMonitors && <PeriodSelector value={period} onChange={setPeriod} />}
          </div>

          {hasMonitors && (
            <>
              <div className={STATS_GRID}>
                {stats && (
                  <StatCard
                    label={t('groups.detail.uptime')}
                    value={`${stats.uptimePct}%`}
                    valueClass={stats.uptimePct >= 99 ? 'text-status-up' : stats.uptimePct >= 95 ? 'text-yellow-500' : 'text-status-down'}
                  />
                )}
                <StatCard
                  label={t('groups.detail.monitors')}
                  value={checkMonitors.length}
                  hint={t('groups.detail.monitorBreakdown', '{{up}} up / {{down}} down', {
                    up: checkStats.up,
                    down: checkStats.problemNames.length,
                  })}
                />
                {checkStats.problemNames.length > 0 && (
                  <StatCard
                    tone="down"
                    label={t('groups.detail.downMonitors')}
                    value={checkStats.problemNames.length}
                    valueClass="text-status-down"
                    hint={checkStats.problemNames.map((n) => anonymize(n)).join(', ')}
                  />
                )}
                {checkStats.maintenanceNames.length > 0 && (
                  <StatCard
                    tone="maintenance"
                    label={t('groups.detail.inMaintenance', 'In maintenance')}
                    value={checkStats.maintenanceNames.length}
                    valueClass="text-status-maintenance"
                    hint={checkStats.maintenanceNames.map((n) => anonymize(n)).join(', ')}
                  />
                )}
                {stats && (
                  <StatCard
                    label={t('groups.detail.avgResponse')}
                    value={stats.avgResponseTime ? `${stats.avgResponseTime}ms` : t('common.na')}
                  />
                )}
                {stats && (
                  <StatCard
                    label={t('groups.detail.totalChecks')}
                    value={stats.total.toLocaleString()}
                  />
                )}
              </div>

              <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">{t('monitors.heartbeatHistory')}</h3>
                <HeartbeatBar heartbeats={periodHeartbeats} />
              </div>
              <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">{t('monitors.responseTime')}</h3>
                <HeartbeatChart heartbeats={periodHeartbeats} height={250} period={period} />
              </div>
            </>
          )}

          <GroupMembersSection
            rootGroupId={groupId}
            rootNode={node}
            members={checkMonitors}
            title={t('groups.detail.monitorList', { count: checkMonitors.length })}
            emptyText={t('groups.detail.emptyGroup', 'No monitors or agents in this group yet.')}
            linkFor={monitorLink}
            metaFor={(m) => MONITOR_TYPE_LABELS[m.type]}
          />
        </section>
      )}

      {/* ── Agents block ── */}
      {hasAgents && (
        <section className="mb-8">
          <h2 className="flex items-center gap-2 mb-4 text-sm font-semibold text-text-secondary uppercase tracking-wide">
            <Server size={14} />
            {t('groups.sections.agents', 'Agents')}
          </h2>

          <div className={STATS_GRID}>
            <StatCard label={t('groups.detail.totalAgents')} value={agentMonitors.length} />
            <StatCard tone="up" label={t('groups.detail.online')} value={agentStats.online} valueClass="text-status-up" />
            {agentStats.alertNames.length > 0 && (
              <StatCard
                tone="alert"
                label={t('groups.detail.alert')}
                value={agentStats.alertNames.length}
                valueClass="text-orange-400"
                hint={agentStats.alertNames.map((n) => anonymize(n)).join(', ')}
              />
            )}
            {agentStats.offlineNames.length > 0 && (
              <StatCard
                label={t('groups.detail.offline')}
                value={agentStats.offlineNames.length}
                valueClass="text-status-down"
                hint={agentStats.offlineNames.map((n) => anonymize(n)).join(', ')}
                tone="down"
              />
            )}
            {agentStats.maintenanceNames.length > 0 && (
              <StatCard
                tone="maintenance"
                label={t('groups.detail.inMaintenance', 'In maintenance')}
                value={agentStats.maintenanceNames.length}
                valueClass="text-status-maintenance"
                hint={agentStats.maintenanceNames.map((n) => anonymize(n)).join(', ')}
              />
            )}
            {agentStats.paused > 0 && (
              <StatCard label={t('groups.detail.paused', 'Paused')} value={agentStats.paused} />
            )}
            {agentStats.pending > 0 && (
              <StatCard tone="pending" label={t('groups.detail.pending')} value={agentStats.pending} valueClass="text-yellow-400" />
            )}
          </div>

          <GroupMembersSection
            rootGroupId={groupId}
            rootNode={node}
            members={agentMonitors}
            title={t('groups.detail.agentList', { count: agentMonitors.length })}
            linkFor={agentLink}
            nameFor={agentName}
            metaFor={() => t('common.agent')}
          />
        </section>
      )}

      {canCreateSubgroup && (
        <CreateGroupModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          defaultParentId={groupId}
        />
      )}
    </PageContainer>
  );
}
