import { useTranslation } from 'react-i18next';
import type { AgentDevice } from '@obliview/shared';
import type { AgentApprovalStatus, AgentFleetDevice, AgentRuntimeStatus } from '@/api/agent.api';
import { cn } from '@/utils/cn';

/**
 * Agent status pill (Obliance DeviceStatusBadge port).
 *
 * Two independent axes:
 *   - approval: pending / approved / refused / suspended (agent_devices.status);
 *   - runtime: online / offline / alert / maintenance / updating /
 *     update_error / pending_uninstall / suspended (derived by the server).
 * A device that is not approved shows its approval state (a pending or
 * refused device has no meaningful runtime state); an approved one shows its
 * runtime state.
 */

/** An 'updating' flag older than this is stale (the agent never came back). */
export const UPDATING_STALE_MS = 10 * 60 * 1000;

const RUNTIME_CONFIG: Record<AgentRuntimeStatus, { key: string; fallback: string; color: string; dot: string }> = {
  online:            { key: 'agents.runtime.online',           fallback: 'Online',            color: 'text-status-up bg-status-up/10 border-status-up/30',                         dot: 'bg-status-up' },
  offline:           { key: 'agents.runtime.offline',          fallback: 'Offline',           color: 'text-text-muted bg-text-muted/10 border-text-muted/30',                      dot: 'bg-text-muted' },
  alert:             { key: 'agents.runtime.alert',            fallback: 'Alert',             color: 'text-orange-400 bg-orange-400/10 border-orange-400/30',                      dot: 'bg-orange-400 animate-pulse' },
  maintenance:       { key: 'agents.runtime.maintenance',      fallback: 'Maintenance',       color: 'text-status-maintenance bg-status-maintenance/10 border-status-maintenance/30', dot: 'bg-status-maintenance' },
  updating:          { key: 'agents.runtime.updating',         fallback: 'Updating',          color: 'text-blue-400 bg-blue-400/10 border-blue-400/30',                            dot: 'bg-blue-400 animate-pulse' },
  update_error:      { key: 'agents.runtime.updateError',      fallback: 'Update failed',     color: 'text-orange-400 bg-orange-400/10 border-orange-400/30',                      dot: 'bg-orange-400' },
  pending_uninstall: { key: 'agents.runtime.pendingUninstall', fallback: 'Pending uninstall', color: 'text-orange-400 bg-orange-400/10 border-orange-400/30',                      dot: 'bg-orange-400 animate-pulse' },
  suspended:         { key: 'agents.runtime.suspended',        fallback: 'Suspended',         color: 'text-text-muted bg-text-muted/10 border-text-muted/20',                      dot: 'bg-text-muted' },
};

const APPROVAL_CONFIG: Record<Exclude<AgentApprovalStatus, 'approved'>, { key: string; fallback: string; color: string; dot: string }> = {
  pending:   { key: 'agents.approval.pending',   fallback: 'Pending approval', color: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/30', dot: 'bg-yellow-400' },
  refused:   { key: 'agents.approval.refused',   fallback: 'Refused',          color: 'text-red-400 bg-red-400/10 border-red-400/30',          dot: 'bg-red-400' },
  suspended: { key: 'agents.approval.suspended', fallback: 'Suspended',        color: 'text-text-muted bg-text-muted/10 border-text-muted/20', dot: 'bg-text-muted' },
};

/** Every runtime status, in filter order. */
export const AGENT_RUNTIME_STATUSES: readonly AgentRuntimeStatus[] = [
  'online', 'offline', 'alert', 'maintenance', 'updating', 'update_error', 'pending_uninstall', 'suspended',
];

/**
 * Map a live agent monitor status (AGENT_STATUS_CHANGED payload: up / down /
 * alert / maintenance / inactive / pending / updating …) onto a runtime status.
 * null = nothing to say (unknown or transient value).
 */
export function liveToRuntimeStatus(live: string | null | undefined): AgentRuntimeStatus | null {
  switch (live) {
    case 'up': return 'online';
    case 'down':
    case 'inactive': return 'offline';
    case 'alert': return 'alert';
    case 'maintenance': return 'maintenance';
    case 'updating': return 'updating';
    default: return null;
  }
}

/** Approval status of a device (the W4-B field, else the legacy `status`). */
export function deviceApprovalStatus(device: Pick<AgentFleetDevice, 'status' | 'approvalStatus'>): AgentApprovalStatus {
  return device.approvalStatus ?? device.status;
}

/** True while an uninstall was requested and the device still exists. */
export function isPendingUninstall(device: Pick<AgentFleetDevice, 'runtimeStatus' | 'pendingCommand' | 'uninstallCommandedAt'>): boolean {
  return device.runtimeStatus === 'pending_uninstall'
    || device.pendingCommand === 'uninstall'
    || device.uninstallCommandedAt != null;
}

/**
 * Runtime status to display for a device.
 *
 * Priority: suspension and pending uninstall (lifecycle states the server
 * owns) win; then a live 'updating' (fresher); then the server-owned
 * lifecycle states 'updating' and 'maintenance', and 'update_error' over a
 * live 'online' (every push emits up / alert, which must not hide them — the
 * server ranks alert / offline above update_error); then a live socket
 * status (fresher than the last fetch); then the server-computed
 * runtimeStatus; then what an older server lets us derive (updating flag,
 * failed update, maintenance). null = unknown (approval-only badge).
 */
export function deviceRuntimeStatus(
  device: AgentFleetDevice | AgentDevice,
  liveStatus?: string | null,
): AgentRuntimeStatus | null {
  const d = device as AgentFleetDevice;
  const approval = deviceApprovalStatus(d);
  // A pending uninstall wins everywhere (refused / suspended devices receive it too).
  if (isPendingUninstall(d)) return 'pending_uninstall';
  if (approval === 'suspended' || d.runtimeStatus === 'suspended') return 'suspended';
  // A pending or refused device has no runtime state.
  if (approval === 'pending' || approval === 'refused') return null;
  const live = liveToRuntimeStatus(liveStatus);
  if (live === 'updating') return 'updating';
  if (d.runtimeStatus === 'updating' || d.runtimeStatus === 'maintenance') return d.runtimeStatus;
  if (d.runtimeStatus === 'update_error' && (live === null || live === 'online')) return 'update_error';
  if (!d.runtimeStatus) {
    // Older server: the same precedence on the legacy fields.
    if (d.updatingSince != null && Date.now() - new Date(d.updatingSince).getTime() < UPDATING_STALE_MS) return 'updating';
    if (d.inMaintenance) return 'maintenance';
    if (d.updateErrorAt != null && (live === null || live === 'online')) return 'update_error';
  }
  if (live) return live;
  if (d.runtimeStatus) return d.runtimeStatus;
  return null;
}

interface DeviceStatusBadgeProps {
  /** Runtime status (null/undefined = unknown: only the approval state is shown). */
  runtimeStatus?: AgentRuntimeStatus | null;
  approvalStatus?: AgentApprovalStatus;
  size?: 'sm' | 'md';
  showDot?: boolean;
  className?: string;
}

export function DeviceStatusBadge({
  runtimeStatus,
  approvalStatus = 'approved',
  size = 'sm',
  showDot = true,
  className,
}: DeviceStatusBadgeProps) {
  const { t } = useTranslation();
  // A pending uninstall is shown whatever the approval state. Otherwise a
  // device that is not approved shows its approval state (a suspended
  // device reads the same on both axes).
  const cfg = runtimeStatus === 'pending_uninstall'
    ? RUNTIME_CONFIG.pending_uninstall
    : approvalStatus !== 'approved'
      ? APPROVAL_CONFIG[approvalStatus]
      : runtimeStatus
      ? RUNTIME_CONFIG[runtimeStatus]
      : { key: 'agents.approval.approved', fallback: 'Approved', color: 'text-status-up bg-status-up/10 border-status-up/30', dot: 'bg-status-up' };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-medium',
        size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        cfg.color,
        className,
      )}
    >
      {showDot && <span className={cn('shrink-0 rounded-full', size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2', cfg.dot)} />}
      {t(cfg.key, cfg.fallback)}
    </span>
  );
}

/** Convenience: badge for a device, with an optional live socket status. */
export function AgentDeviceStatusBadge({
  device,
  liveStatus,
  size,
  className,
}: {
  device: AgentFleetDevice | AgentDevice;
  liveStatus?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <DeviceStatusBadge
      runtimeStatus={deviceRuntimeStatus(device, liveStatus)}
      approvalStatus={deviceApprovalStatus(device as AgentFleetDevice)}
      size={size}
      className={className}
    />
  );
}

export default DeviceStatusBadge;
