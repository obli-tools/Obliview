import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LiveAlertData } from '@obliview/shared';
import apiClient from '../api/client';
import { useTenantStore } from './tenantStore';

/**
 * Suite-wide severities (server migration 065): 'critical' (outage),
 * 'warning' (degraded / threshold), 'info'. Older servers may still send
 * 'down' / 'up', normalized in toLocalAlert.
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * Alert as sent by the server (REST + NOTIFICATION_NEW). Extends the shared
 * LiveAlertData with the incident fields; every extra field is optional so an
 * older server payload still fits.
 */
export interface LiveAlertPayload extends Omit<LiveAlertData, 'severity'> {
  severity: AlertSeverity | 'down' | 'up';
  monitorId?: number | null;
  agentDeviceId?: number | null;
  readAt?: string | null;
  /** The incident is over (recovery). */
  resolved?: boolean;
  resolvedAt?: string | null;
}

/** NOTIFICATION_RESOLVED payload. */
export interface LiveAlertResolvedPayload {
  ids: number[];
  resolvedAt?: string;
}

/** Client-side alert object. Mirrors the server payload and adds ephemeral UI state. */
export interface LiveAlert extends Omit<LiveAlertPayload, 'severity' | 'resolved' | 'resolvedAt'> {
  severity: AlertSeverity;
  resolved: boolean;
  resolvedAt: string | null;
  /** True when the toast popup was dismissed (auto-timer or X button). Ephemeral — resets on reload. */
  toastDismissed: boolean;
}

// ─── Persistent preferences (localStorage) ───────────────────────────────────

interface AlertPrefs {
  /** Show toast popups for the current tenant's alerts */
  localEnabled: boolean;
  /** Show toast popups for other tenants' alerts (visible only when user has multiple tenants) */
  multiTenantEnabled: boolean;
  position: 'top-center' | 'bottom-right';
}

// ─── Full store state ─────────────────────────────────────────────────────────

interface LiveAlertsState extends AlertPrefs {
  alerts: LiveAlert[];

  // ── Preferences ──────────────────────────────────────────────────────────────
  setLocalEnabled: (v: boolean) => void;
  setMultiTenantEnabled: (v: boolean) => void;
  setPosition: (p: 'top-center' | 'bottom-right') => void;
  /** Backward-compat alias used by authStore (reads user.preferences.toastEnabled) */
  setEnabled: (v: boolean) => void;

  // ── Server sync ───────────────────────────────────────────────────────────────
  /** Fetch all alerts (all accessible tenants) from the server and replace local state. */
  fetchAlerts: () => Promise<void>;
  /** Add a single alert received via socket (NOTIFICATION_NEW). */
  addAlertFromServer: (alert: LiveAlertPayload) => void;
  /** Mark alerts resolved (socket NOTIFICATION_RESOLVED); their toasts are dismissed. */
  resolveAlertsFromServer: (payload: LiveAlertResolvedPayload) => void;

  // ── Actions ───────────────────────────────────────────────────────────────────
  // The server-backed actions below update the store optimistically, roll the
  // change back when the request fails, then re-throw so callers can react.
  /** Dismiss the toast popup for one alert (keeps it in the bell, does NOT mark as read). */
  dismissToast: (id: number) => void;
  /** Mark one alert as read (server + local). Also dismisses the toast. */
  markAlertRead: (id: number) => Promise<void>;
  /** Mark all current-tenant alerts as read (server + local). */
  markAllRead: () => Promise<void>;
  /** Dismiss one alert for the current user (server + local). */
  removeAlert: (id: number) => Promise<void>;
  /** Dismiss all current-tenant alerts for the current user (server + local). */
  clearAll: () => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSeverity(severity: LiveAlertPayload['severity']): AlertSeverity {
  if (severity === 'down') return 'critical';
  if (severity === 'up') return 'info';
  return severity === 'critical' || severity === 'warning' ? severity : 'info';
}

function toLocalAlert(data: LiveAlertPayload): LiveAlert {
  const resolvedAt = data.resolvedAt ?? null;
  return {
    ...data,
    severity: normalizeSeverity(data.severity),
    resolved: data.resolved ?? resolvedAt !== null,
    resolvedAt,
    // An alert that is already over never pops up.
    toastDismissed: data.resolved === true || resolvedAt !== null,
  };
}

/**
 * True when the alert belongs to the active tenant. read-all and clear-all
 * are current-tenant endpoints on the server, so the optimistic update must
 * not touch the other tenants' alerts. Before the tenant is known, every
 * alert counts as local.
 */
function isCurrentTenantAlert(alert: LiveAlert): boolean {
  const currentTenantId = useTenantStore.getState().currentTenantId;
  return currentTenantId == null || alert.tenantId === currentTenantId;
}

// apiClient (Axios): same session cookie, 401 handling and base URL as the
// other API calls. Its baseURL is already '/api': paths below start at '/live-alerts'.
async function apiPatch(path: string): Promise<void> {
  await apiClient.patch(path);
}
async function apiPost(path: string): Promise<void> {
  await apiClient.post(path);
}
async function apiDelete(path: string): Promise<void> {
  await apiClient.delete(path);
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useLiveAlertsStore = create<LiveAlertsState>()(
  persist(
    (set, get) => ({
      // Default preferences
      localEnabled: true,
      multiTenantEnabled: true,
      position: 'bottom-right',

      alerts: [],

      // ── Preferences ────────────────────────────────────────────────────────
      setLocalEnabled: (v) => set({ localEnabled: v }),
      setMultiTenantEnabled: (v) => set({ multiTenantEnabled: v }),
      setPosition: (p) => set({ position: p }),
      setEnabled: (v) => set({ localEnabled: v }),

      // ── Server sync ────────────────────────────────────────────────────────
      fetchAlerts: async () => {
        try {
          const res = await apiClient.get<{ alerts: LiveAlertPayload[] }>('/live-alerts/all');
          set({ alerts: (res.data.alerts ?? []).map(toLocalAlert) });
        } catch {
          // Ignore network errors (user may not be logged in yet)
        }
      },

      addAlertFromServer: (alert) =>
        set((s) => {
          // Skip if already in list (e.g. double-emit)
          if (s.alerts.some((a) => a.id === alert.id)) return s;
          return { alerts: [toLocalAlert(alert), ...s.alerts].slice(0, 200) };
        }),

      resolveAlertsFromServer: ({ ids, resolvedAt }) =>
        set((s) => {
          const resolvedIds = new Set(ids);
          if (!s.alerts.some((a) => resolvedIds.has(a.id))) return s;
          const at = resolvedAt ?? new Date().toISOString();
          return {
            alerts: s.alerts.map((a) => resolvedIds.has(a.id)
              ? { ...a, resolved: true, resolvedAt: a.resolvedAt ?? at, toastDismissed: true }
              : a),
          };
        }),

      // ── Actions ────────────────────────────────────────────────────────────
      dismissToast: (id) =>
        set((s) => ({
          alerts: s.alerts.map((a) => a.id === id ? { ...a, toastDismissed: true } : a),
        })),

      markAlertRead: async (id) => {
        const before = get().alerts.find((a) => a.id === id);
        // Optimistic update
        set((s) => ({
          alerts: s.alerts.map((a) => a.id === id ? { ...a, read: true, toastDismissed: true } : a),
        }));
        try {
          await apiPatch(`/live-alerts/${id}/read`);
        } catch (err) {
          // Roll back: the alert is unread again (its toast stays dismissed only if it was)
          if (before) {
            set((s) => ({
              alerts: s.alerts.map((a) => a.id === id
                ? { ...a, read: before.read, toastDismissed: before.toastDismissed }
                : a),
            }));
          }
          throw err;
        }
      },

      markAllRead: async () => {
        const previouslyUnread = new Set(
          get().alerts.filter((a) => !a.read && isCurrentTenantAlert(a)).map((a) => a.id),
        );
        set((s) => ({
          alerts: s.alerts.map((a) => previouslyUnread.has(a.id) ? { ...a, read: true } : a),
        }));
        try {
          await apiPost('/live-alerts/read-all');
        } catch (err) {
          set((s) => ({
            alerts: s.alerts.map((a) => previouslyUnread.has(a.id) ? { ...a, read: false } : a),
          }));
          throw err;
        }
      },

      removeAlert: async (id) => {
        const snapshot = get().alerts;
        const index = snapshot.findIndex((a) => a.id === id);
        const removed = index === -1 ? undefined : snapshot[index];
        set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
        try {
          await apiDelete(`/live-alerts/${id}`);
        } catch (err) {
          // Put the alert back at its previous position (unless it came back meanwhile)
          set((s) => {
            if (!removed || s.alerts.some((a) => a.id === id)) return s;
            const alerts = [...s.alerts];
            alerts.splice(Math.min(index, alerts.length), 0, removed);
            return { alerts };
          });
          throw err;
        }
      },

      clearAll: async () => {
        const cleared = get().alerts.filter(isCurrentTenantAlert);
        const clearedIds = new Set(cleared.map((a) => a.id));
        set((s) => ({ alerts: s.alerts.filter((a) => !clearedIds.has(a.id)) }));
        try {
          await apiDelete('/live-alerts');
        } catch (err) {
          // Restore the cleared alerts, keeping any alert that arrived meanwhile
          set((s) => {
            const present = new Set(s.alerts.map((a) => a.id));
            const restored = [...s.alerts, ...cleared.filter((a) => !present.has(a.id))];
            restored.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            return { alerts: restored.slice(0, 200) };
          });
          throw err;
        }
        // Re-sync with the server (cross-tenant alerts, anything emitted meanwhile)
        await get().fetchAlerts();
      },
    }),
    {
      name: 'obliview-alert-prefs',
      // Only persist preferences, NOT the alert list (alerts always fetched fresh from server)
      partialize: (s) => ({
        localEnabled: s.localEnabled,
        multiTenantEnabled: s.multiTenantEnabled,
        position: s.position,
      }),
    },
  ),
);

// ─── Computed helpers (exported for components) ───────────────────────────────

/**
 * Count of unread alerts that are still active (resolved incidents do not
 * count), optionally filtered to a specific tenant.
 */
export function countUnread(alerts: LiveAlert[], tenantId?: number | null): number {
  return alerts.filter((a) => !a.read && !a.resolved && (tenantId == null || a.tenantId === tenantId)).length;
}
