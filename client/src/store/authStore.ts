import { create } from 'zustand';
import type { User, UserPermissions, PermissionLevel } from '@obliview/shared';
import { authApi, type LoginResult } from '../api/auth.api';
import { connectSocket, disconnectSocket } from '../socket/socketClient';
import { useLiveAlertsStore } from './liveAlertsStore';
import { setLanguage } from '../i18n';
import { useTenantStore } from './tenantStore';
import { useGroupStore } from './groupStore';
import { applyTheme } from '../utils/theme';

/**
 * /auth/me and /auth/permissions payload. `tenantCapabilities` is the list of
 * capabilities the user holds on the ACTIVE tenant (resolved server-side from
 * the permission_set tied to user_tenants.role). Declared here as optional so
 * the store also copes with a payload that predates the field.
 */
type AuthPermissions = UserPermissions & { tenantCapabilities?: string[] };

function syncPreferencesToStore(user: User) {
  const prefs = user.preferences;
  if (prefs) {
    useLiveAlertsStore.getState().setEnabled(prefs.toastEnabled ?? true);
    useLiveAlertsStore.getState().setPosition(prefs.toastPosition ?? 'bottom-right');
    if (prefs.preferredTheme) {
      applyTheme(prefs.preferredTheme);
    }
  }
  if (user.preferredLanguage) {
    setLanguage(user.preferredLanguage);
  }
}

interface AuthState {
  user: User | null;
  permissions: AuthPermissions | null;
  /** Load state of `permissions` ('error' = the last load failed). */
  permissionsStatus: 'idle' | 'loading' | 'loaded' | 'error';
  /** Capabilities on the active tenant (mirrors permissions.tenantCapabilities). */
  tenantCapabilities: string[];
  requires2faSetup: boolean;
  isLoading: boolean;
  isInitialized: boolean;

  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  refreshPermissions: () => Promise<void>;

  // Convenience permission checkers
  isAdmin: () => boolean;
  /**
   * Tenant capability check (Obliance pattern): platform admin, tenant role
   * 'admin' on the active tenant, or the capability is in tenantCapabilities.
   */
  hasCapability: (cap: string) => boolean;
  /** Any-of variant of hasCapability. */
  hasAnyCapability: (caps: readonly string[]) => boolean;
  canCreate: () => boolean;
  /** Group creation: an RW team on the active tenant AND 'groups.manage'
   *  (server: requireCanCreate('groups.manage')). */
  canCreateGroup: () => boolean;
  canWriteMonitor: (monitorId: number, groupId: number | null) => boolean;
  canWriteGroup: (groupId: number) => boolean;
  getMonitorPermission: (monitorId: number, groupId: number | null) => PermissionLevel | null;
  getGroupPermission: (groupId: number) => PermissionLevel | null;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  permissions: null,
  permissionsStatus: 'idle',
  tenantCapabilities: [],
  requires2faSetup: false,
  isLoading: false,
  isInitialized: false,

  login: async (username: string, password: string) => {
    set({ isLoading: true });
    try {
      const result = await authApi.login({ username, password });

      // 2FA required — don't set user yet, return the challenge to caller
      if (result.requires2fa) {
        set({ isLoading: false });
        return result;
      }

      const user = result.user;
      set({ user, isLoading: false });
      syncPreferencesToStore(user);
      connectSocket();
      useTenantStore.getState().fetchTenants();
      useLiveAlertsStore.getState().fetchAlerts();
      // Fetch permissions in the background; on failure, retry once through
      // refreshPermissions (which records 'error' if that fails too).
      set({ permissionsStatus: 'loading' });
      authApi.me()
        .then(({ permissions, user: fullUser, requires2faSetup, currentTenantId }) => {
          set({
            permissions,
            permissionsStatus: 'loaded',
            tenantCapabilities: (permissions as AuthPermissions | null)?.tenantCapabilities ?? [],
            requires2faSetup: requires2faSetup ?? false,
          });
          // The server refuses the live channel until a factor is set up.
          if (requires2faSetup) disconnectSocket();
          syncPreferencesToStore(fullUser);
          if (currentTenantId != null) {
            useTenantStore.setState({ currentTenantId });
          }
          // Reload group collapsed state for this user+tenant context
          useGroupStore.getState().reinitForTenant(fullUser.id, currentTenantId ?? null);
        })
        .catch(() => { void get().refreshPermissions(); });
      return result;
    } catch (err) {
      set({ isLoading: false });
      const axiosErr = err as { response?: { data?: { error?: string }; status?: number }; message?: string };
      const serverMessage = axiosErr?.response?.data?.error;
      const status = axiosErr?.response?.status;
      if (status === 429) {
        throw new Error(serverMessage ?? 'Too many login attempts, please try again later');
      } else if (status === 401) {
        throw new Error(serverMessage ?? 'Invalid username or password');
      } else if (serverMessage) {
        throw new Error(serverMessage);
      } else {
        throw new Error(axiosErr?.message ?? 'Unable to connect to the server');
      }
    }
  },

  logout: async () => {
    // Fetch Obligate logout URL BEFORE destroying local state,
    // because state reset triggers ProtectedRoute → navigate('/login') which races with us.
    let obligateLogoutUrl: string | null = null;
    try {
      const res = await fetch('/api/auth/sso-logout-url', { credentials: 'include' });
      const data = await res.json() as { success: boolean; data: string | null };
      if (data.success && data.data) obligateLogoutUrl = data.data;
    } catch { /* ignore */ }

    try {
      await authApi.logout();
    } finally {
      disconnectSocket();
      set({ user: null, permissions: null, permissionsStatus: 'idle', tenantCapabilities: [], requires2faSetup: false });
    }

    // Redirect to Obligate logout to destroy its session too.
    if (obligateLogoutUrl) {
      window.location.href = obligateLogoutUrl;
    }
  },

  checkSession: async () => {
    try {
      const wasBlocked = get().requires2faSetup;
      const { user, permissions, requires2faSetup, currentTenantId } = await authApi.me();
      set({
        user,
        permissions,
        permissionsStatus: 'loaded',
        tenantCapabilities: (permissions as AuthPermissions | null)?.tenantCapabilities ?? [],
        requires2faSetup: requires2faSetup ?? false,
        isInitialized: true,
      });
      syncPreferencesToStore(user);
      if (requires2faSetup) {
        // The server refuses the live channel until a factor is set up.
        disconnectSocket();
      } else {
        // A handshake refused while 2FA setup was required is not retried
        // by socket.io: start a fresh connection once a factor is enabled.
        if (wasBlocked) disconnectSocket();
        connectSocket();
      }
      useTenantStore.getState().fetchTenants();
      useLiveAlertsStore.getState().fetchAlerts();
      if (currentTenantId != null) {
        useTenantStore.setState({ currentTenantId });
      }
      // Reload group collapsed state for this user+tenant context
      useGroupStore.getState().reinitForTenant(user.id, currentTenantId ?? null);
    } catch {
      // Only clear user if login() hasn't already set one (race condition guard:
      // App.tsx fires checkSession() on mount; if it resolves AFTER a successful
      // login() call, the catch must not overwrite the freshly-authenticated user).
      set((state) =>
        state.user
          ? { isInitialized: true }
          : { user: null, permissions: null, permissionsStatus: 'idle', tenantCapabilities: [], requires2faSetup: false, isInitialized: true }
      );
    }
  },

  refreshPermissions: async () => {
    set({ permissionsStatus: 'loading' });
    try {
      const permissions = await authApi.getPermissions();
      set({
        permissions,
        permissionsStatus: 'loaded',
        tenantCapabilities: (permissions as AuthPermissions | null)?.tenantCapabilities ?? [],
      });
    } catch {
      set({ permissionsStatus: 'error' });
    }
  },

  isAdmin: () => get().user?.role === 'admin',

  hasCapability: (cap: string) => {
    const { user, tenantCapabilities } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (tenantCapabilities.includes(cap)) return true;
    // Tenant role 'admin' short-circuits the capability matrix (server rbac).
    const { currentTenantId, tenants } = useTenantStore.getState();
    if (currentTenantId == null) return false;
    return tenants.find((tn) => tn.id === currentTenantId)?.role === 'admin';
  },

  hasAnyCapability: (caps: readonly string[]) => caps.some((c) => get().hasCapability(c)),

  // canCreate: at least one RW team on the active tenant (server, effective)
  // AND the 'monitors.manage' capability.
  canCreate: () => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (permissions?.canCreate ?? false) && get().hasCapability('monitors.manage');
  },

  canCreateGroup: () => {
    const { user, permissions } = get();
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (permissions?.canCreate ?? false) && get().hasCapability('groups.manage');
  },

  // The helpers below are plain lookups: the server map is EFFECTIVE — each
  // group grant is already expanded to every descendant group (group_closure,
  // highest level wins) and to the monitors inside them. groupId stays in the
  // signatures for callers; it is only a fallback for a monitor key missing
  // from an older payload.
  canWriteMonitor: (monitorId: number, groupId: number | null) =>
    get().getMonitorPermission(monitorId, groupId) === 'rw',

  canWriteGroup: (groupId: number) => get().getGroupPermission(groupId) === 'rw',

  getMonitorPermission: (monitorId: number, groupId: number | null) => {
    const { user, permissions } = get();
    if (!user) return null;
    if (user.role === 'admin') return 'rw';
    if (!permissions) return null;

    const monitorPerm = permissions.permissions[`monitor:${monitorId}`];
    const groupPerm = groupId !== null ? permissions.permissions[`group:${groupId}`] : null;

    if (monitorPerm === 'rw' || groupPerm === 'rw') return 'rw';
    if (monitorPerm === 'ro' || groupPerm === 'ro') return 'ro';
    return null;
  },

  getGroupPermission: (groupId: number) => {
    const { user, permissions } = get();
    if (!user) return null;
    if (user.role === 'admin') return 'rw';
    if (!permissions) return null;
    return permissions.permissions[`group:${groupId}`] ?? null;
  },
}));
