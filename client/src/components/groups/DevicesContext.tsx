import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AgentDevice, Monitor, MonitorStatus } from '@obliview/shared';

/**
 * Provides the list of agent devices to the group tree so each GroupNode can
 * render its devices as leaf items alongside monitors.
 *
 * Sidebar is the canonical owner of the devices list (it already polls + listens
 * to socket events); other consumers of <GroupTree> (e.g. GroupPicker) simply
 * don't wrap with this provider — GroupNode then renders zero devices.
 */
export interface DevicesContextValue {
  devices: AgentDevice[];
  /** Per-device operational status (from `agent:status` socket frames). */
  statuses: Map<number, MonitorStatus | 'suspended' | undefined>;
  /** Whether devices should be rendered at all. The list is fetched for every
   *  user: GET /agent/devices already narrows it to the agents whose monitor
   *  the user can see (all of them with agents.manage). */
  enabled: boolean;
}

interface DevicesContextState extends DevicesContextValue {
  /** Ids of the devices in the list: an agent monitor whose device is not in
   *  it (list still loading, request failed, socket race) keeps its own row. */
  deviceIds: Set<number>;
}

const DevicesContext = createContext<DevicesContextState>({
  devices: [],
  statuses: new Map(),
  enabled: false,
  deviceIds: new Set(),
});

export function DevicesProvider({
  devices,
  statuses,
  enabled,
  children,
}: DevicesContextValue & { children: ReactNode }) {
  // Memoize the context value so its identity is stable when the underlying
  // inputs haven't changed. Without this, every Sidebar re-render (which fires
  // on every socket frame) allocated a fresh object and forced every
  // useContext(DevicesContext) consumer to re-render. Requires each caller
  // (Sidebar) to already memoize `devices` + `statuses` — otherwise this
  // still-fires but at least the object identity gate does its job for the
  // common case where nothing meaningful moved.
  const deviceIds = useMemo(() => new Set(devices.map((d) => d.id)), [devices]);
  const value = useMemo<DevicesContextState>(
    () => ({ devices, statuses, enabled, deviceIds }),
    [devices, statuses, enabled, deviceIds],
  );
  return <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>;
}

/**
 * Filter devices to a single group. Groups its return in a useMemo so the
 * `list` array's identity is stable for consumers whose deps depend on it.
 */
export function useGroupDevices(groupId: number | null): {
  list: AgentDevice[];
  enabled: boolean;
  statuses: Map<number, MonitorStatus | 'suspended' | undefined>;
  deviceIds: Set<number>;
} {
  const ctx = useContext(DevicesContext);
  const list = useMemo(
    () => (ctx.enabled ? ctx.devices.filter((d) => d.groupId === groupId) : []),
    [ctx.enabled, ctx.devices, groupId],
  );
  return { list, enabled: ctx.enabled, statuses: ctx.statuses, deviceIds: ctx.deviceIds };
}

const NO_DEVICES: AgentDevice[] = [];

/**
 * Every device of the context, unfiltered (empty when the list is disabled).
 * Used by the tree for cross-group work: search matches in a whole subtree,
 * god-view tenant buckets, device → tenant lookups.
 */
export function useAllDevices(): {
  devices: AgentDevice[];
  enabled: boolean;
  deviceIds: Set<number>;
} {
  const ctx = useContext(DevicesContext);
  return { devices: ctx.enabled ? ctx.devices : NO_DEVICES, enabled: ctx.enabled, deviceIds: ctx.deviceIds };
}

/**
 * Ids of the devices whose backing agent monitor sits in an active
 * maintenance window (the device payload carries no maintenance flag).
 */
export function agentsInMaintenance(monitors: Monitor[]): Set<number> {
  const ids = new Set<number>();
  for (const m of monitors) {
    if (m.type === 'agent' && m.inMaintenance && m.agentDeviceId != null) ids.add(m.agentDeviceId);
  }
  return ids;
}

/** Sidebar search on a device row: display name, hostname or IP. */
export function deviceMatchesSearch(d: AgentDevice, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [d.name, d.hostname, d.ip].some((v) => !!v && v.toLowerCase().includes(q));
}

/** Sidebar search on a monitor row: its name (agents: also the device display name). */
export function monitorMatchesSearch(m: Monitor, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return m.name.toLowerCase().includes(q) || (!!m.agentDeviceName && m.agentDeviceName.toLowerCase().includes(q));
}

/**
 * Agent monitors that still need their own row: all of them without the
 * devices list, otherwise those whose device is not (yet) in it.
 */
export function fallbackAgentMonitors<T extends { agentDeviceId?: number | null }>(
  agentMonitors: T[],
  devicesEnabled: boolean,
  deviceIds: Set<number>,
): T[] {
  if (!devicesEnabled) return agentMonitors;
  return agentMonitors.filter((m) => m.agentDeviceId == null || !deviceIds.has(m.agentDeviceId));
}
