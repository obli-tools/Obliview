import { useState } from 'react';
import { Save } from 'lucide-react';
import type { Monitor } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { SETTINGS_DEFINITIONS } from '@obliview/shared';
import { monitorsApi } from '@/api/monitors.api';
import { agentApi } from '@/api/agent.api';
import { settingsApi } from '@/api/settings.api';
import { useGroupStore } from '@/store/groupStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { GroupPicker } from '@/components/common/GroupPicker';
import { Checkbox } from '@/components/ui/Checkbox';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { apiErrorCode, apiErrorMessage } from '@/utils/apiError';

interface FieldState<T> {
  enabled: boolean;
  value: T;
}

interface BulkFormState {
  name: FieldState<string>;
  description: FieldState<string>;
  groupId: FieldState<number | null>;
  intervalSeconds: FieldState<string>;
  timeoutMs: FieldState<string>;
  retryIntervalSeconds: FieldState<string>;
  maxRetries: FieldState<string>;
  upsideDown: FieldState<boolean>;
}

type TimingFormKey = 'intervalSeconds' | 'timeoutMs' | 'retryIntervalSeconds' | 'maxRetries';

/**
 * Timing fields → monitor-scope settings keys (the settings table is the only
 * source of a monitor's timing). Enabled + value = override on every selected
 * monitor; enabled + empty = remove the override (back to inherited).
 */
const TIMING_FIELDS: Array<{ field: TimingFormKey; key: SettingsKey; labelKey: string }> = [
  { field: 'intervalSeconds',      key: 'check_interval', labelKey: 'monitors.form.checkInterval' },
  { field: 'timeoutMs',            key: 'timeout',        labelKey: 'monitors.form.timeout' },
  { field: 'retryIntervalSeconds', key: 'retry_interval', labelKey: 'monitors.form.retryInterval' },
  { field: 'maxRetries',           key: 'max_retries',    labelKey: 'monitors.form.maxRetries' },
];

function rangeOf(key: SettingsKey): { min: number; max: number } {
  const def = SETTINGS_DEFINITIONS.find((d) => d.key === key);
  return { min: def?.min ?? 0, max: def?.max ?? Number.MAX_SAFE_INTEGER };
}

function makeDefaultState(): BulkFormState {
  return {
    name:                 { enabled: false, value: '' },
    description:          { enabled: false, value: '' },
    groupId:              { enabled: false, value: null },
    intervalSeconds:      { enabled: false, value: '' },
    timeoutMs:            { enabled: false, value: '' },
    retryIntervalSeconds: { enabled: false, value: '' },
    maxRetries:           { enabled: false, value: '' },
    upsideDown:           { enabled: false, value: false },
  };
}

interface BulkEditModalProps {
  monitorIds: number[];
  isAgentSelection?: boolean;
  onClose: () => void;
}

/** Toggle row — checkbox label + field side by side */
function FieldRow({
  label,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  enabled: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <Checkbox
          checked={enabled}
          onCheckedChange={onToggle}
        />
        <span className={cn('text-sm font-medium', enabled ? 'text-text-primary' : 'text-text-secondary')}>
          {label}
        </span>
      </label>
      <div className={cn('transition-opacity', !enabled && 'opacity-40 pointer-events-none')}>
        {children}
      </div>
    </div>
  );
}

export function BulkEditModal({ monitorIds, isAgentSelection, onClose }: BulkEditModalProps) {
  const { t } = useTranslation();
  const { tree } = useGroupStore();
  // Hybrid groups: any group can host monitors AND devices — no need to split
  // the picker tree by kind anymore. `isAgentSelection` still gates the
  // bulk-editable form fields below.
  const groupTree = tree;
  const { updateMonitor: updateStoreMonitor, fetchMonitors } = useMonitorStore();
  const { isAdmin, hasCapability } = useAuthStore();
  // An agent monitor lives in its device's group: agents are moved through
  // their devices, which needs 'agents.manage' (/agent/devices/bulk).
  const canEditGroup = !isAgentSelection || isAdmin() || hasCapability('agents.manage');
  const [form, setForm] = useState<BulkFormState>(makeDefaultState);
  const [saving, setSaving] = useState(false);

  const count = monitorIds.length;

  const setEnabled = <K extends keyof BulkFormState>(key: K, enabled: boolean) => {
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], enabled } }));
  };

  const setValue = <K extends keyof BulkFormState>(key: K, value: BulkFormState[K]['value']) => {
    setForm((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
  };

  const anyEnabled = Object.values(form).some((f) => f.enabled);

  const handleSubmit = async () => {
    // Direct monitor fields (monitors table)
    const directChanges: Partial<Monitor> = {};
    // Timing fields go to the settings table (monitor-scope overrides)
    const timingOverrides: Array<{ key: SettingsKey; value: number }> = [];
    const timingResets: SettingsKey[] = [];

    if (form.name.enabled && form.name.value.trim())
      directChanges.name = form.name.value.trim();
    if (form.description.enabled)
      directChanges.description = form.description.value.trim() || null;
    const moveAgentDevices = !!isAgentSelection && canEditGroup && form.groupId.enabled;
    if (form.groupId.enabled && !isAgentSelection)
      directChanges.groupId = form.groupId.value;
    if (form.upsideDown.enabled)
      directChanges.upsideDown = form.upsideDown.value;

    if (!isAgentSelection) {
      for (const { field, key, labelKey } of TIMING_FIELDS) {
        if (!form[field].enabled) continue;
        const raw = form[field].value.trim();
        if (raw === '') {
          timingResets.push(key);
          continue;
        }
        const value = Number(raw);
        const { min, max } = rangeOf(key);
        if (!Number.isInteger(value) || value < min || value > max) {
          toast.error(t('bulkEdit.outOfRange', {
            defaultValue: '{{field}}: enter a whole number between {{min}} and {{max}}',
            field: t(labelKey),
            min,
            max,
          }));
          return;
        }
        timingOverrides.push({ key, value });
      }
    }

    const hasDirectChanges = Object.keys(directChanges).length > 0;
    const hasTimingChanges = timingOverrides.length > 0 || timingResets.length > 0;
    if (!hasDirectChanges && !hasTimingChanges && !moveAgentDevices) {
      toast.error(t('bulkEdit.noFields'));
      return;
    }

    setSaving(true);
    // Steps run one after the other; `applied` remembers that an earlier step
    // already changed something, so a later failure is reported as partial.
    let applied = false;
    try {
      // 1. Direct fields (restarts the workers server-side).
      if (hasDirectChanges) {
        const updated = await monitorsApi.bulkUpdate({ monitorIds, changes: directChanges });
        updated.forEach((m) => updateStoreMonitor(m.id, m));
        applied = true;
      }

      // 2. Agents: move the devices — the server mirrors the group onto their
      //    agent monitors.
      if (moveAgentDevices) {
        const { getMonitor } = useMonitorStore.getState();
        const deviceIds = monitorIds
          .map((mid) => getMonitor(mid)?.agentDeviceId)
          .filter((d): d is number => d != null);
        if (deviceIds.length > 0) {
          await agentApi.bulkUpdateDevices(deviceIds, { groupId: form.groupId.value });
          applied = true;
          await fetchMonitors();
        }
      }

      // 3. Timing overrides: one all-or-nothing request for the whole
      //    selection (restarts the affected workers server-side).
      if (hasTimingChanges) {
        try {
          await settingsApi.setMonitorsBulk(monitorIds, timingOverrides, timingResets);
        } catch (err) {
          const error = apiErrorMessage(err, t('bulkEdit.failed'));
          toast.error(applied
            ? t('bulkEdit.partialTiming', {
              defaultValue: 'The other changes were applied to {{count}} monitor(s), but the timing settings were not: {{error}}',
              count,
              error,
            })
            : t('bulkEdit.timingFailed', {
              defaultValue: 'The timing settings could not be saved: {{error}}',
              error,
            }));
          return;
        }
      }

      toast.success(isAgentSelection
        ? t('bulkEdit.successAgents', { defaultValue: '{{count}} agent(s) updated', count })
        : t('bulkEdit.success', { count }));
      onClose();
    } catch (err) {
      const code = apiErrorCode(err);
      const error = code === 'AGENT_MONITOR_MOVE'
        ? t('monitors.errors.agentMonitorMove')
        : code === 'PROXY_FORBIDDEN'
          ? t('monitors.errors.proxyForbidden')
          : code === 'FOREIGN_MONITOR_IDS'
            ? t('monitors.errors.foreignMonitorIds')
            : apiErrorMessage(err, t('bulkEdit.failed'));
      toast.error(applied
        ? t('bulkEdit.partialFailed', {
          defaultValue: 'Some changes were applied, then the update failed: {{error}}',
          error,
        })
        : error);
    } finally {
      setSaving(false);
    }
  };

  const keepPlaceholder = t('bulkEdit.keepCurrent', 'Keep current value');

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      size="sm"
      title={t('bulkEdit.title', 'Bulk Edit')}
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={!anyEnabled}
          >
            <Save size={15} className="mr-1.5" />
            {isAgentSelection
              ? t('bulkEdit.applyAgents', { defaultValue: 'Apply to {{count}} agent(s)', count })
              : t('bulkEdit.applyMonitors', { defaultValue: 'Apply to {{count}} monitor(s)', count })}
          </Button>
        </>
      }
    >
      <p className="text-xs text-text-secondary mb-4">
        {isAgentSelection
          ? t('bulkEdit.subtitleAgents', { defaultValue: '{{count}} agent(s) selected — check a field to change it', count })
          : t('bulkEdit.subtitleMonitors', { defaultValue: '{{count}} monitor(s) selected — check a field to change it', count })}
      </p>

      <div className="space-y-5">
        {/* ── General ── */}
        <section className="space-y-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
            {t('monitors.form.sectionGeneral', 'General')}
          </h3>

          <FieldRow label={t('common.name', 'Name')} enabled={form.name.enabled} onToggle={() => setEnabled('name', !form.name.enabled)}>
            <Input
              value={form.name.value}
              onChange={(e) => setValue('name', e.target.value)}
              placeholder={keepPlaceholder}
              disabled={!form.name.enabled}
            />
          </FieldRow>

          <FieldRow label={t('common.description', 'Description')} enabled={form.description.enabled} onToggle={() => setEnabled('description', !form.description.enabled)}>
            <Input
              value={form.description.value}
              onChange={(e) => setValue('description', e.target.value)}
              placeholder={keepPlaceholder}
              disabled={!form.description.enabled}
            />
          </FieldRow>

          {canEditGroup && (
            <FieldRow label={t('common.group', 'Group')} enabled={form.groupId.enabled} onToggle={() => setEnabled('groupId', !form.groupId.enabled)}>
              <GroupPicker
                value={form.groupId.value}
                onChange={(groupId) => setValue('groupId', groupId)}
                tree={groupTree}
                placeholder={t('monitors.form.noGroup', 'No group')}
              />
            </FieldRow>
          )}
        </section>

        {/* ── Timing (monitor only) ── */}
        {!isAgentSelection && (
          <section className="space-y-4">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                {t('monitors.form.sectionTiming', 'Timing')}
              </h3>
              <p className="text-xs text-text-muted mt-1">
                {t('bulkEdit.timingHint', 'Saved as an override on each monitor. Leave a checked field empty to go back to the inherited value.')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {TIMING_FIELDS.map(({ field, key, labelKey }) => {
                const { min, max } = rangeOf(key);
                return (
                  <FieldRow
                    key={field}
                    label={t(labelKey)}
                    enabled={form[field].enabled}
                    onToggle={() => setEnabled(field, !form[field].enabled)}
                  >
                    <Input
                      type="number"
                      inputMode="numeric"
                      step={1}
                      min={min}
                      max={max}
                      value={form[field].value}
                      onChange={(e) => setValue(field, e.target.value)}
                      placeholder={form[field].enabled
                        ? t('bulkEdit.inheritPlaceholder', 'Inherited')
                        : t('bulkEdit.keep', 'Keep')}
                      disabled={!form[field].enabled}
                    />
                  </FieldRow>
                );
              })}
            </div>
          </section>
        )}

        {/* ── Behaviour (monitor only) ── */}
        {!isAgentSelection && (
          <section className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
              {t('bulkEdit.sectionBehaviour', 'Behaviour')}
            </h3>

            <FieldRow
              label={t('bulkEdit.upsideDown', 'Upside Down Mode')}
              enabled={form.upsideDown.enabled}
              onToggle={() => setEnabled('upsideDown', !form.upsideDown.enabled)}
            >
              <label className={cn('flex items-center gap-2 cursor-pointer', !form.upsideDown.enabled && 'pointer-events-none')}>
                <Checkbox
                  checked={form.upsideDown.value}
                  onCheckedChange={(v) => setValue('upsideDown', v)}
                  disabled={!form.upsideDown.enabled}
                />
                <span className="text-sm text-text-secondary">
                  {t('bulkEdit.invertLogic', 'Invert UP/DOWN logic')}
                </span>
              </label>
            </FieldRow>
          </section>
        )}
      </div>
    </Modal>
  );
}
