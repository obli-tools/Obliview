import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, MonitorGroup } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { Checkbox } from '@/components/common/Checkbox';
import { useConfirm } from '@/components/common/ConfirmDialog';
import type { AgentApiKeyWithDefault } from '@/api/agent.api';
import { AGENT_SELECT_CLS, groupsForTenant, keyDefaultGroup } from './ApproveAgentModal';

/** 'keep' = no change; null = remove from group; number = assign to group */
type GroupSelection = 'keep' | null | number;
type StatusAction = 'no-change' | 'approved' | 'suspended';

export interface BulkEditAgentData {
  groupId?: number | null;
  heartbeatMonitoring?: boolean;
  overrideGroupSettings?: boolean;
  status?: 'approved' | 'suspended';
}

interface BulkEditAgentModalProps {
  /** The selected devices (at least one). */
  devices: AgentDevice[];
  /** Flat list of every group visible to the caller. */
  groups: MonitorGroup[];
  /**
   * API keys (with their default group). When every selected device is
   * ungrouped and their keys share one default group, that group is
   * preselected; it is flagged in the list in any case.
   */
  keys?: AgentApiKeyWithDefault[];
  /** Resolve when the save is done (the modal shows a spinner meanwhile). Only changed fields are sent. */
  onSave: (data: BulkEditAgentData) => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Tri-state checkbox: true / false / null (indeterminate = mixed values across selection).
 * Any click resolves the indeterminate state to true or false.
 */
function TriStateCheckbox({
  value,
  onChange,
  label,
  description,
}: {
  value: boolean | null;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = value === null;
    }
  }, [value]);

  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <Checkbox
        ref={ref}
        checked={value === true}
        onCheckedChange={onChange}
        wrapperClassName="mt-0.5"
      />
      <div>
        <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">{label}</p>
        {description && <p className="text-xs text-text-muted leading-relaxed">{description}</p>}
      </div>
    </label>
  );
}

/** Edit several agents at once: group, monitoring flags and approval / suspension. */
export function BulkEditAgentModal({ devices, groups, keys, onSave, onCancel }: BulkEditAgentModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();

  // A group belongs to exactly one tenant, so 'move to group' only makes sense
  // when every selected device lives in the same tenant (God View can mix them).
  const selectionTenantIds = Array.from(new Set(devices.map(d => d.tenantId)));
  const mixedTenants = selectionTenantIds.length > 1;
  const tenantGroups = mixedTenants || selectionTenantIds.length === 0
    ? []
    : groupsForTenant(groups, selectionTenantIds[0]);

  // Bulk approve only acts on pending (approve) and suspended (reinstate)
  // devices; already approved or refused ones are left untouched.
  const pendingCount = devices.filter(d => d.status === 'pending').length;
  const suspendedCount = devices.filter(d => d.status === 'suspended').length;
  const untouchedCount = devices.length - pendingCount - suspendedCount;

  // Compute initial tri-state values: single value if all same, null if mixed
  const allSameHeartbeat = devices.every(d => d.heartbeatMonitoring === devices[0]?.heartbeatMonitoring);
  const allSameOverride = devices.every(d => d.overrideGroupSettings === devices[0]?.overrideGroupSettings);

  // Key default groups of the selection (same tenant only).
  const keyDefaults = mixedTenants
    ? []
    : devices.map(d => keyDefaultGroup(d, keys, tenantGroups));
  const keyDefaultIds = new Set(keyDefaults.filter(Boolean).map(k => k!.groupId));
  const commonKeyDefault = keyDefaults.length > 0 && keyDefaults.every(k => k && k.groupId === keyDefaults[0]?.groupId)
    ? keyDefaults[0]
    : null;
  const allUngrouped = devices.every(d => d.groupId == null);
  const suggestedGroupId = commonKeyDefault && allUngrouped ? commonKeyDefault.groupId : null;

  const [groupSelection, setGroupSelection] = useState<GroupSelection>(suggestedGroupId ?? 'keep');
  const [groupTouched, setGroupTouched] = useState(false);
  useEffect(() => {
    if (!groupTouched && suggestedGroupId != null) setGroupSelection(suggestedGroupId);
  }, [suggestedGroupId, groupTouched]);
  const [heartbeatMonitoring, setHeartbeatMonitoring] = useState<boolean | null>(
    allSameHeartbeat && devices.length > 0 ? devices[0].heartbeatMonitoring : null,
  );
  const [overrideGroupSettings, setOverrideGroupSettings] = useState<boolean | null>(
    allSameOverride && devices.length > 0 ? devices[0].overrideGroupSettings : null,
  );
  const [statusAction, setStatusAction] = useState<StatusAction>('no-change');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const data: BulkEditAgentData = {};

    if (groupSelection !== 'keep' && !mixedTenants) data.groupId = groupSelection;
    if (heartbeatMonitoring !== null) data.heartbeatMonitoring = heartbeatMonitoring;
    if (overrideGroupSettings !== null) data.overrideGroupSettings = overrideGroupSettings;
    if (statusAction === 'approved') {
      if (pendingCount + suspendedCount > 0) {
        const ok = await confirm({
          title: t('agents.approveAll'),
          message: t('agents.confirmBulkApprove', {
            defaultValue: 'Approve {{pending}} pending agent(s) and reinstate {{suspended}} suspended agent(s)? The {{untouched}} other selected agent(s), already approved or refused, are left untouched.',
            pending: pendingCount,
            suspended: suspendedCount,
            untouched: untouchedCount,
          }),
          confirmLabel: t('agents.approve'),
        });
        if (!ok) return;
        data.status = 'approved';
      }
      // Nothing pending or suspended in the selection: approving is a no-op.
    } else if (statusAction !== 'no-change') {
      data.status = statusAction;
    }

    setSaving(true);
    try {
      await onSave(data);
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
      title={t('agents.bulkEditTitle', { count: devices.length })}
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} loading={saving}>{t('common.apply')}</Button>
        </>
      }
    >
      <p className="text-xs text-text-muted mb-5">
        {t('agents.bulkEditDesc')}
      </p>

      <div className="space-y-4">
        {/* Group */}
        <div>
          <label htmlFor="bulk-agent-group" className="block text-sm font-medium text-text-secondary mb-1">
            {t('common.group', 'Group')}
          </label>
          <select
            id="bulk-agent-group"
            value={
              groupSelection === 'keep' ? '__keep__'
              : groupSelection === null ? ''
              : String(groupSelection)
            }
            onChange={e => {
              setGroupTouched(true);
              const v = e.target.value;
              if (v === '__keep__') setGroupSelection('keep');
              else if (v === '') setGroupSelection(null);
              else setGroupSelection(Number(v));
            }}
            disabled={mixedTenants}
            className={AGENT_SELECT_CLS}
          >
            <option value="__keep__">{t('agents.keepCurrent')}</option>
            <option value="">{t('agents.noGroup')}</option>
            {tenantGroups.map(g => (
              <option key={g.id} value={g.id}>
                {keyDefaultIds.has(g.id)
                  ? t('agents.keyDefaultOption', '{{name}} (key default)', { name: g.name })
                  : g.name}
              </option>
            ))}
          </select>
          {suggestedGroupId != null && groupSelection === suggestedGroupId && commonKeyDefault && (
            <p className="text-xs text-text-muted mt-1">
              {t('agents.keyDefaultPreselected', 'Preselected: default group of the API key "{{key}}".', { key: commonKeyDefault.keyName })}
            </p>
          )}
          {mixedTenants ? (
            <p className="text-xs text-text-muted mt-1">
              {t('agents.bulkMixedTenantsNoMove', 'The selection spans several workspaces: move agents to a group one workspace at a time.')}
            </p>
          ) : tenantGroups.length === 0 && (
            <p className="text-xs text-text-muted mt-1">{t('agents.noGroups', 'No groups yet')}</p>
          )}
        </div>

        {/* Heartbeat monitoring */}
        <TriStateCheckbox
          value={heartbeatMonitoring}
          onChange={setHeartbeatMonitoring}
          label={t('agents.heartbeatMonitoring')}
          description={t('agents.heartbeatMonitoringDesc')}
        />

        {/* Override group settings */}
        <TriStateCheckbox
          value={overrideGroupSettings}
          onChange={setOverrideGroupSettings}
          label={t('agents.overrideGroupSettings')}
          description={t('agents.overrideGroupSettingsDesc')}
        />

        {/* Status */}
        <div>
          <label htmlFor="bulk-agent-status" className="block text-sm font-medium text-text-secondary mb-1">
            {t('common.status')}
          </label>
          <select
            id="bulk-agent-status"
            value={statusAction}
            onChange={e => setStatusAction(e.target.value as StatusAction)}
            className={AGENT_SELECT_CLS}
          >
            <option value="no-change">{t('agents.noChange')}</option>
            <option value="approved">{t('agents.approveAll')}</option>
            <option value="suspended">{t('agents.suspendAll')}</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

export default BulkEditAgentModal;
