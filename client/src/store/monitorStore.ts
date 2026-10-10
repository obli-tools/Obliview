import { create } from 'zustand';
import type { Monitor, Heartbeat } from '@obliview/shared';
import { monitorsApi } from '../api/monitors.api';

export interface MonitorSummary {
  uptimePct: number;
  avgResponseTime: number | null;
}

interface MonitorStore {
  monitors: Map<number, Monitor>;
  heartbeats: Map<number, Heartbeat[]>;
  summary: Record<number, MonitorSummary>;
  /** True once /monitors/summary answered at least once (the dashboard and the sidebar tree poll it every 60 s). */
  summaryLoaded: boolean;
  isLoading: boolean;
  /** True once /monitors answered at least once (an empty list then means "no monitors"). */
  loaded: boolean;
  /** True when the last /monitors fetch failed (cleared by the next successful one). */
  error: boolean;

  // Actions
  fetchMonitors: () => Promise<void>;
  /** Concurrent callers share the in-flight request (sidebar + dashboard mount together). */
  fetchSummary: () => Promise<void>;
  fetchAllHeartbeats: (count?: number) => Promise<void>;
  addMonitor: (monitor: Monitor) => void;
  updateMonitor: (id: number, data: Partial<Monitor>) => void;
  removeMonitor: (id: number) => void;
  /** `monitorStatus` (from the socket payload) wins over heartbeat.status for the badge. */
  addHeartbeat: (monitorId: number, heartbeat: Heartbeat, monitorStatus?: Heartbeat['status']) => void;
  setHeartbeats: (monitorId: number, heartbeats: Heartbeat[]) => void;

  // Getters (as functions)
  getMonitor: (id: number) => Monitor | undefined;
  getMonitorList: () => Monitor[];
  getMonitorsByGroup: (groupId: number | null) => Monitor[];
  getRecentHeartbeats: (monitorId: number) => Heartbeat[];
  getMonitorSummary: (monitorId: number) => MonitorSummary | undefined;
}

/** Max heartbeats kept in memory — updated dynamically by fetchAllHeartbeats */
let maxHeartbeats = 50;

/** In-flight /monitors/summary request shared by concurrent fetchSummary() calls. */
let summaryRequest: Promise<void> | null = null;

export const useMonitorStore = create<MonitorStore>((set, get) => ({
  monitors: new Map(),
  heartbeats: new Map(),
  summary: {},
  summaryLoaded: false,
  isLoading: false,
  loaded: false,
  error: false,

  fetchMonitors: async () => {
    set({ isLoading: true });
    try {
      const list = await monitorsApi.list();
      const monitors = new Map<number, Monitor>();
      list.forEach((m) => monitors.set(m.id, m));
      set({ monitors, isLoading: false, loaded: true, error: false });
    } catch {
      // Keep the last known list (a failed refresh must not empty the
      // dashboard) and flag the failure so pages can offer a retry.
      set({ isLoading: false, error: true });
    }
  },

  fetchSummary: () => {
    if (summaryRequest) return summaryRequest;
    summaryRequest = (async () => {
      try {
        const data = await monitorsApi.getSummary();
        set({ summary: data, summaryLoaded: true });
      } catch {
        // ignore — the dashboard / sidebar tree poll again in 60 s
      } finally {
        summaryRequest = null;
      }
    })();
    return summaryRequest;
  },

  fetchAllHeartbeats: async (count = 50) => {
    try {
      maxHeartbeats = Math.max(maxHeartbeats, count);
      const data = await monitorsApi.getAllHeartbeats(count);
      set((state) => {
        const heartbeats = new Map(state.heartbeats);
        for (const [idStr, hbs] of Object.entries(data)) {
          const id = Number(idStr);
          heartbeats.set(id, hbs.slice(-maxHeartbeats));
        }
        return { heartbeats };
      });
    } catch {
      // ignore
    }
  },

  addMonitor: (monitor) => {
    set((state) => {
      const monitors = new Map(state.monitors);
      monitors.set(monitor.id, monitor);
      return { monitors };
    });
  },

  updateMonitor: (id, data) => {
    set((state) => {
      const monitors = new Map(state.monitors);
      const existing = monitors.get(id);
      if (existing) {
        monitors.set(id, { ...existing, ...data });
      }
      return { monitors };
    });
  },

  removeMonitor: (id) => {
    set((state) => {
      const monitors = new Map(state.monitors);
      monitors.delete(id);
      const heartbeats = new Map(state.heartbeats);
      heartbeats.delete(id);
      return { monitors, heartbeats };
    });
  },

  addHeartbeat: (monitorId, heartbeat, monitorStatus) => {
    set((state) => {
      const heartbeats = new Map(state.heartbeats);
      const existing = heartbeats.get(monitorId) || [];
      const updated = [...existing, heartbeat].slice(-maxHeartbeats);
      heartbeats.set(monitorId, updated);

      // Also update monitor status and maintenance flag.
      // Guard: don't overwrite 'updating' with 'pending' — the agent emits
      // 'pending' heartbeats while self-updating (for uptime exclusion), but the
      // UI badge should stay on 'updating' until the agent reconnects.
      const monitors = new Map(state.monitors);
      const monitor = monitors.get(monitorId);
      if (monitor) {
        // Every emitter sends the logical status; the only beat without it is
        // the agent startup beat the server deliberately does not persist —
        // treat that as "status unchanged" (no false DOWN after a restart).
        const incoming = monitorStatus ?? monitor.status;
        const newStatus = (incoming === 'pending' && monitor.status === 'updating')
          ? 'updating'
          : incoming;
        monitors.set(monitorId, {
          ...monitor,
          status: newStatus,
          inMaintenance: heartbeat.inMaintenance ?? monitor.inMaintenance,
        });
      }

      return { heartbeats, monitors };
    });
  },

  setHeartbeats: (monitorId, hbs) => {
    set((state) => {
      const heartbeats = new Map(state.heartbeats);
      heartbeats.set(monitorId, hbs.slice(-maxHeartbeats));
      return { heartbeats };
    });
  },

  getMonitor: (id) => get().monitors.get(id),
  getMonitorList: () => Array.from(get().monitors.values()),
  getMonitorsByGroup: (groupId) =>
    Array.from(get().monitors.values()).filter((m) => m.groupId === groupId),
  getRecentHeartbeats: (monitorId) => get().heartbeats.get(monitorId) || [],
  getMonitorSummary: (monitorId) => get().summary[monitorId],
}));
