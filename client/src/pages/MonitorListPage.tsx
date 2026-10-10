import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { useAuthStore } from '@/store/authStore';
import { PageContainer } from '@/components/common/PageContainer';
import { Button } from '@/components/common/Button';
import { MonitorTable } from '@/components/monitors/MonitorTable';

/**
 * /monitors — every monitor the caller can see (agents live in /agents),
 * filterable by status / type / tenant / group through the URL
 * (?groupId=&status=&type=&tenants=), as linked from the dashboard counts.
 */
export default function MonitorListPage() {
  const { t } = useTranslation();
  const { canCreate: canCreateFn } = useAuthStore();
  const canCreate = canCreateFn();

  return (
    <PageContainer className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-text-primary">{t('monitorList.title', 'Monitors')}</h1>
        {canCreate && (
          <Link to="/monitor/new">
            <Button variant="secondary" size="sm">
              <Plus size={16} className="mr-1.5" />
              {t('dashboard.addMonitor')}
            </Button>
          </Link>
        )}
      </div>
      <MonitorTable />
    </PageContainer>
  );
}

export { MonitorListPage };
