import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, MonitorGroup } from '@obliview/shared';
import { anonymize } from '@/utils/anonymize';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { Checkbox } from '@/components/common/Checkbox';
import type { AgentApiKeyWithDefault } from '@/api/agent.api';
import { AGENT_SELECT_CLS, groupsForTenant, keyDefaultGroup } from './ApproveAgentModal';

export interface EditAgentData {
  name: string | null;
  /** Only present when the group changed (undefined = keep the current group). */
  groupId?: number | null;
  heartbeatMonitoring: boolean;
  overrideGroupSettings: boolean;
  suspended: boolean;
}

interface EditAgentModalProps {
  device: AgentDevice;
  /** Flat list of every group visible to the caller (filtered to the device tenant here). */
  groups: MonitorGroup[];
  /**
   * API keys (with their default group). A device without a group gets its
   * key's default group preselected (visible in the select before saving).
   */
  keys?: AgentApiKeyWithDefault[];
  /** Resolve when the save is done (the modal shows a spinner meanwhile). */
  onSave: (data: EditAgentData) => void | Promise<void>;
  onCancel: () => void;
}

function CheckboxRow({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description: ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group">
      <Checkbox checked={checked} onCheckedChange={onChange} wrapperClassName="mt-0.5" />
      <div>
        <p className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">{label}</p>
        <p className="text-xs text-text-muted leading-relaxed">{description}</p>
      </div>
    </label>
  );
}

/** Rename an agent, move it to another group of its tenant, toggle monitoring / suspension. */
export function EditAgentModal({ device, groups, keys, onSave, onCancel }: EditAgentModalProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(device.name ?? '');
  const [groupId, setGroupId] = useState<number | null>(device.groupId ?? null);
  const [heartbeatMonitoring, setHeartbeatMonitoring] = useState(device.heartbeatMonitoring);
  const [overrideGroupSettings, setOverrideGroupSettings] = useState(device.overrideGroupSettings);
  const [suspended, setSuspended] = useState(device.status === 'suspended');
  const [saving, setSaving] = useState(false);

  const tenantGroups = groupsForTenant(groups, device.tenantId);
  const keyDefault = keyDefaultGroup(device, keys, tenantGroups);
  // Ungrouped device: suggest the key's default group (once, and only until
  // the operator touches the select).
  const [groupTouched, setGroupTouched] = useState(false);
  const keyDefaultId = keyDefault?.groupId ?? null;
  useEffect(() => {
    if (!groupTouched && device.groupId == null && keyDefaultId != null) setGroupId(keyDefaultId);
  }, [keyDefaultId, groupTouched, device.groupId]);
  // Legacy data: the device may already sit in another tenant's group. Keep it
  // visible (flagged) so the select does not silently show "No group".
  const currentForeignGroup = device.groupId != null && !tenantGroups.some(g => g.id === device.groupId)
    ? groups.find(g => g.id === device.groupId) ?? null
    : null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        name: name.trim() || null,
        // Only send the group when it changed, so an unrelated edit never
        // re-submits (and gets rejected for) a legacy cross-tenant group.
        ...(groupId !== (device.groupId ?? null) ? { groupId } : {}),
        heartbeatMonitoring,
        overrideGroupSettings,
        suspended,
      });
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
      title={t('agents.editAgent')}
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={handleSave} loading={saving}>{t('common.save')}</Button>
        </>
      }
    >
      <p className="text-xs text-text-muted mb-5">
        {t('agents.hostnameInfo', { hostname: anonymize(device.hostname) })}
      </p>

      <div className="space-y-4">
        {/* Display name */}
        <div>
          <label htmlFor="edit-agent-name" className="block text-sm font-medium text-text-secondary mb-1">
            {t('agents.displayName')}
          </label>
          <Input
            id="edit-agent-name"
            placeholder={device.hostname}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !saving) { e.preventDefault(); void handleSave(); } }}
            autoFocus
          />
          <p className="text-xs text-text-muted mt-1">{t('agents.displayNameDesc')}</p>
        </div>

        {/* Group */}
        <div>
          <label htmlFor="edit-agent-group" className="block text-sm font-medium text-text-secondary mb-1">
            {t('common.group', 'Group')}
          </label>
          <select
            id="edit-agent-group"
            value={groupId ?? ''}
            onChange={e => { setGroupTouched(true); setGroupId(e.target.value === '' ? null : Number(e.target.value)); }}
            className={AGENT_SELECT_CLS}
          >
            <option value="">{t('agents.noGroup')}</option>
            {currentForeignGroup && (
              <option value={currentForeignGroup.id}>
                {t('agents.groupOtherTenant', '{{name}} (other workspace)', { name: currentForeignGroup.name })}
              </option>
            )}
            {tenantGroups.map(g => (
              <option key={g.id} value={g.id}>
                {g.id === keyDefault?.groupId
                  ? t('agents.keyDefaultOption', '{{name}} (key default)', { name: g.name })
                  : g.name}
              </option>
            ))}
          </select>
          {keyDefault && device.groupId == null && groupId === keyDefault.groupId && (
            <p className="text-xs text-text-muted mt-1">
              {t('agents.keyDefaultPreselected', 'Preselected: default group of the API key "{{key}}".', { key: keyDefault.keyName })}
            </p>
          )}
          {tenantGroups.length === 0 && !currentForeignGroup && (
            <p className="text-xs text-text-muted mt-1">{t('agents.noGroups', 'No groups yet')}</p>
          )}
        </div>

        <CheckboxRow
          checked={heartbeatMonitoring}
          onChange={setHeartbeatMonitoring}
          label={t('agents.heartbeatMonitoring')}
          description={t('agents.heartbeatMonitoringDesc')}
        />

        <CheckboxRow
          checked={overrideGroupSettings}
          onChange={setOverrideGroupSettings}
          label={t('agents.overrideGroupSettings')}
          description={t('agents.overrideGroupSettingsDesc')}
        />

        <CheckboxRow
          checked={suspended}
          onChange={setSuspended}
          label={t('agents.suspended')}
          description={t('agents.suspendedDesc')}
        />
      </div>
    </Modal>
  );
}

export default EditAgentModal;
