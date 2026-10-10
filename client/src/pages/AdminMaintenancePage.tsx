import { useState } from 'react';
import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MaintenanceWindowList } from '@/components/maintenance/MaintenanceWindowList';
import { PageContainer } from '@/components/common/PageContainer';

/**
 * Every maintenance window of the workspace (all of them in the god view).
 * The list and its modal load their own data (scopes, notification channels).
 */
export function AdminMaintenancePage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const [showRules, setShowRules] = useState(false);

  return (
    <PageContainer embedded={embedded} className="space-y-6">
      {/* Header — the h1 is dropped when embedded (PoliciesPage renders its own) */}
      <div>
        {!embedded && (
          <h1 className="text-2xl font-semibold text-text-primary">{t('maintenance.title')}</h1>
        )}
        <p className={embedded ? 'text-sm text-text-muted' : 'mt-1 text-sm text-text-muted'}>
          {t('maintenance.description')}
        </p>
      </div>

      {/* How it works (collapsible) */}
      <div className="rounded-lg border border-border bg-bg-secondary">
        <button
          type="button"
          onClick={() => setShowRules((v) => !v)}
          aria-expanded={showRules}
          className="flex w-full items-center justify-between gap-2 rounded-lg px-4 py-3 text-left hover:bg-bg-hover transition-colors"
        >
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
            <Info size={13} />
            {t('maintenance.howItWorks')}
          </span>
          {showRules ? <ChevronUp size={14} className="text-text-muted" /> : <ChevronDown size={14} className="text-text-muted" />}
        </button>
        {showRules && (
          <ul className="space-y-1 border-t border-border px-4 pb-4 pt-3 text-sm text-text-secondary">
            <li>• {t('maintenance.rule1')}</li>
            <li>• {t('maintenance.rule2')}</li>
            <li>• {t('maintenance.rule3')}</li>
            <li>• {t('maintenance.rule4')}</li>
            <li>• {t('maintenance.rule5')}</li>
            <li>• {t('maintenance.rule6')}</li>
            <li>• {t('maintenance.rule7')}</li>
            <li>• {t('maintenance.rule8')}</li>
          </ul>
        )}
      </div>

      {/* All windows */}
      <div className="rounded-lg border border-border bg-bg-secondary p-3 sm:p-5">
        <MaintenanceWindowList title={t('maintenance.allWindows')} />
      </div>
    </PageContainer>
  );
}
