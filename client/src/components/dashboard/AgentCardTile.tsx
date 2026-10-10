import { Link } from 'react-router-dom';
import type { Monitor, Heartbeat, AgentThresholds } from '@obliview/shared';
import { anonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

interface AgentCardTileProps {
  monitor: Monitor;
  heartbeats: Heartbeat[];
}

interface GpuInfo {
  model?: string;
  utilizationPct?: number;
  vramUsedMb?: number;
  vramTotalMb?: number;
  tempCelsius?: number;
  engines?: Array<{ label: string; pct: number }>;
}

/** Shape of the JSON stored in heartbeat.value for agent monitors */
interface AgentSnapshot {
  cpu?: number;
  memory?: number;
  disks?: Array<{ mount: string; percent: number }>;
  netIn?: number;   // bytes/sec (top-level, stored by agent.service)
  netOut?: number;  // bytes/sec
  loadAvg?: number;
  _full?: {         // raw AgentMetrics.metrics object
    gpus?: GpuInfo[];
    temps?: Array<{ label?: string; celsius?: number }> | Record<string, number>;
  };
}

function parseAgentSnapshot(heartbeats: Heartbeat[]): AgentSnapshot | null {
  // Scan backwards — synthetic offline-detection heartbeats have no value field
  for (let i = heartbeats.length - 1; i >= 0; i--) {
    if (!heartbeats[i]?.value) continue;
    try { return JSON.parse(heartbeats[i].value!) as AgentSnapshot; }
    catch { continue; }
  }
  return null;
}

function fmtBps(bps: number): string {
  if (bps >= 1_048_576) return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  if (bps >= 1_024)     return `${(bps / 1_024).toFixed(0)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Extract primary CPU temp from _full.temps (array or record form) */
function getPrimaryTemp(
  temps: Array<{ label?: string; celsius?: number }> | Record<string, number> | undefined,
): number | undefined {
  if (!temps) return undefined;
  if (Array.isArray(temps)) {
    const found = temps.find((t) => /cpu|package|core/i.test(String(t.label ?? ''))) ?? temps[0];
    return found?.celsius;
  }
  const keys = Object.keys(temps);
  const key = keys.find((k) => /cpu|package|core/i.test(k)) ?? keys[0];
  return key ? (temps as Record<string, number>)[key] : undefined;
}

/** Bar color based on value vs threshold */
function metricBarColor(value: number, threshold: number | undefined, baseColor: string): string {
  if (!threshold) return baseColor;
  if (value >= threshold)        return 'bg-status-down';
  if (value >= threshold * 0.85) return 'bg-status-pending';
  return baseColor;
}

/** Value text color based on value vs threshold */
function metricTextColor(value: number, threshold: number | undefined): string {
  if (!threshold) return 'text-text-secondary';
  if (value >= threshold)        return 'text-status-down';
  if (value >= threshold * 0.85) return 'text-status-pending';
  return 'text-text-secondary';
}

/** Standard metric bar row */
function MetricRow({
  label, barPct, barColor, valueStr, valueColor = 'text-text-secondary',
}: {
  label: string; barPct: number; barColor: string;
  valueStr: string; valueColor?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted w-8 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barColor)}
          style={{ width: `${Math.min(100, Math.max(0, barPct))}%` }}
        />
      </div>
      <span className={cn('text-xs font-mono w-16 text-right shrink-0', valueColor)}>
        {valueStr}
      </span>
    </div>
  );
}

/** Compact network row (thinner bar, ↓/↑ label) */
function NetRow({
  label, barPct, barColor, valueStr, valueColor = 'text-text-secondary',
}: {
  label: string; barPct: number; barColor: string;
  valueStr: string; valueColor?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted w-3 shrink-0 text-center">{label}</span>
      <div className="flex-1 h-1 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', barColor)}
          style={{ width: `${Math.min(100, Math.max(0, barPct))}%` }}
        />
      </div>
      <span className={cn('text-xs font-mono w-16 text-right shrink-0', valueColor)}>
        {valueStr}
      </span>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const isOnline = status === 'up';
  const isAlert  = status === 'alert';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[11px] font-medium shrink-0',
      isOnline ? 'text-status-up' : isAlert ? 'text-orange-500' : 'text-status-down',
    )}>
      <span className={cn(
        'inline-block w-1.5 h-1.5 rounded-full',
        isOnline ? 'bg-status-up' : isAlert ? 'bg-orange-500' : 'bg-status-down',
      )} />
      {isOnline ? 'Online' : isAlert ? 'Alert' : 'Offline'}
    </span>
  );
}

// 100 Mbps reference for displaying net bar when no threshold configured
const NET_REF = 12_500_000;

export function AgentCardTile({ monitor, heartbeats }: AgentCardTileProps) {
  const snapshot   = parseAgentSnapshot(heartbeats);
  const deviceName = anonymize(monitor.agentDeviceName ?? monitor.name);
  // /agents/:id is open to everyone who can see the agent monitor: the
  // server applies the read/write checks.
  const linkTo     = monitor.agentDeviceId
    ? `/agents/${monitor.agentDeviceId}`
    : `/monitor/${monitor.id}`;

  // ── Thresholds ─────────────────────────────────────────────────────────────
  const thr = monitor.agentThresholds as AgentThresholds | null | undefined;
  const cpuThr  = thr?.cpu?.enabled  !== false ? (thr?.cpu?.threshold  ?? 90) : undefined;
  const memThr  = thr?.memory?.enabled !== false ? (thr?.memory?.threshold  ?? 90) : undefined;
  const diskThr = thr?.disk?.enabled !== false ? (thr?.disk?.threshold ?? 90) : undefined;
  const netInThr  = thr?.netIn?.enabled  ? thr.netIn.threshold  : undefined;
  const netOutThr = thr?.netOut?.enabled ? thr.netOut.threshold : undefined;

  // ── GPU ────────────────────────────────────────────────────────────────────
  const gpu        = snapshot?._full?.gpus?.[0];
  const gpuUtil    = gpu?.utilizationPct;
  const gpuVramPct = (gpu?.vramTotalMb && gpu.vramTotalMb > 0)
    ? ((gpu.vramUsedMb ?? 0) / gpu.vramTotalMb) * 100
    : undefined;

  // ── Network ────────────────────────────────────────────────────────────────
  const netIn  = snapshot?.netIn;
  const netOut = snapshot?.netOut;
  const hasNet = netIn !== undefined || netOut !== undefined;

  // ── Disk + Temp ────────────────────────────────────────────────────────────
  const primaryDisk = snapshot?.disks?.[0];
  const cpuTemp     = getPrimaryTemp(snapshot?._full?.temps);
  const gpuTempFallback = (cpuTemp === undefined && gpu?.tempCelsius !== undefined)
    ? gpu.tempCelsius : undefined;

  // ── Alert message ──────────────────────────────────────────────────────────
  const lastHb = heartbeats[heartbeats.length - 1];
  const alertMsg = (monitor.status === 'alert' || monitor.status === 'down') &&
    lastHb?.message && lastHb.message !== 'All metrics OK'
      ? lastHb.message : null;

  return (
    <Link
      to={linkTo}
      data-status={monitor.status}
      className={cn(
        'flex flex-col rounded-lg border border-border bg-bg-secondary p-3.5 gap-2.5',
        'hover:bg-bg-hover hover:border-border-light transition-colors',
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-1 min-w-0">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary leading-tight">
            {deviceName}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 truncate">
            {monitor.name !== deviceName ? anonymize(monitor.name) : 'Agent Monitor'}
          </div>
        </div>
        <StatusDot status={monitor.status} />
      </div>

      {/* Core metrics: CPU / RAM / GPU / VRAM / Disk / Temp */}
      <div className="flex flex-col gap-1.5">
        {snapshot?.cpu !== undefined && (
          <MetricRow
            label="CPU"
            barPct={snapshot.cpu}
            barColor={metricBarColor(snapshot.cpu, cpuThr, 'bg-accent')}
            valueStr={`${snapshot.cpu.toFixed(0)}%`}
            valueColor={metricTextColor(snapshot.cpu, cpuThr)}
          />
        )}
        {snapshot?.memory !== undefined && (
          <MetricRow
            label="RAM"
            barPct={snapshot.memory}
            barColor={metricBarColor(snapshot.memory, memThr, 'bg-purple-500')}
            valueStr={`${snapshot.memory.toFixed(0)}%`}
            valueColor={metricTextColor(snapshot.memory, memThr)}
          />
        )}

        {gpuUtil !== undefined && (
          <MetricRow
            label="GPU"
            barPct={gpuUtil}
            barColor={metricBarColor(gpuUtil, 90, 'bg-pink-500')}
            valueStr={`${gpuUtil.toFixed(0)}%`}
            valueColor={metricTextColor(gpuUtil, 90)}
          />
        )}
        {gpuVramPct !== undefined && gpu?.vramTotalMb && (
          <MetricRow
            label="VRAM"
            barPct={gpuVramPct}
            barColor={metricBarColor(gpuVramPct, 90, 'bg-pink-400')}
            valueStr={fmtMb(gpu.vramUsedMb ?? 0)}
            valueColor={metricTextColor(gpuVramPct, 90)}
          />
        )}

        {primaryDisk && (
          <MetricRow
            label="Disk"
            barPct={primaryDisk.percent}
            barColor={metricBarColor(primaryDisk.percent, diskThr, 'bg-emerald-500')}
            valueStr={`${primaryDisk.percent.toFixed(0)}%`}
            valueColor={metricTextColor(primaryDisk.percent, diskThr)}
          />
        )}

        {(cpuTemp !== undefined || gpuTempFallback !== undefined) && (() => {
          const temp  = cpuTemp ?? gpuTempFallback!;
          const label = cpuTemp !== undefined ? 'Temp' : 'GPU°';
          return (
            <MetricRow
              label={label}
              barPct={(temp / 120) * 100}
              barColor={temp >= 90 ? 'bg-status-down' : temp >= 75 ? 'bg-status-pending' : 'bg-amber-500'}
              valueStr={`${temp.toFixed(0)}°C`}
              valueColor={temp >= 90 ? 'text-status-down' : temp >= 75 ? 'text-status-pending' : 'text-text-secondary'}
            />
          );
        })()}
      </div>

      {/* Network IN / OUT */}
      {hasNet && (
        <div className="flex flex-col gap-1 pt-1.5 border-t border-border/40">
          {netIn !== undefined && (
            <NetRow
              label="↓"
              barPct={netInThr
                ? Math.min(100, (netIn / netInThr) * 100)
                : Math.min(100, (netIn / NET_REF) * 100)}
              barColor={metricBarColor(netIn, netInThr, 'bg-teal-500')}
              valueStr={fmtBps(netIn)}
              valueColor={metricTextColor(netIn, netInThr)}
            />
          )}
          {netOut !== undefined && (
            <NetRow
              label="↑"
              barPct={netOutThr
                ? Math.min(100, (netOut / netOutThr) * 100)
                : Math.min(100, (netOut / NET_REF) * 100)}
              barColor={metricBarColor(netOut, netOutThr, 'bg-cyan-400')}
              valueStr={fmtBps(netOut)}
              valueColor={metricTextColor(netOut, netOutThr)}
            />
          )}
        </div>
      )}

      {/* Alert message */}
      {alertMsg && (
        <div className={cn(
          'text-[11px] truncate leading-tight',
          monitor.status === 'alert' ? 'text-orange-400' : 'text-status-down',
        )}>
          {alertMsg}
        </div>
      )}
    </Link>
  );
}
