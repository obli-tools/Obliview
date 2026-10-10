import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentUpdatePolicyContext, MonitorGroup } from '@obliview/shared';
import { agentUpdatePolicyApi } from '@/api/agentUpdatePolicy.api';
import { UpdatePolicyField } from '@/components/agent/UpdatePolicyField';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/utils/cn';

/**
 * Agent update policy of a group (/group/:id/edit, agents.manage): its own
 * value, inherited by its sub-groups, over the workspace and global levels.
 * Only the ancestors of the group's own workspace count.
 */
export function GroupUpdatePolicySection({ group, onGroupUpdate, className }: {
  group: MonitorGroup;
  /** Receives the updated group after a save. */
  onGroupUpdate?: (g: MonitorGroup) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<AgentUpdatePolicyContext | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    agentUpdatePolicyApi.getGroup(group.id)
      .then((c) => { if (!cancelled) setCtx(c); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [group.id]);

  return (
    <div className={cn('rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4', className)}>
      <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-1">
        {t('agentUpdatePolicy.title', 'Agent updates')}
      </h2>
      <p className="text-xs text-text-muted mb-4">
        {t('agentUpdatePolicy.groupDesc', 'Update policy of the agents of this group and of its sub-groups. Each agent can override it, except when a level above freezes updates.')}
      </p>
      {ctx ? (
        <UpdatePolicyField
          level="group"
          selfGroupId={group.id}
          label={t('agentUpdatePolicy.policyLabel', 'Update policy')}
          ownPolicy={ctx.ownPolicy}
          inherited={ctx.inherited}
          effective={ctx.effective}
          canEdit
          onChange={async (updatePolicy) => {
            const res = await agentUpdatePolicyApi.setGroup(group.id, updatePolicy);
            setCtx(res.policy);
            onGroupUpdate?.(res.group);
          }}
        />
      ) : failed ? (
        <p className="text-xs text-text-muted">{t('agentUpdatePolicy.loadFailed', 'Could not load the update policy')}</p>
      ) : (
        <div className="flex justify-center py-2"><LoadingSpinner size="sm" /></div>
      )}
    </div>
  );
}
