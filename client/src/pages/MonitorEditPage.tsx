import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useParams, useNavigate, Link, useLocation, Navigate } from 'react-router-dom';
import { ArrowLeft, Save, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Monitor, MonitorType, ResolvedSettings, SettingDefinition } from '@obliview/shared';
import type { SettingsKey } from '@obliview/shared';
import { MONITOR_TYPES, MONITOR_TYPE_LABELS, PROXY_SUPPORTED_TYPES, SETTINGS_DEFINITIONS } from '@obliview/shared';
import { monitorsApi } from '@/api/monitors.api';
import { agentApi, type AgentProxyCandidate } from '@/api/agent.api';
import { settingsApi, type ResolvedWithOverrides } from '@/api/settings.api';
import { systemApi } from '@/api/system.api';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { GroupPicker } from '@/components/common/GroupPicker';
import { Checkbox } from '@/components/ui/Checkbox';
import { InheritanceBadge, OverrideBadge } from '@/components/settings/InheritanceBadge';
import toast from 'react-hot-toast';
import { apiErrorCode, apiErrorMessage } from '@/utils/apiError';

// ── Timing: monitor-scope overrides of the settings table ────────────────────
// The settings table is the single source of a monitor's timing (migration
// 061): an empty field inherits (group chain → workspace → default), a filled
// one is saved as a monitor-scope override. The monitors columns
// (intervalSeconds, timeoutMs, retryIntervalSeconds, maxRetries) are legacy
// and never sent any more.

const TIMING_FIELDS = [
  { key: 'check_interval', labelKey: 'monitors.form.checkInterval' },
  { key: 'timeout', labelKey: 'monitors.form.timeout' },
  { key: 'retry_interval', labelKey: 'monitors.form.retryInterval' },
  { key: 'max_retries', labelKey: 'monitors.form.maxRetries' },
] as const satisfies ReadonlyArray<{ key: SettingsKey; labelKey: string }>;

type TimingKey = (typeof TIMING_FIELDS)[number]['key'];
/** Raw input text per field — '' means "inherit". */
type TimingDraft = Record<TimingKey, string>;
/** Saved monitor-scope overrides. */
type TimingOverrides = Partial<Record<TimingKey, number>>;

const EMPTY_TIMING_DRAFT: TimingDraft = { check_interval: '', timeout: '', retry_interval: '', max_retries: '' };

function timingDefinition(key: TimingKey): SettingDefinition {
  return SETTINGS_DEFINITIONS.find((d) => d.key === key)!;
}

/** Timing keys of a raw overrides record (settings API). */
function pickTiming(overrides: Record<string, number>): TimingOverrides {
  const out: TimingOverrides = {};
  for (const { key } of TIMING_FIELDS) {
    if (typeof overrides[key] === 'number') out[key] = overrides[key];
  }
  return out;
}

function draftFrom(overrides: TimingOverrides): TimingDraft {
  const draft = { ...EMPTY_TIMING_DRAFT };
  for (const { key } of TIMING_FIELDS) {
    if (overrides[key] !== undefined) draft[key] = String(overrides[key]);
  }
  return draft;
}

function parseDraft(draft: TimingDraft): TimingOverrides {
  const out: TimingOverrides = {};
  for (const { key } of TIMING_FIELDS) {
    const raw = draft[key].trim();
    if (raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) out[key] = Math.trunc(n);
  }
  return out;
}

/**
 * What a monitor placed at this layer inherits: the layer's resolved chain
 * with the layer's own overrides applied on top.
 */
function withOwnLayer(
  data: ResolvedWithOverrides,
  source: 'group' | 'global',
  sourceId: number | null,
  sourceName: string,
): ResolvedSettings {
  const merged = { ...data.resolved };
  for (const [key, value] of Object.entries(data.overrides)) {
    if (key in merged && typeof value === 'number') {
      merged[key as SettingsKey] = { value, source, sourceId, sourceName };
    }
  }
  return merged;
}

/** Legacy timing columns are never written by the form any more. */
function withoutTimingColumns(data: Partial<Monitor>): Partial<Monitor> {
  const { intervalSeconds: _i, timeoutMs: _t, retryIntervalSeconds: _r, maxRetries: _m, ...rest } = data;
  return rest;
}

/** One timing row: label + inheritance source, number input, reset. */
function TimingField({
  id,
  label,
  definition,
  value,
  inherited,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  definition: SettingDefinition;
  value: string;
  inherited: ResolvedSettings[SettingsKey] | null;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const overridden = value.trim() !== '';
  const placeholder = inherited
    ? t('monitors.form.inheritedValue', { defaultValue: 'Inherited ({{value}})', value: inherited.value })
    : t('monitors.form.inheritedUnknown', 'Inherited');

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <label htmlFor={id} className="block text-sm font-medium text-text-secondary truncate">
          {label}
        </label>
        {overridden ? <OverrideBadge /> : inherited ? <InheritanceBadge setting={inherited} /> : null}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="flex-1 min-w-0">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            step={1}
            min={definition.min}
            max={definition.max}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
        {overridden && !disabled && (
          <IconButton
            label={t('settingsInheritance.resetTitle', 'Reset to inherited')}
            icon={<RotateCcw size={14} />}
            onClick={() => onChange('')}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Format a threshold number as a full decimal string so it never shows
 * scientific notation (e.g. 9e-7 → "0.0000009") in the input field.
 */
function numToDecimalStr(n: number | null | undefined): string {
  if (n == null) return '';
  if (n !== 0 && Math.abs(n) < 0.001) {
    const places = Math.max(0, -Math.floor(Math.log10(Math.abs(n)))) + 4;
    return n.toFixed(Math.min(places, 15)).replace(/\.?0+$/, '') || '0';
  }
  return String(n);
}

export function MonitorEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { addMonitor, updateMonitor: updateStoreMonitor } = useMonitorStore();
  const { fetchGroups, fetchTree, tree, groups } = useGroupStore();
  const { isAdmin } = useAuthStore();
  const isNew = !id || id === 'new';

  // Check for clone data from navigation state
  const cloneData = (location.state as any)?.cloneData as Partial<Monitor> | undefined;
  // Monitor being cloned (optional): its timing overrides prefill the new one.
  const cloneSourceId = (location.state as any)?.cloneSourceId as number | undefined;

  // Timing fields are not part of the monitor payload (settings table).
  const defaultForm: Partial<Monitor> = {
    name: '',
    type: 'http' as MonitorType,
    url: '',
    method: 'GET',
    expectedStatusCodes: [200, 201, 204],
  };

  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Partial<Monitor>>(() => {
    if (!cloneData) return defaultForm;
    // Agent monitors are created by approving a device, never by hand.
    if (cloneData.type === 'agent') {
      return { ...cloneData, type: 'http' as MonitorType, agentDeviceId: null, agentThresholds: null };
    }
    // Non-admins cannot create script monitors — a cloned one falls back to HTTP
    if (cloneData.type === 'script' && !isAdmin()) {
      return { ...cloneData, type: 'http' as MonitorType, scriptCommand: null };
    }
    return cloneData;
  });
  // Proxy picker: GET /agent/proxy-candidates returns the approved devices the
  // user may route checks through (platform admin, agents.manage, or RW on
  // the device's agent monitor). The picker is shown when there is any.
  const [proxyAgents, setProxyAgents] = useState<AgentProxyCandidate[]>([]);
  const [proxyAgentsLoaded, setProxyAgentsLoaded] = useState(false);
  const canPickProxy = proxyAgents.length > 0;
  // Proxy + workspace of the saved monitor (null until loaded / new monitor):
  // an unchanged proxy is never resent, and the God View asks for the
  // candidates of the monitor's own workspace.
  const [savedProxy, setSavedProxy] = useState<{ id: number | null; tenantId: number | null } | null>(null);

  // Timing (settings table). `loadedGroupId` = group of the saved monitor
  // (undefined until loaded); `timingSaved` = its monitor-scope overrides.
  const [loadedGroupId, setLoadedGroupId] = useState<number | null | undefined>(undefined);
  const [timingDraft, setTimingDraft] = useState<TimingDraft>(EMPTY_TIMING_DRAFT);
  const [timingSaved, setTimingSaved] = useState<TimingOverrides>({});
  const [timingStatus, setTimingStatus] = useState<'loading' | 'ready' | 'failed'>(isNew ? 'ready' : 'loading');
  const [monitorInherited, setMonitorInherited] = useState<ResolvedSettings | null>(null);
  const [timingInherited, setTimingInherited] = useState<ResolvedSettings | null>(null);
  // Unsaved timing draft of a just-created monitor whose timing write failed:
  // /monitor/new and /monitor/:id/edit share this component instance, so the
  // draft survives the switch and is restored instead of the server state.
  const pendingTimingDraftRef = useRef<TimingDraft | null>(null);

  // Load groups for the selector
  useEffect(() => {
    fetchGroups();
    fetchTree();
  }, [fetchGroups, fetchTree]);

  // Devices usable as proxy (an existing monitor waits for its workspace).
  const savedProxyLoaded = savedProxy !== null;
  const savedProxyTenantId = savedProxy?.tenantId ?? null;
  useEffect(() => {
    if (!isNew && !savedProxyLoaded) return;
    let cancelled = false;
    agentApi.listProxyCandidates(!isNew && savedProxyTenantId != null ? savedProxyTenantId : undefined)
      .then((list) => { if (!cancelled) setProxyAgents(list); })
      .catch(() => { if (!cancelled) setProxyAgents([]); })
      .finally(() => { if (!cancelled) setProxyAgentsLoaded(true); });
    return () => { cancelled = true; };
  }, [isNew, savedProxyLoaded, savedProxyTenantId]);

  // Browser monitors need Chromium on the server. GET /system is admin-only:
  // for everyone else the type stays selectable (null = unknown).
  const canReadSystem = isAdmin();
  const [browserAvailable, setBrowserAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!canReadSystem) return;
    let cancelled = false;
    systemApi.getInfo()
      .then((info) => { if (!cancelled) setBrowserAvailable(info.browserAvailable ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [canReadSystem]);

  // Load existing monitor for editing
  useEffect(() => {
    if (!isNew) {
      monitorsApi.getById(parseInt(id!, 10)).then((monitor) => {
        setForm(monitor);
        setLoadedGroupId(monitor.groupId ?? null);
        setSavedProxy({ id: monitor.proxyAgentDeviceId ?? null, tenantId: monitor.tenantId ?? null });
      }).catch(() => {
        toast.error(t('monitors.notFound'));
        navigate('/');
      });
    }
  }, [id, isNew, navigate, t]);

  // Load the monitor's timing overrides + what it inherits without them.
  useEffect(() => {
    if (isNew) {
      // (the clone effect below may prefill the draft afterwards)
      setTimingSaved({});
      setTimingDraft(EMPTY_TIMING_DRAFT);
      setTimingStatus('ready');
      return;
    }
    let cancelled = false;
    setTimingStatus('loading');
    settingsApi.getMonitorResolved(parseInt(id!, 10))
      .then((data) => {
        if (cancelled) return;
        const saved = pickTiming(data.overrides);
        setTimingSaved(saved);
        const pending = pendingTimingDraftRef.current;
        pendingTimingDraftRef.current = null;
        setTimingDraft(pending ?? draftFrom(saved));
        setMonitorInherited(data.inherited ?? null);
        setTimingStatus('ready');
      })
      .catch(() => {
        // Unknown overrides: the fields are locked and nothing is written.
        if (cancelled) return;
        pendingTimingDraftRef.current = null;
        setTimingStatus('failed');
      });
    return () => { cancelled = true; };
  }, [id, isNew]);

  // Clone: prefill the timing overrides of the source monitor.
  useEffect(() => {
    if (!isNew || cloneSourceId == null) return;
    let cancelled = false;
    settingsApi.getMonitorResolved(cloneSourceId)
      .then((data) => {
        if (!cancelled) setTimingDraft(draftFrom(pickTiming(data.overrides)));
      })
      .catch(() => { /* the clone simply inherits */ });
    return () => { cancelled = true; };
  }, [isNew, cloneSourceId]);

  // What the monitor would inherit where it is placed in the form. An existing
  // monitor still in its saved group uses the server's resolution; otherwise
  // the chosen group's chain (+ its own overrides) or the workspace defaults
  // (admin-only endpoint: others just see "Inherited").
  const placementGroupId = form.groupId ?? null;
  const placementGroupName = placementGroupId !== null
    ? groups.get(placementGroupId)?.name ?? `#${placementGroupId}`
    : null;
  const admin = isAdmin();
  useEffect(() => {
    if (!isNew) {
      if (loadedGroupId === undefined) return;
      if (placementGroupId === loadedGroupId) {
        setTimingInherited(monitorInherited);
        return;
      }
    }
    let cancelled = false;
    const request: Promise<ResolvedSettings | null> = placementGroupId !== null
      ? settingsApi.getGroupResolved(placementGroupId)
        .then((data) => withOwnLayer(data, 'group', placementGroupId, placementGroupName ?? ''))
      : admin
        ? settingsApi.getGlobalResolved().then((data) => withOwnLayer(data, 'global', null, 'Workspace'))
        : Promise.resolve(null);
    request
      .then((resolved) => { if (!cancelled) setTimingInherited(resolved); })
      .catch(() => { if (!cancelled) setTimingInherited(null); });
    return () => { cancelled = true; };
  }, [isNew, loadedGroupId, placementGroupId, placementGroupName, monitorInherited, admin]);

  const updateField = <K extends keyof Monitor>(key: K, value: Monitor[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Script monitors run shell commands on the server: platform admins only.
  // Non-admins may still edit the other fields of an existing script monitor,
  // but its type, command and execution host are locked (enforced server-side).
  const canManageScript = isAdmin();
  const scriptLocked = !canManageScript && !isNew && form.type === 'script';
  const availableTypes = MONITOR_TYPES.filter(
    (type) => type !== 'agent' && (type !== 'script' || canManageScript || scriptLocked),
  );

  // Proxy picker: only devices able to run this monitor type (the Go agent
  // runs a subset, the proxy stub runs everything). A proxy already set on
  // the monitor stays visible even when it no longer qualifies.
  const currentType = (form.type ?? 'http') as MonitorType;
  const proxyCandidates = proxyAgents.filter(
    (a) => (PROXY_SUPPORTED_TYPES[a.deviceType] ?? []).includes(currentType),
  );
  const currentProxyId = form.proxyAgentDeviceId ?? null;
  const currentProxy = currentProxyId != null ? proxyAgents.find((a) => a.id === currentProxyId) ?? null : null;
  const currentProxyUnsupported = currentProxyId != null
    && !proxyCandidates.some((a) => a.id === currentProxyId);

  /** Strip fields that don't belong to the selected monitor type */
  const cleanFormForType = (data: Partial<Monitor>): Partial<Monitor> => {
    const cleaned = { ...data };
    const t = cleaned.type;

    // HTTP / JSON API fields
    if (t !== 'http' && t !== 'json_api') {
      cleaned.url = null;
      cleaned.method = undefined;
      cleaned.headers = null;
      cleaned.body = null;
      cleaned.expectedStatusCodes = null;
      cleaned.keyword = null;
      cleaned.keywordIsPresent = null;
      cleaned.ignoreSsl = false;
    }

    // JSON API specific
    if (t !== 'json_api') {
      cleaned.jsonPath = null;
      cleaned.jsonExpectedValue = null;
    }

    // Hostname / port (ping, tcp, dns, ssl, smtp)
    if (!['ping', 'tcp', 'dns', 'ssl', 'smtp'].includes(t!)) {
      cleaned.hostname = null;
      cleaned.port = null;
    }

    // DNS specific
    if (t !== 'dns') {
      cleaned.dnsRecordType = null;
      cleaned.dnsResolver = null;
      cleaned.dnsExpectedValue = null;
    }

    // SSL specific — sslWarnDays is also used for http/json_api SSL cert checking
    if (t !== 'ssl' && t !== 'http' && t !== 'json_api') {
      cleaned.sslWarnDays = null;
    }

    // SMTP specific
    if (t !== 'smtp') {
      cleaned.smtpHost = null;
      cleaned.smtpPort = null;
    }

    // Docker specific
    if (t !== 'docker') {
      cleaned.dockerHost = null;
      cleaned.dockerContainerName = null;
    }

    // Game server specific
    if (t !== 'game_server') {
      cleaned.gameType = null;
      cleaned.gameHost = null;
      cleaned.gamePort = null;
    }

    // Push specific
    if (t !== 'push') {
      cleaned.pushMaxIntervalSec = null;
    }

    // Script specific
    if (t !== 'script') {
      cleaned.scriptCommand = null;
      cleaned.scriptExpectedExit = null;
    }

    // Browser specific
    if (t !== 'browser') {
      cleaned.browserUrl = null;
      cleaned.browserKeyword = null;
      cleaned.browserKeywordIsPresent = null;
      cleaned.browserWaitForSelector = null;
      cleaned.browserScreenshotOnFailure = false;
    }

    // Value Watcher specific
    if (t !== 'value_watcher') {
      cleaned.valueWatcherUrl = null;
      cleaned.valueWatcherJsonPath = null;
      cleaned.valueWatcherOperator = null;
      cleaned.valueWatcherThreshold = null;
      cleaned.valueWatcherThresholdMax = null;
      cleaned.valueWatcherHeaders = null;
    }

    // Proxy agent: push / agent monitors never run through one. On update the
    // proxy is only sent when the user picked another one (without the
    // picker it is never resent): the server keeps it and only re-checks it
    // against a new type.
    if (t === 'push' || t === 'agent') {
      cleaned.proxyAgentDeviceId = null;
    } else if (!isNew && (!canPickProxy || (cleaned.proxyAgentDeviceId ?? null) === (savedProxy?.id ?? null))) {
      delete cleaned.proxyAgentDeviceId;
    }

    return cleaned;
  };

  /**
   * Writes the timing draft as monitor-scope overrides: changed values via
   * setBulk, cleared ones removed (back to inherited). `previous` = the
   * overrides the monitor had when the page loaded ({} for a new monitor).
   */
  const saveTiming = async (monitorId: number, previous: TimingOverrides): Promise<void> => {
    const desired = parseDraft(timingDraft);
    const toSet = TIMING_FIELDS
      .filter(({ key }) => desired[key] !== undefined && desired[key] !== previous[key])
      .map(({ key }) => ({ key: key as SettingsKey, value: desired[key]! }));
    const toRemove = TIMING_FIELDS
      .filter(({ key }) => desired[key] === undefined && previous[key] !== undefined)
      .map(({ key }) => key as SettingsKey);

    if (toSet.length > 0) await settingsApi.setBulk('monitor', String(monitorId), toSet);
    for (const key of toRemove) await settingsApi.remove('monitor', String(monitorId), key);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);

    try {
      const payload = withoutTimingColumns(cleanFormForType(form));

      let monitor: Monitor;
      try {
        if (isNew) {
          monitor = await monitorsApi.create(payload);
          addMonitor(monitor);
        } else {
          monitor = await monitorsApi.update(parseInt(id!, 10), payload);
          updateStoreMonitor(monitor.id, monitor);
        }
      } catch (err) {
        switch (apiErrorCode(err)) {
          case 'PROXY_TYPE_UNSUPPORTED':
            toast.error(t('monitors.errors.proxyTypeUnsupported'));
            break;
          case 'AGENT_MONITOR_MOVE':
            toast.error(t('monitors.errors.agentMonitorMove'));
            break;
          case 'AGENT_TYPE_LOCKED':
            toast.error(t('monitors.errors.agentTypeLocked'));
            break;
          case 'PROXY_FORBIDDEN':
            toast.error(t('monitors.errors.proxyForbidden'));
            break;
          default:
            toast.error(isNew ? t('monitors.failedCreate') : t('monitors.failedUpdate'));
        }
        return;
      }

      if (isNew && !isAdmin()) {
        // The server granted RW on the new monitor to the creator's canCreate
        // teams: reload the permission map before opening it.
        await useAuthStore.getState().refreshPermissions();
      }

      // Timing overrides go to the settings table, after the monitor itself
      // (a new monitor needs its id). Skipped when they could not be loaded.
      if (isNew || timingStatus === 'ready') {
        try {
          await saveTiming(monitor.id, isNew ? {} : timingSaved);
        } catch (err) {
          toast.error(t('monitors.timingSaveFailed', {
            defaultValue: 'The monitor was saved, but its timing settings were not: {{error}}',
            error: apiErrorMessage(err, t('settingsPanel.failedSave')),
          }));
          // Stay on the form to retry (a new monitor reopens as an edit).
          if (isNew) {
            pendingTimingDraftRef.current = timingDraft;
            navigate(`/monitor/${monitor.id}/edit`, { replace: true });
          }
          return;
        }
      }

      toast.success(isNew ? t('monitors.created') : t('monitors.updated'));
      navigate(`/monitor/${monitor.id}`);
    } finally {
      setSaving(false);
    }
  };

  // Agent monitors are not edited here: an agent is configured on its device
  // page (admins). Others go back to the read-only monitor view.
  if (!isNew && form.type === 'agent') {
    return isAdmin() && form.agentDeviceId != null
      ? <Navigate to={`/agents/${form.agentDeviceId}`} replace />
      : <Navigate to={`/monitor/${id}`} replace />;
  }

  return (
    <div className="p-6">
      <Link
        to={isNew ? '/' : `/monitor/${id}`}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4"
      >
        <ArrowLeft size={14} />
        {isNew ? t('monitors.backToDashboard') : t('monitors.backToMonitor')}
      </Link>

      <h1 className="text-2xl font-semibold text-text-primary mb-6">
        {isNew ? t('monitors.new') : t('monitors.edit')}
      </h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic Info */}
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('monitors.form.sectionGeneral')}
          </h2>

          <Input
            label={t('monitors.form.name')}
            value={form.name || ''}
            onChange={(e) => updateField('name', e.target.value)}
            placeholder={t('monitors.form.namePlaceholder')}
            required
          />

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">
              {t('monitors.form.monitorType')}
            </label>
            <select
              value={form.type || 'http'}
              onChange={(e) => updateField('type', e.target.value as MonitorType)}
              disabled={scriptLocked}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
            >
              {availableTypes.map((type) => {
                // A monitor already of type browser keeps it selectable.
                const unavailable = type === 'browser' && browserAvailable === false && form.type !== 'browser';
                return (
                  <option
                    key={type}
                    value={type}
                    disabled={unavailable}
                    title={unavailable ? t('monitors.form.browserUnavailable', 'Browser monitors are unavailable: Chromium was not found on this server.') : undefined}
                  >
                    {MONITOR_TYPE_LABELS[type]}
                    {unavailable ? ` (${t('monitors.form.unavailable', 'unavailable')})` : ''}
                  </option>
                );
              })}
            </select>
            {browserAvailable === false && form.type === 'browser' && (
              <p className="text-xs text-status-down" title={t('monitors.form.browserUnavailable', 'Browser monitors are unavailable: Chromium was not found on this server.')}>
                {t('monitors.form.browserUnavailable', 'Browser monitors are unavailable: Chromium was not found on this server.')}
              </p>
            )}
          </div>

          <Input
            label={t('monitors.form.descriptionOptional')}
            value={form.description || ''}
            onChange={(e) => updateField('description', e.target.value || null)}
            placeholder={t('monitors.form.descriptionPlaceholder')}
          />

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">
              {t('monitors.form.group')}
            </label>
            <GroupPicker
              value={form.groupId ?? null}
              onChange={(groupId) => updateField('groupId', groupId)}
              tree={tree}
              placeholder={t('monitors.form.noGroup')}
            />
          </div>
        </div>

        {/* Type-specific fields */}
        {(form.type === 'http' || form.type === 'json_api') && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionHttp')}
            </h2>

            <Input
              label={t('monitors.form.url')}
              value={form.url || ''}
              onChange={(e) => updateField('url', e.target.value)}
              placeholder={t('monitors.form.urlPlaceholder')}
              required
            />

            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.method')}</label>
              <select
                value={form.method || 'GET'}
                onChange={(e) => updateField('method', e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>

            <Input
              label={t('monitors.form.keyword')}
              value={form.keyword || ''}
              onChange={(e) => updateField('keyword', e.target.value || null)}
              placeholder={t('monitors.form.keywordPlaceholder')}
            />

            {(form.url || '').startsWith('https') && (
              <>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="ignore-ssl"
                    checked={form.ignoreSsl || false}
                    onCheckedChange={(v) => updateField('ignoreSsl', v)}
                  />
                  <label htmlFor="ignore-ssl" className="text-sm text-text-secondary">
                    {t('monitors.form.ignoreSsl')}
                  </label>
                </div>
                {!form.ignoreSsl && (
                  <Input
                    label={t('monitors.form.sslWarnDays')}
                    type="number"
                    value={form.sslWarnDays ?? 30}
                    onChange={(e) => updateField('sslWarnDays', parseInt(e.target.value, 10) || 30)}
                    placeholder="30"
                  />
                )}
              </>
            )}

            {form.type === 'json_api' && (
              <>
                <Input
                  label={t('monitors.form.jsonPath')}
                  value={form.jsonPath || ''}
                  onChange={(e) => updateField('jsonPath', e.target.value || null)}
                  placeholder={t('monitors.form.jsonPathPlaceholder')}
                />
                <Input
                  label={t('monitors.form.expectedValue')}
                  value={form.jsonExpectedValue || ''}
                  onChange={(e) => updateField('jsonExpectedValue', e.target.value || null)}
                  placeholder={t('monitors.form.expectedValuePlaceholder')}
                />
              </>
            )}
          </div>
        )}

        {(form.type === 'ping' || form.type === 'tcp' || form.type === 'dns' || form.type === 'ssl' || form.type === 'smtp') && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionHost')}
            </h2>

            <Input
              label={t('monitors.form.hostname')}
              value={form.hostname || ''}
              onChange={(e) => updateField('hostname', e.target.value)}
              placeholder={t('monitors.form.hostnamePlaceholder')}
              required
            />

            {(form.type === 'tcp' || form.type === 'smtp') && (
              <Input
                label={t('monitors.form.port')}
                type="number"
                value={form.port ?? (form.type === 'smtp' ? 25 : '')}
                onChange={(e) => updateField('port', parseInt(e.target.value, 10) || null)}
                placeholder={form.type === 'smtp' ? '25' : '80'}
              />
            )}

            {form.type === 'dns' && (
              <>
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.dnsRecordType')}</label>
                  <select
                    value={form.dnsRecordType || 'A'}
                    onChange={(e) => updateField('dnsRecordType', e.target.value)}
                    className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
                  >
                    {['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'PTR'].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <Input
                  label={t('monitors.form.dnsResolver')}
                  value={form.dnsResolver || ''}
                  onChange={(e) => updateField('dnsResolver', e.target.value || null)}
                  placeholder={t('monitors.form.dnsResolverPlaceholder')}
                />
                <Input
                  label={t('monitors.form.dnsExpected')}
                  value={form.dnsExpectedValue || ''}
                  onChange={(e) => updateField('dnsExpectedValue', e.target.value || null)}
                  placeholder={t('monitors.form.dnsExpectedPlaceholder')}
                />
              </>
            )}

            {form.type === 'ssl' && (
              <Input
                label={t('monitors.form.warnDays')}
                type="number"
                value={form.sslWarnDays ?? 30}
                onChange={(e) => updateField('sslWarnDays', parseInt(e.target.value, 10) || 30)}
                placeholder="30"
              />
            )}
          </div>
        )}

        {form.type === 'docker' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionDocker')}
            </h2>
            <Input
              label={t('monitors.form.dockerHost')}
              value={form.dockerHost || ''}
              onChange={(e) => updateField('dockerHost', e.target.value)}
              placeholder={t('monitors.form.dockerHostPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.containerName')}
              value={form.dockerContainerName || ''}
              onChange={(e) => updateField('dockerContainerName', e.target.value)}
              placeholder={t('monitors.form.containerNamePlaceholder')}
              required
            />
          </div>
        )}

        {form.type === 'game_server' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionGame')}
            </h2>
            <Input
              label={t('monitors.form.gameType')}
              value={form.gameType || ''}
              onChange={(e) => updateField('gameType', e.target.value)}
              placeholder={t('monitors.form.gameTypePlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.gameHost')}
              value={form.gameHost || ''}
              onChange={(e) => updateField('gameHost', e.target.value)}
              placeholder={t('monitors.form.gameHostPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.gamePort')}
              type="number"
              value={form.gamePort ?? ''}
              onChange={(e) => updateField('gamePort', parseInt(e.target.value, 10) || null)}
              placeholder={t('monitors.form.gamePortPlaceholder')}
            />
          </div>
        )}

        {form.type === 'push' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionPush')}
            </h2>
            <Input
              label={t('monitors.form.pushMaxInterval')}
              type="number"
              value={form.pushMaxIntervalSec ?? 300}
              onChange={(e) => updateField('pushMaxIntervalSec', parseInt(e.target.value, 10) || 300)}
              placeholder={t('monitors.form.pushMaxIntervalPlaceholder')}
            />
            {!isNew && form.pushToken && (
              <div className="space-y-1">
                <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.pushUrl')}</label>
                <code className="block rounded-md bg-bg-tertiary p-2 text-xs text-accent break-all">
                  {window.location.origin}/api/heartbeat/{form.pushToken}
                </code>
              </div>
            )}
          </div>
        )}

        {form.type === 'script' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionScript')}
            </h2>
            <Input
              label={t('monitors.form.scriptCommand')}
              value={form.scriptCommand || ''}
              onChange={(e) => updateField('scriptCommand', e.target.value)}
              placeholder={t('monitors.form.scriptCommandPlaceholder')}
              disabled={scriptLocked}
              required
            />
            <Input
              label={t('monitors.form.scriptExpectedExit')}
              type="number"
              value={form.scriptExpectedExit ?? 0}
              onChange={(e) => updateField('scriptExpectedExit', parseInt(e.target.value, 10) || 0)}
              placeholder={t('monitors.form.scriptExpectedExitPlaceholder')}
            />
          </div>
        )}

        {form.type === 'browser' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionBrowser')}
            </h2>
            <p className="text-xs text-text-secondary">
              {t('monitors.form.browserDesc')}
            </p>
            <Input
              label={t('monitors.form.browserUrl')}
              value={form.browserUrl || ''}
              onChange={(e) => updateField('browserUrl', e.target.value)}
              placeholder={t('monitors.form.browserUrlPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.browserWaitSelector')}
              value={form.browserWaitForSelector || ''}
              onChange={(e) => updateField('browserWaitForSelector', e.target.value || null)}
              placeholder={t('monitors.form.browserWaitSelectorPlaceholder')}
            />
            <Input
              label={t('monitors.form.browserKeyword')}
              value={form.browserKeyword || ''}
              onChange={(e) => updateField('browserKeyword', e.target.value || null)}
              placeholder={t('monitors.form.browserKeywordPlaceholder')}
            />
            {form.browserKeyword && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="browser-keyword-absent"
                  checked={form.browserKeywordIsPresent === false}
                  onCheckedChange={(v) => updateField('browserKeywordIsPresent', v ? false : true)}
                />
                <label htmlFor="browser-keyword-absent" className="text-sm text-text-secondary">
                  {t('monitors.form.browserKeywordInverted')}
                </label>
              </div>
            )}
          </div>
        )}

        {form.type === 'value_watcher' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionValueWatcher')}
            </h2>
            <p className="text-xs text-text-secondary">
              {t('monitors.form.valueWatcherDesc')}
            </p>
            <Input
              label={t('monitors.form.valueWatcherUrl')}
              value={form.valueWatcherUrl || ''}
              onChange={(e) => updateField('valueWatcherUrl', e.target.value)}
              placeholder={t('monitors.form.valueWatcherUrlPlaceholder')}
              required
            />
            <Input
              label={t('monitors.form.valueWatcherJsonPath')}
              value={form.valueWatcherJsonPath || ''}
              onChange={(e) => updateField('valueWatcherJsonPath', e.target.value)}
              placeholder={t('monitors.form.valueWatcherJsonPathPlaceholder')}
              required
            />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-text-secondary">{t('monitors.form.valueWatcherOperator')}</label>
              <select
                value={form.valueWatcherOperator || '>'}
                onChange={(e) => updateField('valueWatcherOperator', e.target.value)}
                className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
              >
                <option value=">">{t('monitors.form.opGt')}</option>
                <option value="<">{t('monitors.form.opLt')}</option>
                <option value=">=">{t('monitors.form.opGte')}</option>
                <option value="<=">{t('monitors.form.opLte')}</option>
                <option value="==">{t('monitors.form.opEq')}</option>
                <option value="!=">{t('monitors.form.opNeq')}</option>
                <option value="between">{t('monitors.form.opBetween')}</option>
                <option value="changed">{t('monitors.form.opChanged')}</option>
              </select>
            </div>
            {form.valueWatcherOperator !== 'changed' && (
              <Input
                label={form.valueWatcherOperator === 'between' ? t('monitors.form.minThreshold') : t('monitors.form.threshold')}
                type="text"
                inputMode="decimal"
                value={numToDecimalStr(form.valueWatcherThreshold)}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  updateField('valueWatcherThreshold', raw ? parseFloat(raw) : null);
                }}
                placeholder="0.000001"
                required
              />
            )}
            {form.valueWatcherOperator === 'between' && (
              <Input
                label={t('monitors.form.maxThreshold')}
                type="text"
                inputMode="decimal"
                value={numToDecimalStr(form.valueWatcherThresholdMax)}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  updateField('valueWatcherThresholdMax', raw ? parseFloat(raw) : null);
                }}
                placeholder="0.000002"
                required
              />
            )}
          </div>
        )}

        {/* Proxy Agent — execute checks via a remote agent (shown when the
            user may use at least one device as proxy) */}
        {canPickProxy && form.type !== 'agent' && form.type !== 'push' && (
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('monitors.form.sectionProxy', 'Proxy Agent')}
            </h2>
            <p className="text-xs text-text-secondary">
              {t('monitors.form.proxyDesc', 'Execute this monitor check through a remote agent instead of the server. Useful for monitoring resources on a LAN that the server cannot reach directly.')}
            </p>
            <select
              value={currentProxyId ?? ''}
              onChange={(e) => updateField('proxyAgentDeviceId', e.target.value ? parseInt(e.target.value, 10) : null)}
              disabled={scriptLocked}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary disabled:opacity-60"
            >
              <option value="">{t('monitors.form.proxyNone', 'None (server-side check)')}</option>
              {currentProxyUnsupported && (
                <option value={currentProxyId!}>
                  {currentProxy
                    ? `${currentProxy.name ?? currentProxy.hostname} (${currentProxy.deviceType === 'proxy' ? 'proxy' : 'agent'})`
                    : `#${currentProxyId}`}
                </option>
              )}
              {proxyCandidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.hostname} ({a.deviceType === 'proxy' ? 'proxy' : 'agent'})
                </option>
              ))}
            </select>
            {currentProxyUnsupported && proxyAgentsLoaded && (
              <p className="text-xs text-status-down">
                {currentProxy
                  ? t('monitors.form.proxyUnsupported', 'The selected proxy cannot run this monitor type or is no longer approved. Choose another proxy or none.')
                  : t('monitors.form.proxyNotAvailable', 'The selected proxy is no longer approved or is not available to you. Choose another proxy or none.')}
              </p>
            )}
          </div>
        )}

        {proxyAgentsLoaded && !canPickProxy && form.proxyAgentDeviceId != null && form.type !== 'agent' && form.type !== 'push' && (
          <p className="rounded-lg border border-border bg-bg-secondary px-4 py-3 text-xs text-text-secondary">
            {t('monitors.form.proxyReadOnly', 'This monitor runs its checks through an agent proxy; some monitor types cannot run on it.')}
          </p>
        )}

        {/* Timing Settings */}
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
            {t('monitors.form.sectionTiming')}
          </h2>

          <p className="text-xs text-text-muted">
            {t('monitors.form.timingInheritHint', 'Leave a field empty to inherit the value of the group or the workspace.')}
          </p>

          {timingStatus === 'failed' && (
            <p className="text-xs text-status-down">
              {t('monitors.form.timingLoadFailed', 'The timing settings could not be loaded: they are left unchanged.')}
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {TIMING_FIELDS.map(({ key, labelKey }) => (
              <TimingField
                key={key}
                id={`monitor-timing-${key}`}
                label={t(labelKey)}
                definition={timingDefinition(key)}
                value={timingDraft[key]}
                inherited={timingInherited?.[key] ?? null}
                disabled={timingStatus !== 'ready'}
                onChange={(value) => setTimingDraft((prev) => ({ ...prev, [key]: value }))}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="upside-down"
              checked={form.upsideDown || false}
              onCheckedChange={(v) => updateField('upsideDown', v)}
            />
            <label htmlFor="upside-down" className="text-sm text-text-secondary">
              {t('monitors.form.upsideDown')}
            </label>
          </div>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3">
          <Button type="submit" loading={saving}>
            <Save size={16} className="mr-1.5" />
            {isNew ? t('monitors.create') : t('monitors.saveChanges')}
          </Button>
          <Link to={isNew ? '/' : `/monitor/${id}`}>
            <Button type="button" variant="secondary">
              {t('common.cancel')}
            </Button>
          </Link>
        </div>
      </form>
    </div>
  );
}
