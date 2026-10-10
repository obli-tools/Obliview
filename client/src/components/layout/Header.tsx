import { Download, LogOut, Menu, MoreHorizontal, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useUiStore, useEffectiveSidebar } from '@/store/uiStore';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher } from './TenantSwitcher';
import { UserAvatar } from '@/components/common/UserAvatar';
import { Logo } from '@/components/common/Logo';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/utils/cn';
import { anonymizeUsername } from '@/utils/anonymize';

/** True when running inside the Obliview native desktop app. */
const isNativeApp = typeof window !== 'undefined' &&
  !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

const CURRENT_APP = 'obliview';

/** Fallback accent dot color when Obligate has no `color` set for an app yet. */
const DEFAULT_ACCENT = '#8B949E';

interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
  icon: string;
  color: string | null;
  /**
   * Marks Obliview's own entry — this call already authenticates to Obligate
   * with Obliview's own API key, so Obligate resolves `self` from that key,
   * no local app-type comparison needed. Kept as a fallback below in case an
   * older Obligate hasn't been upgraded yet (field simply absent then).
   */
  self?: boolean;
  /** Not an Obli* app (filed under "More…" in Obligate): listed in the "More…" dropdown. */
  thirdParty?: boolean;
}

// Refreshed periodically so an app newly registered in Obligate shows up
// without reloading this tab.
const REFRESH_INTERVAL_MS = 5 * 60_000;

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { tenants, currentTenantId } = useTenantStore();
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);
  // Below 1024 px the sidebar is an off-canvas drawer opened from here.
  const { isDrawer } = useEffectiveSidebar();
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const toggleMobileNav = useUiStore((s) => s.toggleMobileNav);

  // Cross-app handoff: forward the current tenant slug to the target app so
  // the user lands on the same workspace if it exists there.
  const currentTenantSlug = tenants.find(t => t.id === currentTenantId)?.slug;

  useEffect(() => {
    const load = () => {
      fetch('/api/auth/connected-apps', { credentials: 'include' })
        .then(r => r.json())
        .then((d: { success: boolean; data?: ConnectedApp[] }) => {
          if (d.success && d.data) setConnectedApps(d.data);
        })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Collapse to dot-only pills as soon as the labelled row would not fit the
  // width flexbox grants the switcher slot — measured against a hidden,
  // always-labelled copy, on every resize and whenever the app list changes.
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const slotRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Pill list comes straight from Obligate (already sorted by sort_order, then
  // name — see admin AppsPage) — no local app registry to keep in sync when a
  // new app joins the suite. `self` (or, for an older Obligate that doesn't
  // send it yet, a type match) picks out Obliview's own entry; if it's
  // missing entirely (Obligate unreachable), synthesize a minimal one so the
  // current app never disappears from its own switcher.
  const hasSelf = connectedApps.some(a => a.self === true || a.appType === CURRENT_APP);
  const pills: ConnectedApp[] = hasSelf
    ? connectedApps
    : [{ appType: CURRENT_APP, name: 'Obliview', baseUrl: '', icon: '', color: '#2bc4bd', self: true }, ...connectedApps];
  const isCurrentApp = (a: ConnectedApp) => a.self === true || a.appType === CURRENT_APP;
  // Obli* apps in the main row, third-party apps (Passly…) in "More…". The
  // current app always stays in the main row, even when it is third-party.
  const mainApps = pills.filter(a => !a.thirdParty || isCurrentApp(a));
  const moreApps = pills.filter(a => a.thirdParty && !isCurrentApp(a));

  const goApp = (app: ConnectedApp) => {
    if (isCurrentApp(app)) return;
    const url = new URL(`${app.baseUrl}/auth/sso-redirect`);
    if (currentTenantSlug) url.searchParams.set('tenant', currentTenantSlug);
    window.location.href = url.toString();
  };

  // "More…" dropdown: outside click and Escape close it.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);

  useEffect(() => {
    const slot = slotRef.current;
    const measure = measureRef.current;
    if (!slot || !measure) return;
    const update = () => setCollapsed(measure.scrollWidth > slot.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(slot);
    return () => ro.disconnect();
  }, [mainApps.length, moreApps.length, isNativeApp]);

  const moreLabel = t('header.moreApps', 'More…');
  const renderMoreButton = (labelled: boolean, interactive: boolean) => (
    <button
      type="button"
      onClick={interactive ? () => setMoreOpen(v => !v) : undefined}
      tabIndex={interactive ? undefined : -1}
      aria-haspopup={interactive ? 'true' : undefined}
      aria-expanded={interactive ? moreOpen : undefined}
      title={moreLabel}
      aria-label={moreLabel}
      className={cn(
        'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary',
        labelled ? 'px-3' : 'px-2',
      )}
    >
      <MoreHorizontal size={14} className="shrink-0" />
      {labelled && <span>{moreLabel}</span>}
      {labelled && <ChevronDown size={12} className={cn('shrink-0 text-text-muted transition-transform', moreOpen && 'rotate-180')} />}
    </button>
  );

  const renderPill = (app: ConnectedApp, labelled: boolean, interactive: boolean) => {
    const isCurrent = isCurrentApp(app);
    const onClick = !interactive || isCurrent ? undefined : () => goApp(app);
    return (
      <button
        key={app.appType}
        type="button"
        onClick={onClick}
        disabled={isCurrent}
        tabIndex={interactive ? undefined : -1}
        title={app.name}
        className={cn(
          'flex shrink-0 items-center gap-2 rounded-md py-1.5 text-[12.5px] font-medium transition-colors',
          labelled ? 'px-3' : 'px-2',
          isCurrent
            ? 'cursor-default bg-bg-secondary font-semibold text-text-primary shadow-[0_1px_3px_rgba(0,0,0,0.15)]'
            : 'cursor-pointer text-text-secondary hover:bg-bg-active hover:text-text-primary',
        )}
      >
        <span
          className="h-2 w-2 rounded-full shrink-0"
          style={{ background: app.color ?? DEFAULT_ACCENT }}
        />
        {labelled && app.name}
      </button>
    );
  };

  return (
    <header
      className={cn(
        'relative flex shrink-0 items-center gap-3.5 bg-bg-secondary',
        // Safe areas: 0 on desktop → the same 52 px / 18 px as before.
        'pt-safe pl-[max(18px,var(--safe-left))] pr-[max(18px,var(--safe-right))]',
        'max-md:gap-2 max-md:pl-[max(0.75rem,var(--safe-left))] max-md:pr-[max(0.75rem,var(--safe-right))]',
      )}
      style={{ height: 'calc(52px + var(--safe-top))' }}
    >
      {/* Hamburger — opens the sidebar drawer below 1024 px. */}
      {isDrawer && (
        <IconButton
          label={t('nav.openMenu', 'Open menu')}
          icon={<Menu className="h-5 w-5" />}
          onClick={toggleMobileNav}
          aria-expanded={mobileNavOpen}
          aria-haspopup="dialog"
          className="-ml-1.5 shrink-0"
        />
      )}

      {/* Logo — the square mark only on phones (< 768 px) */}
      <Link to="/" className="flex items-center shrink-0" aria-label="Obliview">
        <Logo className="h-9 w-auto max-w-[200px] object-contain max-md:hidden" />
        <img src="/favicon.svg" alt="" aria-hidden="true" className="h-8 w-8 md:hidden" />
      </Link>

      {/* Tenant selector */}
      <TenantSwitcher />

      {/* App switcher — container-pill design. Container
          uses bg-bg-hover to match the user pill on the right. Rounded-lg for
          admin/professional look. Adapts to every theme via CSS variables. */}
      {!isNativeApp && (
        <>
          {/* Flexible slot: its width is what flexbox actually grants the
              switcher, compared against the hidden labelled copy below. */}
          {/* No overflow-hidden here: it would clip the "More…" dropdown. */}
          <div ref={slotRef} className="ml-1.5 flex min-w-0 flex-1 items-center">
            <div className="flex items-center gap-1 whitespace-nowrap rounded-lg bg-bg-hover p-1">
              {mainApps.map(app => renderPill(app, !collapsed, true))}
              {moreApps.length > 0 && (
                <div ref={moreRef} className="relative">
                  {renderMoreButton(!collapsed, true)}
                  {moreOpen && (
                    <div className="absolute left-0 top-9 z-50 w-56 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl bg-bg-secondary shadow-2xl">
                      <div className="px-3 py-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t('header.moreAppsTitle', 'Other apps')}</p>
                      </div>
                      <div className="max-h-64 overflow-y-auto overscroll-contain py-1">
                        {moreApps.map(app => (
                          <button
                            key={app.appType + app.baseUrl}
                            type="button"
                            onClick={() => { setMoreOpen(false); goApp(app); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text-primary transition-colors hover:bg-bg-hover"
                          >
                            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: app.color ?? DEFAULT_ACCENT }} />
                            <span className="truncate">{app.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Hidden measurer: always labelled, never visible nor interactive. */}
          <div
            ref={measureRef}
            aria-hidden
            className="pointer-events-none absolute -z-10 flex items-center gap-1 whitespace-nowrap p-1 opacity-0"
            style={{ top: -9999, left: -9999 }}
          >
            {mainApps.map(app => renderPill(app, true, false))}
            {moreApps.length > 0 && renderMoreButton(true, false)}
          </div>
        </>
      )}

      {/* Right cluster */}
      <div className="ml-auto flex shrink-0 items-center gap-3.5 max-md:gap-1.5">
        {/* Download app link — hidden in native desktop; icon only below 1024 px */}
        {!isNativeApp && (
          <Link
            to="/download"
            aria-label={t('nav.downloadApp')}
            title={isDrawer ? t('nav.downloadApp') : undefined}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary max-lg:px-2"
          >
            <Download size={14} />
            <span className="max-lg:hidden">{t('nav.downloadApp')}</span>
          </Link>
        )}

        {/* Notification bell */}
        <NotificationCenter />

        {/* User badge + logout */}
        {user && (
          <>
            <div className="flex items-center gap-[9px] rounded-lg bg-bg-hover py-[5px] pl-[5px] pr-3 text-[12.5px] max-md:pr-[5px]">
              <UserAvatar avatar={user.avatar} username={user.username} size={28} />
              <span className="font-medium text-text-primary max-md:hidden">
                {anonymizeUsername(
                  user.displayName?.trim() ||
                  (user.username.startsWith('og_') ? user.username.slice(3) : user.username),
                )}
              </span>
              <span className="border-l border-border-light pl-2 font-mono text-[10px] uppercase tracking-wider text-accent max-md:hidden">
                {user.role}
              </span>
            </div>
            {/* Phones: sign out lives in the drawer footer (saves header width). */}
            <button
              onClick={logout}
              title={t('nav.signOut')}
              aria-label={t('nav.signOut')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary max-md:hidden"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}
