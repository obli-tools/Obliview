import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Bell, X, Trash2, CheckCheck } from 'lucide-react';
import { useLiveAlertsStore, countUnread } from '@/store/liveAlertsStore';
import type { LiveAlert, AlertSeverity } from '@/store/liveAlertsStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsGodView } from '@/hooks/useIsGodView';
import { cn } from '@/utils/cn';
import { resolveAlertTarget } from '@/utils/alertTarget';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';

const SEVERITY_STYLES: Record<AlertSeverity, { bar: string; dot: string; title: string }> = {
  critical: { bar: 'border-l-red-500',   dot: 'bg-red-500',   title: 'text-red-400'   },
  warning:  { bar: 'border-l-amber-500', dot: 'bg-amber-500', title: 'text-amber-400' },
  info:     { bar: 'border-l-blue-500',  dot: 'bg-blue-500',  title: 'text-blue-400'  },
};

/** Resolved incidents: neutral colours, whatever their severity was. */
const RESOLVED_STYLES = { bar: 'border-l-text-muted', dot: 'bg-text-muted', title: 'text-text-muted' };

type TFn = ReturnType<typeof useTranslation>['t'];

function timeAgo(iso: string, t: TFn): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60) return t('notificationCenter.agoSeconds', { count: diff }) || `${diff}s ago`;
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return t('notificationCenter.agoMinutes', { count: m }) || `${m}m ago`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return t('notificationCenter.agoHours', { count: h }) || `${h}h ago`;
  }
  const d = Math.floor(diff / 86400);
  return t('notificationCenter.agoDays', { count: d }) || `${d}d ago`;
}

// ─── Single alert row ─────────────────────────────────────────────────────────

interface AlertRowProps {
  alert: LiveAlert;
  showTenantBadge: boolean;
  onRead: (alert: LiveAlert) => void;
  onRemove: (id: number) => void;
}

function AlertRow({ alert, showTenantBadge, onRead, onRemove }: AlertRowProps) {
  const { t } = useTranslation();
  const styles = alert.resolved
    ? RESOLVED_STYLES
    : (SEVERITY_STYLES[alert.severity] ?? SEVERITY_STYLES.info);
  return (
    <div
      className={cn(
        'relative flex items-start gap-3 px-4 py-3 border-l-4 transition-colors',
        styles.bar,
        alert.read || alert.resolved ? 'opacity-40' : 'opacity-100',
        alert.navigateTo && 'cursor-pointer hover:bg-bg-hover',
      )}
      onClick={() => onRead(alert)}
    >
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className={cn('text-sm font-semibold truncate', styles.title)}>
            {alert.title}
          </p>
          {!alert.read && !alert.resolved && (
            <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-accent" />
          )}
          {alert.resolved && (
            <span
              className="shrink-0 text-[10px] bg-text-muted/20 text-text-muted px-1.5 py-0.5 rounded-full font-medium"
              title={alert.resolvedAt ? new Date(alert.resolvedAt).toLocaleString() : undefined}
            >
              {t('liveAlerts.resolved', 'Resolved')}
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5 truncate">{alert.message}</p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <p className="text-xs text-text-muted/60">{timeAgo(alert.createdAt, t)}</p>
          {/* Tenant badge: shown in Global tab for alerts from other tenants */}
          {showTenantBadge && alert.tenantName && (
            <span className="text-[10px] bg-accent/20 text-accent px-1.5 py-0.5 rounded-full font-medium">
              {alert.tenantName}
            </span>
          )}
        </div>
      </div>
      <button
        className="shrink-0 text-text-muted hover:text-text-primary transition-colors mt-0.5"
        onClick={(e) => { e.stopPropagation(); onRemove(alert.id); }}
        title={t('notificationCenter.dismiss', 'Dismiss')}
        aria-label={t('notificationCenter.dismiss', 'Dismiss')}
      >
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Pop-up toggle row ────────────────────────────────────────────────────────

interface PopupToggleProps {
  enabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
}

function PopupToggle({ enabled, onChange, label }: PopupToggleProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-muted">{label}</span>
      <ToggleSwitch checked={enabled} onChange={onChange} size="sm" ariaLabel={label} />
    </div>
  );
}

// ─── Main NotificationCenter ──────────────────────────────────────────────────

type Tab = 'local' | 'global';

export function NotificationCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('local');

  const {
    alerts,
    localEnabled, multiTenantEnabled,
    setLocalEnabled, setMultiTenantEnabled,
    clearAll, markAllRead, markAlertRead, removeAlert,
  } = useLiveAlertsStore();

  const { currentTenantId, tenants, setCurrentTenant } = useTenantStore();
  const navigate = useNavigate();
  const isGodView = useIsGodView();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Multi-tenant mode is shown only when the user can access more than one tenant
  const isMultiTenant = tenants.length > 1;

  // Partition alerts by tenant
  const localAlerts  = alerts.filter((a) => a.tenantId === currentTenantId);
  const globalAlerts = alerts; // all tenants (including local)

  const tabAlerts = tab === 'global' ? globalAlerts : localAlerts;
  const totalUnread = countUnread(alerts);
  const localUnread  = countUnread(localAlerts);

  // If multi-tenant becomes unavailable, fall back to local tab
  useEffect(() => {
    if (!isMultiTenant && tab === 'global') setTab('local');
  }, [isMultiTenant, tab]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  /**
   * Handle a notification click:
   * - Mark as read (fire-and-forget: a failure rolls the store back but must
   *   never block the navigation below)
   * - If the alert belongs to another tenant (outside the God View, which
   *   sees every tenant), switch to it; setCurrentTenant then loads
   *   alert.navigateTo (or '/') in that tenant with a full page load
   * - Otherwise navigate client-side to alert.navigateTo if set
   */
  const handleAlertClick = (alert: LiveAlert) => {
    markAlertRead(alert.id).catch(() => {});

    if (!isGodView && alert.tenantId && alert.tenantId !== currentTenantId) {
      setOpen(false);
      void setCurrentTenant(alert.tenantId, alert.navigateTo || '/');
      return;
    }

    // Same-tenant: normal client-side navigation
    if (alert.navigateTo) {
      setOpen(false);
      navigate(resolveAlertTarget(alert.navigateTo));
    }
  };

  const handleMarkAllRead = () => {
    markAllRead().catch(() => toast.error(t('liveAlerts.actionFailed', 'Could not update notifications')));
  };

  const handleClearAll = () => {
    clearAll().catch(() => toast.error(t('liveAlerts.actionFailed', 'Could not update notifications')));
  };

  const handleRemove = (id: number) => {
    removeAlert(id).catch(() => toast.error(t('liveAlerts.actionFailed', 'Could not update notifications')));
  };

  const isAnyEnabled = localEnabled || multiTenantEnabled;

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={t('notificationCenter.title', 'Notification Center')}
        aria-label={totalUnread > 0
          ? `${t('notificationCenter.title', 'Notification Center')} (${totalUnread})`
          : t('notificationCenter.title', 'Notification Center')}
        aria-expanded={open}
        className="relative flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <Bell
          size={14}
          className={isAnyEnabled ? 'text-accent' : 'text-text-muted'}
        />
        {totalUnread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-8 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">{t('notifications.title', 'Notifications')}</h3>
              <div className="flex items-center gap-2">
                {/* read-all and clear-all act on the current tenant only (server
                    endpoints are tenant-scoped), hence localAlerts here. */}
                {localAlerts.some((a) => !a.read && !a.resolved) && (
                  <button
                    onClick={handleMarkAllRead}
                    title={t('notificationCenter.markAllRead', 'Mark all as read')}
                    aria-label={t('notificationCenter.markAllRead', 'Mark all as read')}
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <CheckCheck size={14} />
                  </button>
                )}
                {localAlerts.length > 0 && (
                  <button
                    onClick={handleClearAll}
                    title={t('notificationCenter.clearLocal', 'Clear local notifications')}
                    aria-label={t('notificationCenter.clearLocal', 'Clear local notifications')}
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  title={t('common.close', 'Close')}
                  aria-label={t('common.close', 'Close')}
                  className="text-text-muted hover:text-text-primary transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Tab bar — visible only in multi-tenant mode */}
            {isMultiTenant && (
              <div className="flex gap-1">
                {(['local', 'global'] as const).map((tb) => {
                  const badgeCount = tb === 'local' ? localUnread : totalUnread;
                  return (
                    <button
                      key={tb}
                      onClick={() => setTab(tb)}
                      aria-pressed={tab === tb}
                      className={cn(
                        'flex-1 text-xs py-1 rounded-md transition-colors',
                        tab === tb
                          ? 'bg-accent text-white font-medium'
                          : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                      )}
                    >
                      {tb === 'local'
                        ? t('notificationCenter.local', 'Local')
                        : t('notificationCenter.allTenants', 'All Tenants')}
                      {badgeCount > 0 && (
                        <span className="ml-1 opacity-80">({badgeCount})</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Per-tab pop-up toggle */}
            {tab === 'local' && (
              <PopupToggle
                enabled={localEnabled}
                onChange={setLocalEnabled}
                label={localEnabled
                  ? t('notificationCenter.localPopupsOn', 'Local pop-ups on')
                  : t('notificationCenter.localPopupsOff', 'Local pop-ups off')}
              />
            )}
            {tab === 'global' && isMultiTenant && (
              <PopupToggle
                enabled={multiTenantEnabled}
                onChange={setMultiTenantEnabled}
                label={multiTenantEnabled
                  ? t('notificationCenter.allTenantPopupsOn', 'All-tenant pop-ups on')
                  : t('notificationCenter.allTenantPopupsOff', 'All-tenant pop-ups off')}
              />
            )}
          </div>

          {/* Notifications list */}
          <div className="max-h-96 overflow-y-auto divide-y divide-border/50">
            {tabAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-text-muted gap-2">
                <Bell size={24} className="opacity-30" />
                <p className="text-sm">{t('notificationCenter.empty', 'No notifications')}</p>
              </div>
            ) : (
              tabAlerts.map((alert) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  // Show tenant badge in the Global tab for cross-tenant alerts
                  showTenantBadge={tab === 'global' && alert.tenantId !== currentTenantId}
                  onRead={handleAlertClick}
                  onRemove={handleRemove}
                />
              ))
            )}
          </div>

          {/* Footer */}
          {tabAlerts.length > 0 && (
            <div className="border-t border-border px-4 py-2">
              <p className="text-xs text-text-muted/60 text-center">
                {t('notificationCenter.count', { count: tabAlerts.length })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
