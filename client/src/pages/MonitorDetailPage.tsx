import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link, Navigate } from 'react-router-dom';
import { Pencil, Pause, Play, Trash2, ArrowLeft, Copy, ShieldAlert, ShieldX, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { anonymize, anonymizeUrl } from '@/utils/anonymize';
import { useMonitorStore } from '@/store/monitorStore';
import { useAuthStore } from '@/store/authStore';
import { monitorsApi } from '@/api/monitors.api';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { HeartbeatChart } from '@/components/monitors/HeartbeatChart';
import { HeartbeatBar } from '@/components/monitors/HeartbeatBar';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { PageContainer } from '@/components/common/PageContainer';
import { PeriodSelector } from '@/components/common/PeriodSelector';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useLocateRedirect } from '@/hooks/useLocateRedirect';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { RemediationBindingsPanel } from '@/components/remediation/RemediationBindingsPanel';
import { MaintenanceWindowList } from '@/components/maintenance/MaintenanceWindowList';
import type { Heartbeat, Monitor, MonitorPeriodStats, MonitorStatsPeriod } from '@obliview/shared';
import toast from 'react-hot-toast';

export function MonitorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { isAdmin, canWriteMonitor, hasCapability, canCreate } = useAuthStore();
  const { getMonitor, getRecentHeartbeats, setHeartbeats, updateMonitor, removeMonitor } =
    useMonitorStore();

  const monitorId = parseInt(id!, 10);
  const storeMonitor = getMonitor(monitorId);
  // Deep link before the store is filled (or a monitor the list does not
  // hold): GET /monitors/:id answers before "not found". `monitor: null` = 404/403.
  const [fallback, setFallback] = useState<{ id: number; monitor: Monitor | null } | null>(null);
  const fallbackMonitor = fallback?.id === monitorId ? fallback.monitor : undefined;
  const monitor = storeMonitor ?? fallbackMonitor ?? undefined;
  const lookupPending = !storeMonitor && fallbackMonitor === undefined && !Number.isNaN(monitorId);
  const heartbeats = getRecentHeartbeats(monitorId);
  const canWrite = monitor ? canWriteMonitor(monitorId, monitor.groupId ?? null) : false;
  const [period, setPeriod] = useState<MonitorStatsPeriod>('24h');
  const [periodStats, setPeriodStats] = useState<MonitorPeriodStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [periodHeartbeats, setPeriodHeartbeats] = useState<Heartbeat[]>([]);
  const [zoomRange, setZoomRange] = useState<{ from: Date; to: Date } | null>(null);
  const [zoomHeartbeats, setZoomHeartbeats] = useState<Heartbeat[]>([]);

  const inStore = !!storeMonitor;
  useEffect(() => {
    if (inStore || Number.isNaN(monitorId)) return;
    let cancelled = false;
    monitorsApi.getById(monitorId)
      .then((m) => { if (!cancelled) setFallback({ id: monitorId, monitor: m }); })
      .catch(() => { if (!cancelled) setFallback({ id: monitorId, monitor: null }); });
    return () => { cancelled = true; };
  }, [monitorId, inStore]);

  // Fetch heartbeat history on mount (for store)
  useEffect(() => {
    monitorsApi.getHeartbeats(monitorId, 100)
      // API returns DESC (newest first), reverse to chronological (oldest → newest)
      .then((hbs) => setHeartbeats(monitorId, hbs.reverse()))
      // Monitor data might come from store via socket
      .catch(() => {});
  }, [monitorId, setHeartbeats]);

  // Period stats (uptime, avg / min / max response time, checks) follow the
  // period selector like the bar and the chart; refreshed every minute.
  useEffect(() => {
    let cancelled = false;
    setStatsLoading(true);
    setPeriodStats(null);
    const load = () => {
      monitorsApi.getStats(monitorId, period)
        .then((stats) => { if (!cancelled) setPeriodStats(stats); })
        .catch(() => { /* keep the last stats on screen */ })
        .finally(() => { if (!cancelled) setStatsLoading(false); });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [monitorId, period]);

  // Fetch heartbeats by period for chart/bar display
  useEffect(() => {
    monitorsApi
      .getHeartbeatsByPeriod(monitorId, period)
      .then(setPeriodHeartbeats)
      .catch(() => setPeriodHeartbeats([]));
    // Changing period always resets zoom
    setZoomRange(null);
    setZoomHeartbeats([]);
  }, [monitorId, period]);

  // Fetch zoomed heartbeats when zoom range changes
  useEffect(() => {
    if (!zoomRange) return;
    monitorsApi
      .getHeartbeatsByRange(monitorId, zoomRange.from, zoomRange.to)
      .then(setZoomHeartbeats)
      .catch(() => setZoomHeartbeats([]));
  }, [monitorId, zoomRange]);

  // Deep link to another workspace's monitor: switch there and reload this URL.
  const locate = useLocateRedirect('monitor', monitorId, !monitor && !lookupPending);

  if (!monitor && (lookupPending || locate.pending)) {
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

  if (!monitor) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">{t('monitors.notFound')}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('monitors.backToDashboard')}</Button>
        </Link>
      </div>
    );
  }

  // An agent's identity is its device: everyone who can read the agent monitor
  // can open /agents/:id (server requireAgentDeviceRead), so always redirect.
  const isAgentMonitor = monitor.type === 'agent';
  if (isAgentMonitor && monitor.agentDeviceId != null) {
    return <Navigate to={`/agents/${monitor.agentDeviceId}`} replace />;
  }
  // Edit / Clone / Delete would create a second agent monitor for the same
  // device or orphan the device. Only an orphan agent monitor (no device
  // left) can still be deleted by an admin.
  const canEditMonitor = canWrite && !isAgentMonitor;
  // DELETE /monitors/:id also needs 'monitors.manage' (server).
  const canDeleteMonitor = canWrite && hasCapability('monitors.manage')
    && (!isAgentMonitor || (isAdmin() && monitor.agentDeviceId == null));
  // Clone saves through POST /monitors: canCreate (RW team + 'monitors.manage').
  const canCloneMonitor = canEditMonitor && canCreate();
  // Pausing a device-backed agent monitor suspends the device, which needs
  // 'agents.manage' (the server answers 403 otherwise).
  const canPauseMonitor = canWrite
    && (!isAgentMonitor || monitor.agentDeviceId == null || isAdmin() || hasCapability('agents.manage'));

  const handlePause = async () => {
    try {
      const result = await monitorsApi.pause(monitorId);
      updateMonitor(monitorId, { status: result.status as any });
      toast.success(result.status === 'paused' ? t('monitors.paused') : t('monitors.resumed'));
    } catch {
      toast.error(t('monitors.failedPause'));
    }
  };

  const handleClone = () => {
    // Copy monitor data, strip unique fields, add "(Copy)" to name
    const { id: _id, createdAt: _ca, updatedAt: _ua, pushToken: _pt, status: _st, createdBy: _cb, ...cloneData } = monitor;
    navigate('/monitor/new', {
      // cloneSourceId: the edit page copies the source's timing overrides.
      state: { cloneData: { ...cloneData, name: `${monitor.name}${t('monitors.cloneSuffix')}` }, cloneSourceId: monitor.id },
    });
  };

  const handleDelete = async () => {
    if (!(await confirm({ message: t('monitors.confirmDelete', { name: monitor.name }), danger: true }))) return;
    try {
      await monitorsApi.delete(monitorId);
      removeMonitor(monitorId);
      toast.success(t('monitors.deleted'));
      navigate('/');
    } catch {
      toast.error(t('monitors.failedDelete'));
    }
  };

  const lastHeartbeat = heartbeats[heartbeats.length - 1];

  // Determine if this monitor checks SSL certificates
  const isHttps =
    (monitor.type === 'http' || monitor.type === 'json_api') &&
    monitor.url?.startsWith('https://') &&
    !monitor.ignoreSsl;

  // Parse SSL info from the heartbeat message
  // Messages look like: "... | SSL OK, expires in 45 days (2025-08-15)"
  // or "SSL certificate expires in 12 days (2025-04-01) — threshold: 30 days"
  // or "SSL certificate expired 5 days ago (2025-02-01)"
  let sslDaysRemaining: number | null = null;
  let sslExpiryDate: string | null = null;
  if (isHttps && lastHeartbeat?.message) {
    const msg = lastHeartbeat.message;
    const expiresIn = msg.match(/expires in (\d+) days? \((\d{4}-\d{2}-\d{2})\)/);
    const expiredAgo = msg.match(/expired (\d+) days? ago \((\d{4}-\d{2}-\d{2})\)/);
    if (expiresIn) {
      sslDaysRemaining = parseInt(expiresIn[1], 10);
      sslExpiryDate = expiresIn[2];
    } else if (expiredAgo) {
      sslDaysRemaining = -parseInt(expiredAgo[1], 10);
      sslExpiryDate = expiredAgo[2];
    }
  }

  return (
    <PageContainer>
      {/* Back button: previous page when there is one (deep links land here
          with no history), else the dashboard. */}
      <button
        type="button"
        onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4"
      >
        <ArrowLeft size={14} />
        {t('common.back')}
      </button>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="flex min-w-0 items-center gap-4">
          <MonitorStatusBadge status={monitor.status} size="lg" inMaintenance={monitor.inMaintenance} />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-text-primary break-words">{anonymize(monitor.name)}</h1>
            <p className="text-sm text-text-secondary">
              {MONITOR_TYPE_LABELS[monitor.type]}
              {(monitor.type === 'http' || monitor.type === 'json_api') && monitor.url && ` - ${anonymizeUrl(monitor.url)}`}
              {(['ping', 'tcp', 'dns', 'ssl', 'smtp'].includes(monitor.type)) && monitor.hostname && ` - ${anonymize(monitor.hostname)}${monitor.port ? `:${monitor.port}` : ''}`}
              {monitor.type === 'docker' && monitor.dockerContainerName && ` - ${anonymize(monitor.dockerContainerName)}`}
              {monitor.type === 'game_server' && monitor.gameHost && ` - ${anonymize(monitor.gameHost)}${monitor.gamePort ? `:${monitor.gamePort}` : ''}`}
              {monitor.type === 'push' && ' - Push'}
              {monitor.type === 'script' && monitor.scriptCommand && ` - ${anonymize(monitor.scriptCommand)}`}
              {monitor.type === 'browser' && monitor.browserUrl && ` - ${anonymizeUrl(monitor.browserUrl)}`}
              {monitor.type === 'value_watcher' && monitor.valueWatcherUrl && ` - ${anonymizeUrl(monitor.valueWatcherUrl)}`}
            </p>
          </div>
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {canEditMonitor && (
              <>
                <Link to={`/monitor/${monitorId}/edit`}>
                  <Button variant="secondary" size="sm">
                    <Pencil size={14} className="mr-1.5" />
                    {t('monitors.edit')}
                  </Button>
                </Link>
              </>
            )}
            {canCloneMonitor && (
              <Button variant="secondary" size="sm" onClick={handleClone}>
                <Copy size={14} className="mr-1.5" />
                {t('monitors.clone')}
              </Button>
            )}
            {canPauseMonitor && (
              <Button variant="secondary" size="sm" onClick={handlePause}>
                {monitor.status === 'paused' ? (
                  <><Play size={14} className="mr-1.5" />{t('monitors.resumeMonitor')}</>
                ) : (
                  <><Pause size={14} className="mr-1.5" />{t('monitors.pauseMonitor')}</>
                )}
              </Button>
            )}
            {canDeleteMonitor && (
              <Button variant="danger" size="sm" onClick={handleDelete}>
                <Trash2 size={14} className="mr-1.5" />
                {t('monitors.deleteMonitor')}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* SSL Warning/Expired banner */}
      {monitor.status === 'ssl_warning' && lastHeartbeat?.message && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-status-ssl-warning/30 bg-status-ssl-warning-bg px-4 py-3">
          <ShieldAlert size={20} className="shrink-0 text-status-ssl-warning" />
          <div>
            <p className="text-sm font-semibold text-status-ssl-warning">{t('monitors.stats.sslWarn')}</p>
            <p className="text-sm text-text-secondary">{lastHeartbeat.message}</p>
          </div>
        </div>
      )}
      {monitor.status === 'ssl_expired' && lastHeartbeat?.message && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-status-ssl-expired/30 bg-status-ssl-expired-bg px-4 py-3">
          <ShieldX size={20} className="shrink-0 text-status-ssl-expired" />
          <div>
            <p className="text-sm font-semibold text-status-ssl-expired">{t('monitors.stats.sslExpired')}</p>
            <p className="text-sm text-text-secondary">{lastHeartbeat.message}</p>
          </div>
        </div>
      )}

      {/* Stats row — responsive auto-fit grid */}
      <div
        className="grid gap-4 mb-6"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}
      >
        {monitor.type === 'value_watcher' ? (
          <div className="rounded-lg border border-accent/30 bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.currentValue')}</div>
            <div className="text-xl font-mono font-semibold text-accent">
              {lastHeartbeat?.value != null
                ? (() => { const n = Number(lastHeartbeat.value); return isNaN(n) ? lastHeartbeat.value : n.toLocaleString(); })()
                : t('common.na')}
            </div>
            {monitor.valueWatcherJsonPath && (
              <div className="text-xs text-text-muted mt-0.5">{monitor.valueWatcherJsonPath}</div>
            )}
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.responseTime')}</div>
            <div className="text-xl font-mono font-semibold text-text-primary">
              {lastHeartbeat?.responseTime ? `${lastHeartbeat.responseTime}ms` : t('common.na')}
            </div>
          </div>
        )}
        {/* Period-scoped (GET /monitors/:id/stats) — follow the period selector */}
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <StatLabel label={t('monitors.stats.uptime')} period={period} />
          <div
            className={cn(
              'text-xl font-mono font-semibold',
              !periodStats || periodStats.total === 0
                ? 'text-text-muted'
                : periodStats.uptimePct >= 99
                  ? 'text-status-up'
                  : periodStats.uptimePct >= 95 ? 'text-status-pending' : 'text-status-down',
            )}
          >
            {periodStats && periodStats.total > 0
              ? `${periodStats.uptimePct.toFixed(2)}%`
              : statsLoading ? '…' : t('common.na')}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <StatLabel label={t('monitors.stats.avgResponseTime', 'Avg response time')} period={period} />
          <div className="text-xl font-mono font-semibold text-text-primary">
            {periodStats?.avgResponseTime != null
              ? `${periodStats.avgResponseTime}ms`
              : statsLoading ? '…' : t('common.na')}
          </div>
          {periodStats?.minResponseTime != null && periodStats.maxResponseTime != null && (
            <div className="text-xs text-text-muted mt-0.5 font-mono">
              {t('monitors.stats.minMax', {
                min: periodStats.minResponseTime,
                max: periodStats.maxResponseTime,
                defaultValue: 'min {{min}}ms · max {{max}}ms',
              })}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <StatLabel label={t('monitors.stats.totalChecks')} period={period} />
          <div className="text-xl font-mono font-semibold text-text-primary">
            {periodStats ? periodStats.total.toLocaleString() : statsLoading ? '…' : t('common.na')}
          </div>
        </div>
        <div className="rounded-lg border border-border bg-bg-secondary p-4">
          <div className="text-sm text-text-secondary mb-1">{t('monitors.stats.lastCheck')}</div>
          <div className="text-sm font-mono text-text-primary">
            {lastHeartbeat ? new Date(lastHeartbeat.createdAt).toLocaleString() : t('common.never')}
          </div>
        </div>
        {isHttps && (
          <div
            className={cn(
              'rounded-lg border p-4',
              sslDaysRemaining !== null && sslDaysRemaining < 0
                ? 'border-status-ssl-expired/30 bg-status-ssl-expired-bg'
                : sslDaysRemaining !== null && sslDaysRemaining < (monitor.sslWarnDays ?? 30)
                  ? 'border-status-ssl-warning/30 bg-status-ssl-warning-bg'
                  : 'border-border bg-bg-secondary',
            )}
          >
            <div className="flex items-center gap-1.5 text-sm text-text-secondary mb-1">
              {sslDaysRemaining !== null && sslDaysRemaining < 0 ? (
                <ShieldX size={14} className="text-status-ssl-expired" />
              ) : sslDaysRemaining !== null && sslDaysRemaining < (monitor.sslWarnDays ?? 30) ? (
                <ShieldAlert size={14} className="text-status-ssl-warning" />
              ) : (
                <ShieldCheck size={14} className="text-status-up" />
              )}
              {t('monitors.stats.sslCert')}
            </div>
            <div
              className={cn(
                'text-xl font-mono font-semibold',
                sslDaysRemaining !== null && sslDaysRemaining < 0
                  ? 'text-status-ssl-expired'
                  : sslDaysRemaining !== null && sslDaysRemaining < (monitor.sslWarnDays ?? 30)
                    ? 'text-status-ssl-warning'
                    : 'text-status-up',
              )}
            >
              {sslDaysRemaining !== null
                ? sslDaysRemaining < 0
                  ? t('monitors.stats.sslExpiredAgo', { days: Math.abs(sslDaysRemaining), defaultValue: 'Expired {{days}}d ago' })
                  : t('monitors.stats.sslDaysLeft', { days: sslDaysRemaining, defaultValue: '{{days}}d left' })
                : t('common.na')}
            </div>
            {sslExpiryDate && (
              <div className="text-xs text-text-muted mt-0.5">{sslExpiryDate}</div>
            )}
          </div>
        )}
      </div>

      {/* Period selector */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">
          {t('monitors.history')}{zoomRange && <span className="ml-2 text-xs text-cyan-400 font-normal normal-case tracking-normal">— {t('monitors.zoomed')}</span>}
        </h3>
        <PeriodSelector value={period} onChange={(p) => setPeriod(p as MonitorStatsPeriod)} />
      </div>

      {/* Heartbeat Bar */}
      <div className="mb-6 rounded-lg border border-border bg-bg-secondary p-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">{t('monitors.heartbeatHistory')}</h3>
        <HeartbeatBar heartbeats={periodHeartbeats.length > 0 ? periodHeartbeats : heartbeats} />
      </div>

      {/* Response Time / Value Chart */}
      <div className="rounded-lg border border-border bg-bg-secondary p-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">
          {monitor.type === 'value_watcher' ? t('monitors.valueHistory') : t('monitors.responseTime')}
        </h3>
        <HeartbeatChart
          heartbeats={
            zoomRange
              ? zoomHeartbeats
              : (periodHeartbeats.length > 0 ? periodHeartbeats : heartbeats)
          }
          height={250}
          period={period}
          valueMode={monitor.type === 'value_watcher'}
          onZoom={monitor.type !== 'value_watcher'
            ? (from, to) => setZoomRange({ from, to })
            : undefined}
          isZoomed={!!zoomRange}
          onZoomReset={() => { setZoomRange(null); setZoomHeartbeats([]); }}
          customRange={zoomRange ?? undefined}
        />
      </div>

      {/* Monitor Info */}
      {monitor.description && (
        <div className="mt-6 rounded-lg border border-border bg-bg-secondary p-4">
          <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">{t('monitors.sectionDescription')}</h3>
          <p className="text-sm text-text-primary">{monitor.description}</p>
        </div>
      )}

      {/* Notification Bindings ('notifications' capability) */}
      {hasCapability('notifications') && (
        <div className="mt-6">
          <NotificationBindingsPanel
            scope="monitor"
            scopeId={monitorId}
            title={t('monitors.sectionNotifications')}
          />
        </div>
      )}

      {/* Remediation Bindings ('remediation' capability) */}
      {hasCapability('remediation') && (
        <div className="mt-4">
          <RemediationBindingsPanel
            scope="monitor"
            scopeId={monitorId}
            groupId={monitor?.groupId ?? null}
          />
        </div>
      )}

      {/* Maintenance Windows ('maintenance' capability) */}
      {hasCapability('maintenance') && (
        <div className="mt-4 rounded-lg border border-border bg-bg-secondary p-4">
          <MaintenanceWindowList
            scopeType="monitor"
            scopeId={monitorId}
            defaultScopeType="monitor"
            defaultScopeId={monitorId}
          />
        </div>
      )}

      {/* Settings (admin only) */}
      {isAdmin() && (
        <div className="mt-6">
          <SettingsPanel
            scope="monitor"
            scopeId={monitorId}
            title={t('monitors.sectionSettings')}
          />
        </div>
      )}
    </PageContainer>
  );
}

const PERIOD_LABELS: Record<MonitorStatsPeriod, string> = {
  '1h': '1H',
  '24h': '24H',
  '7d': '7D',
  '30d': '30D',
  '365d': '1Y',
};

/** Stat card label with the period it covers. */
function StatLabel({ label, period }: { label: string; period: MonitorStatsPeriod }) {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-sm text-text-secondary">
      <span className="truncate">{label}</span>
      <span className="shrink-0 rounded bg-bg-tertiary px-1.5 py-px font-mono text-[10px] text-text-muted">
        {PERIOD_LABELS[period]}
      </span>
    </div>
  );
}
