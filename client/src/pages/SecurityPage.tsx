import { FileText, Shield } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuditLogPage } from './AuditLogPage';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { useTabParam } from '@/hooks/useTabParam';

const TABS = ['audit'] as const;
type Tab = typeof TABS[number];

/**
 * Security hub (/manage/security, Obliance layout). One tab today — the
 * audit log — selected by `?tab=audit` so deep links stay stable when more
 * tabs (approvals, sessions…) are added.
 */
export function SecurityPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useTabParam<Tab>(TABS, 'audit');

  return (
    <PageContainer>
      <div className="flex items-center gap-3 mb-4">
        <Shield className="w-6 h-6 text-accent" />
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{t('security.title', 'Security')}</h1>
          <p className="text-sm text-text-muted">{t('security.description', 'Audit trail of the actions taken in this workspace.')}</p>
        </div>
      </div>

      <SegmentedTabs<Tab>
        className="mb-4 inline-flex max-w-full"
        fill={false}
        value={tab}
        onChange={setTab}
        ariaLabel={t('security.title', 'Security')}
        tabs={[
          { id: 'audit', label: t('security.tabAudit', 'Audit log'), icon: <FileText className="w-4 h-4" /> },
        ]}
      />

      {tab === 'audit' && <AuditLogPage embedded />}
    </PageContainer>
  );
}

export default SecurityPage;
