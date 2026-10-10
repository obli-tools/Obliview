import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Award, Clock, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MONITOR_TYPE_LABELS,
  UPTIME_SERIES_PERIODS,
  type Heartbeat,
  type Monitor,
  type MonitorType,
  type UptimeSeriesPeriod,
  type UptimeSeriesPoint,
} from '@obliview/shared';
import { monitorsApi } from '@/api/monitors.api';
import { useMonitorStore } from '@/store/monitorStore';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { effectiveStatus } from '@/utils/monitorStatus';
import { anonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

/**
 * Operator Overview hero. The dashboard's ONLY KPI band.
 *
 *  [ KPI band ]      Up · Down · Alert · Maintenance · Paused · Cert   (monitors, agents excluded —
 *                    Alert is the agent threshold state, see below)
 *  [ Two-column ]    Fleet uptime series (GET /monitors/uptime-series) · Monitors / Agents + type donut
 *  [ Bottom row ]    Worst monitor (24h uptime) · Fastest · Recent incident · SLA
 *
 * Statuses are read through effectiveStatus(): a monitor in a maintenance
 * window counts as Maintenance, never as Down. Per-monitor 24h uptime / avg
 * response time come from the store's summary (fetched and polled every 60 s
 * by DashboardPage) — no fetch of its own besides the series.
 */

const SLA_TARGET = 99.9;
const DEGRADED_BELOW = 99;
const DONUT_MAX_SLICES = 5;

interface HeroCounts {
  monitors: number;
  up: number;
  down: number;
  alert: number;
  maintenance: number;
  paused: number;
  cert: number;
  certExpired: number;
  agents: number;
  agentsOnline: number;
  agentsAlert: number;
  agentsOffline: number;
  agentsMaintenance: number;
}

function countStatuses(monitors: Monitor[]): HeroCounts {
  const c: HeroCounts = {
    monitors: 0, up: 0, down: 0, alert: 0, maintenance: 0, paused: 0, cert: 0, certExpired: 0,
    agents: 0, agentsOnline: 0, agentsAlert: 0, agentsOffline: 0, agentsMaintenance: 0,
  };
  for (const m of monitors) {
    const status = effectiveStatus(m);
    if (m.type === 'agent') {
      c.agents++;
      // Reachability is a fact, maintenance or not.
      if (m.status === 'up' || m.status === 'alert') c.agentsOnline++;
      if (status === 'alert') c.agentsAlert++;
      else if (status === 'down' || status === 'inactive') c.agentsOffline++;
      else if (status === 'maintenance') c.agentsMaintenance++;
      continue;
    }
    c.monitors++;
    switch (status) {
      case 'up': c.up++; break;
      case 'down': c.down++; break;
      case 'alert': c.alert++; break;
      case 'maintenance': c.maintenance++; break;
      case 'paused': c.paused++; break;
      case 'ssl_warning': c.cert++; break;
      case 'ssl_expired': c.cert++; c.certExpired++; break;
      default: break;
    }
  }
  return c;
}

/**
 * Start of the monitor's current incident: the first beat of the trailing run
 * of non-up heartbeats in the store, or `updatedAt` when the run is not in
 * the recent beats (agent threshold alerts are recorded as 'up' beats).
 */
function incidentStartMs(m: Monitor, heartbeats: Heartbeat[] | undefined): number {
  let start: string | null = null;
  if (heartbeats) {
    for (let i = heartbeats.length - 1; i >= 0; i--) {
      const s = heartbeats[i].status;
      if (s === 'up' || s === 'ssl_warning') break;
      start = heartbeats[i].createdAt;
    }
  }
  return Date.parse(start ?? m.updatedAt) || 0;
}

function formatBucket(iso: string, period: UptimeSeriesPeriod): string {
  const d = new Date(iso);
  return period === '24h'
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

interface DashboardHeroProps {
  /** Every visible monitor, agents included (the store list). */
  monitors: Monitor[];
}

export function DashboardHero({ monitors }: DashboardHeroProps) {
  const { t } = useTranslation();
  const summary = useMonitorStore((s) => s.summary);
  const heartbeats = useMonitorStore((s) => s.heartbeats);

  // ── Fleet uptime series ──────────────────────────────────────────────────
  const [period, setPeriod] = useState<UptimeSeriesPeriod>('24h');
  const [series, setSeries] = useState<UptimeSeriesPoint[]>([]);
  const [seriesState, setSeriesState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setSeriesState('loading');
    setSeries([]);
    const load = (initial: boolean) => {
      monitorsApi.getUptimeSeries(period)
        .then((points) => {
          if (cancelled) return;
          setSeries(points);
          setSeriesState('ready');
        })
        .catch(() => {
          // A failed refresh keeps the last series on screen.
          if (!cancelled && initial) setSeriesState('error');
        });
    };
    load(true);
    // Hourly buckets move every minute or so; daily ones are cached 5 min server-side.
    const timer = setInterval(() => load(false), period === '24h' ? 60_000 : 300_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [period]);

  const counts = useMemo(() => countStatuses(monitors), [monitors]);

  const nonAgents = useMemo(() => monitors.filter((m) => m.type !== 'agent'), [monitors]);

  // 24h fleet figures from the per-monitor summary (agents excluded, like the series)
  const fleet24h = useMemo(() => {
    const entries = nonAgents
      .map((m) => ({ m, s: summary[m.id] }))
      .filter((x): x is { m: Monitor; s: NonNullable<typeof x.s> } => x.s !== undefined);
    const uptime = entries.length > 0
      ? entries.reduce((sum, x) => sum + x.s.uptimePct, 0) / entries.length
      : null;
    const withRt = entries.filter((x) => x.s.avgResponseTime !== null) as Array<{ m: Monitor; s: { uptimePct: number; avgResponseTime: number } }>;
    const avgRt = withRt.length > 0
      ? Math.round(withRt.reduce((sum, x) => sum + x.s.avgResponseTime, 0) / withRt.length)
      : null;
    const worst = entries.length > 0
      ? [...entries].sort((a, b) => a.s.uptimePct - b.s.uptimePct || a.m.name.localeCompare(b.m.name))[0]
      : null;
    const fastest = withRt.length > 0
      ? [...withRt].sort((a, b) => a.s.avgResponseTime - b.s.avgResponseTime || a.m.name.localeCompare(b.m.name))[0]
      : null;
    return { uptime, avgRt, worst, fastest };
  }, [nonAgents, summary]);

  // Most recent down transition (down / alert monitors, maintenance excluded)
  const recentIncident = useMemo(() => {
    let best: { m: Monitor; since: number } | null = null;
    for (const m of monitors) {
      const status = effectiveStatus(m);
      if (status !== 'down' && status !== 'alert') continue;
      const since = incidentStartMs(m, heartbeats.get(m.id));
      if (!best || since > best.since) best = { m, since };
    }
    return best;
  }, [monitors, heartbeats]);

  // Donut — distribution of monitor types (agents excluded), labelled
  const donut = useMemo(() => {
    const byType = new Map<MonitorType, number>();
    for (const m of nonAgents) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
    const total = nonAgents.length || 1;
    const sorted = [...byType.entries()].sort((a, b) => b[1] - a[1]);
    const slices = sorted.slice(0, DONUT_MAX_SLICES).map(([type, count]) => ({
      key: type as string,
      label: MONITOR_TYPE_LABELS[type] ?? type,
      count,
      pct: count / total,
    }));
    const rest = sorted.slice(DONUT_MAX_SLICES).reduce((sum, [, count]) => sum + count, 0);
    if (rest > 0) {
      slices.push({ key: '__other', label: t('dashboard.typeOther', 'Other'), count: rest, pct: rest / total });
    }
    return slices;
  }, [nonAgents, t]);

  const seriesAvg = series.length > 0
    ? series.reduce((sum, p) => sum + p.uptime, 0) / series.length
    : null;
  const slaValue = fleet24h.uptime ?? (counts.monitors > 0 ? (counts.up / counts.monitors) * 100 : null);
  const ratio = (n: number, of: number) => (of > 0 ? n / of : 0);
  const msAvg = (ms: number) => t('dashboard.msAvg', { ms, defaultValue: '{{ms}} ms avg' });

  return (
    <section className="flex flex-col gap-[18px]">
      {/* ── KPI band ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label={t('dashboard.kpiUp', { defaultValue: 'UP' })}
          value={counts.up}
          tone="up"
          fillRatio={ratio(counts.up, counts.monitors)}
          sub={t('dashboard.kpiOfMonitors', { count: counts.monitors, defaultValue: 'of {{count}} monitors' })}
        />
        <KpiCard
          label={t('dashboard.kpiDown', { defaultValue: 'DOWN' })}
          value={counts.down}
          tone="down"
          fillRatio={ratio(counts.down, counts.monitors)}
        />
        <KpiCard
          label={t('dashboard.kpiAlert', { defaultValue: 'ALERT' })}
          value={counts.alert + counts.agentsAlert}
          tone="alert"
          fillRatio={ratio(counts.alert + counts.agentsAlert, counts.monitors + counts.agents)}
          sub={t('dashboard.kpiAlertSub', { defaultValue: 'threshold violations' })}
        />
        <KpiCard
          label={t('dashboard.kpiMaintenance', { defaultValue: 'MAINTENANCE' })}
          value={counts.maintenance}
          tone="maintenance"
          fillRatio={ratio(counts.maintenance, counts.monitors)}
        />
        <KpiCard
          label={t('dashboard.kpiPaused', { defaultValue: 'PAUSED' })}
          value={counts.paused}
          tone="paused"
          fillRatio={ratio(counts.paused, counts.monitors)}
        />
        <KpiCard
          label={t('dashboard.kpiCert', { defaultValue: 'CERT EXPIRING' })}
          value={counts.cert}
          tone="cert"
          fillRatio={ratio(counts.cert, counts.monitors)}
          sub={counts.certExpired > 0
            ? t('dashboard.kpiCertExpired', { count: counts.certExpired, defaultValue: '{{count}} expired' })
            : undefined}
        />
      </div>

      {/* ── Two-column row : series + fleet / types ──────────────────── */}
      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-3">
        {/* Uptime % series */}
        <div className="flex min-h-[280px] min-w-0 flex-col gap-4 rounded-[14px] p-5 shadow-card lg:col-span-2" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <div className="min-w-0">
              <h3 className="text-[16px] font-semibold tracking-[0.02em] text-text-primary">
                {t('dashboard.uptimeOverTime', { defaultValue: 'Uptime over time' })}
              </h3>
              <div className="font-mono text-[11px] tracking-[0.04em] text-text-muted">
                {seriesAvg !== null
                  ? t('dashboard.uptimeSeriesSub', {
                    pct: seriesAvg.toFixed(2),
                    count: counts.monitors,
                    defaultValue: 'avg {{pct}}% · {{count}} monitors',
                  })
                  : t('dashboard.uptimeSeriesHint', { defaultValue: 'average uptime of your monitors (agents excluded)' })}
              </div>
            </div>
            <SegmentedTabs
              className="ml-auto"
              size="sm"
              fill={false}
              value={period}
              onChange={setPeriod}
              ariaLabel={t('dashboard.uptimeOverTime', { defaultValue: 'Uptime over time' })}
              tabs={UPTIME_SERIES_PERIODS.map((p) => ({ id: p, label: p }))}
            />
          </div>
          {seriesState === 'ready' && series.length > 0 ? (
            <UptimeChart points={series} period={period} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              {seriesState === 'loading'
                ? t('common.loading', { defaultValue: 'Loading…' })
                : seriesState === 'error'
                  ? t('dashboard.uptimeSeriesError', { defaultValue: 'Could not load the uptime history' })
                  : t('common.noData', { defaultValue: 'No data' })}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Monitors / agents — kept separate: agents never count as monitors */}
          <div className="grid grid-cols-2 gap-4 rounded-[14px] p-5 shadow-card" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
            <div className={cn('min-w-0', counts.agents === 0 && 'col-span-2')}>
              <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                {t('dashboard.kpiMonitors', { defaultValue: 'MONITORS' })}
              </div>
              <div className="mt-2 text-[30px] font-semibold leading-none tracking-[0.02em] text-text-primary">
                {counts.monitors}
              </div>
              <div className="mt-2 truncate font-mono text-[11px] text-text-muted">
                {fleet24h.uptime !== null
                  ? t('dashboard.fleetUptime24h', { pct: fleet24h.uptime.toFixed(2), defaultValue: '{{pct}}% uptime · 24h' })
                  : '—'}
              </div>
              {fleet24h.avgRt !== null && (
                <div className="truncate font-mono text-[11px] text-text-muted">{msAvg(fleet24h.avgRt)}</div>
              )}
            </div>
            {counts.agents > 0 && (
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary">
                  {t('dashboard.kpiAgents', { defaultValue: 'AGENTS ONLINE' })}
                </div>
                <div className="mt-2 text-[30px] font-semibold leading-none tracking-[0.02em] text-status-up">
                  {counts.agentsOnline}
                  <span className="text-[18px] text-text-muted">/{counts.agents}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-2.5 font-mono text-[11px] text-text-muted">
                  {counts.agentsAlert > 0 && (
                    <span className="text-orange-500">{t('dashboard.agentsAlert', { count: counts.agentsAlert, defaultValue: '{{count}} alert' })}</span>
                  )}
                  {counts.agentsOffline > 0 && (
                    <span className="text-status-down">{t('dashboard.agentsOffline', { count: counts.agentsOffline, defaultValue: '{{count}} offline' })}</span>
                  )}
                  {counts.agentsMaintenance > 0 && (
                    <span className="text-status-maintenance">{t('dashboard.agentsMaintenance', { count: counts.agentsMaintenance, defaultValue: '{{count}} maint.' })}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Monitor types donut */}
          <div className="flex flex-1 flex-col gap-4 rounded-[14px] p-5 shadow-card" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
            <h3 className="text-[16px] font-semibold tracking-[0.02em] text-text-primary">
              {t('dashboard.monitorTypes', { defaultValue: 'Monitor types' })}
            </h3>
            {donut.length > 0 ? (
              <div className="flex flex-1 items-center gap-5">
                <DonutChart slices={donut} />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  {donut.map((d, i) => (
                    <div key={d.key} className="flex items-center gap-2.5 text-[13px]">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: donutColor(i) }} />
                      <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{d.label}</span>
                      <span className="shrink-0 font-mono text-[11px] text-text-secondary">
                        {d.count} · {Math.round(d.pct * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                {t('common.noData', { defaultValue: 'No data' })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Bottom row : 4 status cards ───────────────────────────────── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatusCard
          icon={<AlertTriangle size={16} />}
          tone="red"
          label={t('dashboard.worstMonitor', { defaultValue: 'WORST MONITOR' })}
          to={fleet24h.worst ? `/monitor/${fleet24h.worst.m.id}` : undefined}
          name={fleet24h.worst ? anonymize(fleet24h.worst.m.name) : '—'}
          count={fleet24h.worst
            ? t('dashboard.uptime24h', { pct: fleet24h.worst.s.uptimePct.toFixed(2), defaultValue: '{{pct}}% · 24h' })
            : ''}
          badge={!fleet24h.worst ? '' : fleet24h.worst.s.uptimePct < DEGRADED_BELOW
            ? t('dashboard.badgeDegraded', { defaultValue: 'degraded' })
            : fleet24h.worst.s.uptimePct < SLA_TARGET
              ? t('dashboard.badgeWatch', { defaultValue: 'watch' })
              : t('dashboard.badgeOk', { defaultValue: 'ok' })}
          badgeTone={!fleet24h.worst ? 'muted' : fleet24h.worst.s.uptimePct < DEGRADED_BELOW
            ? 'red'
            : fleet24h.worst.s.uptimePct < SLA_TARGET ? 'amber' : 'green'}
        />
        <StatusCard
          icon={<Zap size={16} />}
          tone="green"
          label={t('dashboard.fastest', { defaultValue: 'FASTEST' })}
          to={fleet24h.fastest ? `/monitor/${fleet24h.fastest.m.id}` : undefined}
          name={fleet24h.fastest ? anonymize(fleet24h.fastest.m.name) : '—'}
          count={fleet24h.fastest ? msAvg(Math.round(fleet24h.fastest.s.avgResponseTime)) : ''}
          badge={fleet24h.fastest ? t('dashboard.badgeFast', { defaultValue: 'fast' }) : ''}
          badgeTone="green"
        />
        <StatusCard
          icon={<Clock size={16} />}
          tone="amber"
          label={t('dashboard.recentIncident', { defaultValue: 'RECENT INCIDENT' })}
          to={recentIncident ? `/monitor/${recentIncident.m.id}` : undefined}
          name={recentIncident ? anonymize(recentIncident.m.name) : t('common.none', { defaultValue: 'None' })}
          count={recentIncident
            ? `${effectiveStatus(recentIncident.m) === 'alert'
              ? t('dashboard.statsAlert', { defaultValue: 'Alert' })
              : t('dashboard.statsDown', { defaultValue: 'Down' })} · ${t('dashboard.incidentSince', {
              time: new Date(recentIncident.since).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }),
              defaultValue: 'since {{time}}',
            })}`
            : ''}
          badge={recentIncident
            ? t('dashboard.badgeOpen', { defaultValue: 'open' })
            : t('dashboard.badgeClear', { defaultValue: 'clear' })}
          badgeTone={recentIncident ? 'amber' : 'green'}
        />
        <StatusCard
          icon={<Award size={16} />}
          tone="blue"
          label={t('dashboard.sla', { defaultValue: 'SLA' })}
          name={slaValue !== null ? `${slaValue.toFixed(2)}%` : '—'}
          count={t('dashboard.slaUpCount', { up: counts.up, total: counts.monitors, defaultValue: '{{up}}/{{total}} up' })}
          badge={slaValue === null ? '' : slaValue >= SLA_TARGET
            ? t('dashboard.badgeOnTrack', { defaultValue: 'on track' })
            : t('dashboard.badgeWatch', { defaultValue: 'watch' })}
          badgeTone={slaValue !== null && slaValue >= SLA_TARGET ? 'green' : 'amber'}
        />
      </div>
    </section>
  );
}

// ── Uptime chart ─────────────────────────────────────────────────────────────

const CHART_W = 600;
const CHART_H = 200;

function UptimeChart({ points, period }: { points: UptimeSeriesPoint[]; period: UptimeSeriesPeriod }) {
  const geometry = useMemo(() => {
    const values = points.map((p) => p.uptime);
    const lo = Math.min(...values);
    // Zoom on the interesting band: never flatter than 1 point of uptime,
    // with a little headroom above 100% so a perfect line is not clipped.
    const yMin = Math.min(99, Math.max(0, Math.floor(lo) - 1));
    const yTop = 100 + (100 - yMin) * 0.06;
    const yPctOf = (v: number) => ((yTop - v) / (yTop - yMin)) * 100;
    const times = points.map((p) => Date.parse(p.t));
    const t0 = times[0];
    const span = times[times.length - 1] - t0;
    const coords = points.map((p, i) => ({
      xPct: span > 0
        ? ((times[i] - t0) / span) * 100
        : points.length === 1 ? 50 : (i / (points.length - 1)) * 100,
      yPct: yPctOf(p.uptime),
      point: p,
    }));
    const toY = (pct: number) => ((pct / 100) * CHART_H).toFixed(2);
    // A single bucket draws a flat line across the chart.
    const line = coords.length === 1
      ? `0,${toY(coords[0].yPct)} ${CHART_W},${toY(coords[0].yPct)}`
      : coords.map((c) => `${((c.xPct / 100) * CHART_W).toFixed(2)},${toY(c.yPct)}`).join(' ');
    const refPct = yPctOf(100);
    return { yMin, coords, line, refPct, refY: toY(refPct) };
  }, [points]);

  const first = points[0];
  const mid = points[Math.floor((points.length - 1) / 2)];
  const last = points[points.length - 1];

  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <div className="relative min-h-[200px] flex-1">
        <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id="dashUptimeArea" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent2)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--accent2)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" x2={CHART_W} y1={geometry.refY} y2={geometry.refY} stroke="rgb(var(--c-text-muted))" strokeOpacity="0.25" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          <polygon fill="url(#dashUptimeArea)" points={`0,${CHART_H} ${geometry.line} ${CHART_W},${CHART_H}`} />
          <polyline fill="none" stroke="var(--accent2)" strokeWidth="2" vectorEffect="non-scaling-stroke" points={geometry.line} />
        </svg>
        {/* Points as HTML so they stay round (the SVG is stretched) — native tooltip per bucket */}
        {geometry.coords.map((c) => (
          <span
            key={c.point.t}
            title={`${formatBucket(c.point.t, period)} · ${c.point.uptime.toFixed(2)}%`}
            className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-bg-secondary"
            style={{ left: `${c.xPct}%`, top: `${c.yPct}%`, background: 'var(--accent2)' }}
          />
        ))}
        <span
          className="pointer-events-none absolute left-0 -translate-y-full pb-0.5 font-mono text-[10px] text-text-muted"
          style={{ top: `${geometry.refPct}%` }}
        >
          100%
        </span>
        <span className="pointer-events-none absolute bottom-0 left-0 font-mono text-[10px] text-text-muted">{geometry.yMin}%</span>
      </div>
      <div className="flex justify-between font-mono text-[10px] text-text-muted">
        <span>{formatBucket(first.t, period)}</span>
        {points.length > 2 && <span>{formatBucket(mid.t, period)}</span>}
        {points.length > 1 && <span>{formatBucket(last.t, period)}</span>}
      </div>
    </div>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────────

type KpiTone = 'up' | 'down' | 'alert' | 'maintenance' | 'paused' | 'cert';

const KPI_TONES: Record<KpiTone, { text: string; bar: string }> = {
  up:          { text: 'text-status-up',          bar: 'bg-status-up' },
  down:        { text: 'text-status-down',        bar: 'bg-status-down' },
  alert:       { text: 'text-orange-500',         bar: 'bg-orange-500' },
  maintenance: { text: 'text-status-maintenance', bar: 'bg-status-maintenance' },
  paused:      { text: 'text-status-paused',      bar: 'bg-status-paused' },
  cert:        { text: 'text-status-ssl-warning', bar: 'bg-status-ssl-warning' },
};

function KpiCard({
  label, value, tone, fillRatio, sub,
}: {
  label: string;
  value: number;
  tone: KpiTone;
  fillRatio: number;
  sub?: string;
}) {
  const colors = KPI_TONES[tone];
  // A zero problem count reads neutral; "Up" keeps its colour.
  const dim = value === 0 && tone !== 'up';
  return (
    <div className="relative min-w-0 overflow-hidden rounded-[14px] p-4 shadow-card sm:p-5" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
      <div className="truncate font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary">
        {label}
      </div>
      <div className={cn('mt-3 text-[30px] font-semibold leading-none tracking-[0.02em]', dim ? 'text-text-muted' : colors.text)}>
        {value}
      </div>
      <div className="mt-3 h-[3px] overflow-hidden rounded-sm bg-white/5">
        <div
          className={cn('h-full rounded-sm', colors.bar)}
          style={{ width: `${Math.min(100, fillRatio * 100).toFixed(0)}%` }}
        />
      </div>
      {sub && <div className="mt-2 truncate font-mono text-[11px] text-text-muted">{sub}</div>}
    </div>
  );
}

// ── Donut SVG ────────────────────────────────────────────────────────────────

function donutColor(i: number): string {
  const palette = ['#2bc4bd', '#5fd9d3', '#1edd8a', '#f5a623', '#4f7bff', '#b06aff'];
  return palette[i % palette.length];
}

function DonutChart({ slices }: { slices: Array<{ key: string; pct: number }> }) {
  const size = 120;
  const cx = size / 2;
  const cy = size / 2;
  const r = 50;
  const strokeWidth = 14;

  const circumference = 2 * Math.PI * r;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden>
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth={strokeWidth}
      />
      {slices.map((s, i) => {
        const dash = s.pct * circumference;
        const seg = (
          <circle
            key={s.key}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={donutColor(i)}
            strokeWidth={strokeWidth}
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
        offset += dash;
        return seg;
      })}
    </svg>
  );
}

// ── Status Card (bottom row) ─────────────────────────────────────────────────

function StatusCard({
  icon, tone, label, name, count, badge, badgeTone, to,
}: {
  icon: ReactNode;
  tone: 'red' | 'green' | 'amber' | 'blue';
  label: string;
  name: string;
  count: string;
  badge: string;
  badgeTone: 'red' | 'green' | 'amber' | 'muted';
  /** Makes the card a link (e.g. to the monitor it names). */
  to?: string;
}) {
  const iconBg = {
    red:   'rgba(224,58,58,0.10)',
    green: 'rgba(30,221,138,0.10)',
    amber: 'rgba(245,166,35,0.10)',
    blue:  'rgba(79,123,255,0.10)',
  }[tone];
  const iconColor = {
    red:   'var(--accent2)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    blue:  'var(--blue)',
  }[tone];
  const badgeBg = {
    red:   'rgba(224,58,58,0.12)',
    green: 'rgba(30,221,138,0.12)',
    amber: 'rgba(245,166,35,0.12)',
    muted: 'rgba(255,255,255,0.05)',
  }[badgeTone];
  const badgeColor = {
    red:   'var(--accent2)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    muted: 'var(--text2)',
  }[badgeTone];
  const body = (
    <>
      <div
        className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px]"
        style={{ background: iconBg, color: iconColor }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary">{label}</div>
        <div className="mt-0.5 truncate text-[15px] font-semibold tracking-[0.02em] text-text-primary">{name}</div>
        {count && (
          <div className="mt-0.5 truncate font-mono text-[12px] text-text-secondary">{count}</div>
        )}
      </div>
      {badge && (
        <span
          className="shrink-0 rounded-md px-2.5 py-1 font-mono text-[11px] font-medium"
          style={{ background: badgeBg, color: badgeColor }}
        >
          {badge}
        </span>
      )}
    </>
  );
  const className = 'flex min-w-0 items-center gap-3.5 rounded-[12px] px-4 py-3.5 shadow-card';
  const style = { background: 'rgb(var(--c-bg-secondary))' };
  return to ? (
    <Link to={to} className={cn(className, 'transition-opacity hover:opacity-90')} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>{body}</div>
  );
}
