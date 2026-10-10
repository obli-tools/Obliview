import { useEffect, useState, type ReactNode } from 'react';
import { RotateCcw, Settings2, Thermometer } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type {
  MonitorGroup, AgentThresholds, AgentMetricThreshold, AgentTempThreshold,
} from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS } from '@obliview/shared';
import { groupsApi } from '@/api/groups.api';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// Agent defaults of a group: push interval, heartbeat monitoring, missed
// pushes, notification cooldown and the default alert thresholds. Stored on
// every group (migration 054: groups are hybrid), so an empty group can be
// pre-configured before agents are approved into it. Admin-only (the
// PATCH /groups/:id/agent-config route is admin-only).
// ─────────────────────────────────────────────────────────────────────────────

/** System defaults applied when neither the group chain nor the device sets a value. */
const DEFAULT_COOLDOWN_SECONDS = 300;

const OPS = ['>', '>=', '<', '<='] as const;
const BYTES_PER_MBIT = 125_000;

const NUMBER_INPUT_CLS =
  'rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent text-right placeholder:text-text-muted';
const TABLE_SELECT_CLS =
  'text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1 disabled:opacity-40';
const TABLE_INPUT_CLS =
  'w-24 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1 disabled:opacity-40';

function DefaultHint({ children }: { children: ReactNode }) {
  return <span className="text-xs font-normal text-text-muted">{children}</span>;
}

function OverrideChip() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
      {t('groups.detail.overridden', 'Override')}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold editor (inline table)
// ─────────────────────────────────────────────────────────────────────────────

function AgentGroupThresholdEditor({
  thresholds, onSave,
}: {
  thresholds: AgentThresholds;
  onSave: (t: AgentThresholds) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<AgentThresholds>({ ...thresholds });
  const [tempValues, setTempValues] = useState<AgentTempThreshold>(() => ({
    globalEnabled: false, op: '>', threshold: 85, overrides: {},
    ...(thresholds.temp ?? {}),
  }));
  const [saving, setSaving] = useState(false);

  // Re-sync only when the saved thresholds really change (a save of another
  // panel hands a new group object back: unsaved edits here must survive it).
  const savedKey = JSON.stringify(thresholds);
  useEffect(() => {
    setValues({ ...thresholds });
    setTempValues({ globalEnabled: false, op: '>', threshold: 85, overrides: {}, ...(thresholds.temp ?? {}) });
  }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const upd = (key: keyof Omit<AgentThresholds, 'temp'>, field: keyof AgentMetricThreshold, value: unknown) =>
    setValues(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));

  const updTemp = (field: keyof AgentTempThreshold, value: unknown) =>
    setTempValues(prev => ({ ...prev, [field]: value }));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ ...values, temp: tempValues });
      toast.success(t('groups.detail.thresholdsSaved'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.detail.failedThresholds')));
    } finally {
      setSaving(false);
    }
  };

  const metricRows: Array<{ key: keyof Omit<AgentThresholds, 'temp'>; labelKey: string; unit: string; scale?: number }> = [
    { key: 'cpu',    labelKey: 'groups.detail.cpu',    unit: '%' },
    { key: 'memory', labelKey: 'groups.detail.memory', unit: '%' },
    { key: 'disk',   labelKey: 'groups.detail.disk',   unit: '%' },
    { key: 'netIn',  labelKey: 'groups.detail.netIn',  unit: 'Mbps', scale: BYTES_PER_MBIT },
    { key: 'netOut', labelKey: 'groups.detail.netOut', unit: 'Mbps', scale: BYTES_PER_MBIT },
  ];

  const header = (
    <thead>
      <tr className="text-xs uppercase text-text-muted border-b border-border">
        <th className="text-left pb-2 font-medium">{t('groups.detail.metricCol')}</th>
        <th className="text-center pb-2 font-medium w-14">{t('groups.detail.onCol')}</th>
        <th className="text-center pb-2 font-medium w-16">{t('groups.detail.opCol')}</th>
        <th className="text-left pb-2 font-medium">{t('groups.detail.valueCol')}</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {header}
          <tbody className="divide-y divide-border">
            {metricRows.map(({ key, labelKey, unit, scale }) => (
              <tr key={key} className={values[key].enabled ? '' : 'opacity-50'}>
                <td className="py-2.5 font-medium text-text-secondary">{t(labelKey)}</td>
                <td className="py-2.5">
                  <div className="flex justify-center">
                    <ToggleSwitch
                      size="sm"
                      checked={values[key].enabled}
                      onChange={v => upd(key, 'enabled', v)}
                      ariaLabel={t(labelKey)}
                    />
                  </div>
                </td>
                <td className="py-2.5 text-center">
                  <select value={values[key].op} onChange={e => upd(key, 'op', e.target.value)}
                    disabled={!values[key].enabled}
                    aria-label={`${t(labelKey)} — ${t('groups.detail.opCol')}`}
                    className={TABLE_SELECT_CLS}>
                    {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </td>
                <td className="py-2.5">
                  <div className="flex items-center gap-1.5">
                    <input type="number"
                      value={scale ? Math.round(values[key].threshold / scale) : values[key].threshold}
                      onChange={e => upd(key, 'threshold', scale ? Math.round(Number(e.target.value) * scale) : Number(e.target.value))}
                      disabled={!values[key].enabled} min={0}
                      aria-label={`${t(labelKey)} — ${t('groups.detail.valueCol')}`}
                      className={TABLE_INPUT_CLS} />
                    <span className="text-xs text-text-muted">{unit}</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Temperature global threshold */}
      <div>
        <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2 flex items-center gap-1.5">
          <Thermometer size={11} /> {t('groups.detail.temperatures')}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            {header}
            <tbody className="divide-y divide-border">
              <tr className={tempValues.globalEnabled ? '' : 'opacity-50'}>
                <td className="py-2.5 font-medium text-text-secondary">{t('groups.detail.tempGlobal')}</td>
                <td className="py-2.5">
                  <div className="flex justify-center">
                    <ToggleSwitch
                      size="sm"
                      checked={tempValues.globalEnabled}
                      onChange={v => updTemp('globalEnabled', v)}
                      ariaLabel={t('groups.detail.tempGlobal')}
                    />
                  </div>
                </td>
                <td className="py-2.5 text-center">
                  <select value={tempValues.op} onChange={e => updTemp('op', e.target.value)}
                    disabled={!tempValues.globalEnabled}
                    aria-label={`${t('groups.detail.tempGlobal')} — ${t('groups.detail.opCol')}`}
                    className={TABLE_SELECT_CLS}>
                    {OPS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </td>
                <td className="py-2.5">
                  <div className="flex items-center gap-1.5">
                    <input type="number" value={tempValues.threshold}
                      onChange={e => updTemp('threshold', Number(e.target.value))}
                      disabled={!tempValues.globalEnabled} min={0} max={200}
                      aria-label={`${t('groups.detail.tempGlobal')} — ${t('groups.detail.valueCol')}`}
                      className={TABLE_INPUT_CLS} />
                    <span className="text-xs text-text-muted">°C</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors coarse:min-h-10">
          {saving ? t('common.saving') : t('groups.detail.saveSettings')}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent group settings panel
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentGroupSettingsPanelProps {
  group: MonitorGroup;
  /** Receives the updated group returned by the server after each save. */
  onUpdate: (g: MonitorGroup) => void;
  title?: string;
  className?: string;
}

const numOrEmpty = (v: number | null | undefined): string => (v !== null && v !== undefined ? String(v) : '');
const emptyToNull = (v: string): number | null => (v.trim() ? Number(v) : null);

export function AgentGroupSettingsPanel({ group, onUpdate, title, className }: AgentGroupSettingsPanelProps) {
  const { t } = useTranslation();
  const cfg = group.agentGroupConfig;
  const thr = group.agentThresholds ?? DEFAULT_AGENT_THRESHOLDS;

  const savedInterval = cfg?.pushIntervalSeconds ?? null;
  const savedHeartbeat = cfg?.heartbeatMonitoring ?? null;
  const savedMaxMissed = cfg?.maxMissedPushes ?? null;
  const savedCooldown = cfg?.notificationCooldownSeconds ?? null;

  const [pushInterval, setPushInterval] = useState<string>(numOrEmpty(savedInterval));
  const [heartbeat, setHeartbeat] = useState<boolean | null>(savedHeartbeat);
  const [maxMissed, setMaxMissed] = useState<string>(numOrEmpty(savedMaxMissed));
  const [cooldown, setCooldown] = useState<string>(numOrEmpty(savedCooldown));
  const [saving, setSaving] = useState(false);

  // Follow the saved values (another group, or the server's answer to a save).
  useEffect(() => { setPushInterval(numOrEmpty(savedInterval)); }, [savedInterval]);
  useEffect(() => { setHeartbeat(savedHeartbeat); }, [savedHeartbeat]);
  useEffect(() => { setMaxMissed(numOrEmpty(savedMaxMissed)); }, [savedMaxMissed]);
  useEffect(() => { setCooldown(numOrEmpty(savedCooldown)); }, [savedCooldown]);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      // Partial update: the server merges it into the stored config, so the
      // notification types (saved by their own panel) are left untouched.
      const updated = await groupsApi.updateAgentGroupConfig(group.id, {
        agentGroupConfig: {
          pushIntervalSeconds: emptyToNull(pushInterval),
          heartbeatMonitoring: heartbeat,
          maxMissedPushes: emptyToNull(maxMissed),
          notificationCooldownSeconds: emptyToNull(cooldown),
        },
      });
      onUpdate(updated);
      toast.success(t('groups.detail.settingsSaved', 'Settings saved'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedUpdate')));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveThresholds = async (thresholds: AgentThresholds) => {
    const updated = await groupsApi.updateAgentGroupConfig(group.id, { agentThresholds: thresholds });
    onUpdate(updated);
  };

  return (
    <div className={cn('rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4 space-y-6', className)}>
      <div>
        <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
          {title ?? t('groups.sections.agents', 'Agents')}
        </h2>
        <p className="text-xs text-text-muted mt-1">
          {t('groups.sections.agentsDesc', 'Defaults for the agents of this group and its sub-groups. Each agent can override them.')}
        </p>
      </div>

      {/* Push Interval */}
      <div className="flex items-center justify-between gap-4 max-sm:flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary flex items-center gap-2 flex-wrap">
            {t('groups.detail.pushInterval')}
            {savedInterval === null && <DefaultHint>{t('groups.detail.default', 'Default')}</DefaultHint>}
          </div>
          <div className="text-xs text-text-muted">{t('groups.detail.pushIntervalDesc')}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input type="number" value={pushInterval} min={1} max={86400}
            onChange={e => setPushInterval(e.target.value)}
            placeholder="60"
            aria-label={t('groups.detail.pushInterval')}
            className={cn('w-24', NUMBER_INPUT_CLS)} />
          <span className="text-xs text-text-muted">{t('groups.detail.seconds')}</span>
        </div>
      </div>

      {/* Heartbeat Monitoring */}
      <div className="flex items-center justify-between gap-4 max-sm:flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary flex items-center gap-2 flex-wrap">
            {t('groups.detail.heartbeatMonitoring')}
            {heartbeat === null ? <DefaultHint>{t('groups.detail.default', 'Default')}</DefaultHint> : <OverrideChip />}
          </div>
          <div className="text-xs text-text-muted">{t('groups.detail.heartbeatMonitoringDesc')}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ToggleSwitch
            checked={heartbeat ?? true}
            onChange={v => setHeartbeat(v)}
            disabled={heartbeat === null}
            ariaLabel={t('groups.detail.heartbeatMonitoring')}
          />
          {heartbeat === null ? (
            <button
              type="button"
              onClick={() => setHeartbeat(true)}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors coarse:min-h-10"
            >
              {t('common.override')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setHeartbeat(null)}
              className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-amber-500 hover:bg-amber-500/10 transition-colors flex items-center gap-1 coarse:min-h-10"
            >
              <RotateCcw size={12} />
              {t('common.reset')}
            </button>
          )}
        </div>
      </div>

      {/* Max Missed Pushes */}
      <div className="flex items-center justify-between gap-4 max-sm:flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary flex items-center gap-2 flex-wrap">
            {t('groups.detail.maxMissedPushes')}
            {savedMaxMissed === null && <DefaultHint>{t('groups.detail.default', 'Default')}</DefaultHint>}
          </div>
          <div className="text-xs text-text-muted">{t('groups.detail.maxMissedPushesDesc')}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input type="number" value={maxMissed} min={1} max={20}
            onChange={e => setMaxMissed(e.target.value)}
            placeholder="2"
            aria-label={t('groups.detail.maxMissedPushes')}
            className={cn('w-20', NUMBER_INPUT_CLS)} />
        </div>
      </div>

      {/* Notification Cooldown */}
      <div className="flex items-center justify-between gap-4 max-sm:flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary flex items-center gap-2 flex-wrap">
            {t('groups.detail.notificationCooldown', 'Notification cooldown')}
            {savedCooldown === null && (
              <DefaultHint>
                {t('groups.detail.defaultWithValue', 'Default ({{value}})', { value: `${DEFAULT_COOLDOWN_SECONDS}s` })}
              </DefaultHint>
            )}
          </div>
          <div className="text-xs text-text-muted">
            {t('groups.detail.notificationCooldownDesc', 'Minimum time between repeated alert notifications (0 = no cooldown)')}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <input type="number" value={cooldown} min={0} max={86400}
            onChange={e => setCooldown(e.target.value)}
            placeholder={String(DEFAULT_COOLDOWN_SECONDS)}
            aria-label={t('groups.detail.notificationCooldown', 'Notification cooldown')}
            className={cn('w-24', NUMBER_INPUT_CLS)} />
          <span className="text-xs text-text-muted">{t('groups.detail.seconds')}</span>
        </div>
      </div>

      <div className="flex justify-end">
        <button type="button" onClick={handleSaveConfig} disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors coarse:min-h-10">
          {saving ? t('common.saving') : t('groups.detail.saveSettings')}
        </button>
      </div>

      {/* Thresholds */}
      <div className="border-t border-border pt-4">
        <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-4 flex items-center gap-1.5 flex-wrap">
          <Settings2 size={11} /> {t('groups.detail.thresholds')}
          <span className="ml-1 text-text-muted font-normal normal-case">{t('groups.detail.thresholdsDesc')}</span>
        </div>
        <AgentGroupThresholdEditor thresholds={thr} onSave={handleSaveThresholds} />
      </div>
    </div>
  );
}
