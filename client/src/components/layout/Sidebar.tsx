import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Activity,
  LayoutDashboard,
  Settings,
  Users,
  Plus,
  LogOut,
  Cpu,
  ShieldCheck,
  ChevronDown,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  Pin,
  PinOff,
  Search,
  KeyRound,
  List,
  Shield,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { anonymizeUsername } from '@/utils/anonymize';
import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useTenantStore } from '@/store/tenantStore';
import { useUiStore, useEffectiveSidebar } from '@/store/uiStore';
import { useIsMasterTenant } from '@/hooks/useIsGodView';
import { GroupTree } from '@/components/groups/GroupTree';
import { DevicesProvider } from '@/components/groups/DevicesContext';
import { UserAvatar } from '@/components/common/UserAvatar';
import { IconButton } from '@/components/common/IconButton';
import { agentApi } from '@/api/agent.api';
import { getSocket } from '@/socket/socketClient';
import type { AgentDevice, MonitorStatus } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import { NavLink, type NavItem } from './NavLink';

// ── localStorage helpers ─────────────────────────────────────────────────────

function usePersisted<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* storage blocked */ }
      return next;
    });
  }, [key]);
  return [value, set];
}

// ── Cross-mount cache ────────────────────────────────────────────────────────
// Below 1024 px the Sidebar lives in the off-canvas Drawer (AppLayout), which
// unmounts it when closed — and the drawer closes on every navigation. The
// last device list and pending-approvals count are kept here, keyed by user +
// tenant, so a re-opened drawer renders at once and only refetches the
// devices once they are REFRESH_MS old. The desktop column stays mounted, so
// it behaves as before (fetch on mount, then every 30 s).

/** Full device refresh cadence (socket deltas keep the list live in between). */
const REFRESH_MS = 30_000;
/** Pending-approvals badge poll (socket events refresh it in between). */
const PENDING_POLL_MS = 60_000;

interface DeviceData {
  /** User + tenant the rows belong to; null = nothing loaded yet. */
  key: string | null;
  devices: AgentDevice[];
}

const EMPTY_DEVICES: AgentDevice[] = [];
const EMPTY_DEVICE_DATA: DeviceData = { key: null, devices: EMPTY_DEVICES };

let devicesCache: { key: string; devices: AgentDevice[]; fetchedAt: number } | null = null;
let pendingCountCache: { key: string; count: number } | null = null;

function sidebarCacheKey(userId: number | null | undefined, tenantId: number | null | undefined): string {
  return `${userId ?? '-'}:${tenantId ?? '-'}`;
}

/** Key for the user + tenant active right now (read outside render). */
function currentSidebarCacheKey(): string {
  return sidebarCacheKey(useAuthStore.getState().user?.id, useTenantStore.getState().currentTenantId);
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

interface SidebarProps {
  /**
   * 'drawer' = rendered inside the phone / tablet off-canvas Drawer
   * (AppLayout, < 1024 px): always expanded, a close button instead of the
   * collapse / float toggles. Default: the desktop column.
   */
  variant?: 'default' | 'drawer';
  /** Drawer variant: close the drawer (before opening a modal, etc.). */
  onRequestClose?: () => void;
}

export function Sidebar({ variant = 'default', onRequestClose }: SidebarProps = {}) {
  const { t } = useTranslation();
  const inDrawer = variant === 'drawer';
  const location = useLocation();
  const { isAdmin, canCreate, hasCapability, hasAnyCapability, user } = useAuthStore();
  const { openAddAgentModal, toggleSidebarFloating, toggleSidebarCollapsed } = useUiStore();
  // Effective (device-aware) mode — see useEffectiveSidebar(). The drawer is
  // always the full, expanded sidebar.
  const effective = useEffectiveSidebar();
  const sidebarCollapsed = !inDrawer && effective.collapsed;
  const sidebarFloating = !inDrawer && effective.floating;
  const canFloat = !inDrawer && effective.canFloat;
  const { monitors } = useMonitorStore();
  const currentTenantId = useTenantStore(s => s.currentTenantId);
  // Subscribed so capability checks re-run once the tenant list (and so the
  // tenant role, which short-circuits capabilities) arrives.
  useTenantStore(s => s.tenants);
  const isMaster = useIsMasterTenant();

  const admin = isAdmin();
  // Capability-driven visibility (Obliance pattern): each entry is shown for
  // a platform admin, a tenant 'admin', or a holder of the capability. The
  // server enforces the same capabilities on the matching routes.
  const canManageAgents = hasCapability('agents.manage');
  const canSeePolicies = hasAnyCapability(['notifications', 'remediation', 'maintenance']);
  const canAddMonitor = canCreate();
  // The agent list is open to everyone (the server filters it to the agents
  // the user can see), but the entry only makes sense with something to show.
  const hasVisibleAgent = useMemo(() => {
    for (const m of monitors.values()) if (m.type === 'agent') return true;
    return false;
  }, [monitors]);
  const cacheKey = sidebarCacheKey(user?.id, currentTenantId);

  // Opening the Add-agent modal from the drawer: close the drawer first (it
  // sits above the modal).
  const handleAddAgent = () => {
    onRequestClose?.();
    openAddAgentModal();
  };

  const [deviceData, setDeviceData] = useState<DeviceData>(() => (
    devicesCache?.key === cacheKey
      ? { key: cacheKey, devices: devicesCache.devices }
      : EMPTY_DEVICE_DATA
  ));
  // Never show another user's / tenant's rows: only the data of this key.
  const approvedDevices = deviceData.key === cacheKey ? deviceData.devices : EMPTY_DEVICES;
  // Latest list for the socket handlers (decide outside the state updater).
  const approvedDevicesRef = useRef(approvedDevices);
  useEffect(() => { approvedDevicesRef.current = approvedDevices; }, [approvedDevices]);
  const [deviceStatuses, setDeviceStatuses] = useState<Map<number, MonitorStatus | 'suspended' | undefined>>(new Map());
  const [pendingCount, setPendingCount] = useState(() => (
    pendingCountCache?.key === cacheKey ? pendingCountCache.count : 0
  ));
  const [search, setSearch] = useState('');

  const [navMenuOpen, setNavMenuOpen] = usePersisted<boolean>('sidebar:nav-open', true);
  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);

  // Socket deltas flow back into the cache. `deviceData.key` always
  // describes `deviceData`, so another tenant's rows can never land in it.
  useEffect(() => {
    if (deviceData.key !== null && devicesCache?.key === deviceData.key) {
      devicesCache.devices = deviceData.devices;
    }
  }, [deviceData]);

  // Debounce loadDevices so a burst of AGENT_DEVICE_UPDATED events (typical
  // during bulk approve/delete: server emits one per device in a tight loop)
  // collapses into a single refetch instead of N back-to-back full-tenant
  // scans per admin session. Without it this is a stampede vector —
  // 50-device bulk approve × every open admin sidebar
  // multiplied server load and hammered the API.
  const loadDevicesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Everyone loads the device list: the server returns only the devices whose
  // agent monitor the user can see (agents.manage holders get them all).
  const loadDevices = useCallback(() => {
    if (loadDevicesDebounceRef.current) return;
    loadDevicesDebounceRef.current = setTimeout(() => {
      loadDevicesDebounceRef.current = null;
      const key = currentSidebarCacheKey();
      Promise.all([
        agentApi.listDevices('approved'),
        agentApi.listDevices('suspended'),
      ])
        .then(([approved, suspended]) => {
          // Signed out / other context while in flight: drop the answer.
          if (key !== currentSidebarCacheKey()) return;
          const devices = [...approved, ...suspended];
          devicesCache = { key, devices, fetchedAt: Date.now() };
          setDeviceData({ key, devices });
        })
        .catch(() => {});
    }, 400);
  }, []);

  useEffect(() => () => {
    if (loadDevicesDebounceRef.current) clearTimeout(loadDevicesDebounceRef.current);
    loadDevicesDebounceRef.current = null;
  }, []);

  useEffect(() => {
    const cached = devicesCache?.key === cacheKey ? devicesCache : null;
    setDeviceData(prev => (
      prev.key === cacheKey ? prev
        : cached ? { key: cacheKey, devices: cached.devices }
        : EMPTY_DEVICE_DATA
    ));
    let interval: ReturnType<typeof setInterval> | undefined;
    let firstTick: ReturnType<typeof setTimeout> | undefined;
    const age = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (age >= 0 && age < REFRESH_MS) {
      // Remount on recent cached rows (drawer re-opened): they are already on
      // screen — resume the 30 s cadence instead of refetching right now.
      firstTick = setTimeout(() => {
        loadDevices();
        interval = setInterval(loadDevices, REFRESH_MS);
      }, REFRESH_MS - age);
    } else {
      loadDevices();
      interval = setInterval(loadDevices, REFRESH_MS);
    }
    return () => {
      clearTimeout(firstTick);
      clearInterval(interval);
    };
  }, [loadDevices, cacheKey]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onDeviceUpdated = (data: {
      deviceId: number;
      name: string | null;
      hostname: string;
      status: AgentDevice['status'];
      groupId: number | null;
    }) => {
      const tracked = data.status === 'approved' || data.status === 'suspended';
      if (!approvedDevicesRef.current.some(d => d.id === data.deviceId)) {
        // A device that just became approved / suspended (e.g. after an
        // approval) — fetch the full row. Pending devices are not listed.
        if (tracked) loadDevices();
        return;
      }
      setDeviceData(prev => {
        if (!tracked) {
          return { ...prev, devices: prev.devices.filter(d => d.id !== data.deviceId) };
        }
        return {
          ...prev,
          devices: prev.devices.map(d =>
            d.id === data.deviceId
              ? { ...d, name: data.name, hostname: data.hostname, status: data.status, groupId: data.groupId }
              : d,
          ),
        };
      });
    };

    const onDeviceDeleted = (data: { deviceId: number }) => {
      setDeviceData(prev => (
        prev.devices.some(d => d.id === data.deviceId)
          ? { ...prev, devices: prev.devices.filter(d => d.id !== data.deviceId) }
          : prev
      ));
    };

    const onStatusChanged = (data: { deviceId: number; status: string }) => {
      // Guard against the AgentMonitorWorker firing AGENT_STATUS_CHANGED on
      // every check cycle regardless of whether the status actually changed.
      // Without this, every push tick allocates a fresh Map and re-renders
      // the whole sidebar tree even when nothing moved.
      setDeviceStatuses(prev => {
        if (prev.get(data.deviceId) === (data.status as MonitorStatus | 'suspended')) return prev;
        return new Map(prev).set(data.deviceId, data.status as MonitorStatus | 'suspended');
      });
    };

    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    return () => {
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    };
  }, [loadDevices]);

  // ── Pending approvals badge (agents.manage only) ───────────────────────────
  // Refreshed on every device add / update / delete (debounced: a bulk
  // approve emits one event per device) and polled every 60 s.
  useEffect(() => {
    if (!canManageAgents) return;
    let cancelled = false;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      const key = currentSidebarCacheKey();
      agentApi.listDevices('pending')
        .then(rows => {
          if (key === currentSidebarCacheKey()) pendingCountCache = { key, count: rows.length };
          if (!cancelled) setPendingCount(rows.length);
        })
        .catch(() => {});
    };
    const scheduleLoad = () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        load();
      }, 400);
    };
    load();
    const tick = setInterval(load, PENDING_POLL_MS);
    const socket = getSocket();
    socket?.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, scheduleLoad);
    socket?.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, scheduleLoad);
    return () => {
      cancelled = true;
      clearInterval(tick);
      if (debounce) clearTimeout(debounce);
      socket?.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, scheduleLoad);
      socket?.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, scheduleLoad);
    };
  }, [canManageAgents, cacheKey]);

  // Pre-index monitors by agentDeviceId so the resolver below is O(devices)
  // rather than O(devices × monitors). Rebuilt only when the monitor set or
  // its status distribution changes — device-status socket frames don't
  // invalidate this since they touch `deviceStatuses`, not `monitors`.
  const monitorsByAgentDeviceId = useMemo(() => {
    const map = new Map<number, MonitorStatus>();
    for (const m of monitors.values()) {
      if (m.agentDeviceId != null) map.set(m.agentDeviceId, m.status);
    }
    return map;
  }, [monitors]);

  // Resolve a status for each device by merging the live socket status with
  // its underlying agent monitor's last known status (fallback when no live
  // frame has arrived yet). Memoized so it stays identity-stable when nothing
  // changed — <DevicesProvider> below then avoids re-triggering context
  // consumers on every unrelated sidebar re-render.
  const resolvedDeviceStatuses = useMemo(() => {
    const map = new Map<number, MonitorStatus | 'suspended' | undefined>();
    for (const dev of approvedDevices) {
      const live = deviceStatuses.get(dev.id);
      if (live) { map.set(dev.id, live); continue; }
      const fromMonitor = monitorsByAgentDeviceId.get(dev.id);
      if (fromMonitor) map.set(dev.id, fromMonitor);
    }
    return map;
  }, [approvedDevices, deviceStatuses, monitorsByAgentDeviceId]);

  // ── Nav items ──────────────────────────────────────────────────────────────
  // NAVIGATION (above the tree) and ADMINISTRATION (below it). Each item
  // checks its own visibility; a section with no visible item is not rendered.

  const navItems: NavItem[] = [
    { label: t('nav.dashboard'), path: '/', icon: <LayoutDashboard size={16} /> },
    // Flat monitor list: every signed-in user (the server filters what each one sees).
    { label: t('nav.monitors', 'Monitors'), path: '/monitors', icon: <List size={16} /> },
    ...(canManageAgents || hasVisibleAgent ? [
      {
        label: t('nav.agents'),
        path: '/agents',
        icon: <Cpu size={16} />,
        // Pending approvals are an agents.manage concern only.
        ...(canManageAgents ? {
          badgeCount: pendingCount,
          badgeLabel: t('nav.pendingApprovals', { count: pendingCount, defaultValue: '{{count}} awaiting approval' }),
        } : {}),
      } satisfies NavItem,
    ] : []),
    // Policies hub: shown when at least one of its tabs is reachable.
    ...(canSeePolicies
      ? [{ label: t('nav.policies', 'Policies'), path: '/policies', icon: <ShieldCheck size={16} /> } satisfies NavItem]
      : []),
  ];

  const adminNavItems: NavItem[] = [
    ...(hasCapability('users.manage')
      ? [{ label: t('nav.users'), path: '/manage/users', icon: <Users size={16} /> } satisfies NavItem]
      : []),
    ...(canManageAgents
      ? [{ label: t('nav.agentConfig', 'Agent config'), path: '/manage/agents', icon: <KeyRound size={16} /> } satisfies NavItem]
      : []),
    // Workspace administration: platform admin, and only on the master tenant.
    ...(admin && isMaster
      ? [{ label: t('nav.workspace', 'Workspace'), path: '/workspace', icon: <Building2 size={16} /> } satisfies NavItem]
      : []),
    // Security (audit log): 'supervision:read' — platform and tenant admins always hold it.
    ...(hasCapability('supervision:read')
      ? [{ label: t('nav.security', 'Security'), path: '/manage/security', icon: <Shield size={16} /> } satisfies NavItem]
      : []),
    ...(hasCapability('settings')
      ? [{ label: t('nav.settings'), path: '/settings', icon: <Settings size={16} /> } satisfies NavItem]
      : []),
  ];

  const displayName = anonymizeUsername(
    user?.displayName || (user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username),
  );

  // ── Collapsed (icon-only, 64 px) render ────────────────────────────────────

  if (sidebarCollapsed) {
    const allItems = [...navItems, ...adminNavItems];
    return (
      <aside className="flex h-full w-full flex-col bg-bg-secondary">
        {/* Header — toggle expand */}
        <div className="flex flex-col items-center gap-2 px-2 pt-3.5">
          <IconButton
            label={t('nav.expandSidebar', { defaultValue: 'Expand' })}
            icon={<ChevronsRight size={16} />}
            onClick={toggleSidebarCollapsed}
            className="h-[30px] w-[30px] rounded-md p-0 text-text-secondary"
          />
          {canAddMonitor && (
            <Link
              to="/monitor/new"
              title={t('dashboard.addMonitor')}
              aria-label={t('dashboard.addMonitor')}
              className="relative flex h-[38px] w-[38px] items-center justify-center rounded-[7px] bg-accent/10 text-accent-hover transition-colors hover:bg-accent/20"
            >
              <Activity size={15} />
              <Plus size={10} strokeWidth={3} className="absolute right-1 top-1" />
            </Link>
          )}
          {/* '+ Agent' opens a modal that reads GET /agent/keys (agents.manage) */}
          {canManageAgents && (
            <button
              onClick={openAddAgentModal}
              title={t('dashboard.addAgent')}
              aria-label={t('dashboard.addAgent')}
              className="relative flex h-[38px] w-[38px] items-center justify-center rounded-[7px] bg-accent/10 text-accent-hover transition-colors hover:bg-accent/20"
            >
              <Cpu size={15} />
              <Plus size={10} strokeWidth={3} className="absolute right-1 top-1" />
            </button>
          )}
        </div>

        {/* Nav icons only */}
        <nav
          aria-label={t('nav.navigation', 'Navigation')}
          className="flex flex-1 flex-col items-center gap-1 overflow-y-auto px-2 pt-3"
        >
          {allItems.map(item => <NavLink key={item.path} item={item} collapsed />)}
        </nav>

        {/* Footer — avatar + logout */}
        <div className="flex flex-col items-center gap-2 border-t border-border px-2 py-3">
          <Link
            to="/profile"
            className="flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-80"
            title={displayName}
            aria-label={t('nav.profile')}
          >
            <UserAvatar avatar={user?.avatar} username={user?.username ?? '?'} size={24} />
          </Link>
          <IconButton
            label={t('nav.signOut')}
            icon={<LogOut size={16} />}
            onClick={() => useAuthStore.getState().logout()}
            className="h-9 w-9 rounded-md p-0 text-text-secondary"
          />
        </div>
      </aside>
    );
  }

  // ── Expanded (full content, 260 px / variable, or the drawer) render ───────

  return (
    <aside className={cn('flex h-full w-full flex-col bg-bg-secondary', inDrawer && 'min-h-0 flex-1')}>
      {/* Header — toggle row (or drawer close) + Add monitor / agent + search */}
      <div className="flex flex-col gap-[9px] px-3 pb-2.5 pt-3.5">
        <div className="flex items-center justify-end gap-1">
          {inDrawer ? (
            <IconButton
              label={t('nav.closeMenu', 'Close menu')}
              icon={<X size={16} />}
              onClick={onRequestClose}
              className="h-[30px] w-[30px] rounded-md p-0 text-text-secondary"
            />
          ) : (
            <>
              {/* Collapse toggle — hidden when floating (the two are mutex). */}
              {!sidebarFloating && (
                <IconButton
                  label={t('nav.collapseSidebar', { defaultValue: 'Collapse' })}
                  icon={<ChevronsLeft size={16} />}
                  onClick={toggleSidebarCollapsed}
                  className="h-[30px] w-[30px] rounded-md p-0 text-text-secondary"
                />
              )}
              {/* Pin/Float toggle — floating needs a hovering pointer, so it
                  is not offered on touch screens. */}
              {canFloat && (
                <IconButton
                  label={sidebarFloating ? t('nav.pinSidebar') : t('nav.floatSidebar')}
                  icon={sidebarFloating ? <Pin size={15} /> : <PinOff size={15} />}
                  onClick={toggleSidebarFloating}
                  variant={sidebarFloating ? 'primary' : 'ghost'}
                  className={cn(
                    'h-[30px] w-[30px] rounded-md p-0',
                    sidebarFloating ? 'text-accent-hover' : 'text-text-secondary',
                  )}
                />
              )}
            </>
          )}
        </div>

        {(canAddMonitor || canManageAgents) && (
          <div className="flex gap-2">
            {canAddMonitor && (
              <Link
                to="/monitor/new"
                className="flex h-[38px] flex-1 items-center justify-center gap-2 rounded-[7px] bg-accent/10 text-[13px] font-medium text-accent-hover transition-colors hover:bg-accent/20 coarse:h-11"
              >
                <Plus size={14} />
                <span>{t('common.monitor')}</span>
              </Link>
            )}
            {/* '+ Agent' opens a modal that reads GET /agent/keys (agents.manage) */}
            {canManageAgents && (
              <button
                onClick={handleAddAgent}
                className="flex h-[38px] flex-1 items-center justify-center gap-2 rounded-[7px] bg-accent/10 text-[13px] font-medium text-accent-hover transition-colors hover:bg-accent/20 coarse:h-11"
              >
                <Plus size={14} />
                <span>{t('common.agent')}</span>
              </button>
            )}
          </div>
        )}

        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-[38px] w-full rounded-[7px] bg-bg-tertiary pl-8 pr-3 text-[13px] text-text-primary placeholder:text-text-muted focus:bg-bg-hover focus:outline-none"
          />
        </div>
      </div>

      {/* Body — NAVIGATION block (collapsible, persisted) above the tree, so
          the primary pages never scroll out of sight with a long tree. */}
      <div className="flex min-h-0 flex-1 flex-col px-2">
        <button
          type="button"
          onClick={() => setNavMenuOpen(v => !v)}
          aria-expanded={navMenuOpen}
          title={navMenuOpen
            ? t('nav.collapseNav', 'Collapse navigation')
            : t('nav.expandNav', 'Expand navigation')}
          className="flex w-full shrink-0 items-center gap-2 px-1 py-1.5 text-text-muted transition-colors hover:text-text-secondary coarse:py-2.5"
        >
          <ChevronDown size={11} className={cn('transition-transform duration-200', !navMenuOpen && '-rotate-90')} />
          <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
            {t('nav.navigation', 'Navigation')}
          </span>
          <div className="h-px flex-1 bg-border" />
        </button>
        {navMenuOpen && (
          <nav aria-label={t('nav.navigation', 'Navigation')} className="shrink-0 pb-1">
            {navItems.map(item => <NavLink key={item.path} item={item} />)}
          </nav>
        )}

        {/* Single unified tree: groups are hybrid, monitors and devices live
            side-by-side under each group with distinct leaf icons. */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          <DevicesProvider devices={approvedDevices} statuses={resolvedDeviceStatuses} enabled>
            <GroupTree searchQuery={search} />
          </DevicesProvider>
        </div>
      </div>

      {/* ADMINISTRATION section */}
      {adminNavItems.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setAdminMenuOpen(v => !v)}
            aria-expanded={adminMenuOpen}
            title={adminMenuOpen
              ? t('nav.collapseAdmin', 'Collapse administration')
              : t('nav.expandAdmin', 'Expand administration')}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-text-muted transition-colors hover:text-text-secondary coarse:py-2.5"
          >
            <div className="h-px flex-1 bg-border" />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
              {t('nav.administration', { defaultValue: 'ADMINISTRATION' })}
            </span>
            <ChevronDown size={11} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
            <div className="h-px flex-1 bg-border" />
          </button>

          {adminMenuOpen && (
            <nav aria-label={t('nav.administration', { defaultValue: 'ADMINISTRATION' })} className="px-2 pb-2 pt-0">
              {adminNavItems.map(item => <NavLink key={item.path} item={item} />)}
            </nav>
          )}
        </>
      )}

      {/* Footer — user row + logout */}
      <div className="border-t border-border p-2.5">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors coarse:py-2.5',
            location.pathname === '/profile'
              ? 'bg-accent/10'
              : 'hover:bg-bg-hover',
          )}
        >
          <UserAvatar avatar={user?.avatar} username={user?.username ?? '?'} size={20} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {displayName}
            </div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {(user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username) ?? ''} · {user?.role ?? ''}
            </div>
          </div>
        </Link>
        <button
          onClick={() => useAuthStore.getState().logout()}
          className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary coarse:py-2.5"
        >
          <LogOut size={14} />
          <span>{t('nav.signOut')}</span>
        </button>
      </div>
    </aside>
  );
}
