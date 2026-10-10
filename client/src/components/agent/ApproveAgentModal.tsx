import { useEffect, useState } from 'react';
import { CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, MonitorGroup } from '@obliview/shared';
import type { AgentApiKeyWithDefault } from '@/api/agent.api';
import { anonymize } from '@/utils/anonymize';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';

/**
 * Groups a device may be assigned to: only those of its own tenant. In God
 * View groupsApi.tree() spans every tenant, and a device placed in another
 * tenant's group would inherit that tenant's bindings, thresholds and windows.
 */
export function groupsForTenant(groups: MonitorGroup[], tenantId: number): MonitorGroup[] {
  return groups.filter(g => g.tenantId === tenantId);
}

/**
 * The default group of the API key a device enrolled with, when that group
 * is a valid target for the device (same tenant). null otherwise.
 */
export function keyDefaultGroup(
  device: Pick<AgentDevice, 'apiKeyId' | 'tenantId'>,
  keys: AgentApiKeyWithDefault[] | undefined,
  tenantGroups: MonitorGroup[],
): { groupId: number; keyName: string } | null {
  if (!keys || device.apiKeyId == null) return null;
  const key = keys.find(k => k.id === device.apiKeyId);
  if (!key || key.defaultGroupId == null) return null;
  if (!tenantGroups.some(g => g.id === key.defaultGroupId)) return null;
  return { groupId: key.defaultGroupId, keyName: key.name };
}

/** Shared look of the group / status selects in the agent modals. */
export const AGENT_SELECT_CLS =
  'w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary coarse:min-h-10 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60 disabled:cursor-not-allowed';

interface ApproveAgentModalProps {
  device: AgentDevice;
  /** Flat list of every group visible to the caller (filtered to the device tenant here). */
  groups: MonitorGroup[];
  /** API keys (with their default group): the device key's default group is preselected. */
  keys?: AgentApiKeyWithDefault[];
  /** Resolve when the approval is done (the modal shows a spinner meanwhile). */
  onApprove: (groupId: number | null) => void | Promise<void>;
  onCancel: () => void;
}

/** Approve a pending agent and optionally place it in a group of its own tenant. */
export function ApproveAgentModal({ device, groups, keys, onApprove, onCancel }: ApproveAgentModalProps) {
  const { t } = useTranslation();
  // Hybrid groups: every group of the device's own tenant is a valid target.
  const tenantGroups = groupsForTenant(groups, device.tenantId);
  const keyDefault = keyDefaultGroup(device, keys, tenantGroups);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(keyDefault?.groupId ?? null);
  // Keys / groups may arrive after the modal opened: preselect once, unless
  // the operator already picked something.
  const [touched, setTouched] = useState(false);
  const keyDefaultId = keyDefault?.groupId ?? null;
  useEffect(() => {
    if (!touched && keyDefaultId != null) setSelectedGroupId(keyDefaultId);
  }, [keyDefaultId, touched]);
  const [saving, setSaving] = useState(false);
  const selectedGroup = tenantGroups.find(g => g.id === selectedGroupId);
  const hasGroupThresholds = selectedGroup?.agentThresholds != null;

  const handleApprove = async () => {
    setSaving(true);
    try {
      await onApprove(selectedGroupId);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onCancel}
      dismissible={!saving}
      size="sm"
      phoneLayout="sheet"
      title={t('agents.approveTitle')}
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={handleApprove} loading={saving}>
            <CheckCircle size={14} className="mr-1.5" />{t('agents.approve')}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-muted mb-4">
        {t('agents.approveDesc', { hostname: anonymize(device.hostname) })}
      </p>

      <div className="space-y-1">
        <label htmlFor="approve-agent-group" className="block text-sm font-medium text-text-secondary">
          {t('agents.assignGroup', 'Assign to group')}
        </label>
        <select
          id="approve-agent-group"
          value={selectedGroupId ?? ''}
          onChange={e => { setTouched(true); setSelectedGroupId(e.target.value ? Number(e.target.value) : null); }}
          className={AGENT_SELECT_CLS}
        >
          <option value="">{t('agents.noGroup')}</option>
          {tenantGroups.map(g => (
            <option key={g.id} value={g.id}>
              {g.id === keyDefault?.groupId
                ? t('agents.keyDefaultOption', '{{name}} (key default)', { name: g.name })
                : g.name}
            </option>
          ))}
        </select>
        {keyDefault && (
          <p className="text-xs text-text-muted mt-1">
            {t('agents.keyDefaultHint', 'Default group of the API key "{{key}}".', { key: keyDefault.keyName })}
          </p>
        )}
        {tenantGroups.length === 0 && (
          <p className="text-xs text-text-muted mt-1">{t('agents.noGroups', 'No groups yet')}</p>
        )}
        {hasGroupThresholds && (
          <p className="text-xs text-status-up mt-1">{t('agents.groupThresholdsNote')}</p>
        )}
      </div>
    </Modal>
  );
}

export default ApproveAgentModal;
