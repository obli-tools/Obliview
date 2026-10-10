import { Building2 } from 'lucide-react';
import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { useTenantStore } from '@/store/tenantStore';
import { useIsGodView } from '@/hooks/useIsGodView';

interface Props {
  tenantId: number | null | undefined;
  /** Optional explicit name override — useful when the API row already
   * carries `tenantName` and we want to avoid the store lookup. */
  tenantName?: string | null;
  /** Compact rendering for dense tables (smaller padding, single line). */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Inline tenant chip rendered next to entity names in the god view.
 * Returns `null` when:
 * - the caller isn't in the god view (platform admin on the master tenant):
 *   anywhere else the lists are scoped to one tenant, so the chip would be
 *   redundant. (Obliance gates on the master tenant alone; Obliview keeps its
 *   admin-role check because only admins get the cross-tenant fan-out.)
 * - tenantId is missing
 *
 * Looks up the display name from the already-loaded tenants store so we
 * don't have to thread `tenantName` through every API. Falls back to
 * `Tenant {id}` when the store hasn't loaded yet.
 *
 * The Default tenant gets the accent variant to make the master stand out
 * from child tenants in lists scanned at speed.
 */
export function TenantBadge({ tenantId, tenantName, size = 'sm', className }: Props) {
  const { t } = useTranslation();
  const isGodView = useIsGodView();
  const tenants = useTenantStore((s) => s.tenants);
  if (!isGodView) return null;
  if (tenantId == null) return null;

  // The badge text IS the tenant name, so the hover title adds nothing a
  // touch user misses (no tap popover needed).
  const name =
    tenantName ??
    tenants.find((tn) => tn.id === tenantId)?.name ??
    t('ui.tenant.fallback', 'Tenant {{id}}', { id: tenantId });
  const isDefault = tenantId === MASTER_TENANT_ID;

  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        isDefault
          ? 'bg-accent/10 text-accent border-accent/30'
          : 'bg-bg-tertiary text-text-secondary border-transparent',
        className,
      )}
      title={t('ui.tenant.badgeTitle', 'Tenant: {{name}}', { name })}
    >
      <Building2 className={size === 'sm' ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {name}
    </span>
  );
}
