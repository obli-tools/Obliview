import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceArea,
} from 'recharts';
import {
  ArrowLeft, ArrowLeftRight, RefreshCw, Settings2, Cpu, HardDrive,
  Network, Activity, Server, AlertTriangle, Wind, Thermometer,
  MonitorDot, ArrowDownToLine, ArrowUpFromLine,
  Pencil, Check, X, LayoutDashboard,
  MemoryStick, Wifi, RotateCcw,
  CheckCircle, XCircle, PauseCircle, PlayCircle, PowerOff, Undo2, DownloadCloud, Trash2,
  Clock, Ban,
} from 'lucide-react';
import type { AgentDevice, MonitorGroup, AgentThresholds, AgentMetricThreshold, AgentTempThreshold, AgentDisplayConfig, NotificationChannel, NotificationTypeConfig, Heartbeat } from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS, SOCKET_EVENTS } from '@obliview/shared';
import { AgentDisplayConfigModal } from '../components/agent/AgentDisplayConfigModal';
import { NotificationTypesPanel } from '../components/agent/NotificationTypesPanel';
import toast from 'react-hot-toast';
import {
  agentApi,
  type ResolvedAgentThresholds,
  type AgentDeviceAccess,
  type AgentApiKeyWithDefault,
  type AgentFleetDevice,
} from '../api/agent.api';
import { groupsApi } from '../api/groups.api';
import { useConfirm } from '../components/common/ConfirmDialog';
import { ActionMenu, type ActionMenuItem } from '../components/common/ActionMenu';
import {
  AgentDeviceStatusBadge,
  UPDATING_STALE_MS,
  deviceApprovalStatus,
  isPendingUninstall,
} from '../components/agent/DeviceStatusBadge';
import { ApproveAgentModal } from '../components/agent/ApproveAgentModal';
import { TransferTenantModal } from '../components/agent/TransferTenantModal';
import { useLocateRedirect } from '../hooks/useLocateRedirect';
import { apiErrorMessage } from '../utils/apiError';
import { useAuthStore } from '../store/authStore';
import { monitorsApi } from '../api/monitors.api';
import apiClient from '../api/client';
import type { AgentMetrics, AgentPushSnapshot } from '../types/agent';
import { anonymize, anonymizeIp } from '../utils/anonymize';
import { getSocket } from '../socket/socketClient';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { NotificationBindingsPanel } from '../components/notifications/NotificationBindingsPanel';
import { MaintenanceWindowList } from '../components/maintenance/MaintenanceWindowList';
import { HeartbeatBar } from '../components/monitors/HeartbeatBar';
import { cn } from '../utils/cn';
import { prettifySensorLabel } from '../utils/sensorLabels';
import { UpdatePolicyField, agentUpdateErrorMessage, frozenUpdateHint } from '../components/agent/UpdatePolicyField';

// ─────────────────────────────────────────────────────────────────────────────
// Types / constants
// ─────────────────────────────────────────────────────────────────────────────

type View = 'overview' | 'cpu' | 'ram' | 'gpu' | 'others' | 'temps' | 'uptime';
const MAX_HISTORY = 60;

const DEFAULT_DISPLAY_CONFIG: AgentDisplayConfig = {
  cpu: { groupCoreThreads: false, hiddenCores: [], tempSensor: null, hiddenCharts: [] },
  ram: { hideUsed: false, hideFree: false, hideSwap: false, hiddenCharts: [] },
  gpu: { hiddenRows: [], hiddenCharts: [] },
  drives: { hiddenMounts: [], renames: {}, combineReadWrite: false },
  network: { hiddenInterfaces: [], renames: {}, combineInOut: false },
  temps: { hiddenLabels: [] },
};

function mergeDisplayConfig(saved: AgentDisplayConfig | null): AgentDisplayConfig {
  if (!saved) return DEFAULT_DISPLAY_CONFIG;
  return {
    cpu: { ...DEFAULT_DISPLAY_CONFIG.cpu, ...saved.cpu },
    ram: { ...DEFAULT_DISPLAY_CONFIG.ram, ...saved.ram },
    gpu: { ...DEFAULT_DISPLAY_CONFIG.gpu, ...saved.gpu },
    drives: { ...DEFAULT_DISPLAY_CONFIG.drives, ...saved.drives },
    network: { ...DEFAULT_DISPLAY_CONFIG.network, ...saved.network },
    temps: { ...DEFAULT_DISPLAY_CONFIG.temps, ...saved.temps },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section height persistence (drag-to-resize, stored in localStorage)
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEIGHTS_KEY = 'bk:agent-section-heights-v2';

// Thread grid grows to fill the available card height (flex-1 + min-h-0, no max-h).
// overflow-y-auto shows a scrollbar only when threads exceed the visible area.
// MIN_TOP_HEIGHT = SectionCard header (~60px) + minimum usable thread area + breathing room ≈ 215px.
const MIN_TOP_HEIGHT    = 215;
const MIN_MIDDLE_HEIGHT = 120;
const MIN_BOTTOM_HEIGHT = 80;

const DEFAULT_HEIGHTS = { top: 220, middle: 200, bottom: 160 };

function useSectionHeights() {
  const [heights, setHeights] = useState<{ top: number; middle: number; bottom: number }>(() => {
    try {
      const raw = localStorage.getItem(SECTION_HEIGHTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Clamp to current minimums (in case minimums changed since last save)
        return {
          top:    Math.max(MIN_TOP_HEIGHT,    parsed.top    ?? DEFAULT_HEIGHTS.top),
          middle: Math.max(MIN_MIDDLE_HEIGHT, parsed.middle ?? DEFAULT_HEIGHTS.middle),
          bottom: Math.max(MIN_BOTTOM_HEIGHT, parsed.bottom ?? DEFAULT_HEIGHTS.bottom),
        };
      }
    } catch { /* ignore */ }
    return DEFAULT_HEIGHTS;
  });

  // adjust(section, min, dy) — called on every mousemove tick during drag
  const adjust = useCallback((section: 'top' | 'middle' | 'bottom', min: number, dy: number) => {
    setHeights(prev => {
      const next = { ...prev, [section]: Math.max(min, prev[section] + dy) };
      try { localStorage.setItem(SECTION_HEIGHTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { heights, adjust };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtMb(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}
function fmtGb(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(gb * 1024).toFixed(0)} MB`;
}
function fmtBps(bps: number): string {
  if (bps >= 1073741824) return `${(bps / 1073741824).toFixed(2)} GB/s`;
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}
/** Network throughput: bytes/sec → bits/sec using decimal SI (Kbps/Mbps/Gbps). */
function fmtNetBits(bps: number): string {
  const bits = bps * 8;
  if (bits >= 1_000_000_000) return `${(bits / 1_000_000_000).toFixed(2)} Gbps`;
  if (bits >= 1_000_000)     return `${(bits / 1_000_000).toFixed(2)} Mbps`;
  if (bits >= 1_000)         return `${(bits / 1_000).toFixed(1)} Kbps`;
  return `${bits.toFixed(0)} bps`;
}
/** "12s ago" / "3 min ago" / "2 h ago" / "4 days ago" (plural keys). */
function fmtRelTime(iso: string, t: TFunction): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return t('agents.detail.agoSeconds', '{{count}}s ago', { count: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('agents.detail.agoMinutes', '{{count}} min ago', { count: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('agents.detail.agoHours', '{{count}} h ago', { count: h });
  return t('agents.detail.agoDays', '{{count}} days ago', { count: Math.floor(h / 24) });
}
function extractVendor(model: string): string {
  const lc = model.toLowerCase();
  if (lc.includes('intel')) return 'Intel';
  if (lc.includes('amd')) return 'AMD';
  if (lc.includes('apple')) return 'Apple';
  if (lc.includes('arm')) return 'ARM';
  return '';
}
function fmtTimestampShort(iso: string, period: 'realtime' | '1h' | '24h' | '7d' | '30d' = 'realtime'): string {
  const d = new Date(iso);
  if (period === '7d' || period === '30d') {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (period === '24h') {
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

function usageSvgColor(pct: number, violating = false): string {
  if (violating || pct >= 90) return '#ef4444';
  if (pct >= 75) return '#eab308';
  return '#22d3ee'; // cyan-400 — Cores style
}
function usageBarClass(pct: number, violating = false): string {
  if (violating || pct >= 90) return 'bg-red-500';
  if (pct >= 75) return 'bg-yellow-500';
  return 'bg-cyan-400';
}
function usageTextClass(pct: number, violating = false): string {
  if (violating || pct >= 90) return 'text-red-400';
  if (pct >= 75) return 'text-yellow-400';
  return 'text-cyan-400';
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG Arc Gauge (semi-circle)
// ─────────────────────────────────────────────────────────────────────────────

function ArcGauge({ pct, color, size = 128 }: { pct: number; color: string; size?: number }) {
  const r = 44; const cx = 50; const cy = 50;
  const circ = 2 * Math.PI * r;
  const half = circ / 2;
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * half;
  const rot = `rotate(180 ${cx} ${cy})`;
  return (
    <svg viewBox="0 0 100 57" style={{ width: size, height: Math.round(size * 0.57) }} aria-hidden>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)"
        strokeWidth={9} strokeLinecap="round"
        strokeDasharray={`${half} ${circ}`} transform={rot} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color}
        strokeWidth={9} strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`} transform={rot}
        style={{ transition: 'stroke-dasharray 700ms ease, stroke 400ms ease' }} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Horizontal bar gauge
// ─────────────────────────────────────────────────────────────────────────────

function Bar({ pct, color, h = 'h-[5px]' }: { pct: number; color: string; h?: string }) {
  return (
    <div className={`w-full ${h} rounded-full bg-white/5 overflow-hidden`}>
      <div className={`h-full rounded-full transition-all duration-700 ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Downsample helper — evenly pick n representative samples from snapshots array
// ─────────────────────────────────────────────────────────────────────────────

/** Evenly pick n representative samples from snapshots array */
function downsample(snapshots: AgentPushSnapshot[], n: number): AgentPushSnapshot[] {
  if (snapshots.length <= n) return snapshots;
  const result: AgentPushSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i / (n - 1)) * (snapshots.length - 1));
    result.push(snapshots[idx]);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spark line/area chart
// ─────────────────────────────────────────────────────────────────────────────

function SparkChart({
  data, id, yMin = 0, yMax = 100, color, height = 100, timestamps, unit = '', period = 'realtime',
  data2, color2, legend,
}: {
  data: number[]; id: string; yMin?: number; yMax?: number; color: string; height?: number;
  timestamps?: string[]; unit?: string; period?: 'realtime' | '1h' | '24h' | '7d' | '30d';
  data2?: number[]; color2?: string; legend?: [string, string];
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gradId = `sg-${id}`;
  if (data.length < 2) return <div className="w-full bg-white/5 rounded" style={{ height }} />;
  const W = 500; const H = 80;
  const PL = 0; const PT = 4; const PB = 4;
  const cW = W - PL; const cH = H - PT - PB;
  const range = (yMax - yMin) || 1;
  const toX = (i: number) => PL + (i / (data.length - 1)) * cW;
  const toY = (v: number) => PT + cH - ((Math.min(yMax, Math.max(yMin, v)) - yMin) / range) * cH;
  const pts = data.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const pts2 = data2 && data2.length >= 2 ? data2.map((v, i) => `${toX(i)},${toY(v)}`).join(' ') : null;
  const areaD = [`M ${PL} ${PT + cH}`, ...data.map((v, i) => `L ${toX(i)} ${toY(v)}`), `L ${PL + cW} ${PT + cH}`, 'Z'].join(' ');
  const gridYs = [yMin, yMin + range / 2, yMax];
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(relX * (data.length - 1));
    setHoverIdx(Math.max(0, Math.min(data.length - 1, idx)));
  };
  const hX = hoverIdx !== null ? toX(hoverIdx) : null;
  const hY = hoverIdx !== null ? toY(data[hoverIdx]) : null;
  const hVal = hoverIdx !== null ? data[hoverIdx] : null;
  const hTs = hoverIdx !== null && timestamps ? timestamps[hoverIdx] : null;
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }}
      preserveAspectRatio="none"
      onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIdx(null)}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={`clip-${id}`}><rect x={PL} y={PT} width={cW} height={cH} /></clipPath>
      </defs>
      {gridYs.map((v, i) => (
        <line key={i} x1={PL} y1={toY(v)} x2={PL + cW} y2={toY(v)} stroke="rgba(255,255,255,0.06)" strokeWidth="0.8" />
      ))}
      <path d={areaD} fill={`url(#${gradId})`} clipPath={`url(#clip-${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" clipPath={`url(#clip-${id})`} />
      {pts2 && color2 && (
        <polyline points={pts2} fill="none" stroke={color2} strokeWidth="1.5" clipPath={`url(#clip-${id})`} />
      )}
      {legend && (
        <g>
          <rect x={6} y={4} width={12} height={2} rx="1" fill={color} />
          <text x={22} y={9} fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace">{legend[0]}</text>
          <rect x={6} y={16} width={12} height={2} rx="1" fill={color2 ?? color} />
          <text x={22} y={21} fill="rgba(255,255,255,0.7)" fontSize="9" fontFamily="monospace">{legend[1]}</text>
        </g>
      )}
      {hoverIdx !== null && hX !== null && hY !== null && hVal !== null && (
        <g>
          <line x1={hX} y1={PT} x2={hX} y2={PT + cH} stroke="rgba(255,255,255,0.25)" strokeWidth="0.8" strokeDasharray="2,2" />
          <circle cx={hX} cy={hY} r="3" fill={color} />
          {(() => {
            const label = `${hVal.toFixed(1)}${unit}`;
            const timeLabel = hTs ? fmtTimestampShort(hTs, period) : null;
            const bw = Math.max(label.length * 5.5, timeLabel ? timeLabel.length * 4.8 : 0, 38);
            const tx = Math.max(2, Math.min(hX, cW - bw - 4));
            const ty = Math.max(PT + 2, hY - 26);
            return (
              <g>
                <rect x={tx - 2} y={ty} width={bw + 4} height={timeLabel ? 24 : 14} rx="3" fill="rgba(0,0,0,0.75)" />
                <text x={tx + bw / 2} y={ty + 9} fill="white" fontSize="9" fontFamily="monospace" textAnchor="middle">{label}</text>
                {timeLabel && <text x={tx + bw / 2} y={ty + 20} fill="#aaa" fontSize="8" fontFamily="monospace" textAnchor="middle">{timeLabel}</text>}
              </g>
            );
          })()}
        </g>
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section card wrapper
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({
  icon, title, accent, subtitle, children, className, onConfig,
}: {
  icon: React.ReactNode; title: string; accent: string;
  subtitle?: string; children: React.ReactNode; className?: string;
  onConfig?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className={cn('rounded-xl border border-border bg-bg-secondary overflow-hidden flex flex-col h-full', className)}>
      <div className="px-4 pt-3 pb-2 border-b border-border shrink-0">
        <div className="flex items-center justify-between">
          <div className={`flex items-center gap-2 text-sm font-bold ${accent}`}>
            {icon} {title}
          </div>
          {onConfig && (
            <button
              onClick={(e) => { e.stopPropagation(); onConfig(); }}
              className="text-text-muted hover:text-text-secondary transition-colors p-0.5 rounded hover:bg-bg-hover"
              title={t('agents.detail.configureDisplay', 'Configure display')}
            >
              <Settings2 size={13} />
            </button>
          )}
        </div>
        {subtitle && <div className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag-to-resize handle between sections
// ─────────────────────────────────────────────────────────────────────────────

function ResizeHandle({ onResize }: { onResize: (dy: number) => void }) {
  const { t } = useTranslation();
  const dragRef = useRef<{ lastY: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { lastY: e.clientY };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = ev.clientY - dragRef.current.lastY;
      dragRef.current.lastY = ev.clientY;
      onResize(dy);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onResize]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group my-1 h-4 flex items-center justify-center cursor-ns-resize select-none"
      title={t('common.dragToResize', 'Drag to resize')}
    >
      <div className="w-20 h-[3px] rounded-full bg-border group-hover:bg-text-muted/40 group-active:bg-cyan-400/60 transition-colors duration-150" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CPU Card (Overview) — arc left, per-core scrollable right
// ─────────────────────────────────────────────────────────────────────────────

function CpuCard({ metrics, violating, displayConfig, onConfig }: {
  metrics: AgentMetrics; violating: boolean;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  onConfig?: () => void;
}) {
  const { t } = useTranslation();
  const cpu = metrics.cpu;
  if (!cpu) return null;
  const pct = cpu.percent;
  const color = usageSvgColor(pct, violating);
  const cores = cpu.cores ?? [];
  return (
    <SectionCard icon={<Cpu size={14} />} title="CPU" accent="text-cyan-400"
      subtitle={cpu.model || undefined} onConfig={onConfig}>
      {/* flex row: gauge left | scrollable 2-col core grid right
           min-h-0 on the row is required so the flex-1 child can overflow-y-auto */}
      <div className="flex gap-0 flex-1 overflow-hidden min-h-0">
        {/* Left: arc gauge */}
        <div className="flex flex-col items-center justify-center px-4 py-3 shrink-0 gap-1">
          <div className="relative" style={{ width: 112, height: 64 }}>
            <ArcGauge pct={pct} color={color} size={112} />
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <span className={`text-2xl font-bold tabular-nums leading-none ${violating ? 'text-red-400' : 'text-text-primary'}`}>
                {pct.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
              </span>
            </div>
          </div>
          {metrics.loadAvg !== undefined && (
            <span className="text-[10px] text-text-muted">{t('agents.detail.load', 'Load {{value}}', { value: metrics.loadAvg.toFixed(2) })}</span>
          )}
          {cpu.freqMhz !== undefined && (
            <span className="text-[10px] text-text-muted">
              {cpu.freqMhz >= 1000 ? `${(cpu.freqMhz / 1000).toFixed(1)} GHz` : `${cpu.freqMhz} MHz`}
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="w-px bg-border shrink-0" />

        {/* Right: core grid */}
        <div className="flex-1 min-w-0 overflow-y-auto py-2 px-3 min-h-0">
          {cores.length > 0 ? (() => {
            const coreClocks = cpu.coreClocksMhz;
            const maxClock = coreClocks && coreClocks.length > 0
              ? Math.max(...coreClocks.filter(v => v > 0), 1)
              : 0;

            if (displayConfig.cpu.groupCoreThreads) {
              // Grouped mode: 1 item per physical core with 2 stacked mini-bars
              const physicalCores = Math.ceil(cores.length / 2);
              return (
                <div className="flex flex-col gap-y-[10px]">
                  {Array.from({ length: physicalCores }, (_, coreIdx) => {
                    if (displayConfig.cpu.hiddenCores.includes(coreIdx)) return null;
                    const t1 = cores[coreIdx * 2] ?? 0;
                    const t2 = cores[coreIdx * 2 + 1];
                    const clockMhz = coreClocks?.[coreIdx];
                    const clockPct = clockMhz && maxClock > 0 ? (clockMhz / maxClock) * 100 : 0;
                    const maxPct = Math.max(t1, t2 ?? 0);
                    return (
                      <div key={coreIdx} className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] font-mono text-text-muted/80 w-[22px] shrink-0">
                          C{coreIdx}
                        </span>
                        <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
                          <Bar pct={t1} color={usageBarClass(t1)} h="h-[4px]" />
                          {t2 !== undefined && <Bar pct={t2} color={usageBarClass(t2)} h="h-[4px]" />}
                          {clockMhz !== undefined && clockMhz > 0 && (
                            <div className="mt-[2px] flex items-center gap-1 min-w-0">
                              <div className="flex-1 min-w-0 bg-surface-2 rounded-full h-[2px] overflow-hidden">
                                <div className="h-full bg-cyan-500/50 rounded-full" style={{ width: `${Math.min(clockPct, 100)}%` }} />
                              </div>
                              <span className="text-[8px] tabular-nums text-cyan-400/70 shrink-0 w-[34px] text-right">
                                {(clockMhz / 1000).toFixed(2)} GHz
                              </span>
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] tabular-nums text-text-secondary w-[26px] text-right shrink-0">
                          {maxPct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            }

            // Non-grouped mode: 2-column thread grid
            return (
              <div className="flex flex-col gap-y-[10px]">
                {Array.from({ length: Math.ceil(cores.length / 2) }, (_, coreIdx) => {
                  if (displayConfig.cpu.hiddenCores.includes(coreIdx)) return null;
                  const clockMhz = coreClocks?.[coreIdx];
                  const clockPct = clockMhz && maxClock > 0 ? (clockMhz / maxClock) * 100 : 0;
                  return (
                    <div key={coreIdx}>
                      {/* Thread load bars (2 threads per physical core) */}
                      <div className="grid grid-cols-2 gap-x-3">
                        {[0, 1].map(ti => {
                          const threadIdx = coreIdx * 2 + ti;
                          const threadPct = cores[threadIdx];
                          if (threadPct === undefined) return null;
                          const coreNum = coreIdx;
                          const threadNum = ti + 1;
                          return (
                            <div key={ti} className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[11px] font-mono text-text-muted/80 w-[36px] shrink-0">
                                C{coreNum}:{threadNum}
                              </span>
                              <div className="flex-1 min-w-0">
                                <Bar pct={threadPct} color={usageBarClass(threadPct)} h="h-[6px]" />
                              </div>
                              <span className="text-[11px] tabular-nums text-text-secondary w-[26px] text-right shrink-0">
                                {threadPct.toFixed(0)}%
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      {/* Mini clock bar — visible only when LHM provides per-core data */}
                      {clockMhz !== undefined && clockMhz > 0 && (
                        <div className="mt-[3px] flex items-center gap-1 min-w-0">
                          <div className="flex-1 min-w-0 bg-surface-2 rounded-full h-[3px] overflow-hidden">
                            <div
                              className="h-full bg-cyan-500/50 rounded-full transition-[width] duration-300"
                              style={{ width: `${Math.min(clockPct, 100)}%` }}
                            />
                          </div>
                          <span className="text-[9px] tabular-nums text-cyan-400/70 shrink-0 w-[38px] text-right">
                            {(clockMhz / 1000).toFixed(2)} GHz
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })() : (
            /* Fallback when no per-core data: single overall bar */
            <div className="flex items-center gap-2 pt-2">
              <span className="text-[10px] text-text-muted w-24 shrink-0">{t('agents.detail.overall', 'Overall')}</span>
              <div className="flex-1"><Bar pct={pct} color={usageBarClass(pct, violating)} /></div>
              <span className="text-[11px] tabular-nums text-text-secondary w-8 text-right shrink-0">{pct.toFixed(0)}%</span>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RAM Card (Overview) — arc left, breakdown right
// ─────────────────────────────────────────────────────────────────────────────

function RamCard({ metrics, violating, displayConfig, onConfig }: {
  metrics: AgentMetrics; violating: boolean;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  onConfig?: () => void;
}) {
  const { t } = useTranslation();
  const mem = metrics.memory;
  if (!mem) return null;
  const color = usageSvgColor(mem.percent, violating);
  const freeM = mem.totalMb - mem.usedMb;

  const rows: Array<{ label: string; value: string; pct?: number }> = [];
  if (!displayConfig.ram.hideUsed) rows.push({ label: t('agents.detail.used', 'Used'), value: fmtMb(mem.usedMb), pct: mem.percent });
  if (!displayConfig.ram.hideFree) rows.push({ label: t('agents.detail.free', 'Free'), value: fmtMb(freeM) });
  if (mem.cachedMb) rows.push({ label: t('agents.detail.cached', 'Cached'), value: fmtMb(mem.cachedMb), pct: (mem.cachedMb / mem.totalMb) * 100 });
  if (mem.buffersMb) rows.push({ label: t('agents.detail.buffers', 'Buffers'), value: fmtMb(mem.buffersMb), pct: (mem.buffersMb / mem.totalMb) * 100 });
  if (!displayConfig.ram.hideSwap && mem.swapTotalMb && mem.swapUsedMb !== undefined) {
    const swapPct = mem.swapTotalMb > 0 ? (mem.swapUsedMb / mem.swapTotalMb) * 100 : 0;
    rows.push({ label: t('agents.detail.swap', 'Swap'), value: `${fmtMb(mem.swapUsedMb)} / ${fmtMb(mem.swapTotalMb)}`, pct: swapPct });
  }

  return (
    <SectionCard icon={<MonitorDot size={14} />} title="RAM" accent="text-violet-400"
      subtitle={t('agents.detail.totalValue', 'Total: {{value}}', { value: fmtMb(mem.totalMb) })} onConfig={onConfig}>
      <div className="flex gap-0 flex-1 overflow-hidden">
        {/* Left: arc */}
        <div className="flex flex-col items-center justify-center px-4 py-3 shrink-0 gap-1">
          <div className="relative" style={{ width: 112, height: 64 }}>
            <ArcGauge pct={mem.percent} color={color} size={112} />
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <span className={`text-2xl font-bold tabular-nums leading-none ${violating ? 'text-red-400' : 'text-text-primary'}`}>
                {mem.percent.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
              </span>
            </div>
          </div>
          <span className="text-[10px] text-text-muted">{t('agents.detail.usedValue', '{{value}} used', { value: fmtMb(mem.usedMb) })}</span>
        </div>
        <div className="w-px bg-border shrink-0" />
        {/* Right: breakdown rows */}
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-2 min-h-0">
          {rows.map((r) => (
            <div key={r.label} className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">{r.label}</span>
                <span className="text-[13px] tabular-nums text-text-secondary">{r.value}</span>
              </div>
              {r.pct !== undefined && <Bar pct={r.pct} color="bg-violet-400" />}
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU Card (Overview)
// ─────────────────────────────────────────────────────────────────────────────

function GpuCard({ metrics, displayConfig, onConfig }: {
  metrics: AgentMetrics;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  onConfig?: () => void;
}) {
  const { t } = useTranslation();
  const gpus = metrics.gpus;
  if (!gpus || gpus.length === 0) {
    return (
      <SectionCard icon={<MonitorDot size={14} />} title="GPU" accent="text-pink-400" onConfig={onConfig}>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8 text-text-muted">
          <MonitorDot size={28} className="opacity-30" />
          <span className="text-xs">{t('agent.noGpuData', 'No GPU data')}</span>
        </div>
      </SectionCard>
    );
  }
  const gpu = gpus[0];
  const vramPct = gpu.vramTotalMb > 0 ? (gpu.vramUsedMb / gpu.vramTotalMb) * 100 : 0;
  const color = usageSvgColor(gpu.utilizationPct);

  // Engine utilization rows: use per-engine data when available, else show 3D overall.
  const engineRows: Array<{ label: string; pct: number; displayValue?: string }> =
    gpu.engines && gpu.engines.length > 0
      ? gpu.engines
      : [{ label: '3D', pct: gpu.utilizationPct }];

  // VRAM and Temp are always appended regardless of whether engine rows are present.
  const allRows: Array<{ label: string; pct: number; displayValue?: string }> = [
    ...engineRows,
    { label: 'VRAM', pct: vramPct, displayValue: `${fmtMb(gpu.vramUsedMb)} / ${fmtMb(gpu.vramTotalMb)}` },
    ...(gpu.tempCelsius !== undefined
      ? [{ label: 'Temp', pct: (gpu.tempCelsius / 120) * 100, displayValue: `${gpu.tempCelsius.toFixed(0)}°C` }]
      : []),
  ];

  const rows = allRows.filter(r => !displayConfig.gpu.hiddenRows.includes(r.label));

  return (
    <SectionCard icon={<MonitorDot size={14} />} title="GPU" accent="text-pink-400" subtitle={gpu.model} onConfig={onConfig}>
      <div className="flex gap-0 flex-1 overflow-hidden">
        <div className="flex flex-col items-center justify-center px-4 py-3 shrink-0 gap-1">
          <div className="relative" style={{ width: 112, height: 64 }}>
            <ArcGauge pct={gpu.utilizationPct} color={color} size={112} />
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <span className="text-2xl font-bold tabular-nums leading-none text-text-primary">
                {gpu.utilizationPct.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
              </span>
            </div>
          </div>
          {gpu.tempCelsius !== undefined && (
            <span className="text-[10px] text-text-muted">{gpu.tempCelsius.toFixed(0)}°C</span>
          )}
        </div>
        <div className="w-px bg-border shrink-0" />
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-2 min-h-0">
          {rows.map((r) => (
            <div key={r.label} className="space-y-0.5">
              <div className="flex justify-between">
                <span className="text-xs text-text-muted">{r.label === 'Temp' ? t('agents.detail.temp', 'Temp') : r.label}</span>
                <span className="text-[13px] tabular-nums text-text-secondary">
                  {r.displayValue ?? `${r.pct.toFixed(0)}%`}
                </span>
              </div>
              <Bar pct={r.pct} color="bg-pink-400" />
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drives Card
// ─────────────────────────────────────────────────────────────────────────────

function DrivesCard({ metrics, violating, displayConfig, onConfig, onRenameMount }: {
  metrics: AgentMetrics; violating: boolean;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  onConfig?: () => void;
  onRenameMount?: (mount: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editingMount, setEditingMount] = useState<string | null>(null);
  const [mountNameValue, setMountNameValue] = useState('');
  const [savingMount, setSavingMount] = useState(false);

  const disks = metrics.disks;
  if (!disks || disks.length === 0) return null;
  // Sort fullest first, then filter hidden mounts
  const sorted = [...disks].sort((a, b) => b.percent - a.percent);
  const visibleDisks = sorted.filter(d => !displayConfig.drives.hiddenMounts.includes(d.mount));
  const displayName = (mount: string) => displayConfig.drives.renames[mount] ?? mount;

  const handleSaveMount = async (mount: string) => {
    if (!onRenameMount) return;
    setSavingMount(true);
    try { await onRenameMount(mount, mountNameValue.trim()); setEditingMount(null); }
    catch { /* ignore */ } finally { setSavingMount(false); }
  };

  return (
    <SectionCard icon={<HardDrive size={14} />} title={t('agents.detail.drives', 'Drives')} accent="text-emerald-400" onConfig={onConfig}>
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {visibleDisks.map((d) => {
          const vio = violating && d.percent >= 90;
          const isEditing = editingMount === d.mount;
          const name = displayName(d.mount);
          return (
            <div key={d.mount} className="px-4 py-2.5 space-y-1 group">
              <div className="flex items-center justify-between gap-2">
                {/* Left: mount name with inline edit */}
                {isEditing ? (
                  <span className="flex items-center gap-1 min-w-0 flex-1">
                    <input type="text" value={mountNameValue} autoFocus
                      onChange={e => setMountNameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleSaveMount(d.mount); if (e.key === 'Escape') setEditingMount(null); }}
                      placeholder={d.mount}
                      className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted" />
                    <button onClick={() => void handleSaveMount(d.mount)} disabled={savingMount}
                      className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50 shrink-0" title={t('common.save')}>
                      <Check size={11} />
                    </button>
                    <button onClick={() => setEditingMount(null)}
                      className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0" title={t('common.cancel')}>
                      <X size={11} />
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1 min-w-0 flex-1">
                    <span className="text-sm font-medium text-text-secondary truncate max-w-[120px]">{name}</span>
                    {onRenameMount && (
                      <button
                        onClick={() => { setEditingMount(d.mount); setMountNameValue(name); }}
                        className="p-0.5 rounded text-text-muted opacity-0 group-hover:opacity-100 coarse:opacity-100 focus-visible:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all shrink-0"
                        title={t('agents.detail.rename', 'Rename')}>
                        <Pencil size={10} />
                      </button>
                    )}
                  </span>
                )}
                {/* Right: stats */}
                <div className="flex items-center gap-2 shrink-0">
                  {(d.readBytesPerSec !== undefined || d.writeBytesPerSec !== undefined) && (
                    <span className="text-xs text-text-muted flex gap-1">
                      {d.readBytesPerSec !== undefined && <span className="text-sky-400">↓{fmtBps(d.readBytesPerSec)}</span>}
                      {d.writeBytesPerSec !== undefined && <span className="text-amber-400">↑{fmtBps(d.writeBytesPerSec)}</span>}
                    </span>
                  )}
                  <span className={`text-sm tabular-nums font-semibold ${vio ? 'text-red-400' : 'text-text-primary'}`}>
                    {d.percent.toFixed(0)}%
                  </span>
                  <span className="text-xs text-text-muted">{fmtGb(d.usedGb)}/{fmtGb(d.totalGb)}</span>
                </div>
              </div>
              <Bar pct={d.percent} color={vio ? 'bg-red-500' : 'bg-emerald-400'} />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fans Card
// ─────────────────────────────────────────────────────────────────────────────

function FansCard({ metrics }: { metrics: AgentMetrics }) {
  const { t } = useTranslation();
  const fans = metrics.fans;
  if (!fans || fans.length === 0) return null;
  const maxRpm = Math.max(...fans.map(f => f.maxRpm ?? f.rpm), 1);
  return (
    <SectionCard icon={<Wind size={14} />} title={t('agents.detail.fans', 'Fans')} accent="text-slate-400">
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {fans.map((f) => {
          const pct = f.maxRpm ? (f.rpm / f.maxRpm) * 100 : (f.rpm / maxRpm) * 100;
          return (
            <div key={f.label} className="px-4 py-2.5 space-y-1">
              <div className="flex justify-between">
                <span className="text-xs text-text-secondary truncate max-w-[140px]">{f.label}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs tabular-nums font-semibold text-text-primary">{pct.toFixed(0)}%</span>
                  <span className="text-[10px] text-text-muted">{f.rpm.toLocaleString()} RPM</span>
                </div>
              </div>
              <Bar pct={pct} color="bg-slate-400" />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces Card
// ─────────────────────────────────────────────────────────────────────────────

function InterfacesCard({ metrics, displayConfig, onConfig, onRenameInterface }: {
  metrics: AgentMetrics;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  onConfig?: () => void;
  onRenameInterface?: (iface: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editingIface, setEditingIface] = useState<string | null>(null);
  const [ifaceNameValue, setIfaceNameValue] = useState('');
  const [savingIface, setSavingIface] = useState(false);

  const net = metrics.network;
  if (!net) return null;

  const netRenames = displayConfig.network.renames ?? {};
  // No per-interface data: one synthetic 'Total' row (its id, translated on display).
  const TOTAL_IFACE = 'Total';
  const perIface = !!net.interfaces && net.interfaces.length > 0;
  const displayIfaceName = (name: string) => netRenames[name]
    ?? (!perIface && name === TOTAL_IFACE ? t('agents.detail.total', 'Total') : name);

  const allIfaces = (perIface
    ? net.interfaces!
    : [{ name: TOTAL_IFACE, inBytesPerSec: net.inBytesPerSec, outBytesPerSec: net.outBytesPerSec }]
  ).slice().sort((a, b) => (b.inBytesPerSec + b.outBytesPerSec) - (a.inBytesPerSec + a.outBytesPerSec));
  const visibleIfaces = allIfaces.filter(i => !displayConfig.network.hiddenInterfaces.includes(i.name));
  const maxBps = Math.max(...visibleIfaces.flatMap(i => [i.inBytesPerSec, i.outBytesPerSec]), 1048576);

  const handleSaveIface = async (name: string) => {
    if (!onRenameInterface) return;
    setSavingIface(true);
    try { await onRenameInterface(name, ifaceNameValue.trim()); setEditingIface(null); }
    catch { /* ignore */ } finally { setSavingIface(false); }
  };

  return (
    <SectionCard icon={<Network size={14} />} title={t('agents.detail.interfaces', 'Interfaces')} accent="text-orange-400" onConfig={onConfig}>
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {visibleIfaces.map((iface) => {
          const isEditing = editingIface === iface.name;
          const displayedName = displayIfaceName(iface.name);
          return (
            <div key={iface.name} className="px-4 py-2.5 space-y-1.5 group">
              {/* Interface name with inline edit */}
              {isEditing ? (
                <span className="flex items-center gap-1 min-w-0">
                  <input type="text" value={ifaceNameValue} autoFocus
                    onChange={e => setIfaceNameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleSaveIface(iface.name); if (e.key === 'Escape') setEditingIface(null); }}
                    placeholder={iface.name}
                    className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted" />
                  <button onClick={() => void handleSaveIface(iface.name)} disabled={savingIface}
                    className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50 shrink-0" title={t('common.save')}>
                    <Check size={11} />
                  </button>
                  <button onClick={() => setEditingIface(null)}
                    className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0" title={t('common.cancel')}>
                    <X size={11} />
                  </button>
                </span>
              ) : (
                <span className="flex items-center gap-1 min-w-0">
                  <span className="text-xs font-medium text-text-secondary truncate">{displayedName}</span>
                  {onRenameInterface && (
                    <button
                      onClick={() => { setEditingIface(iface.name); setIfaceNameValue(displayedName); }}
                      className="p-0.5 rounded text-text-muted opacity-0 group-hover:opacity-100 coarse:opacity-100 focus-visible:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all shrink-0"
                      title={t('agents.detail.rename', 'Rename')}>
                      <Pencil size={10} />
                    </button>
                  )}
                </span>
              )}
              <div className="flex items-center gap-2">
                <ArrowDownToLine size={11} className="text-sky-400 shrink-0" />
                <div className="flex-1"><Bar pct={(iface.inBytesPerSec / maxBps) * 100} color="bg-sky-400" /></div>
                <span className="text-[13px] tabular-nums text-text-secondary w-20 text-right shrink-0">
                  {fmtNetBits(iface.inBytesPerSec)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <ArrowUpFromLine size={11} className="text-orange-400 shrink-0" />
                <div className="flex-1"><Bar pct={(iface.outBytesPerSec / maxBps) * 100} color="bg-orange-400" /></div>
                <span className="text-[13px] tabular-nums text-text-secondary w-20 text-right shrink-0">
                  {fmtNetBits(iface.outBytesPerSec)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Temperatures Section (bottom)
// ─────────────────────────────────────────────────────────────────────────────

function TempsSection({
  metrics, sensorDisplayNames, onRename, displayConfig, onConfig,
}: {
  metrics: AgentMetrics;
  sensorDisplayNames: Record<string, string> | null;
  /** Absent = read-only (no rename pencil). */
  onRename?: (key: string, name: string) => Promise<void>;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  onConfig?: () => void;
}) {
  const { t } = useTranslation();
  const temps = metrics.temps;
  const [editingSensor, setEditingSensor] = useState<string | null>(null);
  const [sensorNameValue, setSensorNameValue] = useState('');
  const [savingSensor, setSavingSensor] = useState(false);

  if (!temps || temps.length === 0) return null;
  const visibleTemps = temps.filter(tp => !displayConfig.temps.hiddenLabels.includes(tp.label));
  if (visibleTemps.length === 0) return null;
  const max = Math.max(...visibleTemps.map(tp => tp.celsius), 80);

  const handleStartEdit = (key: string, currentName: string) => {
    setEditingSensor(key); setSensorNameValue(currentName);
  };
  const handleSaveSensor = async () => {
    if (!editingSensor || !onRename) return;
    setSavingSensor(true);
    try { await onRename(editingSensor, sensorNameValue.trim()); setEditingSensor(null); }
    catch { /* ignore */ } finally { setSavingSensor(false); }
  };

  return (
    <SectionCard icon={<Thermometer size={14} />} title={t('agents.detail.temperatures', 'Temperatures')} accent="text-rose-400" onConfig={onConfig}>
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {visibleTemps.map((tp) => {
          const key = `temp:${tp.label}`;
          const displayName = sensorDisplayNames?.[key] ?? prettifySensorLabel(tp.label);
          const pct = (tp.celsius / max) * 100;
          const color = tp.celsius >= 90 ? 'bg-red-500' : tp.celsius >= 75 ? 'bg-yellow-500' : 'bg-rose-400';
          const isEditing = editingSensor === key;
          return (
            <div key={tp.label} className="flex items-center gap-3 px-4 py-2.5 group">
              {isEditing ? (
                <span className="flex items-center gap-1 flex-1 min-w-0">
                  <input type="text" value={sensorNameValue} autoFocus
                    onChange={e => setSensorNameValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void handleSaveSensor(); if (e.key === 'Escape') setEditingSensor(null); }}
                    placeholder={prettifySensorLabel(tp.label)}
                    className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted" />
                  <button onClick={() => void handleSaveSensor()} disabled={savingSensor}
                    className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50" title={t('common.save')}>
                    <Check size={11} />
                  </button>
                  <button onClick={() => setEditingSensor(null)}
                    className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title={t('common.cancel')}>
                    <X size={11} />
                  </button>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-text-secondary flex-1 min-w-0">
                  <span className="truncate">{displayName}</span>
                  {onRename && (
                    <button onClick={() => handleStartEdit(key, displayName)}
                      className="p-0.5 rounded text-text-muted opacity-0 group-hover:opacity-100 coarse:opacity-100 focus-visible:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all shrink-0"
                      title={t('agents.detail.renameSensor', 'Rename sensor')}>
                      <Pencil size={10} />
                    </button>
                  )}
                </span>
              )}
              <div className="w-40 shrink-0"><Bar pct={pct} color={color} /></div>
              <span className="text-sm tabular-nums font-semibold text-text-primary w-14 text-right shrink-0">
                {tp.celsius.toFixed(0)}°C
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview (real-time dashboard)
// ─────────────────────────────────────────────────────────────────────────────

function OverviewView({
  metrics, violations, sensorDisplayNames, onRename, displayConfig, openConfigModal,
  onRenameMount, onRenameInterface,
}: {
  metrics: AgentMetrics;
  violations: string[];
  sensorDisplayNames: Record<string, string> | null;
  // The callbacks below are absent for read-only viewers (no pencils / gears).
  onRename?: (key: string, name: string) => Promise<void>;
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
  openConfigModal?: (section: 'cpu' | 'ram' | 'gpu' | 'drives' | 'network' | 'temps') => void;
  onRenameMount?: (mount: string, name: string) => Promise<void>;
  onRenameInterface?: (iface: string, name: string) => Promise<void>;
}) {
  const configFor = (section: 'cpu' | 'ram' | 'gpu' | 'drives' | 'network' | 'temps') =>
    (openConfigModal ? () => openConfigModal(section) : undefined);
  const { t } = useTranslation();
  const hasCpuVio = violations.some(v => v.toLowerCase().includes('cpu'));
  const hasMemVio = violations.some(v => v.toLowerCase().includes('mem') || v.toLowerCase().includes('ram'));
  const hasDiskVio = violations.some(v => v.toLowerCase().includes('disk'));
  const hasFans = (metrics.fans?.length ?? 0) > 0;
  const hasNet = !!metrics.network;
  const hasTemp = (metrics.temps?.length ?? 0) > 0;
  const hasMiddle = (metrics.disks?.length ?? 0) > 0 || hasFans || hasNet;
  const middleCount = [(metrics.disks?.length ?? 0) > 0, hasFans, hasNet].filter(Boolean).length;

  const { heights, adjust } = useSectionHeights();

  // Stable resize callbacks — minimums prevent the handle from entering the section above
  const onTopResize    = useCallback((dy: number) => adjust('top',    MIN_TOP_HEIGHT,    dy), [adjust]);
  const onMidResize    = useCallback((dy: number) => adjust('middle', MIN_MIDDLE_HEIGHT, dy), [adjust]);
  const onBottomResize = useCallback((dy: number) => adjust('bottom', MIN_BOTTOM_HEIGHT, dy), [adjust]);

  return (
    <div>
      {/* ── Top row: CPU / RAM / GPU ── */}
      <div
        className="grid gap-4 grid-cols-1 md:grid-cols-3 overflow-hidden"
        style={{ height: heights.top, gridTemplateRows: '1fr' }}
      >
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          {metrics.cpu
            ? <CpuCard metrics={metrics} violating={hasCpuVio} displayConfig={displayConfig} onConfig={configFor('cpu')} />
            : <SectionCard icon={<Cpu size={14} />} title="CPU" accent="text-cyan-400">
                <div className="flex-1 flex items-center justify-center text-text-muted text-xs">{t('common.noData', 'No data')}</div>
              </SectionCard>
          }
        </div>
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          {metrics.memory
            ? <RamCard metrics={metrics} violating={hasMemVio} displayConfig={displayConfig} onConfig={configFor('ram')} />
            : <SectionCard icon={<MonitorDot size={14} />} title="RAM" accent="text-violet-400">
                <div className="flex-1 flex items-center justify-center text-text-muted text-xs">{t('common.noData', 'No data')}</div>
              </SectionCard>
          }
        </div>
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          <GpuCard metrics={metrics} displayConfig={displayConfig} onConfig={configFor('gpu')} />
        </div>
      </div>

      {/* Resize handle — resizes the top section */}
      <ResizeHandle onResize={onTopResize} />

      {/* ── Middle row: Drives / Fans / Interfaces ── */}
      {hasMiddle && (
        <>
          <div
            className={cn(
              'grid gap-4',
              middleCount === 3 ? 'grid-cols-1 md:grid-cols-3'
                : middleCount === 2 ? 'grid-cols-1 md:grid-cols-2'
                : 'grid-cols-1',
            )}
            style={{ height: heights.middle, gridTemplateRows: '1fr' }}
          >
            {(metrics.disks?.length ?? 0) > 0 && (
              <div className="h-full flex flex-col overflow-hidden min-h-0">
                <DrivesCard metrics={metrics} violating={hasDiskVio} displayConfig={displayConfig} onConfig={configFor('drives')} onRenameMount={onRenameMount} />
              </div>
            )}
            {hasFans && (
              <div className="h-full flex flex-col overflow-hidden min-h-0">
                <FansCard metrics={metrics} />
              </div>
            )}
            {hasNet && (
              <div className="h-full flex flex-col overflow-hidden min-h-0">
                <InterfacesCard metrics={metrics} displayConfig={displayConfig} onConfig={configFor('network')} onRenameInterface={onRenameInterface} />
              </div>
            )}
          </div>
          {/* Resize handle between middle and temperature — resizes the middle section */}
          {hasTemp && <ResizeHandle onResize={onMidResize} />}
        </>
      )}

      {/* Resize handle between top and temperature when no middle section */}
      {!hasMiddle && hasTemp && <ResizeHandle onResize={onBottomResize} />}

      {/* ── Bottom: Temps ── */}
      {hasTemp && (
        <>
          <div style={{ height: heights.bottom }}>
            <TempsSection metrics={metrics} sensorDisplayNames={sensorDisplayNames} onRename={onRename}
              displayConfig={displayConfig} onConfig={configFor('temps')} />
          </div>
          {/* Resize handle BELOW the temperature section */}
          <ResizeHandle onResize={onBottomResize} />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart Card wrapper
// ─────────────────────────────────────────────────────────────────────────────

function ChartCard({
  icon, title, accent, data, id, yMin, yMax, color, unit, latestLabel, height = 110,
  timestamps, period, titleSuffix, data2, color2, legend,
}: {
  icon: React.ReactNode; title: React.ReactNode; accent: string;
  data: number[]; id: string; yMin?: number; yMax?: number;
  color: string; unit: string; latestLabel?: string; height?: number;
  timestamps?: string[]; period?: 'realtime' | '1h' | '24h' | '7d' | '30d';
  titleSuffix?: React.ReactNode;
  data2?: number[]; color2?: string; legend?: [string, string];
}) {
  const { t } = useTranslation();
  const latest = data[data.length - 1];
  // Time axis labels: show start, middle, end timestamps
  const timeLabels: string[] = [];
  if (timestamps && timestamps.length >= 2) {
    const fmt = (iso: string) => fmtTimestampShort(iso, period ?? 'realtime');
    timeLabels.push(fmt(timestamps[0]));
    if (timestamps.length > 2) timeLabels.push(fmt(timestamps[Math.floor(timestamps.length / 2)]));
    timeLabels.push(fmt(timestamps[timestamps.length - 1]));
  }
  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden group">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className={`flex items-center gap-2 text-sm font-bold ${accent}`}>{icon} {title}{titleSuffix}</div>
        {latest !== undefined && (
          <span className="text-sm font-bold tabular-nums text-text-primary">
            {latestLabel ?? `${latest.toFixed(1)}${unit}`}
          </span>
        )}
      </div>
      <div className="p-3 pb-2">
        <SparkChart data={data} id={id} yMin={yMin} yMax={yMax} color={color} height={height}
          timestamps={timestamps} unit={unit} period={period} data2={data2} color2={color2} legend={legend} />
        <div className="flex justify-between text-[10px] text-text-muted mt-1 px-0.5">
          {timeLabels.length >= 2 ? (
            <>
              <span>{timeLabels[0]}</span>
              {timeLabels.length === 3 && <span className="hidden sm:inline">{timeLabels[1]}</span>}
              <span>{timeLabels[timeLabels.length - 1]}</span>
            </>
          ) : (
            <>
              <span>{data.length > 1 ? t('agents.detail.samples', '{{count}} samples', { count: data.length }) : '—'}</span>
              <span>{t('agents.detail.now', 'Now')}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CPU Detail View (history charts)
// ─────────────────────────────────────────────────────────────────────────────

const CPU_CORES_HEIGHT_KEY = 'bk:agent-cpu-cores-height';

function CpuView({ metrics, history, period, displayConfig }: {
  metrics: AgentMetrics; history: AgentPushSnapshot[]; period: 'realtime' | '1h' | '24h' | '7d' | '30d';
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
}) {
  const { t } = useTranslation();
  const cpu = metrics.cpu;
  const vendor = cpu?.model ? extractVendor(cpu.model) : '';
  const threads = cpu?.cores?.length ?? 0;
  const cores = cpu?.cores ?? [];
  const timestamps = history.map(h => h.receivedAt);

  // Physical cores: assume 2 threads per physical core (same grouping as CpuCard in Overview)
  const numCores = Math.ceil(cores.length / 2);

  // Resizable height for the per-core scrollable area (persisted in localStorage)
  const [coresHeight, setCoresHeight] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(CPU_CORES_HEIGHT_KEY);
      if (raw) return Math.max(140, parseInt(raw, 10));
    } catch { /* ignore */ }
    return 340;
  });
  const onCoresResize = useCallback((dy: number) => {
    setCoresHeight(prev => {
      const next = Math.max(140, prev + dy);
      try { localStorage.setItem(CPU_CORES_HEIGHT_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const loadData = history.map(h => h.metrics.cpu?.percent ?? 0);
  const loadAvgData = history.map(h => h.metrics.loadAvg ?? 0);
  const freqData = history.map(h => h.metrics.cpu?.freqMhz ?? 0).filter((_, i) => history[i].metrics.cpu?.freqMhz !== undefined);
  // Temperature: specific sensor if configured, otherwise average CPU temps
  const tempData = (() => {
    if (displayConfig.cpu.tempSensor) {
      return history.map(h => {
        const sensor = h.metrics.temps?.find(t => t.label === displayConfig.cpu.tempSensor);
        return sensor?.celsius ?? 0;
      }).filter((_v, i) => history[i].metrics.temps && history[i].metrics.temps!.length > 0);
    }
    return history.map(h => {
      const temps = h.metrics.temps;
      if (!temps || temps.length === 0) return 0;
      const cpuTemps = temps.filter(t => /cpu|core|package/i.test(t.label));
      const arr = cpuTemps.length > 0 ? cpuTemps : temps;
      return arr.reduce((s, t) => s + t.celsius, 0) / arr.length;
    }).filter((_v, i) => history[i].metrics.temps && history[i].metrics.temps!.length > 0);
  })();

  return (
    <div className="space-y-4">
      {/* CPU Info — full-width card with metadata + resizable per-core grid */}
      <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-3 pb-2 border-b border-border">
          <div className="flex items-center gap-2 text-sm font-bold text-cyan-400">
            <Cpu size={14} /> {t('agents.detail.cpuInfo', 'CPU Info')}
          </div>
        </div>

        <div className="p-4 pb-2">
          {/* Metadata row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            {vendor && (
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.vendor', 'Vendor')}</div>
                <div className="text-text-primary font-medium">{vendor}</div>
              </div>
            )}
            {cpu?.model && (
              <div className="col-span-2">
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.model', 'Model')}</div>
                <div className="text-text-primary font-medium truncate">{cpu.model}</div>
              </div>
            )}
            {cpu?.freqMhz && (
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.baseSpeed', 'Base Speed')}</div>
                <div className="text-text-primary font-medium">
                  {cpu.freqMhz >= 1000 ? `${(cpu.freqMhz / 1000).toFixed(2)} GHz` : `${cpu.freqMhz} MHz`}
                </div>
              </div>
            )}
            {threads > 0 && (
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.threads', 'Threads')}</div>
                <div className="text-text-primary font-medium">{threads} T</div>
              </div>
            )}
          </div>
        </div>

        {/* Per-core section — only shown when per-thread data is available */}
        {cores.length > 0 && (
          <>
            {/* Section divider with core count label */}
            <div className="flex items-center gap-3 px-4 py-1.5">
              <div className="flex-1 border-t border-border" />
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest shrink-0">
                {t('agents.detail.coreCount', '{{count}} cores', { count: numCores })} · {t('agents.detail.threadCount', '{{count}} threads', { count: cores.length })}
              </span>
              <div className="flex-1 border-t border-border" />
            </div>

            {/* Scrollable 2-column core grid */}
            <div
              style={{ height: coresHeight }}
              className="overflow-y-auto px-4 pb-1"
            >
              <div className="grid grid-cols-2 gap-3 pb-1">
                {Array.from({ length: numCores }, (_, cIdx) => {
                  const t1 = cores[cIdx * 2];
                  const t2 = cores[cIdx * 2 + 1];
                  const avgPct = t2 !== undefined ? (t1 + t2) / 2 : t1;
                  return (
                    <div
                      key={cIdx}
                      className="rounded-lg bg-white/[0.04] border border-white/[0.06] p-3 space-y-2.5"
                    >
                      {/* Core header */}
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-bold text-cyan-400/80 tracking-wide">C{cIdx}</span>
                        <span className={`text-[11px] tabular-nums font-semibold ${usageTextClass(avgPct)}`}>
                          {avgPct.toFixed(0)}%
                        </span>
                      </div>

                      {/* Thread 1 */}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-mono text-text-muted/70">T1</span>
                          <span className="text-[11px] tabular-nums text-text-secondary">{t1.toFixed(0)}%</span>
                        </div>
                        <Bar pct={t1} color={usageBarClass(t1)} h="h-[11px]" />
                      </div>

                      {/* Thread 2 (only when HT / SMT) */}
                      {t2 !== undefined && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-mono text-text-muted/70">T2</span>
                            <span className="text-[11px] tabular-nums text-text-secondary">{t2.toFixed(0)}%</span>
                          </div>
                          <Bar pct={t2} color={usageBarClass(t2)} h="h-[11px]" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Drag handle — resize the cores panel */}
            <ResizeHandle onResize={onCoresResize} />
          </>
        )}
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loadData.length >= 2 && (
          <ChartCard icon={<Activity size={13} />} title={t('agents.detail.cpuLoad', 'CPU Load')} accent="text-cyan-400"
            data={loadData} id="cpu-load" yMin={0} yMax={100} color="#22d3ee" unit="%"
            timestamps={timestamps} period={period} />
        )}
        {!displayConfig.cpu.hiddenCharts.includes('load-avg') && loadAvgData.some(v => v > 0) && (
          <ChartCard icon={<Activity size={13} />} title={t('agents.detail.loadAverage', 'Load Average')} accent="text-sky-400"
            data={loadAvgData} id="load-avg" yMin={0} yMax={Math.max(...loadAvgData, 1)} color="#38bdf8" unit=""
            timestamps={timestamps} period={period} />
        )}
        {!displayConfig.cpu.hiddenCharts.includes('temp') && tempData.length >= 2 && (
          <ChartCard icon={<Thermometer size={13} />} title={displayConfig.cpu.tempSensor ? displayConfig.cpu.tempSensor : t('agents.detail.avgTemperature', 'Avg Temperature')} accent="text-rose-400"
            data={tempData} id="cpu-temp" yMin={20} yMax={100} color="#f87171" unit="°C"
            latestLabel={`${tempData[tempData.length - 1].toFixed(1)}°C`}
            timestamps={timestamps.slice(0, tempData.length)} period={period} />
        )}
        {!displayConfig.cpu.hiddenCharts.includes('freq') && freqData.length >= 2 && (
          <ChartCard icon={<Cpu size={13} />} title={t('agents.detail.clockSpeed', 'Clock Speed')} accent="text-violet-400"
            data={freqData} id="cpu-freq"
            yMin={Math.min(...freqData) * 0.9}
            yMax={Math.max(...freqData) * 1.05}
            color="#a78bfa" unit=" MHz"
            latestLabel={freqData[freqData.length - 1] >= 1000
              ? `${(freqData[freqData.length - 1] / 1000).toFixed(2)} GHz`
              : `${freqData[freqData.length - 1].toFixed(0)} MHz`}
            timestamps={timestamps.slice(0, freqData.length)} period={period} />
        )}
      </div>

      {history.length < 2 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
          {t('agents.detail.graphsAccumulate', 'Graphs will appear as data accumulates (at least 2 push cycles).')}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RAM View
// ─────────────────────────────────────────────────────────────────────────────

function RamView({ history, period, displayConfig }: {
  history: AgentPushSnapshot[]; period: 'realtime' | '1h' | '24h' | '7d' | '30d';
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
}) {
  const { t } = useTranslation();
  const timestamps = history.map(h => h.receivedAt);
  const memPct = history.map(h => h.metrics.memory?.percent ?? 0);
  const memUsedMB = history.map(h => h.metrics.memory?.usedMb ?? 0);
  const swapUsed = history.map(h => h.metrics.memory?.swapUsedMb ?? 0);
  const hasSwap = swapUsed.some(v => v > 0);
  const latest = history[history.length - 1]?.metrics.memory;
  const maxMem = latest ? latest.totalMb : Math.max(...memUsedMB, 1);
  const maxSwap = latest?.swapTotalMb ?? Math.max(...swapUsed, 1);
  return (
    <div className="space-y-4">
      {latest && (
        <div className="rounded-xl border border-border bg-bg-secondary p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-violet-400 mb-3">
            <MemoryStick size={14} /> {t('agents.detail.ramInfo', 'RAM Info')}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.total', 'Total')}</div>
              <div className="text-text-primary font-medium">{fmtMb(latest.totalMb)}</div>
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.used', 'Used')}</div>
              <div className="text-text-primary font-medium">{fmtMb(latest.usedMb)}</div>
            </div>
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.available', 'Available')}</div>
              <div className="text-text-primary font-medium">{fmtMb(latest.totalMb - latest.usedMb)}</div>
            </div>
            {latest.cachedMb != null && latest.cachedMb > 0 && (
              <div>
                <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">{t('agents.detail.cached', 'Cached')}</div>
                <div className="text-text-primary font-medium">{fmtMb(latest.cachedMb)}</div>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {!displayConfig.ram.hiddenCharts.includes('pct') && memPct.length >= 2 && (
          <ChartCard icon={<MemoryStick size={13} />} title={t('agents.detail.memoryUsage', 'Memory Usage')} accent="text-violet-400"
            data={memPct} id="ram-pct" yMin={0} yMax={100} color="#a78bfa" unit="%"
            timestamps={timestamps} period={period} />
        )}
        {!displayConfig.ram.hiddenCharts.includes('used-mb') && memUsedMB.length >= 2 && (
          <ChartCard icon={<MemoryStick size={13} />} title={t('agents.detail.memoryUsed', 'Memory Used')} accent="text-violet-400"
            data={memUsedMB} id="ram-used" yMin={0} yMax={maxMem} color="#8b5cf6" unit=" MB"
            latestLabel={fmtMb(memUsedMB[memUsedMB.length - 1])}
            timestamps={timestamps} period={period} />
        )}
        {!displayConfig.ram.hiddenCharts.includes('swap') && hasSwap && swapUsed.length >= 2 && (
          <ChartCard icon={<MemoryStick size={13} />} title={t('agents.detail.swapUsed', 'Swap Used')} accent="text-purple-400"
            data={swapUsed} id="swap-used" yMin={0} yMax={maxSwap} color="#7c3aed" unit=" MB"
            latestLabel={fmtMb(swapUsed[swapUsed.length - 1])}
            timestamps={timestamps} period={period} />
        )}
      </div>
      {history.length < 2 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
          {t('agents.detail.graphsAccumulate', 'Graphs will appear as data accumulates (at least 2 push cycles).')}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU View
// ─────────────────────────────────────────────────────────────────────────────

function GpuView({ history, period, displayConfig }: {
  history: AgentPushSnapshot[]; period: 'realtime' | '1h' | '24h' | '7d' | '30d';
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
}) {
  const { t } = useTranslation();
  const timestamps = history.map(h => h.receivedAt);
  // Collect unique GPU names across history
  const gpuNames = Array.from(new Set(history.flatMap(h => (h.metrics.gpus ?? []).map(g => g.model))));
  if (gpuNames.length === 0) return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
      {t('agents.detail.noGpuData', 'No GPU data available.')}
    </div>
  );
  return (
    <div className="space-y-6">
      {gpuNames.map((name, gi) => {
        const utilData = history.map(h => (h.metrics.gpus ?? [])[gi]?.utilizationPct ?? 0);
        const vramUsed = history.map(h => (h.metrics.gpus ?? [])[gi]?.vramUsedMb ?? 0);
        const tempData = history.map(h => (h.metrics.gpus ?? [])[gi]?.tempCelsius ?? 0).filter(v => v > 0);
        const hasTempData = tempData.length > 0;
        const latestGpu = history[history.length - 1]?.metrics.gpus?.[gi];
        const maxVram = latestGpu?.vramTotalMb ?? Math.max(...vramUsed, 1);
        return (
          <div key={name} className="space-y-3">
            <div className="rounded-xl border border-border bg-bg-secondary p-4">
              <div className="flex items-center gap-2 text-sm font-bold text-indigo-400 mb-1">
                <MonitorDot size={14} /> {name}
              </div>
              {latestGpu && (
                <div className="flex gap-6 text-xs text-text-muted mt-1">
                  <span>VRAM {fmtMb(latestGpu.vramUsedMb)} / {fmtMb(latestGpu.vramTotalMb)}</span>
                  {(latestGpu.tempCelsius ?? 0) > 0 && <span>{latestGpu.tempCelsius!.toFixed(0)}°C</span>}
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {!displayConfig.gpu.hiddenCharts.includes('util') && utilData.length >= 2 && (
                <ChartCard icon={<MonitorDot size={13} />} title={t('agents.detail.gpuUtilization', 'GPU Utilization')} accent="text-indigo-400"
                  data={utilData} id={`gpu-${gi}-util`} yMin={0} yMax={100} color="#818cf8" unit="%"
                  timestamps={timestamps} period={period} />
              )}
              {!displayConfig.gpu.hiddenCharts.includes('vram') && vramUsed.length >= 2 && (
                <ChartCard icon={<MonitorDot size={13} />} title={t('agents.detail.vramUsed', 'VRAM Used')} accent="text-indigo-400"
                  data={vramUsed} id={`gpu-${gi}-vram`} yMin={0} yMax={maxVram} color="#6366f1" unit=" MB"
                  latestLabel={fmtMb(vramUsed[vramUsed.length - 1])}
                  timestamps={timestamps} period={period} />
              )}
              {!displayConfig.gpu.hiddenCharts.includes('temp') && hasTempData && tempData.length >= 2 && (
                <ChartCard icon={<Thermometer size={13} />} title={t('agents.detail.gpuTemperature', 'GPU Temperature')} accent="text-rose-400"
                  data={tempData} id={`gpu-${gi}-temp`} yMin={20} yMax={100} color="#f87171" unit="°C"
                  latestLabel={`${tempData[tempData.length - 1].toFixed(0)}°C`}
                  timestamps={timestamps.slice(0, tempData.length)} period={period} />
              )}
            </div>
          </div>
        );
      })}
      {history.length < 2 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
          {t('agents.detail.graphsAccumulate', 'Graphs will appear as data accumulates (at least 2 push cycles).')}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Others View (Disks + Interfaces)
// ─────────────────────────────────────────────────────────────────────────────

function OthersView({ history, period, displayConfig }: {
  history: AgentPushSnapshot[]; period: 'realtime' | '1h' | '24h' | '7d' | '30d';
  displayConfig: import('@obliview/shared').AgentDisplayConfig;
}) {
  const { t } = useTranslation();
  const timestamps = history.map(h => h.receivedAt);
  // Collect unique disk mounts and interface names
  const allMounts = Array.from(new Set(history.flatMap(h => (h.metrics.disks ?? []).map(d => d.mount))));
  const mounts = allMounts.filter(m => !displayConfig.drives.hiddenMounts.includes(m));
  const displayMountName = (mount: string) => displayConfig.drives.renames[mount] ?? mount;

  const allIfaceNames = Array.from(new Set(history.flatMap(h => (h.metrics.network?.interfaces ?? []).map(i => i.name))));
  const ifaceNames = allIfaceNames.filter(n => !displayConfig.network.hiddenInterfaces.includes(n));
  const displayIfaceName = (name: string) => (displayConfig.network.renames ?? {})[name] ?? name;

  const hasIO = mounts.some(mount =>
    history.some(h => {
      const d = (h.metrics.disks ?? []).find(d => d.mount === mount);
      return (d?.readBytesPerSec ?? 0) > 0 || (d?.writeBytesPerSec ?? 0) > 0;
    })
  );
  const hasNetIO = ifaceNames.some(name =>
    history.some(h => {
      const i = (h.metrics.network?.interfaces ?? []).find(i => i.name === name);
      return (i?.inBytesPerSec ?? 0) > 0 || (i?.outBytesPerSec ?? 0) > 0;
    })
  );
  return (
    <div className="space-y-6">
      {/* Disk I/O */}
      {hasIO && (
        <div>
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <HardDrive size={12} /> {t('agents.detail.diskIo', 'Disk I/O')}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {mounts.flatMap(mount => {
              const readData = history.map(h => (h.metrics.disks ?? []).find(d => d.mount === mount)?.readBytesPerSec ?? 0);
              const writeData = history.map(h => (h.metrics.disks ?? []).find(d => d.mount === mount)?.writeBytesPerSec ?? 0);
              const hasRead = readData.some(v => v > 0);
              const hasWrite = writeData.some(v => v > 0);
              if (!hasRead && !hasWrite) return [];
              const maxIO = Math.max(...readData, ...writeData, 1);
              const mountDisplayName = displayMountName(mount);
              const safeId = mount.replace(/\//g, '-');

              if (displayConfig.drives.combineReadWrite) {
                const latestRead = readData[readData.length - 1] ?? 0;
                const latestWrite = writeData[writeData.length - 1] ?? 0;
                return [
                  readData.length >= 2 && (
                    <ChartCard key={`${mount}-rw`} icon={<HardDrive size={13} />} title={`${mountDisplayName} I/O`} accent="text-emerald-400"
                      data={readData} id={`disk${safeId}-rw`} yMin={0} yMax={maxIO} color="#34d399" unit=" B/s"
                      data2={writeData} color2="#f59e0b" legend={[t('agents.detail.read', 'Read'), t('agents.detail.write', 'Write')]}
                      latestLabel={`↑${fmtBps(latestRead)} ↓${fmtBps(latestWrite)}`}
                      timestamps={timestamps} period={period} />
                  ),
                ].filter(Boolean);
              }

              return [
                hasRead && readData.length >= 2 && (
                  <ChartCard key={`${mount}-r`} icon={<HardDrive size={13} />} title={t('agents.detail.mountRead', '{{name}} read', { name: mountDisplayName })} accent="text-emerald-400"
                    data={readData} id={`disk${safeId}-r`} yMin={0} yMax={maxIO} color="#34d399" unit=" B/s"
                    latestLabel={fmtBps(readData[readData.length - 1])}
                    timestamps={timestamps} period={period} />
                ),
                hasWrite && writeData.length >= 2 && (
                  <ChartCard key={`${mount}-w`} icon={<HardDrive size={13} />} title={t('agents.detail.mountWrite', '{{name}} write', { name: mountDisplayName })} accent="text-amber-400"
                    data={writeData} id={`disk${safeId}-w`} yMin={0} yMax={maxIO} color="#fbbf24" unit=" B/s"
                    latestLabel={fmtBps(writeData[writeData.length - 1])}
                    timestamps={timestamps} period={period} />
                ),
              ].filter(Boolean);
            })}
          </div>
        </div>
      )}
      {/* Network I/O per interface */}
      {hasNetIO && (
        <div>
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3 flex items-center gap-1.5">
            <Wifi size={12} /> {t('agents.detail.networkIo', 'Network I/O')}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {ifaceNames.flatMap(name => {
              const inData = history.map(h => (h.metrics.network?.interfaces ?? []).find(i => i.name === name)?.inBytesPerSec ?? 0);
              const outData = history.map(h => (h.metrics.network?.interfaces ?? []).find(i => i.name === name)?.outBytesPerSec ?? 0);
              if (!inData.some(v => v > 0) && !outData.some(v => v > 0)) return [];
              const maxNet = Math.max(...inData, ...outData, 1);

              const ifaceDisplayName = displayIfaceName(name);
              if (displayConfig.network.combineInOut) {
                const latestIn = inData[inData.length - 1] ?? 0;
                const latestOut = outData[outData.length - 1] ?? 0;
                return [
                  inData.length >= 2 && (
                    <ChartCard key={`${name}-io`} icon={<Network size={13} />} title={`${ifaceDisplayName} I/O`} accent="text-sky-400"
                      data={inData} id={`net-${name}-io`} yMin={0} yMax={maxNet} color="#38bdf8" unit=" B/s"
                      data2={outData} color2="#fb923c" legend={['IN', 'OUT']}
                      latestLabel={`↓${fmtBps(latestIn)} ↑${fmtBps(latestOut)}`}
                      timestamps={timestamps} period={period} />
                  ),
                ].filter(Boolean);
              }

              return [
                inData.length >= 2 && (
                  <ChartCard key={`${name}-in`} icon={<ArrowDownToLine size={13} />} title={`${ifaceDisplayName} ↓`} accent="text-sky-400"
                    data={inData} id={`net-${name}-in`} yMin={0} yMax={maxNet} color="#38bdf8" unit=" B/s"
                    latestLabel={fmtBps(inData[inData.length - 1])}
                    timestamps={timestamps} period={period} />
                ),
                outData.length >= 2 && (
                  <ChartCard key={`${name}-out`} icon={<ArrowUpFromLine size={13} />} title={`${ifaceDisplayName} ↑`} accent="text-orange-400"
                    data={outData} id={`net-${name}-out`} yMin={0} yMax={maxNet} color="#fb923c" unit=" B/s"
                    latestLabel={fmtBps(outData[outData.length - 1])}
                    timestamps={timestamps} period={period} />
                ),
              ].filter(Boolean);
            })}
          </div>
        </div>
      )}
      {!hasIO && !hasNetIO && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
          {t('agents.detail.noIoData', 'No disk I/O or network data available. Data accumulates after 2 push cycles.')}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Temperatures View
// ─────────────────────────────────────────────────────────────────────────────

function TempsView({
  history, period, sensorDisplayNames, onRename,
}: {
  history: AgentPushSnapshot[];
  period: 'realtime' | '1h' | '24h' | '7d' | '30d';
  sensorDisplayNames: Record<string, string> | null;
  /** Absent = read-only (no rename pencil). */
  onRename?: (key: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const timestamps = history.map(h => h.receivedAt);
  const sensorLabels = Array.from(new Set(history.flatMap(h => (h.metrics.temps ?? []).map(t => t.label))));
  const [editingSensor, setEditingSensor] = useState<string | null>(null);
  const [sensorNameValue, setSensorNameValue] = useState('');
  const [savingSensor, setSavingSensor] = useState(false);

  const handleStartEdit = (key: string, currentName: string) => {
    setEditingSensor(key); setSensorNameValue(currentName);
  };
  const handleSaveSensor = async () => {
    if (!editingSensor || !onRename) return;
    setSavingSensor(true);
    try { await onRename(editingSensor, sensorNameValue.trim()); setEditingSensor(null); }
    catch { /* ignore */ } finally { setSavingSensor(false); }
  };

  if (sensorLabels.length === 0) return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
      {t('agents.detail.noTempData', 'No temperature data available.')}
    </div>
  );
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {sensorLabels.map(label => {
        const key = `temp:${label}`;
        const displayName = sensorDisplayNames?.[key] ?? prettifySensorLabel(label);
        const data = history.map(h => (h.metrics.temps ?? []).find(t => t.label === label)?.celsius ?? 0);
        if (data.length < 2) return null;
        const maxTemp = Math.max(...data, 80);
        const latestTemp = data[data.length - 1];
        const color = latestTemp >= 90 ? '#ef4444' : latestTemp >= 75 ? '#eab308' : '#f87171';
        const accent = latestTemp >= 90 ? 'text-red-400' : latestTemp >= 75 ? 'text-yellow-400' : 'text-rose-400';
        const isEditing = editingSensor === key;
        const titleNode: React.ReactNode = isEditing ? (
          <span className="flex items-center gap-1 font-normal">
            <input type="text" value={sensorNameValue} autoFocus
              onChange={e => setSensorNameValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleSaveSensor(); if (e.key === 'Escape') setEditingSensor(null); }}
              placeholder={label}
              className="w-28 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted" />
            <button onClick={() => void handleSaveSensor()} disabled={savingSensor}
              className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50" title={t('common.save')}>
              <Check size={11} />
            </button>
            <button onClick={() => setEditingSensor(null)}
              className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title={t('common.cancel')}>
              <X size={11} />
            </button>
          </span>
        ) : displayName;
        const titleSuffix: React.ReactNode = isEditing || !onRename ? null : (
          <button onClick={() => handleStartEdit(key, displayName)}
            className="ml-1 p-0.5 rounded text-text-muted opacity-0 group-hover:opacity-100 coarse:opacity-100 focus-visible:opacity-100 hover:text-text-primary hover:bg-bg-hover transition-all"
            title={t('agents.detail.renameSensor', 'Rename sensor')}>
            <Pencil size={10} />
          </button>
        );
        return (
          <ChartCard key={label} icon={<Thermometer size={13} />} title={titleNode} accent={accent}
            data={data} id={`temp-${label}`} yMin={0} yMax={maxTemp} color={color} unit="°C"
            latestLabel={`${latestTemp.toFixed(0)}°C`}
            timestamps={timestamps} period={period} titleSuffix={titleSuffix} />
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Uptime % chart — recharts-based, mirrors the look-and-feel of the monitor
// HeartbeatChart: 60 buckets, area + line, per-bucket outage shading
// (orange for partial, red for full-down — never the whole chart), tooltip
// with the exact bucket time range and up/total counts, drag-to-zoom and
// reset zoom button.
// ─────────────────────────────────────────────────────────────────────────────

interface UptimePoint {
  ts: number;
  pct: number;
  up: number;
  total: number;
  hasOutage: boolean;
  allDown: boolean;
  fullLabel: string;
  slotEnd: number;
  tickLabel: string;
}

const _upP2 = (n: number) => String(n).padStart(2, '0');
// Day + short month in the browser locale ("02 Oct", "02 oct.").
const _upFmtDate   = (d: Date) => d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
const _upFmtDateHm = (d: Date) => `${_upFmtDate(d)} ${_upP2(d.getHours())}:${_upP2(d.getMinutes())}`;
const _upFmtHms    = (d: Date) => `${_upP2(d.getHours())}:${_upP2(d.getMinutes())}:${_upP2(d.getSeconds())}`;
const _upFmtHm     = (d: Date) => `${_upP2(d.getHours())}:${_upP2(d.getMinutes())}`;

function buildUptimePoints(
  heartbeats: Heartbeat[],
  _period: 'realtime' | '1h' | '24h' | '7d' | '30d',
  customRange?: { from: Date; to: Date },
): UptimePoint[] {
  const N = 60;
  if (heartbeats.length === 0) return [];

  let rangeStart: number;
  let rangeEnd: number;
  if (customRange) {
    rangeStart = customRange.from.getTime();
    rangeEnd   = customRange.to.getTime();
  } else {
    rangeStart = new Date(heartbeats[0].createdAt).getTime();
    rangeEnd   = new Date(heartbeats[heartbeats.length - 1].createdAt).getTime();
    if (rangeEnd <= rangeStart) rangeEnd = rangeStart + 60_000;
  }
  const span = rangeEnd - rangeStart;
  const bucketMs = span / N;

  // Tick / tooltip formatting. Tooltip always shows the FULL bucket range
  // (start -> end) so the user knows exactly which slice of time they are
  // hovering — important on 7d / 30d where each bucket spans several hours
  // and the start-only label hides the precision the user is looking for.
  const rangeHours = span / 3_600_000;
  let tickLabelFn: (ts: number) => string;
  let fullLabelFn: (start: Date, end: Date) => string;
  if (rangeHours < 2) {
    tickLabelFn = ts => _upFmtHms(new Date(ts));
    fullLabelFn = (s, e) => `${_upFmtHms(s)} – ${_upFmtHms(e)}`;
  } else if (rangeHours < 72) {
    tickLabelFn = ts => _upFmtHm(new Date(ts));
    fullLabelFn = (s, e) => {
      const sameDay = s.toDateString() === e.toDateString();
      return sameDay
        ? `${_upFmtDate(s)} ${_upFmtHm(s)} – ${_upFmtHm(e)}`
        : `${_upFmtDateHm(s)} – ${_upFmtDateHm(e)}`;
    };
  } else {
    tickLabelFn = ts => _upFmtDate(new Date(ts));
    fullLabelFn = (s, e) => {
      const sameDay = s.toDateString() === e.toDateString();
      return sameDay
        ? `${_upFmtDate(s)} ${_upFmtHm(s)} – ${_upFmtHm(e)}`
        : `${_upFmtDateHm(s)} – ${_upFmtDateHm(e)}`;
    };
  }

  const slotList = Array.from({ length: N }, (_, i) => rangeStart + i * bucketMs);
  const buckets = new Map<number, { up: number; total: number }>();
  for (const ts of slotList) buckets.set(ts, { up: 0, total: 0 });

  for (const hb of heartbeats) {
    const hbMs = new Date(hb.createdAt).getTime();
    if (hbMs < rangeStart || hbMs > rangeEnd) continue;
    const idx = Math.min(N - 1, Math.max(0, Math.floor((hbMs - rangeStart) / bucketMs)));
    const b = buckets.get(slotList[idx]);
    if (!b) continue;
    b.total++;
    if (hb.status === 'up') b.up++;
  }

  // Carry-forward avoids 0% spikes for empty buckets between two healthy ones.
  let last = 100;
  return slotList.map(ts => {
    const b = buckets.get(ts)!;
    const slotEnd = ts + bucketMs;
    if (b.total > 0) last = (b.up / b.total) * 100;
    const pct = last;
    return {
      ts,
      pct: Math.round(pct * 100) / 100,
      up: b.up,
      total: b.total,
      hasOutage: b.total > 0 && b.up < b.total,
      allDown:   b.total > 0 && b.up === 0,
      fullLabel: fullLabelFn(new Date(ts), new Date(slotEnd)),
      slotEnd,
      tickLabel: tickLabelFn(ts),
    };
  });
}

function UptimeTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: UptimePoint }> }) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div style={{
      background: 'rgb(var(--c-bg-secondary))', border: '1px solid rgb(var(--c-border))', borderRadius: 6,
      padding: '8px 12px', fontSize: 12, color: 'rgb(var(--c-text-primary))', lineHeight: 1.6,
    }}>
      <div style={{ color: 'rgb(var(--c-text-secondary))', marginBottom: 4 }}>{p.fullLabel}</div>
      <div style={{
        color: p.allDown ? 'rgb(var(--c-status-down))' :
               p.hasOutage ? 'rgb(var(--c-status-pending))' :
                             'rgb(var(--c-status-up))',
        fontWeight: 600,
      }}>
        {t('agents.detail.pctUp', '{{pct}}% up', { pct: p.pct.toFixed(2) })}
      </div>
      {p.total > 0 && (
        <div style={{ color: 'rgb(var(--c-text-secondary))', fontSize: 11 }}>
          {t('agents.detail.checksReachable', '{{up}}/{{total}} checks reachable', { up: p.up, total: p.total })}
        </div>
      )}
      {p.allDown && (
        <div style={{ color: 'rgb(var(--c-status-down))', fontSize: 11, marginTop: 2 }}>
          {t('agents.detail.unreachableWindow', 'Agent unreachable for the entire window')}
        </div>
      )}
      {p.hasOutage && !p.allDown && (
        <div style={{ color: 'rgb(var(--c-status-pending))', fontSize: 11, marginTop: 2 }}>
          ⚠ {t('agents.detail.partialOutage', 'Partial outage in window')}
        </div>
      )}
    </div>
  );
}

function UptimeChart({
  heartbeats,
  period,
}: {
  heartbeats: Heartbeat[];
  period: 'realtime' | '1h' | '24h' | '7d' | '30d';
}) {
  const { t } = useTranslation();
  // Drag-to-zoom: stores a custom range overriding the period bucketing.
  const [customRange, setCustomRange] = useState<{ from: Date; to: Date } | null>(null);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd]     = useState<number | null>(null);
  const [dragging, setDragging]   = useState(false);

  const onMouseDown = useCallback((e: { activeLabel?: number | string | null }) => {
    if (e?.activeLabel == null) return;
    setDragStart(Number(e.activeLabel));
    setDragEnd(null);
    setDragging(true);
  }, []);
  const onMouseMove = useCallback((e: { activeLabel?: number | string | null }) => {
    if (!dragging || e?.activeLabel == null) return;
    setDragEnd(Number(e.activeLabel));
  }, [dragging]);
  const onMouseUp = useCallback((e: { activeLabel?: number | string | null }) => {
    if (!dragging) return;
    setDragging(false);
    const l = dragStart;
    const r = dragEnd ?? (e?.activeLabel != null ? Number(e.activeLabel) : null);
    setDragStart(null);
    setDragEnd(null);
    if (l === null || r === null) return;
    const from = new Date(Math.min(l, r));
    const to   = new Date(Math.max(l, r));
    if (to.getTime() - from.getTime() < 60_000) return;
    setCustomRange({ from, to });
  }, [dragging, dragStart, dragEnd]);

  const points = useMemo(
    () => buildUptimePoints(heartbeats, period, customRange ?? undefined),
    [heartbeats, period, customRange],
  );

  if (heartbeats.length === 0 || points.length === 0) return null;

  // Per-bucket reference areas (outage shading) — orange for partial, red for full.
  // Crucial: shading is per-bucket, never spanning the whole chart, so a single
  // 5-min outage in a 30d window doesn't paint everything red.
  const refAreas = points.flatMap(p => {
    if (p.allDown)   return [{ x1: p.ts, x2: p.slotEnd, fill: 'rgb(var(--c-status-down))', opacity: 0.20 }];
    if (p.hasOutage) return [{ x1: p.ts, x2: p.slotEnd, fill: 'rgb(var(--c-status-pending))', opacity: 0.18 }];
    return [];
  });

  const ticks = points.filter((_, i) => i % 6 === 0).map(p => p.ts);
  const tickLabelMap = new Map<number, string>();
  for (const p of points) tickLabelMap.set(p.ts, p.tickLabel);
  const tickFormatter = (ts: number) => tickLabelMap.get(ts) ?? '';

  const domain: [number, number] = [points[0].ts, points[points.length - 1].slotEnd];

  return (
    <div className="space-y-2" style={{ position: 'relative', userSelect: 'none' }}>
      {customRange && (
        <button
          onClick={() => setCustomRange(null)}
          title={t('charts.resetZoom', 'Back to original period')}
          style={{
            position: 'absolute', top: -2, right: 0, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'rgb(var(--c-bg-secondary) / 0.92)', border: '1px solid rgb(var(--c-border))',
            borderRadius: 6, padding: '3px 8px', fontSize: 11,
            color: 'rgb(var(--c-text-secondary))', cursor: 'pointer', lineHeight: 1.4,
          }}
        >
          ↺ {t('agents.detail.resetZoom', 'Reset zoom')}
        </button>
      )}
      {!customRange && (
        <div style={{
          position: 'absolute', top: -2, right: 0, zIndex: 10,
          fontSize: 10, color: 'rgb(var(--c-text-muted))', pointerEvents: 'none',
        }}>
          {t('agents.detail.dragToZoom', 'Drag to zoom')}
        </div>
      )}

      <ResponsiveContainer width="100%" height={180}>
        <AreaChart
          data={points}
          margin={{ top: 8, right: 5, bottom: 5, left: 5 }}
          onMouseDown={onMouseDown as any}
          onMouseMove={onMouseMove as any}
          onMouseUp={onMouseUp as any}
          style={{ cursor: 'crosshair' }}
        >
          <defs>
            <linearGradient id="uptime-up" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="rgb(var(--c-status-up))" stopOpacity={0.32} />
              <stop offset="95%" stopColor="rgb(var(--c-status-up))" stopOpacity={0} />
            </linearGradient>
          </defs>

          {refAreas.map((a, i) => (
            <ReferenceArea key={`u-ra-${i}`} x1={a.x1} x2={a.x2}
              fill={a.fill} fillOpacity={a.opacity} stroke="none" />
          ))}

          {dragging && dragStart !== null && dragEnd !== null && (
            <ReferenceArea
              x1={Math.min(dragStart, dragEnd)}
              x2={Math.max(dragStart, dragEnd)}
              fill="rgb(var(--c-accent))" fillOpacity={0.10}
              stroke="rgb(var(--c-accent))" strokeOpacity={0.5} strokeWidth={1}
            />
          )}

          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--c-border))" />

          <XAxis
            dataKey="ts" type="number" scale="time"
            domain={domain}
            ticks={ticks}
            tickFormatter={tickFormatter}
            tick={{ fill: 'rgb(var(--c-text-muted))', fontSize: 10 }}
            stroke="rgb(var(--c-border))"
          />
          <YAxis
            tick={{ fill: 'rgb(var(--c-text-muted))', fontSize: 11 }}
            stroke="rgb(var(--c-border))"
            domain={[0, 100]}
            ticks={[0, 50, 95, 100]}
            unit="%"
            width={50}
          />

          {!dragging && <Tooltip content={<UptimeTooltip />} />}

          <Area
            type="monotone"
            dataKey="pct"
            stroke="rgb(var(--c-status-up))"
            strokeWidth={2}
            fill="url(#uptime-up)"
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Uptime View
// Online/offline timeline backed by the heartbeat history of the agent's
// monitor. Period selector mirrors the other tabs (Live / 1H / 24H / 7d / 30d).
// ─────────────────────────────────────────────────────────────────────────────

function UptimeView({
  heartbeats, period, isOnline, currentStatus, loading, lastPushIso, checkIntervalSeconds,
}: {
  heartbeats: Heartbeat[];
  period: 'realtime' | '1h' | '24h' | '7d' | '30d';
  isOnline: boolean;
  currentStatus: string;
  loading: boolean;
  lastPushIso: string | null;
  checkIntervalSeconds: number;
}) {
  const { t } = useTranslation();

  // Stats over the visible heartbeat window
  const total = heartbeats.length;
  const upCount      = heartbeats.filter(h => h.status === 'up').length;
  const downCount    = heartbeats.filter(h => h.status === 'down' || h.status === 'pending').length;
  const alertCount   = heartbeats.filter(h => h.status === 'alert').length;
  const maintCount   = heartbeats.filter(h => h.inMaintenance).length;
  const uptimePct    = total > 0 ? (upCount / total) * 100 : 0;

  // Average response time across recorded heartbeats (push interval observed)
  const responseTimes = heartbeats.map(h => h.responseTime).filter((x): x is number => x != null && x > 0);
  const avgResponseTime = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
    : null;

  // Approximate duration covered (pretty)
  const periodLabel = period === 'realtime' ? t('agent.uptime.live', 'Live') : period.toUpperCase();

  // Find longest down streak in the window
  let longestDown = 0;
  let cur = 0;
  for (const h of heartbeats) {
    if (h.status === 'up') { cur = 0; continue; }
    cur += 1;
    if (cur > longestDown) longestDown = cur;
  }
  const longestDownDuration = longestDown * checkIntervalSeconds;

  const fmtDuration = (s: number): string => {
    if (s <= 0) return '—';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  };

  const uptimeColor =
    uptimePct >= 99 ? 'text-status-up' :
    uptimePct >= 95 ? 'text-yellow-400' :
    'text-red-400';

  return (
    <div className="space-y-4">

      {/* Hero strip — current status + uptime % over the selected window */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-2">
            {t('agent.uptime.currentStatus', 'Current status')}
          </div>
          <div className="flex items-center gap-2">
            <span className={cn(
              'h-3 w-3 rounded-full shrink-0',
              isOnline ? 'bg-status-up shadow-[0_0_8px_2px] shadow-status-up/50' : 'bg-text-muted',
            )} />
            <span className={cn(
              'font-display text-[26px] font-semibold leading-none',
              isOnline ? 'text-status-up' : 'text-text-muted',
            )}>
              {isOnline ? t('agent.uptime.online', 'Online') : t('agent.uptime.offline', 'Offline')}
            </span>
          </div>
          <div className="mt-2 text-[11px] font-mono text-text-muted">
            {lastPushIso ? `${t('agent.uptime.lastPush', 'Last push')}: ${fmtRelTime(lastPushIso, t)}` : currentStatus}
          </div>
        </div>

        <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-2">
            {t('agent.uptime.uptimePct', 'Uptime')} · {periodLabel}
          </div>
          <div className={cn('font-display text-[36px] font-semibold leading-none tabular-nums', uptimeColor)}>
            {total > 0 ? `${uptimePct.toFixed(2)}%` : '—'}
          </div>
          <div className="mt-3 h-1 w-full bg-white/[0.04] rounded">
            <div
              className={cn(
                'h-full rounded',
                uptimePct >= 99 ? 'bg-status-up' :
                uptimePct >= 95 ? 'bg-yellow-400' :
                'bg-red-400',
              )}
              style={{ width: `${Math.min(100, Math.max(0, uptimePct))}%` }}
            />
          </div>
        </div>

        <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-2">
            {t('agent.uptime.totalChecks', 'Checks')}
          </div>
          <div className="font-display text-[36px] font-semibold leading-none text-text-primary tabular-nums">
            {total}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1 text-[11px] font-mono">
            <span className="text-status-up">↑ {upCount}</span>
            <span className="text-red-400">↓ {downCount + alertCount}</span>
            {maintCount > 0 && <span className="text-status-maintenance">⚒ {maintCount}</span>}
          </div>
        </div>

        <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-2">
            {t('agent.uptime.longestDown', 'Longest outage')}
          </div>
          <div className="font-display text-[26px] font-semibold leading-none text-text-primary tabular-nums">
            {fmtDuration(longestDownDuration)}
          </div>
          <div className="mt-2 text-[11px] font-mono text-text-muted">
            {avgResponseTime != null
              ? `${t('agent.uptime.avgResponse', 'Avg response')}: ${avgResponseTime}ms`
              : t('agent.uptime.noResponseData', 'No response data')}
          </div>
        </div>
      </div>

      {/* Uptime % over time chart */}
      {total > 0 && (
        <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-3">
            {t('agent.uptime.chart', 'Uptime over time')}
          </div>
          <UptimeChart heartbeats={heartbeats} period={period} />
        </div>
      )}

      {/* Heartbeat timeline */}
      <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted">
              {t('agent.uptime.timeline', 'Heartbeat timeline')}
            </div>
            <div className="text-[12px] text-text-secondary mt-0.5">
              {periodLabel} · {t('agents.detail.heartbeatCount', '{{count}} heartbeats', { count: total })}
            </div>
          </div>
          {loading && (
            <span className="text-xs text-text-muted animate-pulse">{t('common.loading')}</span>
          )}
        </div>

        {total === 0 && !loading ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-text-muted text-sm">
            {t('agent.uptime.noData', 'No heartbeat history for this period.')}
          </div>
        ) : (
          <div className="space-y-2">
            <HeartbeatBar heartbeats={heartbeats} maxBars={Math.min(heartbeats.length, 200)} />
            {heartbeats.length > 0 && (
              <div className="flex justify-between text-[10px] font-mono text-text-muted">
                <span>{fmtTimestampShort(heartbeats[0].createdAt, period)}</span>
                <span>{fmtTimestampShort(heartbeats[heartbeats.length - 1].createdAt, period)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Latest events table */}
      {heartbeats.length > 0 && (
        <div className="rounded-xl bg-bg-secondary p-4 shadow-card">
          <div className="text-[11px] font-mono uppercase tracking-[0.14em] text-text-muted mb-3">
            {t('agent.uptime.recentEvents', 'Recent state changes')}
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {(() => {
              // Collapse consecutive same-status heartbeats into events
              const events: Array<{ status: string; from: string; to: string; durationS: number; inMaintenance: boolean }> = [];
              let runStart: Heartbeat | null = null;
              let runStatus: string | null = null;
              for (const hb of heartbeats) {
                const s = hb.inMaintenance ? 'maintenance' : hb.status;
                if (runStatus === null) {
                  runStart = hb; runStatus = s;
                } else if (s !== runStatus) {
                  events.push({
                    status: runStatus,
                    from: runStart!.createdAt,
                    to: hb.createdAt,
                    durationS: Math.max(0, Math.round((new Date(hb.createdAt).getTime() - new Date(runStart!.createdAt).getTime()) / 1000)),
                    inMaintenance: runStatus === 'maintenance',
                  });
                  runStart = hb; runStatus = s;
                }
              }
              if (runStart && runStatus !== null) {
                const last = heartbeats[heartbeats.length - 1];
                events.push({
                  status: runStatus,
                  from: runStart.createdAt,
                  to: last.createdAt,
                  durationS: Math.max(0, Math.round((new Date(last.createdAt).getTime() - new Date(runStart.createdAt).getTime()) / 1000)),
                  inMaintenance: runStatus === 'maintenance',
                });
              }
              return events.slice(-30).reverse().map((e, i) => {
                const color =
                  e.status === 'up'          ? 'text-status-up' :
                  e.status === 'maintenance' ? 'text-status-maintenance' :
                  e.status === 'alert'       ? 'text-orange-400' :
                                               'text-red-400';
                return (
                  <div key={i} className="flex items-center gap-3 text-[12px] font-mono">
                    <span className={cn('uppercase font-semibold w-20 shrink-0', color)}>
                      {e.status === 'maintenance'
                        ? t('agents.runtime.maintenance', 'Maintenance')
                        : t(`status.${e.status}`, e.status)}
                    </span>
                    <span className="text-text-secondary flex-1 truncate">
                      {fmtTimestampShort(e.from, period)} → {fmtTimestampShort(e.to, period)}
                    </span>
                    <span className="text-text-muted tabular-nums">{fmtDuration(e.durationS)}</span>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold Editor Modal
// ─────────────────────────────────────────────────────────────────────────────

// ── Toggle switch helper ──────────────────────────────────────────────────────
function Switch({ on, onChange, disabled = false }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange?.(!on)}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-bg-tertiary border border-border',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform',
        on ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

type ThresholdMetricKey = 'cpu' | 'memory' | 'disk' | 'netIn' | 'netOut';
const THRESHOLD_METRIC_KEYS: ThresholdMetricKey[] = ['cpu', 'memory', 'disk', 'netIn', 'netOut'];
const DEFAULT_TEMP_THRESHOLD: AgentTempThreshold = { globalEnabled: false, op: '>', threshold: 85, overrides: {} };

function metricEqual(a: AgentMetricThreshold, b: AgentMetricThreshold) {
  return a.enabled === b.enabled && a.op === b.op && a.threshold === b.threshold;
}

function tempEqual(a: AgentTempThreshold, b: AgentTempThreshold) {
  if (a.globalEnabled !== b.globalEnabled || a.op !== b.op || a.threshold !== b.threshold) return false;
  const aKeys = Object.keys(a.overrides ?? {});
  const bKeys = Object.keys(b.overrides ?? {});
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => {
    const x = a.overrides[k];
    const y = b.overrides?.[k];
    return !!y && x.enabled === y.enabled && x.op === y.op && x.threshold === y.threshold;
  });
}

/**
 * Threshold editor for one agent. `thresholds` are the effective values,
 * `inheritedThresholds` what the group chain gives (no device override).
 * Saving sends only the metrics that differ from the group, so every other
 * metric keeps following the group live; `null` = no override at all.
 */
function ThresholdEditor({
  thresholds, inheritedThresholds, hasOverride, onSave, onClose, knownSensors = [],
}: {
  thresholds: AgentThresholds;
  inheritedThresholds: AgentThresholds;
  /** The device currently has an override (enables "Reset to group"). */
  hasOverride: boolean;
  onSave: (override: Partial<AgentThresholds> | null) => Promise<void>;
  onClose: () => void;
  knownSensors?: Array<{ key: string; label: string }>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);

  type MetricKey = ThresholdMetricKey;

  const inh = inheritedThresholds;
  const inhTemp: AgentTempThreshold = inh.temp ?? DEFAULT_TEMP_THRESHOLD;
  const agentTemp: AgentTempThreshold = thresholds.temp ?? inhTemp;

  // Standard metric editable values
  const [values, setValues] = useState<AgentThresholds>({ ...thresholds });

  // Which standard metrics are overriding inherited values
  const [overridingMetrics, setOverridingMetrics] = useState<Record<MetricKey, boolean>>({
    cpu:    !metricEqual(thresholds.cpu,    inh.cpu),
    memory: !metricEqual(thresholds.memory, inh.memory),
    disk:   !metricEqual(thresholds.disk,   inh.disk),
    netIn:  !metricEqual(thresholds.netIn,  inh.netIn),
    netOut: !metricEqual(thresholds.netOut, inh.netOut),
  });

  // Temperature state
  const [tempValues, setTempValues] = useState<AgentTempThreshold>(agentTemp);
  const [tempGlobalOverriding, setTempGlobalOverriding] = useState<boolean>(
    agentTemp.globalEnabled !== inhTemp.globalEnabled ||
    agentTemp.op !== inhTemp.op ||
    agentTemp.threshold !== inhTemp.threshold,
  );

  const upd = (key: MetricKey, field: keyof AgentMetricThreshold, val: unknown) =>
    setValues(prev => ({ ...prev, [key]: { ...prev[key], [field]: val } }));

  const handleOverrideMetric = (key: MetricKey, overriding: boolean) => {
    if (!overriding) {
      // Reset → copy inherited value back
      setValues(prev => ({ ...prev, [key]: { ...inh[key] } }));
    }
    setOverridingMetrics(prev => ({ ...prev, [key]: overriding }));
  };

  const handleOverrideTempGlobal = (overriding: boolean) => {
    if (!overriding) {
      setTempValues(prev => ({
        ...prev,
        globalEnabled: inhTemp.globalEnabled,
        op: inhTemp.op,
        threshold: inhTemp.threshold,
      }));
    }
    setTempGlobalOverriding(overriding);
  };

  const handleOverrideSensor = (sensorKey: string, overriding: boolean) => {
    if (overriding) {
      setTempValues(prev => ({
        ...prev,
        overrides: {
          ...prev.overrides,
          [sensorKey]: { enabled: true, op: prev.op, threshold: prev.threshold },
        },
      }));
    } else {
      setTempValues(prev => {
        const next = { ...prev.overrides };
        delete next[sensorKey];
        return { ...prev, overrides: next };
      });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Only the metrics that differ from the group become device override
      // slots; the others keep following the group.
      const override: Partial<AgentThresholds> = {};
      for (const key of THRESHOLD_METRIC_KEYS) {
        if (overridingMetrics[key] && !metricEqual(values[key], inh[key])) override[key] = values[key];
      }
      const temp: AgentTempThreshold = {
        globalEnabled: tempGlobalOverriding ? tempValues.globalEnabled : inhTemp.globalEnabled,
        op:            tempGlobalOverriding ? tempValues.op            : inhTemp.op,
        threshold:     tempGlobalOverriding ? tempValues.threshold     : inhTemp.threshold,
        overrides: tempValues.overrides,
      };
      if (!tempEqual(temp, inhTemp)) override.temp = temp;
      await onSave(Object.keys(override).length > 0 ? override : null);
      onClose();
    } catch {
      toast.error(t('agents.failedUpdateAgent'));
    } finally { setSaving(false); }
  };

  const handleResetToGroup = async () => {
    setSaving(true);
    try {
      await onSave(null);
      onClose();
    } catch {
      toast.error(t('agents.failedUpdateAgent'));
    } finally { setSaving(false); }
  };

  const BYTES_PER_MBIT = 125_000;
  const rows: Array<{ key: MetricKey; label: string; unit: string; scale?: number }> = [
    { key: 'cpu',    label: t('groups.detail.cpu'),    unit: '%' },
    { key: 'memory', label: t('groups.detail.memory'), unit: '%' },
    { key: 'disk',   label: t('groups.detail.disk'),   unit: '%' },
    { key: 'netIn',  label: t('groups.detail.netIn'),  unit: 'Mbps', scale: BYTES_PER_MBIT },
    { key: 'netOut', label: t('groups.detail.netOut'), unit: 'Mbps', scale: BYTES_PER_MBIT },
  ];
  const OPS = ['>', '>=', '<', '<='] as const;

  const OverrideBtn = ({ overriding, onToggle }: { overriding: boolean; onToggle: (v: boolean) => void }) => (
    <button
      onClick={() => onToggle(!overriding)}
      className={cn(
        'text-xs px-2 py-1 rounded border transition-colors whitespace-nowrap',
        overriding
          ? 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10'
          : 'border-border text-text-muted hover:bg-bg-hover hover:text-text-secondary',
      )}
    >
      {overriding ? t('common.reset', 'Reset') : t('common.override', 'Override')}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Settings2 size={16} /> {t('groups.detail.thresholds')}
          </h2>
          <button onClick={onClose} aria-label={t('common.close', 'Close')} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="overflow-y-auto flex-1 p-5 space-y-5">

          {/* ── Standard metrics ── */}
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-text-muted border-b border-border">
                <th className="text-left pb-2 font-medium">{t('groups.detail.metricCol')}</th>
                <th className="text-center pb-2 font-medium w-12">{t('groups.detail.onCol')}</th>
                <th className="text-center pb-2 font-medium w-16">{t('groups.detail.opCol')}</th>
                <th className="text-left pb-2 font-medium">{t('groups.detail.valueCol')}</th>
                <th className="pb-2 w-20" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ key, label, unit, scale }) => {
                const overriding = overridingMetrics[key];
                // Show inherited values when not overriding, editable values when overriding
                const src = overriding ? values[key] : inh[key];
                const displayValue = scale ? Math.round(src.threshold / scale) : src.threshold;
                return (
                  <tr key={key} className={cn(!overriding && 'opacity-50')}>
                    <td className={cn('py-2.5 font-medium', src.enabled ? 'text-text-secondary' : 'text-text-muted')}>
                      {label}
                    </td>
                    <td className="py-2.5 text-center">
                      <Switch on={src.enabled} disabled={!overriding}
                        onChange={v => overriding && upd(key, 'enabled', v)} />
                    </td>
                    <td className="py-2.5 text-center">
                      {overriding && src.enabled ? (
                        <select value={src.op} onChange={e => upd(key, 'op', e.target.value)}
                          className="text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1">
                          {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <span className="text-xs text-text-muted">{src.op}</span>
                      )}
                    </td>
                    <td className="py-2.5">
                      {overriding && src.enabled ? (
                        <div className="flex items-center gap-1.5">
                          <input type="number" value={displayValue} min={0}
                            onChange={e => upd(key, 'threshold', scale
                              ? Math.round(Number(e.target.value) * scale)
                              : Number(e.target.value))}
                            className="w-24 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1" />
                          <span className="text-xs text-text-muted">{unit}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-text-muted">
                          {src.enabled ? `${displayValue} ${unit}` : t('agents.detail.thresholdDisabled', 'disabled')}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right">
                      <OverrideBtn overriding={overriding} onToggle={v => handleOverrideMetric(key, v)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* ── Temperature thresholds ── */}
          <div>
            <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Thermometer size={11} /> {t('groups.detail.temperatures')}
            </div>

            {/* Global Sensor card */}
            <div className={cn(
              'rounded-lg border border-border bg-bg-secondary px-4 py-3 mb-3 transition-opacity',
              !tempGlobalOverriding && 'opacity-50',
            )}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Switch
                    on={tempGlobalOverriding ? tempValues.globalEnabled : inhTemp.globalEnabled}
                    disabled={!tempGlobalOverriding}
                    onChange={v => tempGlobalOverriding && setTempValues(prev => ({ ...prev, globalEnabled: v }))}
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary">{t('groups.detail.tempGlobal')}</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {tempGlobalOverriding
                        ? t('agents.detail.customThreshold', 'Custom threshold for this agent')
                        : t('agents.detail.usingGroupDefault', 'Using group default')}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {/* Show op + value when globalEnabled is true (from either source) */}
                  {(tempGlobalOverriding ? tempValues.globalEnabled : inhTemp.globalEnabled) && (
                    tempGlobalOverriding ? (
                      <>
                        <select value={tempValues.op}
                          onChange={e => setTempValues(prev => ({ ...prev, op: e.target.value as typeof tempValues.op }))}
                          className="text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1">
                          {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                        </select>
                        <input type="number" value={tempValues.threshold} min={0} max={200}
                          onChange={e => setTempValues(prev => ({ ...prev, threshold: Number(e.target.value) }))}
                          className="w-20 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1" />
                        <span className="text-xs text-text-muted">°C</span>
                      </>
                    ) : (
                      <span className="text-xs text-text-muted">{inhTemp.op} {inhTemp.threshold}°C</span>
                    )
                  )}
                  <OverrideBtn overriding={tempGlobalOverriding} onToggle={handleOverrideTempGlobal} />
                </div>
              </div>
            </div>

            {/* Per-sensor rows */}
            {knownSensors.length > 0 && (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase text-text-muted border-b border-border">
                    <th className="text-left pb-2 font-medium">{t('agents.detail.sensor', 'Sensor')}</th>
                    <th className="text-center pb-2 font-medium w-12">{t('groups.detail.onCol')}</th>
                    <th className="text-left pb-2 font-medium">{t('agents.detail.threshold', 'Threshold')}</th>
                    <th className="pb-2 w-20" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {knownSensors.map(sensor => {
                    const ov = tempValues.overrides[sensor.key];
                    const sensorOverriding = ov !== undefined;
                    // Effective global: agent override (if set) or inherited
                    const effGlobal = tempGlobalOverriding ? tempValues : inhTemp;
                    return (
                      <tr key={sensor.key} className={cn(!sensorOverriding && 'opacity-50')}>
                        <td className="py-2.5 text-xs text-text-secondary">{sensor.label}</td>
                        <td className="py-2.5 text-center">
                          {sensorOverriding ? (
                            <Switch on={ov.enabled ?? true}
                              onChange={v => setTempValues(prev => ({
                                ...prev,
                                overrides: { ...prev.overrides, [sensor.key]: { ...ov, enabled: v } },
                              }))} />
                          ) : (
                            <Switch on={effGlobal.globalEnabled} disabled />
                          )}
                        </td>
                        <td className="py-2.5">
                          {sensorOverriding ? (
                            <div className="flex items-center gap-1.5">
                              <select
                                value={ov.op}
                                onChange={e => setTempValues(prev => ({
                                  ...prev,
                                  overrides: { ...prev.overrides, [sensor.key]: { ...ov, op: e.target.value as typeof ov.op } },
                                }))}
                                className="text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1">
                                {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                              </select>
                              <input type="number" value={ov.threshold} min={0} max={200}
                                onChange={e => setTempValues(prev => ({
                                  ...prev,
                                  overrides: { ...prev.overrides, [sensor.key]: { ...ov, threshold: Number(e.target.value) } },
                                }))}
                                className="w-20 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1" />
                              <span className="text-xs text-text-muted">°C</span>
                            </div>
                          ) : (
                            <span className="text-xs text-text-muted">
                              {effGlobal.op} {effGlobal.threshold}°C ({t('agents.detail.globalSuffix', 'global')})
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right">
                          <OverrideBtn overriding={sensorOverriding}
                            onToggle={v => handleOverrideSensor(sensor.key, v)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border shrink-0">
          {hasOverride && (
            <button onClick={() => void handleResetToGroup()} disabled={saving}
              title={t('agents.resetThresholdsToGroupDesc', 'Remove every custom threshold of this agent and follow the group again')}
              className="mr-auto flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-amber-500/40 text-amber-400 hover:bg-amber-500/10 disabled:opacity-60 transition-colors">
              <RotateCcw size={13} /> {t('agents.resetThresholdsToGroup', 'Reset to group')}
            </button>
          )}
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
            {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Settings Section (inline panel at bottom of detail page)
// ─────────────────────────────────────────────────────────────────────────────

function AgentSettingsSection({
  device, thresholds, thresholdInfo, knownSensors,
  onDeviceUpdate, onThresholdsUpdate, canWrite, canManage,
}: {
  device: AgentDevice;
  /** RW on the agent monitor: may edit the threshold override. */
  canWrite: boolean;
  /** agents.manage: may change check interval, heartbeat monitoring and cooldown. */
  canManage: boolean;
  /** Effective thresholds of the device. */
  thresholds: AgentThresholds;
  /** GET /agent/devices/:id/thresholds-resolved (null when unavailable). */
  thresholdInfo: ResolvedAgentThresholds | null;
  knownSensors: Array<{ key: string; label: string }>;
  onDeviceUpdate: (d: AgentDevice) => void;
  /** Called after the override was written (`null` = reset to group). */
  onThresholdsUpdate: (override: Partial<AgentThresholds> | null) => Promise<void>;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  // groupSettings = raw group config unaffected by the override flag.
  // This is the source of truth for "what the group actually says".
  // resolvedSettings conflates group + device values depending on override,
  // so we can't use it alone to determine the true inherited value.
  const groupCfg = device.groupSettings;
  const inheritedInterval  = groupCfg?.pushIntervalSeconds  ?? device.checkIntervalSeconds ?? 60;
  const inheritedHeartbeat = groupCfg?.heartbeatMonitoring  ?? device.heartbeatMonitoring  ?? true;
  const inheritedCooldown  = groupCfg?.notificationCooldownSeconds ?? 300;

  // Per-field override:  a field is "overriding" when the global override flag
  // is ON *and* the device's raw value differs from what the group prescribes.
  // If the values happen to be equal we still honour the override flag for
  // checkInterval (user explicitly chose to pin it) but not for heartbeat
  // (a heartbeat value equal to the group's is indistinguishable from inherited).
  const [fields, setFields] = useState({
    checkInterval: {
      overriding: device.overrideGroupSettings && device.checkIntervalSeconds != null,
      value: device.checkIntervalSeconds ?? inheritedInterval,
    },
    heartbeat: {
      overriding: device.overrideGroupSettings && device.heartbeatMonitoring !== inheritedHeartbeat,
      value: device.heartbeatMonitoring ?? inheritedHeartbeat,
    },
    cooldown: {
      overriding: device.notificationCooldownSeconds != null,
      value: device.notificationCooldownSeconds ?? inheritedCooldown,
    },
  });
  const [saving, setSaving] = useState(false);
  const [showThresholdModal, setShowThresholdModal] = useState(false);

  // Re-sync fields state when device props change (e.g. after a save or
  // when the parent refreshes the device from the server).  Without this,
  // useState keeps the stale initial values and the "overriding" badges and
  // displayed values would be wrong after an update.
  useEffect(() => {
    const gc = device.groupSettings;
    const iInterval  = gc?.pushIntervalSeconds  ?? device.checkIntervalSeconds ?? 60;
    const iHeartbeat = gc?.heartbeatMonitoring  ?? device.heartbeatMonitoring  ?? true;
    const iCooldown  = gc?.notificationCooldownSeconds ?? 300;
    setFields({
      checkInterval: {
        overriding: device.overrideGroupSettings && device.checkIntervalSeconds != null,
        value: device.checkIntervalSeconds ?? iInterval,
      },
      heartbeat: {
        overriding: device.overrideGroupSettings && device.heartbeatMonitoring !== iHeartbeat,
        value: device.heartbeatMonitoring ?? iHeartbeat,
      },
      cooldown: {
        overriding: device.notificationCooldownSeconds != null,
        value: device.notificationCooldownSeconds ?? iCooldown,
      },
    });
  }, [device.id, device.overrideGroupSettings, device.heartbeatMonitoring, device.checkIntervalSeconds,
      device.notificationCooldownSeconds,
      device.groupSettings?.heartbeatMonitoring, device.groupSettings?.pushIntervalSeconds,
      device.groupSettings?.notificationCooldownSeconds]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (newFields: typeof fields) => {
    setSaving(true);
    const anyOverride = newFields.checkInterval.overriding || newFields.heartbeat.overriding;
    try {
      const updated = await agentApi.updateDevice(device.id, {
        overrideGroupSettings: anyOverride,
        checkIntervalSeconds: newFields.checkInterval.overriding ? newFields.checkInterval.value : inheritedInterval,
        heartbeatMonitoring:  newFields.heartbeat.overriding  ? newFields.heartbeat.value  : inheritedHeartbeat,
        notificationCooldownSeconds: newFields.cooldown.overriding ? newFields.cooldown.value : null,
      });
      onDeviceUpdate(updated);
    } finally {
      setSaving(false);
    }
  };

  const toggleField = (field: 'checkInterval' | 'heartbeat' | 'cooldown', override: boolean) => {
    const newFields = { ...fields, [field]: { ...fields[field], overriding: override } };
    setFields(newFields);
    save(newFields);
  };

  const updateValue = (field: 'checkInterval' | 'cooldown', value: number) => {
    setFields(f => ({ ...f, [field]: { ...f[field], value } }));
  };

  // What the device gets with no override: the group chain on top of the
  // defaults. Falls back to the device payload when the resolve endpoint is
  // unavailable.
  const inheritedThresholds = thresholdInfo?.groupResolved ?? device.groupThresholds ?? DEFAULT_AGENT_THRESHOLDS;
  const hasThresholdOverride = thresholdInfo
    ? thresholdInfo.override != null && Object.keys(thresholdInfo.override).length > 0
    : (THRESHOLD_METRIC_KEYS.some((k) => !metricEqual(thresholds[k], inheritedThresholds[k]))
      || !tempEqual(thresholds.temp ?? DEFAULT_TEMP_THRESHOLD, inheritedThresholds.temp ?? DEFAULT_TEMP_THRESHOLD));
  const [resettingThresholds, setResettingThresholds] = useState(false);

  const handleSaveThresholds = async (override: Partial<AgentThresholds> | null) => {
    await agentApi.updateDeviceThresholds(device.id, override);
    await onThresholdsUpdate(override);
  };

  const handleResetThresholds = async () => {
    const ok = await confirm({
      message: t('agents.confirmResetThresholds', 'Discard the custom thresholds of this agent and use the group thresholds?'),
      confirmLabel: t('agents.resetThresholdsToGroup', 'Reset to group'),
    });
    if (!ok) return;
    setResettingThresholds(true);
    try {
      await handleSaveThresholds(null);
    } catch {
      toast.error(t('agents.failedUpdateAgent'));
    } finally {
      setResettingThresholds(false);
    }
  };

  // Compact "CPU > 90% · RAM > 90%" summary of the effective standard metrics.
  const BYTES_PER_MBIT = 125_000;
  const thresholdSummary = THRESHOLD_METRIC_KEYS
    .filter((k) => thresholds[k]?.enabled)
    .map((k) => {
      const m = thresholds[k];
      const label = k === 'cpu' ? t('groups.detail.cpu')
        : k === 'memory' ? t('groups.detail.memory')
        : k === 'disk' ? t('groups.detail.disk')
        : k === 'netIn' ? t('groups.detail.netIn')
        : t('groups.detail.netOut');
      const value = k === 'netIn' || k === 'netOut'
        ? `${Math.round(m.threshold / BYTES_PER_MBIT)} Mbps`
        : `${m.threshold}%`;
      return `${label} ${m.op} ${value}`;
    })
    .join(' · ');

  // Override toggles change monitoring behaviour: agents.manage only.
  const inGroup = !!device.groupId && canManage;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide flex items-center gap-1.5">
          <Settings2 size={12} /> {t('agents.editAgent')}
        </h3>
      </div>

      <div className="space-y-1">
        {/* Check Interval field */}
        <div className="flex items-center gap-3 py-3 border-b border-border">
          <span className="text-sm font-medium text-text-primary w-40">{t('agents.detail.checkInterval', 'Check interval')}</span>
          {fields.checkInterval.overriding ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">{t('common.override', 'Override')}</span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{t('common.inherit')}</span>
          )}
          <input
            type="number"
            min={1}
            value={fields.checkInterval.overriding ? fields.checkInterval.value : inheritedInterval}
            disabled={!canManage || !fields.checkInterval.overriding}
            onChange={e => updateValue('checkInterval', Number(e.target.value))}
            onBlur={() => { if (fields.checkInterval.overriding) save(fields); }}
            className="w-24 rounded border border-border bg-bg-secondary px-2 py-1 text-sm disabled:opacity-50"
          />
          <span className="text-xs text-text-muted">{t('groups.detail.seconds')}</span>
          {inGroup && (
            <button
              onClick={() => toggleField('checkInterval', !fields.checkInterval.overriding)}
              disabled={saving}
              className={cn(
                'ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                fields.checkInterval.overriding
                  ? 'text-amber-500 hover:bg-amber-500/10'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
              title={fields.checkInterval.overriding
                ? t('agents.detail.resetToInherited', 'Reset to inherited')
                : t('agents.detail.overrideLocally', 'Override locally')}
            >
              {fields.checkInterval.overriding ? (
                <span className="flex items-center gap-1"><RotateCcw size={12} />{t('common.reset', 'Reset')}</span>
              ) : t('common.override', 'Override')}
            </button>
          )}
        </div>

        {/* Heartbeat Monitoring field */}
        <div className="flex items-center gap-3 py-3 border-b border-border">
          <span className="text-sm font-medium text-text-primary w-40">{t('agents.heartbeatMonitoring')}</span>
          {fields.heartbeat.overriding ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">{t('common.override', 'Override')}</span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{t('common.inherit')}</span>
          )}
          <Switch
            on={fields.heartbeat.overriding ? fields.heartbeat.value : inheritedHeartbeat}
            onChange={v => {
              if (!fields.heartbeat.overriding) return;
              const newFields = { ...fields, heartbeat: { ...fields.heartbeat, value: v } };
              setFields(newFields);
              save(newFields);
            }}
            disabled={!canManage || !fields.heartbeat.overriding}
          />
          {inGroup && (
            <button
              onClick={() => toggleField('heartbeat', !fields.heartbeat.overriding)}
              disabled={saving}
              className={cn(
                'ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                fields.heartbeat.overriding
                  ? 'text-amber-500 hover:bg-amber-500/10'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
              title={fields.heartbeat.overriding
                ? t('agents.detail.resetToInherited', 'Reset to inherited')
                : t('agents.detail.overrideLocally', 'Override locally')}
            >
              {fields.heartbeat.overriding ? (
                <span className="flex items-center gap-1"><RotateCcw size={12} />{t('common.reset', 'Reset')}</span>
              ) : t('common.override', 'Override')}
            </button>
          )}
        </div>

        {/* Notification Cooldown field */}
        <div className="flex items-center gap-3 py-3 border-b border-border">
          <span className="text-sm font-medium text-text-primary w-40">{t('agents.detail.notifCooldown', 'Notif. cooldown')}</span>
          {fields.cooldown.overriding ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">{t('common.override', 'Override')}</span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{t('common.inherit')}</span>
          )}
          <input
            type="number"
            min={0}
            max={86400}
            value={fields.cooldown.overriding ? fields.cooldown.value : inheritedCooldown}
            disabled={!canManage || !fields.cooldown.overriding}
            onChange={e => updateValue('cooldown', Number(e.target.value))}
            onBlur={() => { if (fields.cooldown.overriding) save(fields); }}
            className="w-24 rounded border border-border bg-bg-secondary px-2 py-1 text-sm disabled:opacity-50"
          />
          <span className="text-xs text-text-muted">{t('groups.detail.seconds')}</span>
          {canManage && (
            <button
              onClick={() => toggleField('cooldown', !fields.cooldown.overriding)}
              disabled={saving}
              className={cn(
                'ml-auto shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                fields.cooldown.overriding
                  ? 'text-amber-500 hover:bg-amber-500/10'
                  : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
              )}
              title={fields.cooldown.overriding
                ? t('agents.detail.resetToInherited', 'Reset to inherited')
                : t('agents.detail.overrideLocally', 'Override locally')}
            >
              {fields.cooldown.overriding ? (
                <span className="flex items-center gap-1"><RotateCcw size={12} />{t('common.reset', 'Reset')}</span>
              ) : t('common.override', 'Override')}
            </button>
          )}
        </div>

        {/* Agent update policy (global -> workspace -> group chain -> this agent) */}
        {device.resolvedUpdatePolicy && device.inheritedUpdatePolicy && device.deviceType !== 'proxy' && (
          <UpdatePolicyField
            layout="row"
            level="agent"
            label={t('agentUpdatePolicy.title', 'Agent updates')}
            ownPolicy={device.updatePolicy ?? null}
            inherited={device.inheritedUpdatePolicy}
            effective={device.resolvedUpdatePolicy}
            canEdit={canManage}
            onChange={async (updatePolicy) => {
              const updated = await agentApi.updateDevice(device.id, { updatePolicy });
              onDeviceUpdate({ ...device, ...updated });
            }}
          />
        )}

        {/* Alert Thresholds */}
        <div className="flex items-center gap-3 py-3">
          <span className="text-sm font-medium text-text-primary w-40">{t('groups.detail.thresholds')}</span>
          {hasThresholdOverride ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">{t('common.override', 'Override')}</span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">{t('common.inherit')}</span>
          )}
          <span className="text-xs text-text-muted truncate min-w-0" title={thresholdSummary || undefined}>
            {thresholdSummary || t('groups.detail.thresholdsDesc')}
          </span>
          {canWrite && (
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {hasThresholdOverride && (
                <button onClick={() => void handleResetThresholds()} disabled={resettingThresholds}
                  title={t('agents.resetThresholdsToGroupDesc', 'Remove every custom threshold of this agent and follow the group again')}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 disabled:opacity-60 transition-colors">
                  <RotateCcw size={12} /> {t('agents.resetThresholdsToGroup', 'Reset to group')}
                </button>
              )}
              <button onClick={() => setShowThresholdModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
                <Settings2 size={12} /> {t('agents.detail.configure', 'Configure')}
              </button>
            </div>
          )}
        </div>
      </div>

      {canWrite && showThresholdModal && (
        <ThresholdEditor
          thresholds={thresholds}
          inheritedThresholds={inheritedThresholds}
          hasOverride={hasThresholdOverride}
          onSave={handleSaveThresholds}
          onClose={() => setShowThresholdModal(false)}
          knownSensors={knownSensors}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

/** Right rail views. `label` is the English fallback of `labelKey` (translated at render). */
const NAV_ITEMS: Array<{ id: View; icon: React.ReactNode; labelKey: string; label: string }> = [
  { id: 'overview', icon: <LayoutDashboard size={18} />, labelKey: 'agents.detail.nav.overview', label: 'Overview' },
  { id: 'cpu',      icon: <Cpu size={18} />,             labelKey: 'agents.detail.nav.cpu',      label: 'CPU' },
  { id: 'ram',      icon: <MemoryStick size={18} />,     labelKey: 'agents.detail.nav.ram',      label: 'RAM' },
  { id: 'gpu',      icon: <MonitorDot size={18} />,      labelKey: 'agents.detail.nav.gpu',      label: 'GPU' },
  { id: 'others',   icon: <HardDrive size={18} />,       labelKey: 'agents.detail.nav.others',   label: 'Disk / Net' },
  { id: 'temps',    icon: <Thermometer size={18} />,     labelKey: 'agents.detail.nav.temps',    label: 'Temperatures' },
  { id: 'uptime',   icon: <Wifi size={18} />,            labelKey: 'agents.detail.nav.uptime',   label: 'Uptime' },
];


export function AgentDetailPage() {
  const { t } = useTranslation();
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const id = Number(deviceId);
  // Whole-store subscription: re-render when user / capabilities / permissions load.
  const { isAdmin, hasCapability, canWriteMonitor } = useAuthStore();
  const admin = isAdmin();
  // Tenant capabilities of the notification / maintenance routes.
  const canNotifications = hasCapability('notifications');
  const canMaintenance = hasCapability('maintenance');

  const confirm = useConfirm();
  const [view, setView] = useState<View>('overview');
  const [device, setDevice] = useState<AgentFleetDevice | null>(null);
  // Caller's access as computed by GET /agent/devices/:id (kept apart from
  // `device`: PATCH responses do not carry it) + the agent monitor id.
  const [access, setAccess] = useState<AgentDeviceAccess | null>(null);
  const [agentMonitorId, setAgentMonitorId] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<AgentPushSnapshot | null>(null);
  const [history, setHistory] = useState<AgentPushSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [thresholds, setThresholds] = useState<AgentThresholds>(DEFAULT_AGENT_THRESHOLDS);
  // Effective / override / group-inherited thresholds (null until loaded, or
  // when the resolve endpoint is unavailable).
  const [thresholdInfo, setThresholdInfo] = useState<ResolvedAgentThresholds | null>(null);
  const [lastPush, setLastPush] = useState<string | null>(null);
  const [period, setPeriod] = useState<'realtime' | '1h' | '24h' | '7d' | '30d'>('realtime');
  const [historicalData, setHistoricalData] = useState<AgentPushSnapshot[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // Heartbeat history for the Uptime view (online/offline timeline)
  const [uptimeHeartbeats, setUptimeHeartbeats] = useState<Heartbeat[]>([]);
  const [loadingUptime, setLoadingUptime] = useState(false);
  // Inline display name editing
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  // Inline notes editing
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);

  // Display configuration
  const [maintenanceChannels, setMaintenanceChannels] = useState<NotificationChannel[]>([]);
  const [displayConfig, setDisplayConfig] = useState<AgentDisplayConfig>(() => DEFAULT_DISPLAY_CONFIG);
  const [configModalSection, setConfigModalSection] = useState<'cpu' | 'ram' | 'gpu' | 'drives' | 'network' | 'temps'>('cpu');
  const [configModalOpen, setConfigModalOpen] = useState(false);

  // Live operational status pushed by socket (e.g. 'updating')
  const [liveStatus, setLiveStatus] = useState<string | null>(null);

  // Lifecycle actions (agents.manage): approve dialog, transfer dialog.
  const [approveOpen, setApproveOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [approveGroups, setApproveGroups] = useState<MonitorGroup[]>([]);
  const [approveKeys, setApproveKeys] = useState<AgentApiKeyWithDefault[]>([]);

  // Cross-app device links
  const [crossAppLinks, setCrossAppLinks] = useState<Array<{ appType: string; name: string; url: string; color: string | null }>>([]);


  const openConfigModal = (section: 'cpu' | 'ram' | 'gpu' | 'drives' | 'network' | 'temps') => {
    setConfigModalSection(section);
    setConfigModalOpen(true);
  };

  const saveDisplayConfig = async (newConfig: AgentDisplayConfig) => {
    await agentApi.updateDevice(id, { displayConfig: newConfig });
    setDisplayConfig(newConfig);
  };

  const handleRenameMount = async (mount: string, name: string) => {
    const newRenames = { ...displayConfig.drives.renames };
    if (name && name !== mount) { newRenames[mount] = name; } else { delete newRenames[mount]; }
    const newConfig = { ...displayConfig, drives: { ...displayConfig.drives, renames: newRenames } };
    await saveDisplayConfig(newConfig);
  };

  const handleRenameInterface = async (iface: string, name: string) => {
    const newRenames = { ...(displayConfig.network.renames ?? {}) };
    if (name && name !== iface) { newRenames[iface] = name; } else { delete newRenames[iface]; }
    const newConfig = { ...displayConfig, network: { ...displayConfig.network, renames: newRenames } };
    await saveDisplayConfig(newConfig);
  };

  const loadData = useCallback(async () => {
    try {
      const [dev, snap, thr] = await Promise.all([
        agentApi.getDeviceById(id),
        agentApi.getDeviceMetrics(id),
        agentApi.getResolvedThresholds(id),
      ]);
      setDevice(dev);
      setAccess(dev?.access ?? null);
      setAgentMonitorId(dev?.monitorId ?? null);
      setThresholdInfo(thr);
      if (thr) setThresholds(thr.resolved);
      // (push interval is now managed by AgentSettingsSection)
      if (snap) {
        setSnapshot(snap);
        setLastPush(snap.receivedAt);
        setHistory(prev => prev.length === 0 ? [snap] : prev);
        if (!thr) {
          // Fallback when the resolve endpoint is unavailable: the override
          // stored on the agent monitor (possibly sparse) over the group.
          try {
            const monitor = await monitorsApi.getById(snap.monitorId);
            const base = dev?.groupThresholds ?? DEFAULT_AGENT_THRESHOLDS;
            setThresholds(monitor.agentThresholds ? { ...base, ...monitor.agentThresholds } : base);
          } catch { /* defaults */ }
        }
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [id]);

  /** Refresh thresholds after the override was written (`null` = reset to group). */
  const handleThresholdsUpdated = useCallback(async (override: Partial<AgentThresholds> | null) => {
    const thr = await agentApi.getResolvedThresholds(id);
    setThresholdInfo(thr);
    if (thr) {
      setThresholds(thr.resolved);
      return;
    }
    // Endpoint unavailable: merge locally (an override key wins over the group).
    const base = device?.groupThresholds ?? DEFAULT_AGENT_THRESHOLDS;
    setThresholds(override ? { ...base, ...override } : base);
  }, [id, device?.groupThresholds]);

  // Clear stale data immediately when navigating to a different agent —
  // ensures the previous agent's metrics never bleed through during the fetch.
  useEffect(() => {
    setDevice(null);
    setLiveStatus(null);
    setAccess(null);
    setAgentMonitorId(null);
    setSnapshot(null);
    setHistory([]);
    setLastPush(null);
    setThresholds(DEFAULT_AGENT_THRESHOLDS);
    setThresholdInfo(null);
    setLoading(true);
  }, [id]);

  // Fetch notification channels for the MaintenanceWindowList modal
  // (only the channels usable by this device's workspace). GET
  // /notifications/channels needs the 'notifications' tenant capability.
  useEffect(() => {
    if (!canNotifications || !Number.isInteger(id) || id <= 0) return;
    apiClient.get<{ success: boolean; data: NotificationChannel[] }>('/notifications/channels', {
      params: { scope: 'agent', scopeId: id },
    })
      .then((res) => { if (res.data.success) setMaintenanceChannels(res.data.data); })
      .catch(() => {});
  }, [id, canNotifications]);

  // Sync displayConfig when device loads / changes
  useEffect(() => {
    if (device) setDisplayConfig(mergeDisplayConfig(device.displayConfig ?? null));
  }, [device?.id]); // eslint-disable-line react-hooks/exhaustive-deps


  useEffect(() => { loadData(); }, [loadData]);

  // Fetch cross-app device links (apiClient: session cookie + 401 handling).
  useEffect(() => {
    setCrossAppLinks([]);
    if (!device?.uuid) return;
    let cancelled = false;
    apiClient
      .get<{ success: boolean; data?: Array<{ appType: string; name: string; url: string; color: string | null }> }>(
        '/auth/device-links',
        { params: { uuid: device.uuid } },
      )
      .then(({ data: d }) => {
        if (!cancelled && d.success && d.data) setCrossAppLinks(d.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [device?.uuid]);

  // Socket.io real-time updates + history accumulation
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (data: {
      deviceId: number; monitorId: number; agentVersion?: string;
      metrics: AgentMetrics; violations: string[]; overallStatus: 'up' | 'alert'; receivedAt: string;
    }) => {
      if (data.deviceId !== id) return;
      const snap: AgentPushSnapshot = {
        monitorId: data.monitorId, receivedAt: data.receivedAt,
        metrics: data.metrics, violations: data.violations, overallStatus: data.overallStatus,
      };
      setSnapshot(snap);
      setLastPush(data.receivedAt);
      setHistory(prev => [...prev, snap].slice(-MAX_HISTORY));
      // Keep displayed agent version in sync without a REST round-trip
      if (data.agentVersion) {
        setDevice(prev => prev && prev.agentVersion !== data.agentVersion
          ? { ...prev, agentVersion: data.agentVersion! }
          : prev);
      }
    };
    socket.on('agentPush', handler);
    return () => { socket.off('agentPush', handler); };
  }, [id]);

  // Lifecycle changes made elsewhere (list page, another operator, the server
  // update / uninstall jobs) arrive as AGENT_DEVICE_UPDATED with the full
  // device; a deletion (uninstall completed) sends the viewer back to the list.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onUpdated = (data: Partial<AgentFleetDevice> & { deviceId?: number }) => {
      const { deviceId: legacyId, ...patch } = data;
      if ((patch.id ?? legacyId) !== id) return;
      setDevice(prev => (prev ? { ...prev, ...patch, id } : prev));
      // A fresh server runtime state replaces an older live value.
      if (patch.runtimeStatus !== undefined) setLiveStatus(null);
    };
    const onDeleted = (data: { deviceId: number }) => {
      if (data.deviceId !== id) return;
      toast(t('agents.detail.deviceRemoved', 'This agent was removed'));
      navigate('/agents', { replace: true });
    };
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onUpdated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeleted);
    return () => {
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onUpdated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeleted);
    };
  }, [id, navigate, t]);

  // Track AGENT_STATUS_CHANGED for live 'updating' badge
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (data: { deviceId: number; status: string }) => {
      if (data.deviceId !== id) return;
      // Kept for the runtime badge (up / down / alert / maintenance / updating).
      setLiveStatus(data.status);
    };
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, handler);
    return () => { socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, handler); };
  }, [id]);

  // Fetch heartbeat history for the Uptime view. For 'realtime' (Live) we
  // pull the latest 100 heartbeats; otherwise we fetch the full window.
  useEffect(() => {
    const monitorId = snapshot?.monitorId;
    if (view !== 'uptime' || !monitorId) return;
    setLoadingUptime(true);
    const fetcher = period === 'realtime'
      ? monitorsApi.getHeartbeats(monitorId, 100, 0)
      : monitorsApi.getHeartbeatsByPeriod(monitorId, period as '1h' | '24h' | '7d' | '30d');
    fetcher
      .then(hbs => {
        // Server returns descending; we want ascending for the timeline
        const sorted = [...hbs].sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
        setUptimeHeartbeats(sorted);
      })
      .catch(() => setUptimeHeartbeats([]))
      .finally(() => setLoadingUptime(false));
  }, [view, period, snapshot?.monitorId, lastPush]);

  // Fetch historical heartbeat data when switching away from realtime
  useEffect(() => {
    const monitorId = snapshot?.monitorId;
    if (period === 'realtime' || !monitorId) {
      setHistoricalData(null);
      return;
    }
    setLoadingHistory(true);
    monitorsApi.getHeartbeatsByPeriod(monitorId, period as '1h' | '24h' | '7d' | '30d')
      .then(heartbeats => {
        const snapshots = heartbeats
          .filter(hb => hb.value)
          .map(hb => {
            try {
              const v = JSON.parse(hb.value!);
              if (!v._full) return null;
              return {
                monitorId,
                receivedAt: hb.createdAt,
                metrics: v._full as AgentMetrics,
                violations: v._violations ?? [],
                overallStatus: (hb.status === 'up' || hb.status === 'alert') ? hb.status as 'up' | 'alert' : 'up',
              } as AgentPushSnapshot;
            } catch { return null; }
          })
          .filter((s): s is AgentPushSnapshot => s !== null)
          .sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
        setHistoricalData(snapshots.length > 30 ? downsample(snapshots, 30) : snapshots);
      })
      .catch(() => {})
      .finally(() => setLoadingHistory(false));
  }, [period, snapshot?.monitorId]);

  const handleSaveName = async () => {
    setSavingName(true);
    try {
      const updated = await agentApi.updateDevice(id, { name: nameValue.trim() || null });
      if (updated) setDevice(updated);
      setEditingName(false);
    } catch { /* ignore */ }
    finally { setSavingName(false); }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      const updated = await agentApi.updateDevice(id, { notes: notesValue.trim() || null });
      if (updated) setDevice(updated);
      setEditingNotes(false);
    } catch { /* ignore */ }
    finally { setSavingNotes(false); }
  };

  const handleSaveSensorName = async (key: string, name: string) => {
    const current = device?.sensorDisplayNames ?? {};
    const updated: Record<string, string> = name
      ? { ...current, [key]: name }
      : Object.fromEntries(Object.entries(current).filter(([k]) => k !== key));
    const updatedDevice = await agentApi.updateDevice(id, { sensorDisplayNames: updated });
    if (updatedDevice) setDevice(updatedDevice);
  };

  // ── Lifecycle actions (agents.manage) ──────────────────────────────────

  /** Apply a device returned by a lifecycle call (null = reload from the server). */
  const applyLifecycleResult = (updated: AgentFleetDevice | null) => {
    if (updated) setDevice(prev => (prev ? { ...prev, ...updated } : updated));
    else void loadData();
  };

  /** Run a lifecycle call with a busy flag and an error toast. */
  const runLifecycle = async (fn: () => Promise<void>, failMsg: string) => {
    setLifecycleBusy(true);
    try {
      await fn();
    } catch (err) {
      toast.error(apiErrorMessage(err, failMsg));
    } finally {
      setLifecycleBusy(false);
    }
  };

  const openApprove = () => {
    setApproveOpen(true);
    // Groups and keys feed the group picker (key default group preselected).
    groupsApi.tree()
      .then((tree) => {
        const flat: MonitorGroup[] = [];
        const walk = (nodes: typeof tree) => { for (const n of nodes) { flat.push(n); walk(n.children); } };
        walk(tree);
        setApproveGroups(flat);
      })
      .catch(() => setApproveGroups([]));
    agentApi.listKeys().then(setApproveKeys).catch(() => setApproveKeys([]));
  };

  const handleApprove = async (groupId: number | null) => {
    if (!device) return;
    try {
      const updated = await agentApi.updateDevice(device.id, { status: 'approved', groupId });
      toast.success(t('agents.deviceApproved', { hostname: anonymize(device.hostname) }));
      setApproveOpen(false);
      applyLifecycleResult(updated);
      void loadData();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedApprove')));
    }
  };

  const handleRefuse = async () => {
    if (!device) return;
    const ok = await confirm({
      message: t('agents.confirmRefuse', { hostname: anonymize(device.hostname) }),
      danger: true,
      confirmLabel: t('agents.refuse', 'Refuse'),
    });
    if (!ok) return;
    await runLifecycle(async () => {
      applyLifecycleResult(await agentApi.updateDevice(device.id, { status: 'refused' }));
      toast.success(t('agents.deviceRefused'));
    }, t('agents.failedRefuse'));
  };

  const handleSuspend = async () => {
    if (!device) return;
    const ok = await confirm({
      title: t('agents.detail.suspendTitle', 'Suspend this agent?'),
      message: t('agents.suspendedDesc'),
      confirmLabel: t('agents.detail.suspend', 'Suspend'),
    });
    if (!ok) return;
    await runLifecycle(async () => {
      applyLifecycleResult(await agentApi.updateDevice(device.id, { status: 'suspended' }));
      toast.success(t('agents.detail.deviceSuspended', 'Agent suspended'));
    }, t('agents.failedUpdateAgent'));
  };

  /** Suspended → approved again; refused → back to pending (to be approved again). */
  const handleReinstate = async () => {
    if (!device) return;
    const refused = deviceApprovalStatus(device) === 'refused';
    await runLifecycle(async () => {
      applyLifecycleResult(await agentApi.updateDevice(device.id, { status: refused ? 'pending' : 'approved' }));
      toast.success(refused ? t('agents.deviceReinstated') : t('agents.deviceResumed', 'Agent reactivated'));
    }, t('agents.failedReinstate'));
  };

  const handleUpdateNow = async () => {
    if (!device) return;
    await runLifecycle(async () => {
      let res: Awaited<ReturnType<typeof agentApi.requestUpdate>>;
      try {
        res = await agentApi.requestUpdate(device.id);
      } catch (err) {
        // 409 AGENT_UPDATE_FROZEN names the level that froze the agent.
        toast.error(agentUpdateErrorMessage(err, t, t('agents.failedUpdateQueue', 'Failed to queue the update')));
        return;
      }
      const { result, device: updated } = res;
      applyLifecycleResult(updated);
      if (result.queued > 0) {
        toast.success(t('agents.updateQueued', 'Update queued: the agent updates when the rollout reaches it'));
      } else if (result.alreadyQueued > 0) {
        toast(t('agents.updateAlreadyQueued', 'An update is already queued for this agent'));
      } else if (result.upToDate > 0) {
        toast(t('agents.alreadyUpToDate', 'This agent already runs the latest version'));
      }
    }, t('agents.failedUpdateQueue', 'Failed to queue the update'));
  };

  const handleUninstall = async () => {
    if (!device) return;
    const ok = await confirm({
      message: t('agents.confirmUninstall', { hostname: anonymize(device.name ?? device.hostname) }),
      danger: true,
      confirmLabel: t('agents.uninstall', 'Uninstall'),
    });
    if (!ok) return;
    await runLifecycle(async () => {
      applyLifecycleResult(await agentApi.uninstallDevice(device.id));
      toast.success(t('agents.uninstallQueued'));
    }, t('agents.failedUninstall'));
  };

  const handleCancelUninstall = async () => {
    if (!device) return;
    await runLifecycle(async () => {
      applyLifecycleResult(await agentApi.cancelUninstall(device.id));
      toast.success(t('agents.uninstallCancelled', 'Uninstall cancelled'));
    }, t('agents.failedCancelUninstall', 'Failed to cancel the uninstall'));
  };

  const handleDelete = async () => {
    if (!device) return;
    const ok = await confirm({
      message: t('agents.confirmDeleteDevice', { hostname: anonymize(device.name ?? device.hostname) }),
      danger: true,
    });
    if (!ok) return;
    await runLifecycle(async () => {
      await agentApi.deleteDevice(device.id);
      toast.success(t('agents.deviceDeleted'));
      navigate('/agents', { replace: true });
    }, t('agents.failedDeleteDevice'));
  };

  const goBack = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/agents');
  };

  // ── Loading / not found ──────────────────────────────────────────────────

  // Deep link to another workspace's agent: switch there and reload this URL
  // (never from the God View, which already sees every workspace).
  const locate = useLocateRedirect('agent', id, !loading && !device);

  if (loading || (!device && locate.pending)) return (
    <div className="flex h-64 flex-col items-center justify-center gap-3">
      <LoadingSpinner size="lg" />
      {locate.status === 'switching' && locate.tenantName && (
        <p className="text-sm text-text-muted">
          {t('tenant.locate.switching', { tenant: locate.tenantName })}
        </p>
      )}
    </div>
  );
  if (!device) return (
    <div className="p-6 text-center">
      <Server size={48} className="mx-auto mb-3 text-text-muted opacity-40" />
      <p className="text-text-muted">{t('agents.detail.notFound', 'Agent not found')}</p>
      <button onClick={goBack} className="mt-3 text-accent hover:underline text-sm">{t('common.back')}</button>
    </div>
  );

  // ── Derived state ────────────────────────────────────────────────────────

  // What the viewer may change. The server-computed access wins; the store is
  // a fallback (older server). canManage = lifecycle / monitoring settings /
  // notification types; canWrite = name, notes, display config, sensor names
  // and thresholds (RW on the agent monitor).
  const canManage = access ? access.canManage : (admin || hasCapability('agents.manage'));
  const monitorIdForPerms = agentMonitorId ?? snapshot?.monitorId ?? null;
  const canWrite = access
    ? access.canWrite
    : canManage || (monitorIdForPerms != null && canWriteMonitor(monitorIdForPerms, device.groupId ?? null));

  const m = snapshot?.metrics ?? null;
  const isOnline = !!snapshot && (Date.now() - new Date(snapshot.receivedAt).getTime()) < (device.checkIntervalSeconds ?? 60) * 2000;
  const isUpdating = liveStatus === 'updating' ||
    (device.updatingSince != null &&
      Date.now() - new Date(device.updatingSince).getTime() < UPDATING_STALE_MS);
  const overallStatus = isUpdating ? 'updating' : (!isOnline ? 'offline' : (snapshot?.overallStatus ?? 'pending'));
  const violations = snapshot?.violations ?? [];
  const sc = {
    up:       { dot: 'bg-status-up',   text: 'text-status-up',   label: t('groups.detail.online'),  glow: 'shadow-[0_0_8px_2px] shadow-status-up/50' },
    alert:    { dot: 'bg-orange-500',  text: 'text-orange-400',  label: t('groups.detail.alert'),   glow: 'shadow-[0_0_8px_2px] shadow-orange-500/50' },
    offline:  { dot: 'bg-text-muted',  text: 'text-text-muted',  label: t('groups.detail.offline'), glow: '' },
    pending:  { dot: 'bg-yellow-500',  text: 'text-yellow-400',  label: t('groups.detail.pending'), glow: '' },
    updating: { dot: 'bg-blue-500',    text: 'text-blue-400',    label: t('agents.runtime.updating', 'Updating'), glow: 'shadow-[0_0_8px_2px] shadow-blue-500/40' },
  }[overallStatus] ?? { dot: 'bg-text-muted', text: 'text-text-muted', label: overallStatus, glow: '' };
  // Lifecycle: agents.manage (server-computed access wins, see canManage).
  const canLifecycle = canManage && hasCapability('agents.manage');
  const isPlatformAdmin = admin;
  const approval = deviceApprovalStatus(device);
  const pendingUninstall = isPendingUninstall(device);
  const lifecycleItems: ActionMenuItem[] = [
    {
      key: 'approve',
      icon: <CheckCircle size={14} />,
      label: t('agents.approve'),
      onClick: openApprove,
      hidden: approval !== 'pending',
    },
    {
      key: 'refuse',
      icon: <XCircle size={14} />,
      label: t('agents.refuse', 'Refuse'),
      onClick: () => void handleRefuse(),
      hidden: approval !== 'pending',
      danger: true,
    },
    {
      key: 'suspend',
      icon: <PauseCircle size={14} />,
      label: t('agents.detail.suspend', 'Suspend'),
      onClick: () => void handleSuspend(),
      hidden: approval !== 'approved',
    },
    {
      key: 'reinstate',
      icon: <PlayCircle size={14} />,
      label: t('agents.reinstate', 'Reinstate'),
      description: approval === 'refused'
        ? t('agents.detail.reinstateRefusedDesc', 'Back to pending approval')
        : undefined,
      onClick: () => void handleReinstate(),
      hidden: approval !== 'suspended' && approval !== 'refused',
    },
    {
      key: 'update',
      icon: <DownloadCloud size={14} />,
      label: t('agents.updateNow', 'Update now'),
      // Update policy 'off' at some level: manual updates are refused too.
      description: frozenUpdateHint(t, device.resolvedUpdatePolicy),
      disabled: device.resolvedUpdatePolicy?.policy === 'off',
      onClick: () => void handleUpdateNow(),
      hidden: approval !== 'approved' || pendingUninstall,
      separator: true,
    },
    {
      key: 'uninstall',
      icon: <PowerOff size={14} />,
      label: t('agents.uninstallAgent', 'Uninstall agent'),
      onClick: () => void handleUninstall(),
      // A proxy ignores 'uninstall': it is stopped by hand, then deleted.
      hidden: pendingUninstall || approval === 'pending' || device.deviceType === 'proxy',
    },
    {
      key: 'cancel-uninstall',
      icon: <Undo2 size={14} />,
      label: t('agents.cancelUninstall', 'Cancel uninstall'),
      onClick: () => void handleCancelUninstall(),
      hidden: !pendingUninstall,
    },
    {
      key: 'transfer',
      icon: <ArrowLeftRight size={14} />,
      label: t('agents.transfer.action', 'Transfer to another workspace'),
      onClick: () => setTransferOpen(true),
      hidden: !isPlatformAdmin,
    },
    {
      key: 'delete',
      icon: <Trash2 size={14} />,
      label: t('common.delete'),
      onClick: () => void handleDelete(),
      danger: true,
      separator: true,
    },
  ];
  const osLabel = device.osInfo
    ? `${device.osInfo.distro ?? device.osInfo.platform ?? ''} ${device.osInfo.release ?? ''}`.trim()
    : null;

  // Data source for all chart tabs — realtime uses in-memory history, 1h/24h use fetched data
  const displayData: AgentPushSnapshot[] = period === 'realtime' ? history : (historicalData ?? history);

  // Known temperature sensors (for ThresholdEditor sensor overrides)
  const knownSensors: Array<{ key: string; label: string }> = [
    ...(m?.temps ?? []).map(s => {
      const key = `temp:${s.label}`;
      return { key, label: device.sensorDisplayNames?.[key] ?? prettifySensorLabel(s.label) };
    }),
    ...(m?.gpus ?? []).flatMap((gpu, i) => {
      if (gpu.tempCelsius === undefined) return [];
      const key = `gpu:${i}:${gpu.model}`;
      return [{ key, label: device.sensorDisplayNames?.[key] ?? prettifySensorLabel(`gpu_${gpu.model}`) }];
    }),
  ];

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1">

      {/* ── Main scrollable content ── */}
      <div className="flex-1 min-w-0 p-4 md:p-6 space-y-4">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <button onClick={goBack} aria-label={t('common.back')}
              className="mt-0.5 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div className="group">
              {/* Display name with inline pencil edit */}
              <div className="flex items-center gap-2 flex-wrap">
                {!editingName ? (
                  <>
                    <h1 className="text-xl font-bold text-text-primary">{anonymize(device.name ?? device.hostname)}</h1>
                    {device.inMaintenance && (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-status-maintenance/15 text-status-maintenance border border-status-maintenance/30">
                        {t('agents.detail.maintenanceBadge', 'MAINT.')}
                      </span>
                    )}
                    {canWrite && (
                      <button
                        onClick={() => { setNameValue(device.name ?? ''); setEditingName(true); }}
                        className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                        title={t('agents.detail.editDisplayName', 'Edit display name')}>
                        <Pencil size={13} />
                      </button>
                    )}
                  </>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <input type="text" value={nameValue} autoFocus
                      onChange={e => setNameValue(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void handleSaveName(); if (e.key === 'Escape') setEditingName(false); }}
                      placeholder={device.hostname}
                      className="rounded border border-border bg-bg-tertiary px-2 py-0.5 text-base font-bold text-text-primary focus:outline-none focus:ring-1 focus:ring-accent placeholder:text-text-muted" />
                    <button onClick={() => void handleSaveName()} disabled={savingName}
                      className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50" title={t('common.save')}>
                      <Check size={13} />
                    </button>
                    <button onClick={() => setEditingName(false)}
                      className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title={t('common.cancel')}>
                      <X size={13} />
                    </button>
                  </span>
                )}
                {approval === 'approved' && !pendingUninstall ? (
                  <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${sc.text}`}>
                    {overallStatus === 'updating'
                      ? <RefreshCw size={10} className="animate-spin" />
                      : <span className={`inline-block w-2.5 h-2.5 rounded-full ${sc.dot} ${sc.glow}`} />
                    }
                    {sc.label}
                  </span>
                ) : null}
                {/* Lifecycle state (pending / refused / suspended / pending
                    uninstall / update failed …) or, for a plain approved
                    device, its runtime state from the server. */}
                {(approval !== 'approved' || pendingUninstall || device.runtimeStatus === 'update_error') && (
                  <AgentDeviceStatusBadge device={device} liveStatus={liveStatus} />
                )}
              </div>
              {/* Subtitle: system info */}
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-text-muted">
                {device.name         && <span className="font-mono">{anonymize(device.hostname)}</span>}
                {device.ip           && <span>{anonymizeIp(device.ip)}</span>}
                {osLabel             && <span>{osLabel}</span>}
                {device.osInfo?.arch && <span>{device.osInfo.arch}</span>}
                {device.agentVersion && <span>{t('agents.detail.agentVersion', 'Agent v{{version}}', { version: device.agentVersion })}</span>}
                {device.targetVersion && device.targetVersion !== device.agentVersion && (
                  <span className="text-blue-400">{t('agents.detail.targetVersion', 'Update to v{{version}} requested', { version: device.targetVersion })}</span>
                )}
                {lastPush            && <span>{t('agent.uptime.lastPush', 'Last push')}: {fmtRelTime(lastPush, t)}</span>}
                {!snapshot           && <span className="text-yellow-400">{t('status.pending')}…</span>}
              </div>
              {/* Notes banner — below system info */}
              {canWrite && editingNotes ? (
                <div className="flex items-start gap-1.5 mt-2 w-full">
                  <textarea
                    value={notesValue} autoFocus rows={2}
                    onChange={e => setNotesValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSaveNotes(); } if (e.key === 'Escape') setEditingNotes(false); }}
                    placeholder={t('agents.detail.addNotesPlaceholder', 'Add notes…')}
                    className="flex-1 rounded border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none placeholder:text-text-muted"
                  />
                  <button onClick={() => void handleSaveNotes()} disabled={savingNotes}
                    className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50 mt-0.5" title={t('common.save')}>
                    <Check size={13} />
                  </button>
                  <button onClick={() => setEditingNotes(false)}
                    className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors mt-0.5" title={t('common.cancel')}>
                    <X size={13} />
                  </button>
                </div>
              ) : device.notes && !canWrite ? (
                <div className="mt-2 w-full rounded-lg bg-accent/5 border border-accent/10 px-3 py-1.5">
                  <p className="text-xs text-accent/70 whitespace-pre-wrap break-words">{device.notes}</p>
                </div>
              ) : device.notes ? (
                <div className="group/notes mt-2 w-full rounded-lg bg-accent/5 border border-accent/10 px-3 py-1.5 flex items-center gap-2 cursor-pointer"
                  onClick={() => { setNotesValue(device.notes ?? ''); setEditingNotes(true); }}>
                  <p className="flex-1 text-xs text-accent/70 truncate">{device.notes}</p>
                  <Pencil size={10} className="shrink-0 text-accent/40 opacity-0 group-hover/notes:opacity-100 coarse:opacity-100 transition-opacity" />
                </div>
              ) : canWrite && (
                <button
                  onClick={() => { setNotesValue(''); setEditingNotes(true); }}
                  className="mt-2 text-[10px] text-text-muted opacity-0 group-hover:opacity-70 coarse:opacity-70 focus-visible:opacity-100 hover:!opacity-100 transition-opacity flex items-center gap-0.5"
                  title={t('agents.detail.addNotes', 'Add notes')}>
                  <Pencil size={9} /> {t('agents.detail.addNotes', 'Add notes')}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Period selector — only shown for non-overview tabs */}
            {view !== 'overview' && (
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
                {(['realtime', '1h', '24h', '7d', '30d'] as const).map(p => (
                  <button key={p} onClick={() => setPeriod(p)}
                    className={cn('px-2.5 py-1.5 font-medium transition-colors',
                      period === p ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-hover'
                    )}>
                    {p === 'realtime' ? t('agent.uptime.live', 'Live') : p}
                  </button>
                ))}
              </div>
            )}
            {/* Loading indicator for historical data */}
            {loadingHistory && (
              <span className="text-xs text-text-muted animate-pulse">{t('common.loading')}</span>
            )}
            {/* Display config button — for non-overview detail views */}
            {canWrite && view !== 'overview' && (
              <button
                onClick={() => {
                  const section = view === 'cpu' ? 'cpu' : view === 'ram' ? 'ram' : view === 'gpu' ? 'gpu' : view === 'others' ? 'drives' : 'temps';
                  openConfigModal(section as 'cpu' | 'ram' | 'gpu' | 'drives' | 'network' | 'temps');
                }}
                className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
                title={t('agents.detail.displayConfiguration', 'Display configuration')}>
                <Settings2 size={15} />
              </button>
            )}
            {crossAppLinks.map(link => (
              <a
                key={link.appType}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('agents.detail.openIn', 'Open in {{app}}', { app: link.name })}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border transition-colors"
                style={{ color: link.color ?? '#58a6ff', borderColor: `${link.color ?? '#58a6ff'}40`, backgroundColor: `${link.color ?? '#58a6ff'}0d` }}
              >
                <ArrowLeftRight size={12} />
                {link.name}
              </a>
            ))}
            <button onClick={() => void loadData()}
              className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title={t('common.refresh')}>
              <RefreshCw size={15} />
            </button>
            {canLifecycle && (
              <ActionMenu
                items={lifecycleItems}
                label={t('agents.detail.actions', 'Agent actions')}
                disabled={lifecycleBusy}
              />
            )}
          </div>
        </div>

        {/* Lifecycle banner: pending / refused / suspended / pending uninstall / update failed */}
        {(() => {
          type Banner = { icon: React.ReactNode; cls: string; text: string; action?: { label: string; onClick: () => void } };
          let banner: Banner | null = null;
          if (pendingUninstall) {
            banner = {
              icon: <PowerOff size={15} className="mt-0.5 shrink-0" />,
              cls: 'border-orange-400/30 bg-orange-400/10 text-orange-400',
              text: device.uninstallCommandedAt
                ? t('agents.detail.bannerUninstallDelivered', 'Uninstall sent to the agent {{when}}. The device is removed automatically once it is gone.', { when: fmtRelTime(device.uninstallCommandedAt, t) })
                : t('agents.detail.bannerUninstallPending', 'Uninstall requested: it is delivered as soon as the agent connects.'),
              action: canLifecycle && !device.uninstallCommandedAt
                ? { label: t('agents.cancelUninstall', 'Cancel uninstall'), onClick: () => void handleCancelUninstall() }
                : undefined,
            };
          } else if (approval === 'pending') {
            banner = {
              icon: <Clock size={15} className="mt-0.5 shrink-0" />,
              cls: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400',
              text: t('agents.detail.bannerPending', 'This agent is waiting for approval: it sends no data and has no active monitor yet.'),
              action: canLifecycle ? { label: t('agents.approve'), onClick: openApprove } : undefined,
            };
          } else if (approval === 'refused') {
            banner = {
              icon: <Ban size={15} className="mt-0.5 shrink-0" />,
              cls: 'border-red-500/30 bg-red-500/10 text-red-400',
              text: t('agents.detail.bannerRefused', 'This agent was refused: its pushes are rejected.'),
              action: canLifecycle ? { label: t('agents.reinstate', 'Reinstate'), onClick: () => void handleReinstate() } : undefined,
            };
          } else if (approval === 'suspended') {
            banner = {
              icon: <PauseCircle size={15} className="mt-0.5 shrink-0" />,
              cls: 'border-border bg-bg-tertiary text-text-secondary',
              text: t('agents.detail.bannerSuspended', 'This agent is suspended: its monitor is paused and its pushes are rejected.'),
              action: canLifecycle ? { label: t('agents.reinstate', 'Reinstate'), onClick: () => void handleReinstate() } : undefined,
            };
          } else if (device.runtimeStatus === 'update_error') {
            banner = {
              icon: <AlertTriangle size={15} className="mt-0.5 shrink-0" />,
              cls: 'border-orange-400/30 bg-orange-400/10 text-orange-400',
              text: t('agents.detail.bannerUpdateError', 'The last agent update did not complete in time.'),
              action: canLifecycle && device.resolvedUpdatePolicy?.policy !== 'off'
                ? { label: t('agents.detail.retryUpdate', 'Retry update'), onClick: () => void handleUpdateNow() }
                : undefined,
            };
          }
          if (!banner) return null;
          return (
            <div className={cn('flex flex-wrap items-start gap-2.5 rounded-lg border p-3 text-sm', banner.cls)}>
              {banner.icon}
              <span className="min-w-0 flex-1">{banner.text}</span>
              {banner.action && (
                <button
                  type="button"
                  onClick={banner.action.onClick}
                  disabled={lifecycleBusy}
                  className="shrink-0 rounded-md border border-current px-2.5 py-1 text-xs font-medium hover:bg-white/5 disabled:opacity-50 coarse:min-h-10"
                >
                  {banner.action.label}
                </button>
              )}
            </div>
          );
        })()}

        {/* Violations banners — one banner per alert type */}
        {violations.length > 0 && (() => {
          const driveRenames = displayConfig.drives.renames ?? {};

          type ViolGroup = { key: string; label: string; items: string[] };
          const groups: ViolGroup[] = [];
          const byKey: Record<string, ViolGroup> = {};

          const addTo = (key: string, label: string, text: string) => {
            if (!byKey[key]) { byKey[key] = { key, label, items: [] }; groups.push(byKey[key]); }
            byKey[key].items.push(text);
          };

          for (const v of violations) {
            if (v.startsWith('CPU:')) {
              addTo('cpu', t('agents.detail.nav.cpu', 'CPU'), v);
            } else if (v.startsWith('RAM:')) {
              addTo('ram', t('agents.detail.nav.ram', 'RAM'), v);
            } else if (v.startsWith('Net ')) {
              addTo('net', t('agents.detail.network', 'Network'), v);
            } else if (v.startsWith('Disk ')) {
              // "Disk <mount>: 92.2% > 90%"
              const match = v.match(/^Disk (.+): (\d.+)$/);
              const displayMount = match ? (driveRenames[match[1]] ?? match[1]) : v.slice(5);
              const text = match ? `${displayMount}: ${match[2]}` : v;
              addTo('disk', t('agents.detail.disk', 'Disk'), text);
            } else if (v.startsWith('Temp ')) {
              // "Temp <display_label>: 92.1°C > 85°C"
              // The server already resolves the label (custom name or prettified key),
              // so we just strip the "Temp " prefix — no re-lookup needed.
              addTo('temp', t('agents.detail.temperature', 'Temperature'), v.slice(5));
            } else {
              addTo('other', t('agents.runtime.alert', 'Alert'), v);
            }
          }

          return (
            <div className="space-y-2">
              {groups.map(g => (
                <div key={g.key} className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                  <span><span className="font-semibold mr-1.5">{g.label}:</span>{g.items.join(' · ')}</span>
                </div>
              ))}
            </div>
          );
        })()}

        {/* No data yet */}
        {!snapshot && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <Activity size={36} className="mx-auto mb-3 text-text-muted opacity-40" />
            <p className="text-text-muted text-sm">
              {approval === 'approved'
                ? t('agents.detail.waitingFirstPush', 'Waiting for data: the agent pushes every {{seconds}} s.', { seconds: device.checkIntervalSeconds ?? 60 })
                : t('agents.detail.noDataNotApproved', 'No data: the agent only reports once it is approved.')}
            </p>
          </div>
        )}

        {/* View content */}
        {m && view === 'overview' && <OverviewView metrics={m} violations={violations} sensorDisplayNames={device.sensorDisplayNames ?? null} onRename={canWrite ? handleSaveSensorName : undefined} displayConfig={displayConfig} openConfigModal={canWrite ? openConfigModal : undefined} onRenameMount={canWrite ? handleRenameMount : undefined} onRenameInterface={canWrite ? handleRenameInterface : undefined} />}
        {view === 'cpu'    && <CpuView    metrics={m ?? {}} history={displayData} period={period} displayConfig={displayConfig} />}
        {view === 'ram'    && <RamView    history={displayData} period={period} displayConfig={displayConfig} />}
        {view === 'gpu'    && <GpuView    history={displayData} period={period} displayConfig={displayConfig} />}
        {view === 'others' && <OthersView history={displayData} period={period} displayConfig={displayConfig} />}
        {view === 'temps'  && <TempsView  history={displayData} period={period} sensorDisplayNames={device.sensorDisplayNames ?? null} onRename={canWrite ? handleSaveSensorName : undefined} />}
        {view === 'uptime' && (
          <UptimeView
            heartbeats={uptimeHeartbeats}
            period={period}
            isOnline={isOnline}
            currentStatus={sc.label}
            loading={loadingUptime}
            lastPushIso={lastPush}
            checkIntervalSeconds={device.checkIntervalSeconds ?? 60}
          />
        )}

        {/* ── Agent Settings Section ── */}
        <AgentSettingsSection
          device={device}
          thresholds={thresholds}
          thresholdInfo={thresholdInfo}
          knownSensors={knownSensors}
          onDeviceUpdate={setDevice}
          onThresholdsUpdate={handleThresholdsUpdated}
          canWrite={canWrite}
          canManage={canManage}
        />

        {/* ── Agent Notification Channels ('notifications' capability) ── */}
        {canNotifications && (
          <NotificationBindingsPanel
            scope="agent"
            scopeId={device.id}
          />
        )}

        {/* ── Agent Notification Types (agents.manage) ── */}
        {canManage && (
          <NotificationTypesPanel
            config={device.notificationTypes ?? null}
            scope="device"
            onSave={async (notifTypes: NotificationTypeConfig | null) => {
              const updated = await agentApi.updateDevice(device.id, { notificationTypes: notifTypes });
              setDevice(updated);
            }}
          />
        )}

        {/* ── Agent Maintenance Windows ('maintenance' capability) ── */}
        {canMaintenance && (
          <div className="rounded-lg border border-border bg-bg-secondary p-4">
            <MaintenanceWindowList
              scopeType="agent"
              scopeId={device.id}
              scopeOptions={[{ id: device.id, name: device.name ?? device.hostname, type: 'agent' }]}
              channels={maintenanceChannels}
              defaultScopeType="agent"
              defaultScopeId={device.id}
            />
          </div>
        )}

      </div>

      {/* ── Right mini navigation sidebar ──
           Outer div: stretches to full page height (no h-screen / self-start) so the
           background colour never gets a sharp cutoff mid-page.
           Inner div: sticky top-0 so the nav icons stay visible while scrolling. ── */}
      <div className="w-12 border-l border-border bg-bg-secondary shrink-0">
        <nav className="sticky top-0 flex flex-col items-center pt-4 gap-1">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              title={t(item.labelKey, item.label)}
              aria-label={t(item.labelKey, item.label)}
              aria-pressed={view === item.id}
              className={cn(
                'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                view === item.id
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
              )}
            >
              {item.icon}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Display Configuration Modal ── */}
      <AgentDisplayConfigModal
        open={canWrite && configModalOpen}
        onClose={() => setConfigModalOpen(false)}
        initialSection={configModalSection}
        config={displayConfig}
        onSave={saveDisplayConfig}
        onRenameSensor={handleSaveSensorName}
        availableThreadCount={m?.cpu?.cores?.length ?? 0}
        availableMounts={Array.from(new Set(history.flatMap(h => (h.metrics.disks ?? []).map(d => d.mount))))}
        availableInterfaces={Array.from(new Set(history.flatMap(h => (h.metrics.network?.interfaces ?? []).map(i => i.name))))}
        availableTemps={Array.from(new Set(history.flatMap(h => (h.metrics.temps ?? []).map(t => t.label))))}
        availableGpuRows={Array.from(new Set(
          history.flatMap(h => (h.metrics.gpus ?? []).flatMap(g => (g.engines ?? []).map(e => e.label)))
        ))}
        sensorDisplayNames={device.sensorDisplayNames ?? {}}
      />

      {/* ── Lifecycle dialogs ── */}
      {canLifecycle && approveOpen && (
        <ApproveAgentModal
          device={device}
          groups={approveGroups}
          keys={approveKeys}
          onApprove={handleApprove}
          onCancel={() => setApproveOpen(false)}
        />
      )}
      {canLifecycle && isPlatformAdmin && transferOpen && (
        <TransferTenantModal
          devices={[{ id: device.id, tenantId: device.tenantId, name: anonymize(device.name ?? device.hostname) }]}
          onClose={() => setTransferOpen(false)}
          onTransferred={() => navigate('/agents', { replace: true })}
        />
      )}
    </div>
  );
}

export default AgentDetailPage;
