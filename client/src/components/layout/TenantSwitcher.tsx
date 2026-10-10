import { useRef, useState, useEffect } from 'react';
import { ChevronDown, Building2, Check } from 'lucide-react'; // Building2 used in dropdown rows
import { useTranslation } from 'react-i18next';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';

export function TenantSwitcher() {
  const { t } = useTranslation();
  const { currentTenantId, tenants, setCurrentTenant } = useTenantStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click — must be BEFORE the early return to satisfy Rules of Hooks
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

  // In the native desktop app the injected tab bar replaces this dropdown
  const isNativeApp = !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;
  if (isNativeApp && tenants.length > 1) return null;

  // Only show when there are multiple tenants
  if (tenants.length <= 1) return null;

  const currentTenant = tenants.find((t) => t.id === currentTenantId) ?? tenants[0];

  const handleSwitch = async (tenantId: number) => {
    if (tenantId === currentTenantId || switching) return;
    setSwitching(true);
    setOpen(false);

    try {
      // On success this navigates to the new tenant's dashboard with a full
      // page load (stores and socket start fresh), so nothing runs after it.
      await setCurrentTenant(tenantId, '/');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className={cn(
          'flex items-center gap-2 rounded-[7px] px-3 py-1.5 text-sm transition-colors',
          'bg-[rgba(255,255,255,0.04)] hover:bg-[rgba(255,255,255,0.06)]',
          switching && 'opacity-60 cursor-wait',
        )}
      >
        {/* The workspace icon (same as the sidebar's Workspace entry) stands
            for the "Tenant" caption; the sr-only span keeps the word. */}
        <Building2 size={14} className="shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="sr-only">{t('tenant.label', 'Tenant')}</span>
        <span className="max-w-[140px] truncate font-medium tracking-[0.04em] text-text-primary">
          {anonymize(currentTenant?.name) || '…'}
        </span>
        <ChevronDown size={12} className={cn('text-text-secondary transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 top-9 z-50 w-52 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('tenant.switchWorkspace')}
            </p>
          </div>
          <div className="py-1 max-h-64 overflow-y-auto">
            {tenants.map((tenant) => (
              <button
                key={tenant.id}
                onClick={() => handleSwitch(tenant.id)}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors hover:bg-bg-hover',
                  tenant.id === currentTenantId
                    ? 'text-accent font-semibold'
                    : 'text-text-primary',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 size={13} className="shrink-0 text-text-muted" />
                  <span className="truncate">{anonymize(tenant.name)}</span>
                  {tenant.role === 'admin' && (
                    <span className="shrink-0 text-[10px] text-text-muted bg-bg-tertiary rounded px-1 py-0.5">
                      {t('tenant.roleAdmin')}
                    </span>
                  )}
                </div>
                {tenant.id === currentTenantId && (
                  <Check size={13} className="shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
