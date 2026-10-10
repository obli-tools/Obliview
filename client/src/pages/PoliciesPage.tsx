import { useTranslation } from 'react-i18next';
import { Bell, ShieldCheck, CalendarClock } from 'lucide-react';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useTabParam } from '@/hooks/useTabParam';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { NotificationsPage } from './NotificationsPage';
import { AdminRemediationsPage } from './AdminRemediationsPage';
import { AdminMaintenancePage } from './AdminMaintenancePage';

const TABS = ['notifications', 'remediations', 'maintenance'] as const;
type Tab = (typeof TABS)[number];

/** Tenant capability each tab's server routes require (W3-A route gates). */
const TAB_CAPABILITY: Record<Tab, string> = {
  notifications: 'notifications',
  remediations: 'remediation',
  maintenance: 'maintenance',
};

/**
 * Policies hub (Obliance PoliciesPage / SupervisionPage pattern): everything
 * that decides what happens when a monitor or an agent changes state, in one
 * page. Each tab renders the original page with `embedded` (no padding, no
 * h1); the active tab lives in `?tab=` so links like
 * /policies?tab=maintenance (and the legacy /notifications,
 * /manage/remediations, /manage/maintenance redirects) land on it.
 */
export function PoliciesPage() {
  const { t } = useTranslation();
  const hasCapability = useAuthStore((s) => s.hasCapability);
  // Re-render once the tenant list (tenant role fallback) arrives.
  useTenantStore((s) => s.tenants);
  useAuthStore((s) => s.tenantCapabilities);
  const allowed = TABS.filter((id) => hasCapability(TAB_CAPABILITY[id]));
  const [tab, setTab] = useTabParam<Tab>(allowed, allowed[0] ?? 'notifications');

  const allTabs: SegmentedTab<Tab>[] = [
    { id: 'notifications', label: t('policies.tabNotifications', 'Notifications'), icon: <Bell size={16} /> },
    { id: 'remediations', label: t('policies.tabRemediations', 'Remediations'), icon: <ShieldCheck size={16} /> },
    { id: 'maintenance', label: t('policies.tabMaintenance', 'Maintenance'), icon: <CalendarClock size={16} /> },
  ];
  const tabs = allTabs.filter((tb) => allowed.includes(tb.id));

  return (
    <PageContainer className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">{t('policies.title', 'Policies')}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t(
            'policies.description',
            'What happens when a monitor or an agent changes state: notification channels, automated remediations and planned maintenance windows.',
          )}
        </p>
      </div>

      <SegmentedTabs<Tab>
        tabs={tabs}
        value={tab}
        onChange={setTab}
        ariaLabel={t('policies.title', 'Policies')}
        tabClassName="max-sm:px-3"
      />

      {allowed.includes(tab) && tab === 'notifications' && <NotificationsPage embedded />}
      {allowed.includes(tab) && tab === 'remediations' && <AdminRemediationsPage embedded />}
      {allowed.includes(tab) && tab === 'maintenance' && <AdminMaintenancePage embedded />}
    </PageContainer>
  );
}

export default PoliciesPage;
