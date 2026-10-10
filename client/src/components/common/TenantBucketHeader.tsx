import type { ReactNode } from 'react';
import { Building2, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { cn } from '@/utils/cn';
import { useTenantStore } from '@/store/tenantStore';

export type TenantBucketHeaderVariant = 'sidebar' | 'bar' | 'row';

export interface TenantBucketHeaderProps {
  tenantId: number;
  /** Display name. Default: looked up in the tenants store, then "Tenant {id}". */
  tenantName?: string | null;
  /** Bucket collapsed (chevron points right, caller hides the rows). */
  collapsed: boolean;
  /** Toggle the collapsed state (e.g. useTenantCollapse().toggle(tenantId)). */
  onToggle: () => void;
  /** Number of items in the bucket, shown at the right edge. */
  count?: number;
  /**
   * Custom count text (e.g. t('agents.deviceCount', { count })). Overrides the
   * bare `count` number when set.
   */
  countLabel?: ReactNode;
  /**
   * - 'sidebar' (default): compact header of the sidebar GroupTree buckets.
   * - 'bar': full-width tinted bar for card lists (e.g. agent API keys).
   * - 'row': full-width button for a table row — render it inside
   *   `<tr className="bg-accent/5"><td colSpan={n} className="px-3 py-0">…</td></tr>`.
   */
  variant?: TenantBucketHeaderVariant;
  className?: string;
}

const variants: Record<TenantBucketHeaderVariant, { button: string; label: string; icon: number }> = {
  sidebar: {
    button: 'mt-2 gap-1.5 rounded px-2 py-1 hover:bg-accent/5',
    label: 'text-[10px] tracking-[0.14em]',
    icon: 11,
  },
  bar: {
    button: 'gap-2 bg-accent/5 px-4 py-2 hover:bg-accent/10',
    label: 'text-xs tracking-[0.12em]',
    icon: 14,
  },
  row: {
    button: 'gap-2 rounded py-2 hover:bg-accent/10',
    label: 'text-xs tracking-[0.12em]',
    icon: 14,
  },
};

/**
 * Collapsible god-view tenant bucket header (chevron, building icon, tenant
 * name, translated "(master)" suffix, optional count). Replaces the three
 * copy-pasted headers in components/groups/GroupTree.tsx and
 * pages/AdminAgentPage.tsx (devices table + API keys list).
 *
 *   <TenantBucketHeader
 *     tenantId={tid}
 *     collapsed={isCollapsed(tid)}
 *     onToggle={() => toggle(tid)}
 *     count={devices.length}
 *     variant="row"
 *   />
 */
export function TenantBucketHeader({
  tenantId,
  tenantName,
  collapsed,
  onToggle,
  count,
  countLabel,
  variant = 'sidebar',
  className,
}: TenantBucketHeaderProps) {
  const { t } = useTranslation();
  const storeName = useTenantStore((s) => s.tenants.find((tn) => tn.id === tenantId)?.name);
  const name = tenantName ?? storeName ?? t('ui.tenant.fallback', 'Tenant {{id}}', { id: tenantId });
  const isMaster = tenantId === MASTER_TENANT_ID;
  const v = variants[variant];
  const countNode = countLabel ?? (count != null ? count : null);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={
        collapsed
          ? t('ui.tenantBucket.expand', 'Expand {{name}}', { name })
          : t('ui.tenantBucket.collapse', 'Collapse {{name}}', { name })
      }
      className={cn(
        'flex w-full items-center text-left text-accent transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60',
        v.button,
        className,
      )}
    >
      <ChevronRight
        size={v.icon}
        className={cn('shrink-0 transition-transform duration-150', !collapsed && 'rotate-90')}
      />
      <Building2 size={v.icon} className="shrink-0" />
      <span className={cn('min-w-0 flex-1 truncate font-semibold uppercase', v.label)}>
        {name}
        {isMaster && (
          <span className="ml-1 font-normal normal-case tracking-normal text-text-muted">
            {t('ui.tenant.masterSuffix', '(master)')}
          </span>
        )}
      </span>
      {countNode != null && (
        <span className="shrink-0 text-[10px] font-normal text-text-muted">{countNode}</span>
      )}
    </button>
  );
}
