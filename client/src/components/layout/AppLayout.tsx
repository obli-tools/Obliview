import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { DesktopUpdateBanner } from './DesktopUpdateBanner';
import { LiveAlerts } from './LiveAlerts';
import { GlobalAddAgentModal } from './GlobalAddAgentModal';
import { Drawer } from '@/components/common/Drawer';
import { useUiStore, useEffectiveSidebar } from '@/store/uiStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useTenantStore } from '@/store/tenantStore';
import { useSocket } from '@/hooks/useSocket';
import { cn } from '@/utils/cn';

export function AppLayout() {
  const { t } = useTranslation();
  // Global socket subscriptions — always active regardless of which page is open
  useSocket();

  // The monitor list feeds the sidebar tree on every page. Loaded here (the
  // shell is always mounted) rather than in the Sidebar, which the phone /
  // tablet drawer unmounts on every close.
  const fetchMonitors = useMonitorStore((s) => s.fetchMonitors);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors, currentTenantId]);

  const { sidebarWidth, setSidebarWidth, mobileNavOpen, setMobileNavOpen } = useUiStore();
  // Effective mode: drawer below 1024 px; on a touch
  // screen ≥ 1024 px floating + mouse resize are disabled. Never persisted.
  const sidebar = useEffectiveSidebar();
  const COLLAPSED_WIDTH = 64;
  const effectiveWidth = sidebar.collapsed ? COLLAPSED_WIDTH : sidebarWidth;
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // ── Off-canvas drawer (phone / tablet) ────────────────────────────────────
  // Closes on every navigation (location.key changes even when the same link
  // is tapped again) and whenever the layout leaves drawer mode, so it never
  // pops back open after a resize / rotation.
  const location = useLocation();
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.key, setMobileNavOpen]);
  useEffect(() => {
    if (!sidebar.isDrawer) setMobileNavOpen(false);
  }, [sidebar.isDrawer, setMobileNavOpen]);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [setMobileNavOpen]);

  // ── Body-row top offset ────────────────────────────────────────────────────
  // Floating sidebar is `position: fixed` and must drop down BELOW the topbar.
  // We measure where the body row actually starts (excludes the header) and
  // use that as the floating sidebar's top anchor. This also handles the
  // native desktop app's tab bar (added as body padding-top).
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      if (bodyRowRef.current) {
        setTopOffset(bodyRowRef.current.getBoundingClientRect().top);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── Floating sidebar visibility ───────────────────────────────────────────
  const [floatVisible, setFloatVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset floating visibility whenever the (effective) mode is toggled off
  useEffect(() => {
    if (!sidebar.floating) setFloatVisible(false);
  }, [sidebar.floating]);

  const showFloat = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setFloatVisible(true);
  }, []);

  const hideFloat = useCallback(() => {
    hideTimer.current = setTimeout(() => setFloatVisible(false), 150);
  }, []);

  // ── Resize handle ─────────────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - startX.current;
        setSidebarWidth(startWidth.current + delta);
      };

      const handleMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth, setSidebarWidth],
  );

  return (
    // h-screen fallback only where dvh is unsupported (WebView < 108): a
    // plain 'h-screen h-dvh' pair would let vh win (Tailwind orders
    // same-property utilities alphabetically).
    <div className="flex h-dvh supports-[not(height:100dvh)]:h-screen flex-col overflow-hidden bg-bg-primary">

      {/* Full-width topbar — always above the sidebar so logo + tenant
          selector + app switcher stay visible regardless of sidebar state
          (pinned, collapsed, floating, drawer). */}
      <Header />
      <DesktopUpdateBanner />

      {/* Body row — sidebar + main content side by side, below the topbar */}
      <div ref={bodyRowRef} className="flex flex-1 overflow-hidden">

        {sidebar.isDrawer ? null : sidebar.floating ? (
          <>
            {/* Invisible hover-trigger strip on the far left edge of the body
                row (excludes the topbar so the user can still click logo /
                tenant when the sidebar is auto-hidden). */}
            <div
              className="fixed left-0 z-[51]"
              style={{ top: topOffset, height: `calc(100% - ${topOffset}px)`, width: '8px' }}
              onMouseEnter={showFloat}
            />

            {/* Floating sidebar panel — slides in from left on hover, anchored
                to the body row top so it never overlaps the topbar. */}
            <div
              className={cn(
                'fixed left-0 z-50',
                'transition-transform duration-200 ease-in-out',
                'shadow-[4px_0_24px_0_rgba(0,0,0,0.35)]',
                floatVisible ? 'translate-x-0' : '-translate-x-full',
              )}
              style={{ width: `${effectiveWidth}px`, top: topOffset, height: `calc(100% - ${topOffset}px)` }}
              onMouseEnter={showFloat}
              onMouseLeave={hideFloat}
            >
              <Sidebar />

              {sidebar.resizable && (
                <div
                  onMouseDown={handleMouseDown}
                  className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10"
                />
              )}
            </div>
          </>
        ) : (
          /* ── Normal pinned sidebar (expanded or collapsed-64px) ── */
          <div
            className="relative flex-shrink-0 transition-all duration-200"
            style={{ width: `${effectiveWidth}px` }}
          >
            <Sidebar />

            {/* Resize handle — disabled while collapsed (fixed 64 px width)
                and on touch screens (no mouse to drag it with). */}
            {sidebar.resizable && (
              <div
                onMouseDown={handleMouseDown}
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10"
              />
            )}
          </div>
        )}

        {/* Main content — min-w-0 so a wide page (tables, toolbars) scrolls
            inside itself instead of widening the whole layout; safe-area
            padding keeps content clear of the gesture bar / notch (0 on
            desktop). */}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-safe pb-safe">
          <Outlet />
        </main>

      </div>

      {/* Phone / tablet navigation: the sidebar as an off-canvas drawer,
          opened by the hamburger in the Header. The Drawer closes itself on
          backdrop tap, Escape and Android back. */}
      {sidebar.isDrawer && (
        <Drawer
          open={mobileNavOpen}
          onClose={closeMobileNav}
          side="left"
          ariaLabel={t('nav.menu', 'Menu')}
          bodyClassName="flex flex-col overflow-hidden p-0"
        >
          <Sidebar variant="drawer" onRequestClose={closeMobileNav} />
        </Drawer>
      )}

      {/* Live alert toasts */}
      <LiveAlerts />

      {/* Global Add Agent modal (triggered from sidebar / dashboard) */}
      <GlobalAddAgentModal />
    </div>
  );
}
