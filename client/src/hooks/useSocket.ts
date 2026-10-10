import { useEffect, useRef } from 'react';
import { getSocket } from '../socket/socketClient';
import { useMonitorStore } from '../store/monitorStore';
import { useGroupStore } from '../store/groupStore';
import { useAuthStore } from '../store/authStore';
import { useLiveAlertsStore } from '../store/liveAlertsStore';
import type { LiveAlertPayload, LiveAlertResolvedPayload } from '../store/liveAlertsStore';
import { estimateMaxBars } from '../components/monitors/HeartbeatBar';
import { onNativeLifecycle } from '../native/bridge';
import { SOCKET_EVENTS } from '@obliview/shared';
import type { Monitor, MonitorGroup, Heartbeat } from '@obliview/shared';

/** Dispatch a sound notification to the native desktop app overlay. */
function notifyNative(type: 'probe_down' | 'probe_up' | 'agent_alert' | 'agent_fixed') {
  window.dispatchEvent(new CustomEvent('obliview:notify', { detail: { type } }));
}

/** Window event dispatched on 'settings:updated' (SettingsPanel can listen to it). */
export const SETTINGS_UPDATED_WINDOW_EVENT = 'obliview:settings-updated';

/** Emitted by groups.controller after a drag-and-drop reorder (no SOCKET_EVENTS constant yet). */
const GROUP_REORDERED_EVENT = 'group:reordered';

/** One resync per burst of reconnects (flapping network, sleep/wake + forced reconnect). */
const RESYNC_DEBOUNCE_MS = 2_000;

/**
 * Re-read everything the socket keeps live. Events emitted while the socket
 * was down (server deploy, laptop sleep, network cut) are lost, so without
 * this a wall dashboard would keep showing pre-disconnect statuses until F5.
 */
function resyncAfterReconnect() {
  void useMonitorStore.getState().fetchMonitors();
  void useMonitorStore.getState().fetchAllHeartbeats(estimateMaxBars());
  void useGroupStore.getState().fetchTree();
  void useLiveAlertsStore.getState().fetchAlerts();
}

export function useSocket() {
  const { user } = useAuthStore();
  const { addMonitor, updateMonitor, removeMonitor, addHeartbeat } = useMonitorStore();
  const { addGroup, updateGroup, removeGroup, fetchTree } = useGroupStore();

  // Track previous agent statuses to detect transitions (alert↔ok) for native sounds.
  const agentStatusRef = useRef<Map<number, string>>(new Map());

  const isNativeApp = typeof window !== 'undefined' && !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

  useEffect(() => {
    if (!user) return;

    const socket = getSocket();
    if (!socket) return;

    // ── Reconnect resync ──────────────────────────────────────────────────────
    // 'connect' fires on the first connect AND on every reconnect. The first
    // one is covered by the boot / login fetches; every later one triggers a
    // debounced resync.
    let hadConnected = socket.connected;
    let resyncTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleResync = () => {
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        resyncAfterReconnect();
      }, RESYNC_DEBOUNCE_MS);
    };
    const onConnect = () => {
      if (hadConnected) scheduleResync();
      hadConnected = true;
    };
    // Obli Android shell back to the foreground: Android may have frozen the
    // WebView (timers and socket paused) without the socket ever noticing a
    // disconnect, so events were missed. Same debounced resync; a reconnect
    // in the same burst coalesces with it.
    const offNativeResume = onNativeLifecycle('resume', scheduleResync);

    // ── Live alert (NOTIFICATION_NEW) ─────────────────────────────────────────
    // The server now persists alerts in the DB and emits NOTIFICATION_NEW.
    // We simply add the alert to the local store; toast display is handled by LiveAlerts.tsx.
    const onNotificationNew = (alert: LiveAlertPayload) => {
      useLiveAlertsStore.getState().addAlertFromServer(alert);
    };
    // Incident(s) over (recovery): the bell greys them out, toasts close.
    const onNotificationResolved = (payload: LiveAlertResolvedPayload) => {
      if (!payload || !Array.isArray(payload.ids)) return;
      useLiveAlertsStore.getState().resolveAlertsFromServer(payload);
    };

    // ── Monitor heartbeat ─────────────────────────────────────────────────────
    // `monitorStatus` is the logical status the server just saved; it can differ
    // from heartbeat.status ('ssl_warning' / agent 'alert' beats are stored as 'up').
    const onMonitorHeartbeat = (data: { monitorId: number; heartbeat: Heartbeat; monitorStatus?: Heartbeat['status'] }) => {
      addHeartbeat(data.monitorId, data.heartbeat, data.monitorStatus);
    };

    // ── Monitor status change ─────────────────────────────────────────────────
    // Only used for: native app sounds + store/sidebar badge update.
    // Live alert toasts now come via NOTIFICATION_NEW (server-generated, DB-backed).
    const onMonitorStatusChange = (data: { monitorId: number; newStatus: string }) => {
      const prevMonitor = useMonitorStore.getState().getMonitor(data.monitorId);
      const prev = prevMonitor?.status;

      // While an agent is self-updating the worker emits 'pending' heartbeats (for
      // uptime exclusion), but the UI badge should stay on 'updating'. Skip any
      // 'pending' transition that would overwrite the 'updating' badge.
      if (data.newStatus === 'pending' && prev === 'updating') return;

      // Native app: play sound on down/recovery transitions
      if (isNativeApp) {
        if (data.newStatus === 'down' && prev !== 'down') {
          notifyNative('probe_down');
        } else if (prev === 'down' && data.newStatus !== 'down') {
          notifyNative('probe_up');
        }
      }

      updateMonitor(data.monitorId, { status: data.newStatus as Monitor['status'] });

      // Auto-expand parent groups when a monitor goes DOWN
      if (data.newStatus === 'down') {
        const monitor = useMonitorStore.getState().getMonitor(data.monitorId);
        if (monitor?.groupId) {
          const groupStore = useGroupStore.getState();
          groupStore.expandGroup(monitor.groupId);
          groupStore.expandAncestors(monitor.groupId);
        }
      }
    };

    // ── Monitor CRUD ──────────────────────────────────────────────────────────
    const onMonitorCreated = (data: { monitor: Monitor }) => {
      addMonitor(data.monitor);
    };
    const onMonitorUpdated = (data: { monitorId: number; changes: Partial<Monitor> }) => {
      updateMonitor(data.monitorId, data.changes);
    };
    const onMonitorDeleted = (data: { monitorId: number }) => {
      removeMonitor(data.monitorId);
    };
    const onMonitorPaused = (data: { monitorId: number; isPaused: boolean }) => {
      updateMonitor(data.monitorId, { status: data.isPaused ? 'paused' : 'pending' });
    };

    // ── Group events ──────────────────────────────────────────────────────────
    const onGroupCreated = (data: { group: MonitorGroup }) => {
      addGroup(data.group);
      fetchTree();
    };
    const onGroupUpdated = (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
      fetchTree();
    };
    const onGroupDeleted = (data: { groupId: number }) => {
      removeGroup(data.groupId);
      fetchTree();
    };
    const onGroupMoved = (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
      fetchTree();
    };
    // Another admin session reordered groups: the payload only carries sort
    // orders, so re-read the tree.
    const onGroupReordered = () => {
      fetchTree();
    };

    // ── Settings ──────────────────────────────────────────────────────────────
    // Re-broadcast as a window event so any mounted settings view can refresh
    // itself without this hook knowing about it.
    const onSettingsUpdated = (data: unknown) => {
      window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_WINDOW_EVENT, { detail: data }));
    };

    // ── Agent status — native sounds + 'updating' badge propagation ─────────────
    const onAgentStatusChanged = (data: {
      deviceId: number;
      status: string;
      violations?: string[];
      violationKeys?: string[];
    }) => {
      const prev = agentStatusRef.current.get(data.deviceId);

      if (isNativeApp) {
        if (data.status === 'alert' && prev !== 'alert') {
          notifyNative('agent_alert');
        } else if (prev === 'alert' && data.status !== 'alert') {
          notifyNative('agent_fixed');
        }
      }

      agentStatusRef.current.set(data.deviceId, data.status);

      // Propagate 'updating' (and its clearing) to the linked agent monitor badge.
      // The worker returns 'pending' heartbeats during update (for uptime exclusion),
      // but the monitor badge should reflect 'updating' (blue) instead.
      if (data.status === 'updating') {
        const agentMonitor = useMonitorStore.getState().getMonitorList()
          .find(m => m.agentDeviceId === data.deviceId);
        if (agentMonitor) {
          updateMonitor(agentMonitor.id, { status: 'updating' });
        }
      }
    };

    socket.on('connect', onConnect);
    socket.on(SOCKET_EVENTS.NOTIFICATION_NEW, onNotificationNew);
    socket.on(SOCKET_EVENTS.NOTIFICATION_RESOLVED, onNotificationResolved);
    socket.on(SOCKET_EVENTS.MONITOR_HEARTBEAT, onMonitorHeartbeat);
    socket.on(SOCKET_EVENTS.MONITOR_STATUS_CHANGE, onMonitorStatusChange);
    socket.on(SOCKET_EVENTS.MONITOR_CREATED, onMonitorCreated);
    socket.on(SOCKET_EVENTS.MONITOR_UPDATED, onMonitorUpdated);
    socket.on(SOCKET_EVENTS.MONITOR_DELETED, onMonitorDeleted);
    socket.on(SOCKET_EVENTS.MONITOR_PAUSED, onMonitorPaused);
    socket.on(SOCKET_EVENTS.GROUP_CREATED, onGroupCreated);
    socket.on(SOCKET_EVENTS.GROUP_UPDATED, onGroupUpdated);
    socket.on(SOCKET_EVENTS.GROUP_DELETED, onGroupDeleted);
    socket.on(SOCKET_EVENTS.GROUP_MOVED, onGroupMoved);
    socket.on(GROUP_REORDERED_EVENT, onGroupReordered);
    socket.on(SOCKET_EVENTS.SETTINGS_UPDATED, onSettingsUpdated);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatusChanged);

    // Remove only this hook's handlers: other components (Sidebar, detail
    // pages) subscribe to some of the same events on the shared socket.
    return () => {
      if (resyncTimer) clearTimeout(resyncTimer);
      offNativeResume();
      socket.off('connect', onConnect);
      socket.off(SOCKET_EVENTS.NOTIFICATION_NEW, onNotificationNew);
      socket.off(SOCKET_EVENTS.NOTIFICATION_RESOLVED, onNotificationResolved);
      socket.off(SOCKET_EVENTS.MONITOR_HEARTBEAT, onMonitorHeartbeat);
      socket.off(SOCKET_EVENTS.MONITOR_STATUS_CHANGE, onMonitorStatusChange);
      socket.off(SOCKET_EVENTS.MONITOR_CREATED, onMonitorCreated);
      socket.off(SOCKET_EVENTS.MONITOR_UPDATED, onMonitorUpdated);
      socket.off(SOCKET_EVENTS.MONITOR_DELETED, onMonitorDeleted);
      socket.off(SOCKET_EVENTS.MONITOR_PAUSED, onMonitorPaused);
      socket.off(SOCKET_EVENTS.GROUP_CREATED, onGroupCreated);
      socket.off(SOCKET_EVENTS.GROUP_UPDATED, onGroupUpdated);
      socket.off(SOCKET_EVENTS.GROUP_DELETED, onGroupDeleted);
      socket.off(SOCKET_EVENTS.GROUP_MOVED, onGroupMoved);
      socket.off(GROUP_REORDERED_EVENT, onGroupReordered);
      socket.off(SOCKET_EVENTS.SETTINGS_UPDATED, onSettingsUpdated);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatusChanged);
    };
  }, [user, addMonitor, updateMonitor, removeMonitor, addHeartbeat, addGroup, updateGroup, removeGroup, fetchTree, isNativeApp]);
}
