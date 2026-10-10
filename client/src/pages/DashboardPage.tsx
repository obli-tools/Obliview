import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Plus, Activity, AlertTriangle, CheckCircle2, FolderPlus, Server,
  LayoutList, LayoutGrid, RefreshCw,
} from 'lucide-react';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import type { Monitor, GroupTreeNode } from '@obliview/shared';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';

import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { estimateMaxBars } from '@/components/monitors/HeartbeatBar';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantBadge } from '@/components/common/TenantBadge';
import { CreateGroupModal } from '@/components/groups/CreateGroupModal';
import { PeekedGrid } from '@/components/dashboard/PeekedGrid';
import { MonitorCardTile } from '@/components/dashboard/MonitorCardTile';
import { AgentCardTile } from '@/components/dashboard/AgentCardTile';
import { DashboardHero } from '@/components/dashboard/DashboardHero';
import { GroupSummaryTree } from '@/components/dashboard/GroupSummaryTree';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';
import { effectiveStatus, compareByEffectiveStatus } from '@/utils/monitorStatus';

/** Rows shown in "Needs attention" before the "show all" link. */
const ATTENTION_LIMIT = 8;

function indexGroupNames(nodes: GroupTreeNode[], map = new Map<number, string>()): Map<number, string> {
  for (const n of nodes) {
    map.set(n.id, n.name);
    indexGroupNames(n.children, map);
  }
  return map;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { canCreate, canCreateGroup, hasCapability } = useAuthStore();
  const { openAddAgentModal, dashboardLayout, setDashboardLayout } = useUiStore();
  const {
    fetchMonitors, fetchAllHeartbeats, fetchSummary,
    getMonitorList, getRecentHeartbeats,
    isLoading, loaded, error,
  } = useMonitorStore();
  const { tree, fetchTree } = useGroupStore();
  const [createGroupOpen, setCreateGroupOpen] = useState(false);

  useEffect(() => {
    fetchMonitors();
    fetchAllHeartbeats(estimateMaxBars());
    fetchTree();
    // The per-monitor 24h summary (hero) lives in the store. The dashboard
    // refreshes it itself (on mount and every 60 s below): the sidebar tree
    // that also polls it is not mounted in the collapsed rail or while the
    // phone/tablet drawer is closed. Concurrent calls share one request.
    fetchSummary();
  }, [fetchMonitors, fetchAllHeartbeats, fetchTree, fetchSummary]);

  useEffect(() => {
    const timer = setInterval(() => { fetchSummary(); }, 60_000);
    return () => clearInterval(timer);
  }, [fetchSummary]);

  const retry = () => {
    fetchMonitors();
    fetchAllHeartbeats(estimateMaxBars());
    fetchTree();
  };

  const monitors = getMonitorList();
  const showCreate = canCreate();
  // Group creation needs 'groups.manage' (server: requireCanCreate('groups.manage')).
  const showCreateGroup = canCreateGroup();
  const cardsLayout = dashboardLayout === 'cards';

  // ── Cards-layout: flat lists sorted by effective status (maintenance is not down) ──
  const cardMonitors = useMemo(
    () => monitors.filter((m) => m.type !== 'agent').sort(compareByEffectiveStatus),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monitors],
  );
  const cardAgents = useMemo(
    () => monitors.filter((m) => m.type === 'agent').sort(compareByEffectiveStatus),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monitors],
  );
  // Same definition as the hero: an agent in alert is still online.
  const cardAgentsOnline = cardAgents.filter((m) => m.status === 'up' || m.status === 'alert').length;

  // ── Needs attention: down and alert, read through effectiveStatus (a
  // monitor in a maintenance window is neither). Agents included. ──
  const attention = useMemo(
    () => monitors
      .filter((m) => {
        const s = effectiveStatus(m);
        return s === 'down' || s === 'alert';
      })
      .sort(compareByEffectiveStatus),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [monitors],
  );
  const groupNames = useMemo(() => indexGroupNames(tree), [tree]);
  // The monitor list excludes agents (they live in /agents): link each kind
  // to its own list. AgentListPage's ?runtime= takes a single value.
  const attentionAgentList = attention.filter((m) => m.type === 'agent');
  const attentionMonitors = attention.length - attentionAgentList.length;
  const attentionAgents = attentionAgentList.length;
  const attentionAgentsLink = attentionAgentList.every((m) => effectiveStatus(m) === 'down')
    ? '/agents?runtime=offline'
    : attentionAgentList.every((m) => effectiveStatus(m) === 'alert')
      ? '/agents?runtime=alert'
      : '/agents';

  // First load (or a reload of an empty list) — not the empty state yet.
  if (monitors.length === 0 && !error && (!loaded || isLoading)) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-[24px] font-semibold tracking-[0.02em] text-text-primary">{t('dashboard.title')}</h1>
      <div className="flex flex-wrap items-center gap-2">
        {/* Layout toggle */}
        {monitors.length > 0 && (
          <div className="flex items-center overflow-hidden rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setDashboardLayout('list')}
              title={t('dashboard.layoutList')}
              aria-label={t('dashboard.layoutList')}
              aria-pressed={!cardsLayout}
              className={cn(
                'p-1.5 transition-colors coarse:p-2.5',
                !cardsLayout
                  ? 'bg-bg-tertiary text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              <LayoutList size={15} />
            </button>
            <button
              type="button"
              onClick={() => setDashboardLayout('cards')}
              title={t('dashboard.layoutCards')}
              aria-label={t('dashboard.layoutCards')}
              aria-pressed={cardsLayout}
              className={cn(
                'p-1.5 transition-colors coarse:p-2.5',
                cardsLayout
                  ? 'bg-bg-tertiary text-text-primary'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              <LayoutGrid size={15} />
            </button>
          </div>
        )}

        {showCreate && (
          <>
            {/* Add agent opens a modal that reads GET /agent/keys (agents.manage) */}
            {hasCapability('agents.manage') && (
              <Button variant="secondary" size="sm" onClick={openAddAgentModal}>
                <Plus size={16} className="mr-1.5" />
                {t('dashboard.addAgent')}
              </Button>
            )}
            <Link to="/monitor/new">
              <Button variant="secondary" size="sm">
                <Plus size={16} className="mr-1.5" />
                {t('dashboard.addMonitor')}
              </Button>
            </Link>
          </>
        )}
      </div>
    </div>
  );

  const createGroupModal = showCreateGroup && (
    <CreateGroupModal open={createGroupOpen} onClose={() => setCreateGroupOpen(false)} defaultParentId={null} />
  );

  // ── Load failure with nothing to show: error state, not "no monitors" ──
  if (monitors.length === 0 && error) {
    return (
      <PageContainer className="flex flex-col gap-[18px]">
        {header}
        <div className="flex flex-col items-center justify-center gap-3 rounded-[14px] bg-bg-secondary px-6 py-14 text-center shadow-card">
          <AlertTriangle size={28} className="text-status-down" />
          <div className="text-[15px] font-semibold text-text-primary">
            {t('dashboard.loadErrorTitle', 'Could not load your monitors')}
          </div>
          <p className="max-w-md text-sm text-text-muted">
            {t('dashboard.loadErrorDesc', 'The server did not answer or returned an error. Check your connection, then try again.')}
          </p>
          <Button variant="secondary" size="sm" onClick={retry} loading={isLoading}>
            {!isLoading && <RefreshCw size={14} className="mr-1.5" />}
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      </PageContainer>
    );
  }

  // ── Nothing visible yet: empty state with the create actions ──
  if (monitors.length === 0) {
    return (
      <PageContainer className="flex flex-col gap-[18px]">
        {header}
        <div className="flex flex-col items-center justify-center gap-3 rounded-[14px] bg-bg-secondary px-6 py-14 text-center shadow-card">
          <Activity size={28} className="text-accent" />
          <div className="text-[15px] font-semibold text-text-primary">
            {t('dashboard.emptyTitle', 'No monitors yet')}
          </div>
          <p className="max-w-md text-sm text-text-muted">
            {showCreate || showCreateGroup
              ? t('dashboard.emptyDesc', 'Create a monitor to start watching a service, or a group to organise your monitors.')
              : t('dashboard.emptyDescReadOnly', 'No monitor is shared with you yet. Ask an administrator for access.')}
          </p>
          {(showCreate || showCreateGroup) && (
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              {showCreate && (
                <Link to="/monitor/new">
                  <Button size="sm">
                    <Plus size={16} className="mr-1.5" />
                    {t('dashboard.createMonitor', 'Create monitor')}
                  </Button>
                </Link>
              )}
              {showCreateGroup && (
                <Button variant="secondary" size="sm" onClick={() => setCreateGroupOpen(true)}>
                  <FolderPlus size={16} className="mr-1.5" />
                  {t('dashboard.createGroup', 'Create group')}
                </Button>
              )}
            </div>
          )}
        </div>
        {createGroupModal}
      </PageContainer>
    );
  }

  const attentionShown = attention.slice(0, ATTENTION_LIMIT);

  return (
    <PageContainer className="flex flex-col gap-[18px]">
      {header}

      {/* A refresh failed: the list below is the last one received */}
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-status-down/30 bg-status-down-bg px-4 py-2.5">
          <AlertTriangle size={16} className="shrink-0 text-status-down" />
          <span className="min-w-0 flex-1 text-sm text-text-secondary">
            {t('dashboard.refreshError', 'Could not refresh the monitor list — showing the last known state.')}
          </span>
          <Button variant="secondary" size="sm" onClick={retry} loading={isLoading}>
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      )}

      {/* Operator Overview (the only KPI band) */}
      <DashboardHero monitors={monitors} />

      {/* ── Needs attention (down / alert, maintenance excluded) ── */}
      <section className="rounded-[14px] bg-bg-secondary p-5 shadow-card max-sm:p-3">
        <div className="mb-3 flex items-center gap-2">
          <AlertTriangle size={16} className={attention.length > 0 ? 'text-status-down' : 'text-text-muted'} />
          <span className="text-[15px] font-semibold text-text-primary">
            {t('dashboard.needsAttention', 'Needs attention')}
          </span>
          {attention.length > 0 && (
            <span className="rounded-full bg-status-down-bg px-2 py-0.5 text-xs font-semibold text-status-down">
              {attention.length}
            </span>
          )}
          {attention.length > 0 && (
            <div className="ml-auto flex flex-wrap justify-end gap-3">
              {attentionMonitors > 0 && (
                <Link
                  to="/monitors?status=down,alert"
                  className="font-mono text-[12px] text-accent transition-opacity hover:opacity-80 coarse:py-2"
                >
                  {t('dashboard.attentionShowAll', 'Open in monitor list')} →
                </Link>
              )}
              {attentionAgents > 0 && (
                <Link
                  to={attentionAgentsLink}
                  className="font-mono text-[12px] text-accent transition-opacity hover:opacity-80 coarse:py-2"
                >
                  {t('dashboard.attentionShowAgents', 'Open in agent list')} →
                </Link>
              )}
            </div>
          )}
        </div>
        {attention.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-sm text-text-muted">
            <CheckCircle2 size={16} className="text-status-up" />
            {t('dashboard.attentionNone', 'Nothing down or in alert.')}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {attentionShown.map((m) => (
              <AttentionRow key={m.id} monitor={m} groupName={m.groupId != null ? groupNames.get(m.groupId) : undefined} />
            ))}
          </ul>
        )}
        {attention.length > ATTENTION_LIMIT && (
          <div className="mt-2 text-xs text-text-muted">
            {t('dashboard.attentionMore', '+ {{count}} more', { count: attention.length - ATTENTION_LIMIT })}
          </div>
        )}
      </section>

      {cardsLayout ? (
        /* ── Cards layout ── */
        <div>
          {/* Monitors grid */}
          {cardMonitors.length > 0 && (
            <PeekedGrid
              title={t('dashboard.sectionMonitors')}
              icon={<Activity size={14} className="text-accent" />}
              count={`${cardMonitors.length}`}
              cardWidth={290}
              rows={cardMonitors.length > 4 ? 2 : 1}
            >
              {cardMonitors.map((m) => (
                <MonitorCardTile
                  key={m.id}
                  monitor={m}
                  heartbeats={getRecentHeartbeats(m.id)}
                />
              ))}
            </PeekedGrid>
          )}

          {/* Agents grid */}
          {cardAgents.length > 0 && (
            <PeekedGrid
              title={t('dashboard.sectionAgents')}
              icon={<Server size={14} className="text-accent" />}
              count={t('dashboard.agentsOnlineTotal', {
                online: cardAgentsOnline,
                total: cardAgents.length,
                defaultValue: '{{online}} online · {{total}} total',
              })}
              cardWidth={450}
              rows={cardAgents.length > 3 ? 2 : 1}
            >
              {cardAgents.map((m) => (
                <AgentCardTile
                  key={m.id}
                  monitor={m}
                  heartbeats={getRecentHeartbeats(m.id)}
                />
              ))}
            </PeekedGrid>
          )}
        </div>
      ) : (
        /* ── List layout: group summary tree ── */
        <GroupSummaryTree
          monitors={monitors}
          action={showCreateGroup ? (
            <button
              type="button"
              onClick={() => setCreateGroupOpen(true)}
              className="flex items-center gap-1 font-mono text-[12px] text-text-muted transition-colors hover:text-accent coarse:py-2"
            >
              <FolderPlus size={13} />
              {t('dashboard.createGroup', 'Create group')}
            </button>
          ) : undefined}
        />
      )}

      {createGroupModal}
    </PageContainer>
  );
}

/** Compact "Needs attention" row: status, name, type, group, tenant (God View). */
function AttentionRow({ monitor: m, groupName }: { monitor: Monitor; groupName?: string }) {
  const { t } = useTranslation();
  const isAgent = m.type === 'agent';
  // Agent monitors open the device page (same rule as MonitorCard).
  const to = isAgent && m.agentDeviceId ? `/agents/${m.agentDeviceId}` : `/monitor/${m.id}`;
  return (
    <li className="flex min-w-0 items-center gap-3 py-2 max-sm:flex-wrap max-sm:gap-y-1">
      <MonitorStatusBadge status={m.status} size="sm" />
      <Link to={to} className="min-w-0 truncate text-sm font-medium text-text-primary hover:text-accent max-sm:flex-1">
        {anonymize(m.name)}
      </Link>
      <TenantBadge tenantId={m.tenantId} />
      <span className={cn('ml-auto shrink-0 text-xs text-text-muted', 'max-sm:ml-0')}>
        {isAgent ? t('common.agent') : (MONITOR_TYPE_LABELS[m.type] ?? m.type)}
        {groupName ? ` · ${anonymize(groupName)}` : ''}
      </span>
    </li>
  );
}
