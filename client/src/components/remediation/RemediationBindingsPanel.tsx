import { useState, useEffect, useCallback } from 'react';
import { anonymize } from '@/utils/anonymize';
import { ShieldCheck, Plus, X, ArrowDown, ArrowUp, AlertTriangle, Loader2 } from 'lucide-react';
import type {
  RemediationAction,
  RemediationBinding,
  ResolvedRemediationBindingView,
  RemediationTrigger,
  OverrideModeR,
  RemediationActionType,
  WebhookRemediationConfig,
  ScriptRemediationConfig,
  DockerRestartRemediationConfig,
} from '@obliview/shared';
import { remediationApi, isServerExecutedActionType, type RemediationCapabilities } from '../../api/remediation.api';
import { apiErrorCode, apiErrorMessage } from '../../utils/apiError';
import { cn } from '../../utils/cn';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// ─── Helpers ───────────────────────────────────────────────────────────────────

type TFn = ReturnType<typeof useTranslation>['t'];

/** [i18n key, English fallback] */
type Label = [string, string];

const SOURCE_BADGE: Record<'global' | 'group' | 'monitor', { label: Label; className: string }> = {
  global:  { label: ['common.global', 'Global'],   className: 'bg-blue-500/10 text-blue-400' },
  group:   { label: ['common.group', 'Group'],     className: 'bg-purple-500/10 text-purple-400' },
  monitor: { label: ['common.monitor', 'Monitor'], className: 'bg-green-500/10 text-green-400' },
};

const TRIGGER_LABELS: Record<RemediationTrigger, Label> = {
  down: ['remediationBindings.triggerDown', 'On DOWN'],
  up:   ['remediationBindings.triggerUp', 'On UP'],
  both: ['remediationBindings.triggerBoth', 'On both'],
};

const OVERRIDE_LABELS: Record<OverrideModeR, Label> = {
  merge:   ['remediationBindings.modeMerge', 'Merge'],
  replace: ['remediationBindings.modeReplace', 'Replace'],
  exclude: ['remediationBindings.modeExclude', 'Exclude'],
};

const ACTION_TYPE_SHORT: Record<string, string> = {
  webhook:        'Webhook',
  n8n:            'N8N',
  script:         'Script',
  docker_restart: 'Docker',
  ssh:            'SSH',
};

const ACTION_TYPE_LABELS: Record<RemediationActionType, Label> = {
  webhook:        ['remediations.typeWebhook', 'Generic Webhook'],
  n8n:            ['remediations.typeN8n', 'N8N Workflow'],
  script:         ['remediations.typeScript', 'Custom Script'],
  docker_restart: ['remediations.typeDocker', 'Docker Restart'],
  ssh:            ['remediations.typeSsh', 'SSH Command'],
};

const ACTION_TYPE_DESCRIPTIONS: Record<RemediationActionType, Label> = {
  webhook:        ['remediations.descWebhook', 'HTTP request to any endpoint'],
  n8n:            ['remediations.descN8n', 'Trigger an N8N workflow via webhook'],
  script:         ['remediations.descScript', 'Run a shell script on the server'],
  docker_restart: ['remediations.descDocker', 'Restart a Docker container'],
  ssh:            ['remediations.descSsh', 'Run a command on a remote host via SSH'],
};

/** Resolve a [key, fallback] label */
const tl = (t: TFn, [key, fallback]: Label): string => t(key, fallback);

const ACTION_TYPES = Object.keys(ACTION_TYPE_LABELS) as RemediationActionType[];

/**
 * Types offered by the inline "Create & Bind": Script / Docker only when they
 * may run here and the caller may manage them (platform admin on the master
 * tenant). SSH is never created inline: it needs a pinned host key, fetched
 * from the Remediations page.
 */
function inlineCreatableTypes(caps: RemediationCapabilities | null): RemediationActionType[] {
  const allowServerTypes = !!caps && caps.serverScriptsEnabled && caps.canManageServerActions;
  return ACTION_TYPES.filter(tp => tp !== 'ssh' && (allowServerTypes || !isServerExecutedActionType(tp)));
}

/** A server-executed action that does not run because the server disabled them */
function isDisabledOnServer(type: string, caps: RemediationCapabilities | null): boolean {
  return !!caps && !caps.serverScriptsEnabled && isServerExecutedActionType(type);
}

type AnyConfig = Record<string, unknown>;

// ─── ResolvedEntry type (server returns source fields + config-free action) ────

type ResolvedEntry = ResolvedRemediationBindingView;

// ─── Inline config forms ───────────────────────────────────────────────────────

const inputCls = 'w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent';
const labelCls = 'block text-xs font-medium text-text-secondary mb-1';

function WebhookForm({
  config, onChange, isN8n,
}: {
  config: Partial<WebhookRemediationConfig>;
  onChange: (c: Partial<WebhookRemediationConfig>) => void;
  isN8n?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>{isN8n ? t('remediationBindings.n8nWebhookUrl', 'N8N Webhook URL') : t('remediationBindings.url', 'URL')} <span className="text-red-400">*</span></label>
        <input type="url" required value={config.url ?? ''} onChange={e => onChange({ ...config, url: e.target.value })}
          placeholder="https://..." className={inputCls} />
      </div>
      {!isN8n && (
        <div>
          <label className={labelCls}>{t('remediationBindings.method', 'Method')}</label>
          <select value={config.method ?? 'POST'}
            onChange={e => onChange({ ...config, method: e.target.value as WebhookRemediationConfig['method'] })}
            className={inputCls}>
            {['POST', 'GET', 'PUT', 'PATCH'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}
      <div>
        <label className={labelCls}>{t('remediationBindings.timeoutMs', 'Timeout (ms)')}</label>
        <input type="number" min={1000} max={60000} value={String(config.timeoutMs ?? 10000)}
          onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>{t('remediationBindings.extraHeaders', 'Extra Headers')} <span className="font-normal text-text-muted">{t('remediationBindings.jsonObject', '(JSON object)')}</span></label>
        <textarea rows={2}
          value={config.headers ? JSON.stringify(config.headers, null, 2) : ''}
          onChange={e => { try { onChange({ ...config, headers: JSON.parse(e.target.value || '{}') }); } catch { /* ignore */ } }}
          placeholder='{"Authorization": "Bearer "}'
          className={cn(inputCls, 'resize-y font-mono text-xs')} />
      </div>
      {!isN8n && (
        <div>
          <label className={labelCls}>{t('remediationBindings.extraBody', 'Extra Body Fields')} <span className="font-normal text-text-muted">{t('remediationBindings.extraBodyHint', '(JSON object merged into payload)')}</span></label>
          <textarea rows={3}
            value={config.bodyExtra ? JSON.stringify(config.bodyExtra, null, 2) : ''}
            onChange={e => { try { onChange({ ...config, bodyExtra: e.target.value ? JSON.parse(e.target.value) : undefined }); } catch { /* ignore */ } }}
            placeholder='{"customField": "value"}'
            className={cn(inputCls, 'resize-y font-mono text-xs')} />
        </div>
      )}
    </div>
  );
}

function ScriptForm({
  config, onChange,
}: {
  config: Partial<ScriptRemediationConfig>;
  onChange: (c: Partial<ScriptRemediationConfig>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>{t('remediationBindings.script', 'Script')} <span className="text-red-400">*</span></label>
        <textarea rows={6} required value={config.script ?? ''}
          onChange={e => onChange({ ...config, script: e.target.value })}
          placeholder={'#!/bin/bash\nsystemctl restart nginx'}
          className={cn(inputCls, 'resize-y font-mono text-xs')} />
      </div>
      <div>
        <label className={labelCls}>{t('remediationBindings.timeoutMs', 'Timeout (ms)')}</label>
        <input type="number" min={1000} max={300000} value={String(config.timeoutMs ?? 30000)}
          onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} className={inputCls} />
      </div>
    </div>
  );
}

function DockerForm({
  config, onChange,
}: {
  config: Partial<DockerRestartRemediationConfig>;
  onChange: (c: Partial<DockerRestartRemediationConfig>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>{t('remediationBindings.containerName', 'Container Name')} <span className="text-red-400">*</span></label>
        <input required value={config.containerName ?? ''}
          onChange={e => onChange({ ...config, containerName: e.target.value })}
          placeholder="my-nginx" className={inputCls} />
      </div>
      <div>
        <label className={labelCls}>{t('remediationBindings.dockerSocket', 'Docker Socket Path')}</label>
        <input value={config.socketPath ?? '/var/run/docker.sock'}
          onChange={e => onChange({ ...config, socketPath: e.target.value })}
          placeholder="/var/run/docker.sock" className={inputCls} />
      </div>
    </div>
  );
}

// ─── Add Binding Modal ────────────────────────────────────────────────────────

function AddBindingModal({
  actions,
  capabilities,
  onAdd,
  onAddWithNew,
  onClose,
}: {
  actions: RemediationAction[];
  capabilities: RemediationCapabilities | null;
  onAdd: (actionId: number, triggerOn: RemediationTrigger, overrideMode: OverrideModeR, cooldownSeconds: number) => Promise<unknown>;
  onAddWithNew: (name: string, type: RemediationActionType, config: AnyConfig, triggerOn: RemediationTrigger, overrideMode: OverrideModeR, cooldownSeconds: number) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Tab: 'select' = pick existing action, 'create' = inline action creation
  const [tab, setTab] = useState<'select' | 'create'>(actions.length === 0 ? 'create' : 'select');

  // Select-tab state
  const [selectedId, setSelectedId] = useState<number | null>(actions[0]?.id ?? null);

  // Create-tab state
  const [newName, setNewName]       = useState('');
  const [newType, setNewType]       = useState<RemediationActionType>('webhook');
  const [newConfig, setNewConfig]   = useState<AnyConfig>({ method: 'POST', timeoutMs: 10000 });

  // Shared binding config
  const [triggerOn, setTriggerOn]   = useState<RemediationTrigger>('down');
  const [overrideMode, setMode]     = useState<OverrideModeR>('merge');
  const [cooldown, setCooldown]     = useState(300);
  const [saving, setSaving]         = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (tab === 'select') {
        if (!selectedId) return;
        await onAdd(selectedId, triggerOn, overrideMode, cooldown);
      } else {
        if (!newName.trim()) { toast.error(t('remediationBindings.actionRequired')); setSaving(false); return; }
        await onAddWithNew(newName.trim(), newType, newConfig, triggerOn, overrideMode, cooldown);
      }
      onClose();
    } catch (err) {
      toast.error(apiErrorCode(err) === 'SERVER_SCRIPTS_DISABLED'
        ? t('remediations.serverTypesDisabledHint', 'Script, SSH and Docker actions are disabled on this server.')
        : apiErrorMessage(err, t('remediationBindings.failedAddBinding')));
    } finally {
      setSaving(false);
    }
  };

  const creatableTypes = inlineCreatableTypes(capabilities);
  const serverTypesHidden = creatableTypes.length < ACTION_TYPES.length;

  const renderConfigForm = () => {
    switch (newType) {
      case 'webhook': return <WebhookForm config={newConfig as Partial<WebhookRemediationConfig>} onChange={c => setNewConfig(c as AnyConfig)} />;
      case 'n8n':     return <WebhookForm config={newConfig as Partial<WebhookRemediationConfig>} onChange={c => setNewConfig(c as AnyConfig)} isN8n />;
      case 'script':  return <ScriptForm config={newConfig as Partial<ScriptRemediationConfig>} onChange={c => setNewConfig(c as AnyConfig)} />;
      case 'docker_restart': return <DockerForm config={newConfig as Partial<DockerRestartRemediationConfig>} onChange={c => setNewConfig(c as AnyConfig)} />;
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary shadow-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <ShieldCheck size={15} /> {t('remediationBindings.addTitle', 'Add Remediation Binding')}
          </h3>
          <button onClick={onClose} aria-label={t('common.close', 'Close')} title={t('common.close', 'Close')} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          <button type="button" onClick={() => setTab('select')}
            className={cn(
              'flex-1 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === 'select'
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}>
            {t('remediationBindings.selectExisting', 'Select Existing')}{actions.length > 0 ? ` (${actions.length})` : ''}
          </button>
          <button type="button" onClick={() => setTab('create')}
            className={cn(
              'flex-1 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === 'create'
                ? 'border-b-2 border-accent text-accent'
                : 'text-text-secondary hover:text-text-primary',
            )}>
            {t('remediationBindings.createNew', 'Create New')}
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-5 space-y-4">

          {/* ── Select existing ── */}
          {tab === 'select' && (
            <div>
              <label className={labelCls}>{t('remediationBindings.action', 'Action')}</label>
              {actions.length > 0 ? (
                <select value={selectedId ?? ''} onChange={e => setSelectedId(Number(e.target.value))}
                  className={inputCls}>
                  {actions.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({ACTION_TYPE_SHORT[a.type] ?? a.type})
                      {isDisabledOnServer(a.type, capabilities)
                        ? ` — ${t('remediations.serverDisabledBadge', 'Disabled on this server')}`
                        : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <p className="text-xs text-text-muted">{t('remediationBindings.noActionsYet', 'No actions yet.')}</p>
                  <button type="button" onClick={() => setTab('create')}
                    className="mt-1.5 text-xs text-accent hover:underline">
                    {t('remediationBindings.createOneNow', 'Create one now →')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Create new ── */}
          {tab === 'create' && (
            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className={labelCls}>{t('remediations.nameLabel', 'Name')} <span className="text-red-400">*</span></label>
                <input required value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder={t('remediations.namePlaceholder', 'Restart Nginx')} className={inputCls} />
              </div>

              {/* Type selector */}
              <div>
                <label className={labelCls}>{t('remediations.actionType', 'Action Type')}</label>
                <div className="grid grid-cols-1 gap-1.5">
                  {creatableTypes.map(tp => (
                    <label key={tp} className={cn(
                      'flex items-start gap-3 p-2.5 rounded-lg border cursor-pointer transition-colors',
                      newType === tp
                        ? 'border-accent bg-accent/5'
                        : 'border-border hover:border-accent/50 hover:bg-bg-hover',
                    )}>
                      <input type="radio" name="newActionType" value={tp} checked={newType === tp}
                        onChange={() => { setNewType(tp); setNewConfig({}); }}
                        className="mt-0.5 accent-accent" />
                      <div>
                        <div className="text-xs font-medium text-text-primary">{tl(t, ACTION_TYPE_LABELS[tp])}</div>
                        <div className="text-[11px] text-text-muted">{tl(t, ACTION_TYPE_DESCRIPTIONS[tp])}</div>
                      </div>
                    </label>
                  ))}
                </div>
                {serverTypesHidden && (
                  <p className="text-xs text-text-muted mt-1.5">
                    {t('remediationBindings.serverTypesElsewhere', 'Script, SSH and Docker actions are created from the Remediations page (SSH needs a pinned host key).')}
                  </p>
                )}
              </div>

              {/* Config form */}
              <div className="border-t border-border pt-4">
                <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-3">
                  {t('remediations.sectionConfig', { defaultValue: '{{type}} Configuration', type: tl(t, ACTION_TYPE_LABELS[newType]) })}
                </p>
                {renderConfigForm()}
              </div>
            </div>
          )}

          {/* ── Binding configuration (always visible) ── */}
          <div className="border-t border-border pt-4 space-y-4">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide">{t('remediationBindings.bindingConfig', 'Binding Configuration')}</p>

            {/* Trigger */}
            <div>
              <label className={labelCls}>{t('remediationBindings.trigger', 'Trigger')}</label>
              <div className="flex rounded-lg border border-border overflow-hidden text-xs">
                {(['down', 'up', 'both'] as RemediationTrigger[]).map(tr => (
                  <button key={tr} type="button" onClick={() => setTriggerOn(tr)}
                    className={cn('flex-1 py-1.5 font-medium transition-colors',
                      triggerOn === tr ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-hover')}>
                    {tl(t, TRIGGER_LABELS[tr])}
                  </button>
                ))}
              </div>
            </div>

            {/* Override mode */}
            <div>
              <label className={labelCls}>{t('remediationBindings.overrideMode', 'Override Mode')}</label>
              <div className="flex rounded-lg border border-border overflow-hidden text-xs">
                {(['merge', 'replace', 'exclude'] as OverrideModeR[]).map(m => (
                  <button key={m} type="button" onClick={() => setMode(m)}
                    className={cn('flex-1 py-1.5 font-medium transition-colors',
                      overrideMode === m ? 'bg-accent text-white' : 'text-text-secondary hover:bg-bg-hover')}>
                    {tl(t, OVERRIDE_LABELS[m])}
                  </button>
                ))}
              </div>
              <p className="text-xs text-text-muted mt-1">
                {overrideMode === 'merge'   && t('remediationBindings.modeMergeHint', 'Merge: adds to inherited bindings from parent scopes.')}
                {overrideMode === 'replace' && t('remediationBindings.modeReplaceHint', 'Replace: overrides all inherited bindings at this scope.')}
                {overrideMode === 'exclude' && t('remediationBindings.modeExcludeHint', 'Exclude: disables an inherited action at this scope.')}
              </p>
            </div>

            {/* Cooldown */}
            <div>
              <label className={labelCls}>{t('remediationBindings.cooldown', 'Cooldown (seconds)')}</label>
              <input type="number" min={0} max={86400} value={cooldown}
                onChange={e => setCooldown(Number(e.target.value))}
                className={inputCls} />
              <p className="text-xs text-text-muted mt-1">{t('remediationBindings.cooldownHint', 'Minimum time between executions (0 = no cooldown)')}</p>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover transition-colors">
            {t('common.cancel', 'Cancel')}
          </button>
          <button onClick={() => void handleSave()}
            disabled={saving || (tab === 'select' && !selectedId)}
            className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors flex items-center gap-1.5">
            {saving && <Loader2 size={13} className="animate-spin" />}
            {tab === 'create'
              ? t('remediationBindings.createAndBind', 'Create & Bind')
              : t('remediationBindings.addBinding', 'Add Binding')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function RemediationBindingsPanel({
  scope,
  scopeId,
  groupId,
  title,
}: {
  scope: 'group' | 'monitor';
  scopeId: number;
  groupId?: number | null;
  title?: string;
}) {
  const { t } = useTranslation();
  const [resolved, setResolved]     = useState<ResolvedEntry[]>([]);
  const [allActions, setAllActions] = useState<RemediationAction[]>([]);
  const [directMap, setDirectMap]   = useState<Map<number, RemediationBinding>>(new Map());
  const [overrideMode, setOverrideMode] = useState<'merge' | 'replace'>('merge');
  // Tenant owning this target — only its actions can be bound / ever run here
  const [targetTenantId, setTargetTenantId] = useState<number | null>(null);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  // Server-script capability: gates the inline types and the "disabled" badges
  const [capabilities, setCapabilities] = useState<RemediationCapabilities | null>(null);

  useEffect(() => {
    remediationApi.getCapabilities().then(setCapabilities).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const [res, acts] = await Promise.all([
        remediationApi.getResolved(scope, scopeId, groupId),
        remediationApi.listActions(),
      ]);
      setResolved(res.bindings);
      setTargetTenantId(res.tenantId);
      setAllActions(acts);

      // Build direct bindings map from scope bindings
      const direct = await remediationApi.getBindings(scope, scopeId);
      const map = new Map(direct.map(b => [b.actionId, b]));
      setDirectMap(map);

      // Detect current override mode from direct non-exclude bindings (stale bindings to
      // another tenant's action — only visible in God View — never apply, so ignore them)
      const actionTenant = new Map(acts.map(a => [a.id, a.tenantId]));
      const replaceBinding = direct.find(b => {
        const tid = actionTenant.get(b.actionId);
        return b.overrideMode === 'replace' && (tid == null || tid === res.tenantId);
      });
      setOverrideMode(replaceBinding ? 'replace' : 'merge');
    } catch {
      toast.error(t('remediationBindings.failedLoad'));
    } finally {
      setLoading(false);
    }
  }, [scope, scopeId, groupId]);

  useEffect(() => { void load(); }, [load]);

  const handleAdd = async (
    actionId: number,
    triggerOn: RemediationTrigger,
    ovMode: OverrideModeR,
    cooldownSeconds: number,
  ) => {
    const binding = await remediationApi.addBinding({
      actionId,
      scope,
      scopeId,
      overrideMode: ovMode,
      triggerOn,
      cooldownSeconds,
    });
    await load();
    toast.success(t('remediationBindings.bindingAdded'));
    return binding;
  };

  const handleAddWithNew = async (
    name: string,
    type: RemediationActionType,
    config: AnyConfig,
    triggerOn: RemediationTrigger,
    ovMode: OverrideModeR,
    cooldownSeconds: number,
  ) => {
    // 1. Create the action in the target's tenant (differs from the active one only in God View)
    const newAction = await remediationApi.createAction({
      name, type, config, enabled: true,
      ...(targetTenantId != null ? { tenantId: targetTenantId } : {}),
    });
    // 2. Immediately bind it at the current scope (if the server rejects the binding,
    //    don't leave the just-created action orphaned)
    let binding: RemediationBinding;
    try {
      binding = await remediationApi.addBinding({
        actionId: newAction.id,
        scope,
        scopeId,
        overrideMode: ovMode,
        triggerOn,
        cooldownSeconds,
      });
    } catch (err) {
      await remediationApi.deleteAction(newAction.id).catch(() => {});
      throw err;
    }
    await load();
    toast.success(t('remediationBindings.actionCreatedAndBound'));
    return binding;
  };

  const handleRemoveDirect = async (actionId: number) => {
    const b = directMap.get(actionId);
    if (!b) return;
    await remediationApi.deleteBinding(b.id);
    await load();
    toast.success(t('remediationBindings.bindingRemoved'));
  };

  const handleExclude = async (actionId: number) => {
    // Exclude an inherited action by adding an 'exclude' binding at this scope
    await remediationApi.addBinding({
      actionId, scope, scopeId, overrideMode: 'exclude',
      triggerOn: 'both', cooldownSeconds: 0,
    });
    await load();
    toast.success(t('remediationBindings.actionExcluded'));
  };

  /** Action of another tenant than the target's (stale binding — never runs here; God View only) */
  const isForeignAction = (actionId: number) => {
    const tid = allActions.find(a => a.id === actionId)?.tenantId;
    return targetTenantId != null && tid != null && tid !== targetTenantId;
  };

  const handleToggleOverrideMode = async () => {
    const newMode: OverrideModeR = overrideMode === 'merge' ? 'replace' : 'merge';
    // Update all direct non-exclude bindings to the new mode
    const updates = Array.from(directMap.values())
      .filter(b => b.overrideMode !== 'exclude' && !isForeignAction(b.actionId));
    await Promise.all(updates.map(b => remediationApi.updateBinding(b.id, { overrideMode: newMode })));
    await load();
    setOverrideMode(newMode);
  };

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <Loader2 size={14} className="animate-spin" /> {t('remediationBindings.loading', 'Loading remediations…')}
        </div>
      </div>
    );
  }

  const hasDirectNonExclude = Array.from(directMap.values())
    .some(b => b.overrideMode !== 'exclude' && !isForeignAction(b.actionId));

  // Build display list: all known actions + their status from resolved
  const resolvedByActionId = new Map(resolved.map(r => [r.actionId, r]));

  // Collect all action IDs we know about (from resolved + direct)
  const allActionIds = new Set([
    ...resolved.map(r => r.actionId),
    ...Array.from(directMap.keys()),
  ]);
  const allActionsById = new Map(allActions.map(a => [a.id, a]));

  return (
    <div className="rounded-xl border border-border bg-bg-secondary p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide flex items-center gap-1.5">
          <ShieldCheck size={12} /> {title ?? t('remediations.title', 'Remediations')}
        </h3>
        <div className="flex items-center gap-2">
          {hasDirectNonExclude && (
            <button type="button" onClick={() => void handleToggleOverrideMode()}
              className={cn(
                'text-xs px-2 py-1 rounded-lg border font-medium transition-colors',
                overrideMode === 'replace'
                  ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                  : 'border-border text-text-muted hover:bg-bg-hover',
              )}
              title={overrideMode === 'replace'
                ? t('remediationBindings.replaceModeTitle', 'Replace mode: parent bindings are ignored. Click to switch to Merge')
                : t('remediationBindings.mergeModeTitle', 'Merge mode: adds to parent bindings. Click to switch to Replace')}>
              {tl(t, OVERRIDE_LABELS[overrideMode])}
            </button>
          )}
          <button type="button" onClick={() => setShowAdd(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border text-text-secondary hover:bg-bg-hover transition-colors">
            <Plus size={11} /> {t('remediationBindings.bind', 'Bind')}
          </button>
        </div>
      </div>

      {overrideMode === 'replace' && (
        <div className="flex items-start gap-2 mb-3 rounded-lg border border-orange-500/30 bg-orange-500/10 p-2.5 text-xs text-orange-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t('remediationBindings.replaceActive', 'Replace mode active — inherited bindings from parent scopes are ignored.')}
        </div>
      )}

      {/* Binding list */}
      {allActionIds.size === 0 ? (
        <div className="text-center py-6 text-text-muted text-sm">
          <ShieldCheck size={24} className="mx-auto mb-2 opacity-30" />
          {t('remediationBindings.empty', 'No remediations configured')}
        </div>
      ) : (
        <div className="divide-y divide-border/50">
          {Array.from(allActionIds).map(actionId => {
            const resolvedEntry = resolvedByActionId.get(actionId);
            const directBinding = directMap.get(actionId);
            const action = resolvedEntry?.action ?? allActionsById.get(actionId);
            if (!action) return null;

            const isForeign   = !!directBinding && isForeignAction(actionId);
            const isExcluded  = !isForeign && directBinding?.overrideMode === 'exclude';
            const isDirect    = !isForeign && !!directBinding && !isExcluded;
            const isInherited = !directBinding && !!resolvedEntry;

            return (
              <div key={actionId} className={cn(
                'flex items-center gap-3 py-2.5',
                (isExcluded || isForeign) && 'opacity-50',
              )}>
                {/* Status icon */}
                <span className={cn(
                  'shrink-0',
                  isDirect    ? 'text-accent'     :
                  isExcluded  ? 'text-orange-400' :
                  isInherited ? 'text-text-muted' : 'text-text-muted',
                )}>
                  <ShieldCheck size={13} />
                </span>

                {/* Action info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm text-text-primary">{anonymize(action.name)}</span>
                    <span className="text-[10px] bg-bg-tertiary text-text-muted px-1.5 py-0.5 rounded-full">
                      {ACTION_TYPE_SHORT[action.type] ?? action.type}
                    </span>
                    {/* Source badge — show for all resolved entries */}
                    {resolvedEntry && (() => {
                      const badge = SOURCE_BADGE[resolvedEntry.source];
                      return badge ? (
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', badge.className)}>
                          {tl(t, badge.label)}
                        </span>
                      ) : null;
                    })()}
                    {isExcluded && (
                      <span className="text-[10px] bg-orange-500/10 text-orange-400 px-1.5 py-0.5 rounded-full">{t('remediationBindings.excluded', 'Excluded')}</span>
                    )}
                    {isDisabledOnServer(action.type, capabilities) && (
                      <span className="text-[10px] bg-status-down/10 text-status-down px-1.5 py-0.5 rounded-full"
                        title={t('remediations.serverDisabledBadgeTitle', 'REMEDIATION_ALLOW_SERVER_SCRIPTS=false: this action does not run')}>
                        {t('remediations.serverDisabledBadge', 'Disabled on this server')}
                      </span>
                    )}
                    {isForeign && (
                      <span className="text-[10px] bg-status-down/10 text-status-down px-1.5 py-0.5 rounded-full"
                        title={t('remediationBindings.foreignTitle', 'This action belongs to another workspace and never runs for this target')}>
                        {t('remediationBindings.foreignBadge', 'Other workspace — inactive')}
                      </span>
                    )}
                  </div>
                  {/* Trigger + cooldown info */}
                  {(isDirect || isInherited) && resolvedEntry && (
                    <div className="flex items-center gap-2 text-[11px] text-text-muted mt-0.5">
                      {resolvedEntry.triggerOn === 'down' && <span className="flex items-center gap-0.5"><ArrowDown size={9} /> DOWN</span>}
                      {resolvedEntry.triggerOn === 'up'   && <span className="flex items-center gap-0.5"><ArrowUp size={9} /> UP</span>}
                      {resolvedEntry.triggerOn === 'both' && <span>DOWN + UP</span>}
                      {resolvedEntry.cooldownSeconds > 0 && (
                        <span>• {t('remediationBindings.cooldownBadge', { defaultValue: '{{seconds}}s cooldown', seconds: resolvedEntry.cooldownSeconds })}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {(isDirect || isForeign) && (
                    <button onClick={() => void handleRemoveDirect(actionId)}
                      className="p-1 rounded text-text-muted hover:text-status-down hover:bg-status-down/10 transition-colors"
                      title={t('remediationBindings.removeDirect', 'Remove direct binding')}
                      aria-label={t('remediationBindings.removeDirect', 'Remove direct binding')}>
                      <X size={12} />
                    </button>
                  )}
                  {isInherited && !isExcluded && (
                    <button onClick={() => void handleExclude(actionId)}
                      className="text-xs px-2 py-0.5 rounded border border-border text-text-muted hover:bg-bg-hover transition-colors"
                      title={t('remediationBindings.excludeTitle', 'Exclude at this scope — disable this inherited action here')}>
                      {t('remediationBindings.exclude', 'Exclude')}
                    </button>
                  )}
                  {isExcluded && (
                    <button onClick={() => void handleRemoveDirect(actionId)}
                      className="text-xs px-2 py-0.5 rounded border border-orange-500/30 text-orange-400 hover:bg-orange-500/10 transition-colors"
                      title={t('remediationBindings.reinheritTitle', 'Remove exclusion (re-inherit)')}>
                      {t('remediationBindings.reinherit', 'Re-inherit')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add binding modal — only the target tenant's actions can be bound (God View lists every tenant's) */}
      {showAdd && (
        <AddBindingModal
          actions={allActions.filter(a => a.enabled
            && (targetTenantId == null || a.tenantId == null || a.tenantId === targetTenantId))}
          capabilities={capabilities}
          onAdd={handleAdd}
          onAddWithNew={handleAddWithNew}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}

export default RemediationBindingsPanel;
