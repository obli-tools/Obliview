import { Link, useLocation } from 'react-router-dom';
import { useDraggable } from '@dnd-kit/core';
import { Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, MonitorStatus } from '@obliview/shared';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';

/** Status badge mirroring the one used by Sidebar's old DraggableDeviceItem. */
function DeviceStatusBadge({ status }: { status: MonitorStatus | 'suspended' | undefined }) {
  const cfg: Record<string, { dot: string }> = {
    up:          { dot: 'bg-green-500' },
    down:        { dot: 'bg-red-500' },
    alert:       { dot: 'bg-orange-500' },
    inactive:    { dot: 'bg-gray-400' },
    suspended:   { dot: 'bg-gray-500' },
    paused:      { dot: 'bg-gray-500' },
    pending:     { dot: 'bg-yellow-500' },
    maintenance: { dot: 'bg-status-maintenance' },
    ssl_warning: { dot: 'bg-yellow-400' },
    ssl_expired: { dot: 'bg-red-500' },
    updating:    { dot: 'bg-blue-500 animate-pulse' },
  };
  const s = cfg[status ?? ''] ?? { dot: 'bg-gray-400' };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />;
}

interface DraggableDeviceProps {
  device: AgentDevice;
  status: MonitorStatus | 'suspended' | undefined;
  depth: number;
  dndEnabled: boolean;
  /**
   * The agent sits in an active maintenance window (read from its backing
   * agent monitor). A non-'up' status then shows the maintenance colour
   * instead of red — same rule as the monitor badges.
   */
  inMaintenance?: boolean;
}

/**
 * Leaf-row renderer for an agent device inside the unified GroupTree.
 * Mirrors the layout of <DraggableMonitor> so monitors and devices line up
 * visually as siblings under a hybrid group. Distinct icon (Cpu) signals
 * this is a device, not a monitor.
 */
export function DraggableDevice({ device, status, depth, dndEnabled, inMaintenance = false }: DraggableDeviceProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const isActive = location.pathname === `/agents/${device.id}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `agent-device-${device.id}`,
    data: { type: 'agent-device', device },
    disabled: !dndEnabled,
  });

  const displayName = anonymize(device.name ?? device.hostname);
  const baseStatus = device.status === 'suspended' ? 'suspended' : status;
  const effectiveStatus = inMaintenance && baseStatus !== 'up' && baseStatus !== 'suspended'
    ? 'maintenance'
    : baseStatus;

  return (
    <div
      ref={dndEnabled ? setNodeRef : undefined}
      {...(dndEnabled ? attributes : {})}
      {...(dndEnabled ? listeners : {})}
      style={{ opacity: isDragging ? 0.4 : 1, paddingLeft: `${depth * 16 + 8}px` }}
    >
      <Link
        to={`/agents/${device.id}`}
        title={effectiveStatus === 'maintenance' ? t('groupTree.inMaintenance', 'In maintenance') : undefined}
        className={cn(
          'flex items-center gap-2 rounded-md py-1 px-2 text-sm transition-colors',
          isActive
            ? 'bg-accent/10 text-accent-hover'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
        onClick={(e) => { if (isDragging) e.preventDefault(); }}
      >
        <Cpu size={12} className="shrink-0 text-text-muted" />
        <DeviceStatusBadge status={effectiveStatus} />
        <span className="truncate flex-1 text-xs">{displayName}</span>
      </Link>
    </div>
  );
}
