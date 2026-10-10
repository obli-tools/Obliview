import type { Monitor, MonitorStatus } from '@obliview/shared';

/**
 * The status a monitor is DISPLAYED and COUNTED with.
 *
 * During a maintenance window the worker keeps the real status (often
 * 'down': the target is being worked on) and flags the monitor
 * `inMaintenance`. Anything that is not 'up' then reads as 'maintenance', so
 * planned work is never counted or listed as an outage (dashboard KPIs,
 * problem sections, sorting, status chips). Badges already show MAINT. for
 * such monitors (MonitorStatusBadge `inMaintenance`).
 */
export function effectiveStatus(m: Pick<Monitor, 'status' | 'inMaintenance'>): MonitorStatus {
  return m.inMaintenance && m.status !== 'up' ? 'maintenance' : m.status;
}

/** Sort rank by effective status: problems first, then healthy, then idle states. */
export const STATUS_SORT_ORDER: Record<MonitorStatus, number> = {
  down: 0,
  alert: 1,
  ssl_expired: 2,
  ssl_warning: 3,
  pending: 4,
  updating: 5,
  up: 6,
  maintenance: 7,
  paused: 8,
  inactive: 9,
};

/** Comparator: effective status rank, then name. */
export function compareByEffectiveStatus(
  a: Pick<Monitor, 'status' | 'inMaintenance' | 'name'>,
  b: Pick<Monitor, 'status' | 'inMaintenance' | 'name'>,
): number {
  return (
    (STATUS_SORT_ORDER[effectiveStatus(a)] ?? 99) - (STATUS_SORT_ORDER[effectiveStatus(b)] ?? 99) ||
    a.name.localeCompare(b.name)
  );
}
