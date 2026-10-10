import { useState, useEffect, useId } from 'react';
import {
  Plus, Pencil, Trash2, ShieldCheck, Zap, Globe, History,
  Loader2, ChevronDown, ChevronUp, KeyRound, AlertTriangle, ServerOff,
} from 'lucide-react';
import type {
  RemediationAction,
  RemediationBinding,
  RemediationActionType,
  WebhookRemediationConfig,
  ScriptRemediationConfig,
  DockerRestartRemediationConfig,
  SshRemediationConfig,
} from '@obliview/shared';
import {
  remediationApi,
  isServerExecutedActionType,
  type RemediationCapabilities,
  type PinnedSshRemediationConfig,
  type SshHostKeyFingerprint,
} from '../api/remediation.api';
import { anonymize } from '../utils/anonymize';
import { apiErrorMessage, apiErrorCode } from '../utils/apiError';
import { Button } from '../components/common/Button';
import { Input } from '../components/common/Input';
import { Modal } from '../components/common/Modal';
import { IconButton } from '../components/common/IconButton';
import { PageContainer } from '../components/common/PageContainer';
import { ToggleSwitch } from '../components/common/ToggleSwitch';
import { TenantBadge } from '../components/common/TenantBadge';
import { useConfirm } from '../components/common/ConfirmDialog';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// ─── Type metadata ─────────────────────────────────────────────────────────────

const ACTION_TYPES: RemediationActionType[] = ['webhook', 'n8n', 'script', 'docker_restart', 'ssh'];

/** Translated label + description of each action type (locale keys remediations.type* / desc*). */
function useActionTypeMeta(): Record<RemediationActionType, { label: string; description: string }> {
  const { t } = useTranslation();
  return {
    webhook: {
      label: t('remediations.typeWebhook', 'Generic Webhook'),
      description: t('remediations.descWebhook', 'HTTP request to any endpoint'),
    },
    n8n: {
      label: t('remediations.typeN8n', 'N8N Workflow'),
      description: t('remediations.descN8n', 'Trigger an N8N workflow via webhook'),
    },
    script: {
      label: t('remediations.typeScript', 'Custom Script'),
      description: t('remediations.descScript', 'Run a shell script on the server'),
    },
    docker_restart: {
      label: t('remediations.typeDocker', 'Docker Restart'),
      description: t('remediations.descDocker', 'Restart a Docker container'),
    },
    ssh: {
      label: t('remediations.typeSsh', 'SSH Command'),
      description: t('remediations.descSsh', 'Run a command on a remote host via SSH'),
    },
  };
}

/** Script / SSH / Docker actions can be created and edited from here */
function canManageServerTypes(caps: RemediationCapabilities | null): boolean {
  return !!caps && caps.serverScriptsEnabled && caps.canManageServerActions;
}

function ServerDisabledBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down shrink-0"
      title={t('remediations.serverDisabledBadgeTitle', 'REMEDIATION_ALLOW_SERVER_SCRIPTS=false: this action does not run')}>
      <ServerOff size={10} /> {t('remediations.serverDisabledBadge', 'Disabled on this server')}
    </span>
  );
}

// ─── Config editors ────────────────────────────────────────────────────────────

function WebhookForm({
  config, onChange, isN8n,
}: {
  config: Partial<WebhookRemediationConfig>;
  onChange: (c: Partial<WebhookRemediationConfig>) => void;
  isN8n?: boolean;
}) {
  return (
    <div className="space-y-3">
      <Input label={isN8n ? 'N8N Webhook URL' : 'URL'} type="url" required
        value={config.url ?? ''} onChange={e => onChange({ ...config, url: e.target.value })}
        placeholder="https://..." />
      {!isN8n && (
        <div>
          <label className="block text-xs font-medium text-text-secondary mb-1">Method</label>
          <select value={config.method ?? 'POST'} onChange={e => onChange({ ...config, method: e.target.value as WebhookRemediationConfig['method'] })}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
            {['POST', 'GET', 'PUT', 'PATCH'].map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
      )}
      <Input label="Timeout (ms)" type="number" min={1000} max={60000}
        value={String(config.timeoutMs ?? 10000)}
        onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} />
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Extra Headers <span className="font-normal text-text-muted">(JSON object)</span>
        </label>
        <textarea rows={2}
          value={config.headers ? JSON.stringify(config.headers, null, 2) : ''}
          onChange={e => {
            try { onChange({ ...config, headers: JSON.parse(e.target.value || '{}') }); } catch { /* ignore */ }
          }}
          placeholder='{"Authorization": "Bearer ..."}'
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono text-xs" />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          Extra body fields <span className="font-normal text-text-muted">(JSON, merged with event payload)</span>
        </label>
        <textarea rows={2}
          value={config.bodyExtra ? JSON.stringify(config.bodyExtra, null, 2) : ''}
          onChange={e => {
            try { onChange({ ...config, bodyExtra: JSON.parse(e.target.value || '{}') }); } catch { /* ignore */ }
          }}
          placeholder='{"token": "abc"}'
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-none font-mono text-xs" />
      </div>
    </div>
  );
}

function ScriptForm({ config, onChange }: {
  config: Partial<ScriptRemediationConfig>;
  onChange: (c: Partial<ScriptRemediationConfig>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Script</label>
        <textarea rows={6} required
          value={config.script ?? ''}
          onChange={e => onChange({ ...config, script: e.target.value })}
          placeholder={'#!/bin/sh\n# Available env vars: MONITOR_ID, MONITOR_NAME, STATUS, PREV_STATUS, TRIGGER\necho "Monitor $MONITOR_NAME is $STATUS"'}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono text-xs" />
        <p className="text-xs text-text-muted mt-1">
          {t(
            'remediations.scriptEnvNote',
            'The script only inherits PATH, HOME, LANG and TZ from the server environment, plus MONITOR_ID, MONITOR_NAME, MONITOR_URL, MONITOR_TYPE, STATUS, PREV_STATUS, TRIGGERED_AT and TRIGGER.',
          )}
        </p>
      </div>
      <Input label="Shell" value={config.shell ?? '/bin/sh'}
        onChange={e => onChange({ ...config, shell: e.target.value })}
        placeholder="/bin/sh" />
      <Input label="Timeout (ms)" type="number" min={1000} max={120000}
        value={String(config.timeoutMs ?? 30000)}
        onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} />
    </div>
  );
}

function DockerForm({ config, onChange }: {
  config: Partial<DockerRestartRemediationConfig>;
  onChange: (c: Partial<DockerRestartRemediationConfig>) => void;
}) {
  return (
    <div className="space-y-3">
      <Input label="Container Name" required
        value={config.containerName ?? ''}
        onChange={e => onChange({ ...config, containerName: e.target.value })}
        placeholder="my-nginx" />
      <Input label="Docker Socket Path"
        value={config.socketPath ?? '/var/run/docker.sock'}
        onChange={e => onChange({ ...config, socketPath: e.target.value })}
        placeholder="/var/run/docker.sock" />
    </div>
  );
}

function SshForm({
  config, onChange, isEdit,
}: {
  config: Partial<PinnedSshRemediationConfig & { credential?: string }>;
  onChange: (c: Partial<PinnedSshRemediationConfig & { credential?: string }>) => void;
  isEdit?: boolean;
}) {
  const { t } = useTranslation();
  const [fetching, setFetching] = useState(false);
  // Fingerprint fetched for `endpoint` (ignored once host or port changes)
  const [fetchedFor, setFetchedFor] = useState<(SshHostKeyFingerprint & { endpoint: string }) | null>(null);
  const pinned = config.hostKeySha256 || null;
  const endpoint = `${config.host?.trim() ?? ''}:${config.port ?? 22}`;
  const fetched = fetchedFor && fetchedFor.endpoint === endpoint ? fetchedFor : null;

  // A pinned key belongs to one host:port — changing either unpins it
  const setEndpoint = (patch: Partial<PinnedSshRemediationConfig>) => {
    setFetchedFor(null);
    onChange({ ...config, ...patch, hostKeySha256: '' });
  };

  const fetchFingerprint = async () => {
    const host = config.host?.trim();
    if (!host) return;
    const forEndpoint = endpoint;
    setFetching(true);
    setFetchedFor(null);
    try {
      const fp = await remediationApi.fetchSshFingerprint(host, config.port ?? 22);
      setFetchedFor({ ...fp, endpoint: forEndpoint });
    } catch (err) {
      toast.error(apiErrorMessage(err, t('remediations.sshFingerprintFailed', 'Could not fetch the host key fingerprint')));
    } finally {
      setFetching(false);
    }
  };

  const pinFetched = () => {
    if (!fetched) return;
    onChange({ ...config, hostKeySha256: fetched.fingerprint });
    setFetchedFor(null);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <Input label="Host" required
            value={config.host ?? ''}
            onChange={e => setEndpoint({ host: e.target.value })}
            placeholder="192.168.1.10" />
        </div>
        <Input label="Port" type="number" min={1} max={65535}
          value={String(config.port ?? 22)}
          onChange={e => setEndpoint({ port: Number(e.target.value) })} />
      </div>

      {/* Host key pinning */}
      <div className="rounded-lg border border-border bg-bg-secondary p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-text-secondary flex items-center gap-1.5">
            <KeyRound size={12} /> {t('remediations.sshHostKey', 'Host key')}
          </span>
          <Button type="button" size="sm" variant="secondary" loading={fetching}
            disabled={!config.host?.trim()}
            onClick={() => void fetchFingerprint()}>
            {t('remediations.sshFetchFingerprint', 'Fetch fingerprint')}
          </Button>
        </div>
        {pinned ? (
          <p className="text-xs text-text-muted break-all">
            {t('remediations.sshPinned', 'Pinned:')}{' '}
            <code className="font-mono text-text-primary">{pinned}</code>
          </p>
        ) : (
          <p className="text-xs text-yellow-400 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {t(
              'remediations.sshNotPinned',
              'A host key pin is required: the SSH action is not saved and does not run until a host key is pinned. Fetch the fingerprint, check it against the server, then pin it.',
            )}
          </p>
        )}
        {fetched && (
          <div className="rounded-md border border-accent/40 bg-accent/5 p-2 space-y-2">
            <p className="text-xs text-text-secondary">
              {t('remediations.sshFetchedFingerprint', {
                defaultValue: 'The server presented this {{keyType}} host key. Check it against the server (ssh-keygen -lf on its host key) before pinning it.',
                keyType: fetched.keyType ?? 'SSH',
              })}
            </p>
            <code className="block font-mono text-xs text-text-primary break-all">{fetched.fingerprint}</code>
            {pinned && pinned !== fetched.fingerprint && (
              <p className="text-xs text-status-down">
                {t('remediations.sshFingerprintDiffers', 'This key differs from the pinned one.')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setFetchedFor(null)}>
                {t('common.cancel')}
              </Button>
              <Button type="button" size="sm" onClick={pinFetched} disabled={pinned === fetched.fingerprint}>
                {t('remediations.sshPinKey', 'Pin this key')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <Input label="Username" required
        value={config.username ?? ''}
        onChange={e => onChange({ ...config, username: e.target.value })}
        placeholder="root" />
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">Auth Type</label>
        <select value={config.authType ?? 'password'}
          onChange={e => onChange({ ...config, authType: e.target.value as 'password' | 'key' })}
          className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent">
          <option value="password">Password</option>
          <option value="key">Private Key</option>
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {config.authType === 'key' ? 'Private Key' : 'Password'}
          {isEdit && <span className="ml-1 text-text-muted font-normal">(leave blank to keep existing)</span>}
        </label>
        {config.authType === 'key' ? (
          <textarea rows={4}
            value={config.credential ?? ''}
            onChange={e => onChange({ ...config, credential: e.target.value })}
            placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono text-xs" />
        ) : (
          <input type="password" autoComplete="new-password"
            value={config.credential ?? ''}
            onChange={e => onChange({ ...config, credential: e.target.value })}
            className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
        )}
      </div>
      <Input label="Command" required
        value={config.command ?? ''}
        onChange={e => onChange({ ...config, command: e.target.value })}
        placeholder="sudo systemctl restart nginx" />
      <p className="text-xs text-text-muted">
        {t(
          'remediations.sshEnvNote',
          'Env vars: MONITOR_ID, MONITOR_NAME (letters, digits, spaces and ._:/@+=,- only — others become _), MONITOR_NAME_B64 (exact name, base64), STATUS, PREV_STATUS, TRIGGER',
        )}
      </p>
      <Input label="Timeout (ms)" type="number" min={1000} max={60000}
        value={String(config.timeoutMs ?? 15000)}
        onChange={e => onChange({ ...config, timeoutMs: Number(e.target.value) })} />
      <p className="text-xs text-text-muted">{t('remediations.credentialsNote')}</p>
    </div>
  );
}

// ─── Action modal ─────────────────────────────────────────────────────────────

type AnyConfig = Record<string, unknown>;

function ActionModal({
  initial, capabilities, onSave, onClose,
}: {
  initial?: RemediationAction;
  capabilities: RemediationCapabilities | null;
  onSave: (name: string, type: RemediationActionType, config: AnyConfig, enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const typeMeta = useActionTypeMeta();
  // Script / SSH / Docker are offered only when they may run here and the caller may manage them
  const allowServerTypes = canManageServerTypes(capabilities);
  const availableTypes = ACTION_TYPES.filter(tp => allowServerTypes || !isServerExecutedActionType(tp));
  const [type, setType] = useState<RemediationActionType>(initial?.type ?? 'webhook');
  const [name, setName] = useState(initial?.name ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [config, setConfig] = useState<AnyConfig>(() => {
    if (!initial) return { method: 'POST', timeoutMs: 10000 };
    const c = { ...(initial.config as unknown as AnyConfig) };
    // Remove masked credential
    if (c.credentialEnc === '[set]') delete c.credentialEnc;
    return c;
  });
  const [saving, setSaving] = useState(false);
  // SSH actions never trust a host key on first use: a pin is required to save.
  const sshPinMissing = type === 'ssh' && !String(config.hostKeySha256 ?? '').trim();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sshPinMissing) return;
    setSaving(true);
    try {
      await onSave(name, type, config, enabled);
    } finally {
      setSaving(false);
    }
  };

  const renderConfigForm = () => {
    switch (type) {
      case 'webhook':
        return <WebhookForm config={config as Partial<WebhookRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} />;
      case 'n8n':
        return <WebhookForm config={config as Partial<WebhookRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} isN8n />;
      case 'script':
        return <ScriptForm config={config as Partial<ScriptRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} />;
      case 'docker_restart':
        return <DockerForm config={config as Partial<DockerRestartRemediationConfig>} onChange={c => setConfig(c as AnyConfig)} />;
      case 'ssh':
        return <SshForm config={config as Partial<PinnedSshRemediationConfig & { credential?: string }>} onChange={c => setConfig(c as AnyConfig)} isEdit={!!initial} />;
      default:
        return null;
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? t('remediations.editAction') : t('remediations.newAction')}
      icon={<ShieldCheck size={16} className="text-accent" />}
      size="md"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} type="button">{t('common.cancel')}</Button>
          <Button type="submit" form={formId} loading={saving} disabled={sshPinMissing}>
            {initial ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <Input label={t('remediations.nameLabel')} required value={name} onChange={e => setName(e.target.value)} placeholder={t('remediations.namePlaceholder')} />

        {/* Type selector — only for new actions */}
        {!initial && (
          <div>
            <label className="block text-xs font-medium text-text-secondary mb-2">{t('remediations.actionType')}</label>
            <div className="grid grid-cols-1 gap-2">
              {availableTypes.map(t_ => (
                <label key={t_} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  type === t_
                    ? 'border-accent bg-accent/5'
                    : 'border-border hover:border-accent/50 hover:bg-bg-hover'
                }`}>
                  <input type="radio" name="actionType" value={t_} checked={type === t_}
                    onChange={() => { setType(t_); setConfig({}); }} className="mt-0.5 accent-accent" />
                  <div>
                    <div className="text-sm font-medium text-text-primary">{typeMeta[t_].label}</div>
                    <div className="text-xs text-text-muted">{typeMeta[t_].description}</div>
                  </div>
                </label>
              ))}
            </div>
            {!allowServerTypes && capabilities && (
              <p className="mt-2 text-xs text-text-muted flex items-start gap-1.5">
                <ServerOff size={12} className="mt-0.5 shrink-0" />
                {!capabilities.serverScriptsEnabled
                  ? t('remediations.serverTypesDisabledHint', 'Script, SSH and Docker actions are disabled on this server.')
                  : t('remediations.serverTypesMasterOnlyHint', 'Script, SSH and Docker actions can only be managed by a platform admin in the master workspace.')}
              </p>
            )}
          </div>
        )}

        {/* Enabled toggle */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-secondary">{t('remediations.enabledLabel')}</span>
          <ToggleSwitch
            checked={enabled}
            onChange={setEnabled}
            ariaLabel={t('remediations.enabledLabel')}
          />
        </div>

        <div className="border-t border-border pt-4">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-3">
            {t('remediations.sectionConfig', { type: typeMeta[type].label })}
          </p>
          {renderConfigForm()}
        </div>
      </form>
    </Modal>
  );
}

// ─── Global Bindings inline panel ─────────────────────────────────────────────

function GlobalBindingsPanel({ actions, capabilities }: {
  actions: RemediationAction[];
  capabilities: RemediationCapabilities | null;
}) {
  const { t } = useTranslation();
  const typeMeta = useActionTypeMeta();
  const [bindings, setBindings] = useState<RemediationBinding[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    remediationApi.getBindings('global', null)
      .then(setBindings)
      .catch(() => {});
  }, []);

  const isBound = (actionId: number) => bindings.some(b => b.actionId === actionId);

  const toggle = async (actionId: number) => {
    setBusyId(actionId);
    try {
      const existing = bindings.find(b => b.actionId === actionId);
      if (existing) {
        await remediationApi.deleteBinding(existing.id);
        setBindings(prev => prev.filter(b => b.actionId !== actionId));
        toast.success(t('remediations.removedFromGlobal'));
      } else {
        const nb = await remediationApi.addBinding({
          actionId, scope: 'global', overrideMode: 'merge', triggerOn: 'down', cooldownSeconds: 300,
        });
        setBindings(prev => [...prev, nb]);
        toast.success(t('remediations.addedToGlobal'));
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, t('remediations.failedAddBinding')));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-bg-secondary">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-text-primary hover:bg-bg-hover transition-colors rounded-lg">
        <span className="flex items-center gap-2">
          <Globe size={14} className="text-text-muted" />
          {t('remediations.globalBindings')}
          {bindings.length > 0 && (
            <span className="rounded-full bg-accent/10 text-accent text-xs px-2 py-0.5 font-medium">
              {bindings.length}
            </span>
          )}
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-4 pb-4 border-t border-border space-y-1 pt-3">
          <p className="text-xs text-text-muted mb-2">
            {t('remediations.globalBindingsDesc')}{' '}
            {t('remediations.globalBindingsTenantNote', 'Each action only runs for monitors of its own workspace.')}
          </p>
          {actions.length === 0 && (
            <p className="text-xs text-text-muted">{t('remediations.noActions')}</p>
          )}
          {actions.map(a => (
            <div key={a.id} className="flex items-center justify-between gap-2 py-1">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-sm text-text-primary truncate">{anonymize(a.name)}</span>
                <span className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded-full shrink-0">
                  {typeMeta[a.type].label}
                </span>
                <TenantBadge tenantId={a.tenantId} />
                {capabilities && !capabilities.serverScriptsEnabled && isServerExecutedActionType(a.type) && (
                  <ServerDisabledBadge />
                )}
              </div>
              <button
                type="button"
                onClick={() => void toggle(a.id)}
                disabled={busyId === a.id}
                aria-pressed={isBound(a.id)}
                className={`shrink-0 rounded-md px-2 py-1 coarse:px-3 coarse:py-2 text-xs font-medium transition-colors disabled:opacity-40 ${
                  isBound(a.id)
                    ? 'bg-accent/10 text-accent hover:bg-accent/20'
                    : 'text-text-muted border border-border hover:bg-bg-hover'
                }`}>
                {busyId === a.id ? <Loader2 size={11} className="animate-spin" /> : isBound(a.id) ? t('remediations.globalActive') : t('remediations.addToGlobal')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

/** Hover-revealed on mouse devices, always visible on touch (and while focused). */
const hoverRevealCls =
  'can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100 transition-opacity';

export function AdminRemediationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const typeMeta = useActionTypeMeta();
  const [actions, setActions]   = useState<RemediationAction[]>([]);
  const [loading, setLoading]   = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing]   = useState<RemediationAction | undefined>(undefined);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<number | null>(null);
  // null until loaded (or on failure): script / SSH / Docker are then not offered
  const [capabilities, setCapabilities] = useState<RemediationCapabilities | null>(null);

  const load = async () => {
    try {
      const a = await remediationApi.listActions();
      setActions(a);
    } catch {
      toast.error(t('remediations.failedLoad'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    remediationApi.getCapabilities().then(setCapabilities).catch(() => {});
  }, []);

  const openCreate = () => { setEditing(undefined); setShowModal(true); };
  const openEdit   = (a: RemediationAction) => { setEditing(a); setShowModal(true); };

  /** Script / SSH / Docker actions are read-only unless they may run here and the caller may manage them */
  const editBlockedReason = (a: RemediationAction): string | null => {
    if (!isServerExecutedActionType(a.type) || !capabilities) return null;
    if (!capabilities.serverScriptsEnabled) {
      return t('remediations.serverTypesDisabledHint', 'Script, SSH and Docker actions are disabled on this server.');
    }
    if (!capabilities.canManageServerActions) {
      return t('remediations.serverTypesMasterOnlyHint', 'Script, SSH and Docker actions can only be managed by a platform admin in the master workspace.');
    }
    return null;
  };

  const handleSave = async (name: string, type: RemediationActionType, config: AnyConfig, enabled: boolean) => {
    try {
      if (editing) {
        const updated = await remediationApi.updateAction(editing.id, { name, config, enabled });
        setActions(prev => prev.map(a => a.id === editing.id ? updated : a));
        toast.success(t('remediations.updated'));
      } else {
        const created = await remediationApi.createAction({ name, type, config, enabled });
        setActions(prev => [...prev, created]);
        toast.success(t('remediations.created'));
      }
      setShowModal(false);
    } catch (err) {
      if (apiErrorCode(err) === 'SERVER_SCRIPTS_DISABLED') {
        setCapabilities(c => (c ? { ...c, serverScriptsEnabled: false } : c));
        toast.error(t('remediations.serverTypesDisabledHint', 'Script, SSH and Docker actions are disabled on this server.'));
      } else {
        toast.error(apiErrorMessage(err, t('remediations.failedSave')));
      }
    }
  };

  const handleDelete = async (action: RemediationAction) => {
    if (!(await confirm({
      title: anonymize(action.name),
      message: t('remediations.confirmDelete'),
      danger: true,
    }))) return;
    setDeleting(action.id);
    try {
      await remediationApi.deleteAction(action.id);
      setActions(prev => prev.filter(a => a.id !== action.id));
      toast.success(t('remediations.deleted'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('remediations.failedDelete')));
    } finally {
      setDeleting(null);
    }
  };

  const description = t(
    'remediations.description',
    'Automated actions (webhook, script, SSH, Docker restart) run when a monitor or an agent changes status.',
  );

  return (
    <PageContainer embedded={embedded} className="space-y-6">
      {/* Header — the h1 is dropped when embedded (PoliciesPage renders its own) */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {!embedded && (
            <h1 className="text-2xl font-semibold text-text-primary">{t('remediations.title')}</h1>
          )}
          <p className={embedded ? 'text-sm text-text-muted' : 'mt-1 text-sm text-text-muted'}>{description}</p>
        </div>
        <Button size="sm" onClick={openCreate} className="shrink-0">
          <Plus size={16} className="mr-1.5" />
          {t('remediations.newAction')}
        </Button>
      </div>

      {/* Global Bindings panel */}
      <GlobalBindingsPanel actions={actions} capabilities={capabilities} />

      {/* Actions list */}
      <div className="rounded-lg border border-border bg-bg-secondary">
        {loading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 size={24} className="animate-spin text-text-muted" />
          </div>
        ) : actions.length === 0 ? (
          <div className="py-12 text-center">
            <ShieldCheck size={32} className="mx-auto mb-3 text-text-muted opacity-40" />
            <p className="text-text-muted">{t('remediations.noActions')}</p>
            <p className="text-sm text-text-muted mt-1">
              {t('remediations.noActionsDesc', 'Create actions to automate the response to monitor and agent failures.')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {actions.map(action => {
              const blocked = editBlockedReason(action);
              return (
                <div key={action.id} className="px-3 sm:px-4 py-3 group">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Zap size={13} className="text-amber-400 shrink-0" />
                        <span className="text-sm font-medium text-text-primary break-words">{anonymize(action.name)}</span>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                          {typeMeta[action.type].label}
                        </span>
                        <TenantBadge tenantId={action.tenantId} />
                        {capabilities && !capabilities.serverScriptsEnabled && isServerExecutedActionType(action.type) && (
                          <ServerDisabledBadge />
                        )}
                        {!action.enabled && (
                          <span className="rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down">
                            {t('status.disabled')}
                          </span>
                        )}
                      </div>
                      {/* Config summary */}
                      <div className="text-xs text-text-muted mt-0.5 truncate">
                        {action.type === 'webhook' || action.type === 'n8n'
                          ? (action.config as WebhookRemediationConfig).url
                          : action.type === 'script'
                          ? `${(action.config as ScriptRemediationConfig).shell ?? '/bin/sh'}`
                          : action.type === 'docker_restart'
                          ? (action.config as DockerRestartRemediationConfig).containerName
                          : action.type === 'ssh'
                          ? `${(action.config as SshRemediationConfig).username}@${(action.config as SshRemediationConfig).host}`
                          : ''}
                      </div>
                    </div>

                    <div className={`flex items-center gap-1 shrink-0 ${hoverRevealCls}`}>
                      <IconButton
                        label={t('remediations.viewRuns', 'Run history')}
                        icon={<History size={14} />}
                        active={expandedRuns === action.id}
                        aria-expanded={expandedRuns === action.id}
                        onClick={() => setExpandedRuns(expandedRuns === action.id ? null : action.id)}
                      />
                      <IconButton
                        label={blocked ?? t('common.edit')}
                        icon={<Pencil size={14} />}
                        disabled={blocked !== null}
                        onClick={() => openEdit(action)}
                        className="disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-text-muted"
                      />
                      <IconButton
                        label={t('common.delete')}
                        icon={deleting === action.id
                          ? <Loader2 size={14} className="animate-spin" />
                          : <Trash2 size={14} />}
                        variant="danger"
                        disabled={deleting === action.id}
                        onClick={() => void handleDelete(action)}
                        className="disabled:opacity-40"
                      />
                    </div>
                  </div>

                  {/* Run history expand */}
                  {expandedRuns === action.id && <RunHistory actionId={action.id} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <ActionModal
          initial={editing}
          capabilities={capabilities}
          onSave={handleSave}
          onClose={() => setShowModal(false)}
        />
      )}
    </PageContainer>
  );
}

// ─── Run history sub-component ────────────────────────────────────────────────

function RunHistory({ actionId }: { actionId: number }) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<import('@obliview/shared').RemediationRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    remediationApi.getRunsForAction(actionId).then(setRuns).catch(() => {}).finally(() => setLoading(false));
  }, [actionId]);

  const statusColor = (s: string) => {
    if (s === 'success') return 'text-status-up';
    if (s === 'cooldown_skip') return 'text-text-muted';
    if (s === 'timeout') return 'text-yellow-400';
    return 'text-status-down';
  };

  return (
    <div className="mt-2 ml-5 border-l-2 border-border pl-3 space-y-1">
      {loading && <p className="text-xs text-text-muted animate-pulse">{t('common.loading')}</p>}
      {!loading && runs.length === 0 && <p className="text-xs text-text-muted">{t('remediations.noRuns', 'No runs yet')}</p>}
      {runs.slice(0, 10).map(r => (
        <div key={r.id} className="flex flex-wrap items-start gap-x-2 gap-y-0.5 text-xs py-0.5">
          <span className={`font-medium shrink-0 ${statusColor(r.status)}`}>{r.status}</span>
          <span className="text-text-muted shrink-0">•</span>
          <span className="text-text-muted shrink-0">
            {r.triggeredBy === 'down' ? '↓' : '↑'} {t('remediations.runMonitor', 'monitor {{id}}', { id: r.monitorId })}
          </span>
          {r.durationMs != null && <span className="text-text-muted shrink-0">{r.durationMs}ms</span>}
          {r.error && <span className="text-status-down truncate">{r.error}</span>}
          <span className="text-text-muted ml-auto shrink-0">{new Date(r.triggeredAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

export default AdminRemediationsPage;
