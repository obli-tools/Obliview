import { useState, useEffect, useRef, useId, type FormEvent } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Bell,
  TestTube2,
  Zap,
  Loader2,
  Building2,
  ChevronDown,
  ChevronRight,
  X,
} from 'lucide-react';
import type {
  NotificationChannel,
  NotificationPluginMeta,
  NotificationBinding,
  SmtpServer,
} from '@obliview/shared';
import { notificationsApi } from '@/api/notifications.api';
import { smtpServerApi } from '@/api/smtpServer.api';
import { useIsGodView } from '@/hooks/useIsGodView';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu } from '@/components/common/ActionMenu';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantBadge } from '@/components/common/TenantBadge';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Checkbox } from '@/components/ui/Checkbox';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useTenantStore } from '@/store/tenantStore';
import { anonymize } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';

/** Display name of a tenant from the store (translated fallback while it loads). */
function useTenantName() {
  const { t } = useTranslation();
  const tenants = useTenantStore((s) => s.tenants);
  return (id: number) =>
    tenants.find((tn) => tn.id === id)?.name ?? t('ui.tenant.fallback', 'Tenant {{id}}', { id });
}

// ── Tenant sharing panel (per channel) ──────────────────────────────────────

interface TenantSharingPanelProps {
  channelId: number;
  /** Owner workspace of the channel (never offered as a share target). */
  ownerTenantId: number | null;
}

function TenantSharingPanel({ channelId, ownerTenantId }: TenantSharingPanelProps) {
  const { t } = useTranslation();
  const { tenants } = useTenantStore();
  const tenantName = useTenantName();
  const [sharedTenantIds, setSharedTenantIds] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingId, setAddingId] = useState<number | ''>('');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    setLoading(true);
    notificationsApi.getChannelTenants(channelId)
      .then((ids) => {
        if (isMounted.current) {
          setSharedTenantIds(ids);
          setLoading(false);
        }
      })
      .catch(() => {
        if (isMounted.current) setLoading(false);
      });
    return () => { isMounted.current = false; };
  }, [channelId]);

  const applyChange = async (newIds: number[]) => {
    setSaving(true);
    try {
      await notificationsApi.setChannelTenants(channelId, newIds);
      setSharedTenantIds(newIds);
    } catch {
      toast.error(t('notifications.failedTenantAssign'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = (tenantId: number) => {
    if (!sharedTenantIds) return;
    applyChange(sharedTenantIds.filter((id) => id !== tenantId));
  };

  const handleAdd = () => {
    if (!addingId || !sharedTenantIds) return;
    const id = Number(addingId);
    if (sharedTenantIds.includes(id)) return;
    applyChange([...sharedTenantIds, id]);
    setAddingId('');
  };

  // Available: exclude the channel's owner tenant and already-shared ones
  const availableTenants = tenants.filter(
    (tn) => tn.id !== ownerTenantId && !(sharedTenantIds ?? []).includes(tn.id),
  );

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-1.5 px-3 py-2 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-border bg-bg-primary px-3 py-2.5 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {t('notifications.sharedWith')}
      </p>

      {/* Current shared tenants */}
      <div className="flex flex-wrap gap-1.5 min-h-[22px]">
        {sharedTenantIds && sharedTenantIds.length === 0 && (
          <span className="text-xs text-text-muted italic">{t('notifications.notShared')}</span>
        )}
        {sharedTenantIds?.map((tid) => (
          <span
            key={tid}
            className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary border border-border px-2 py-0.5 text-xs text-text-primary"
          >
            <Building2 size={10} className="text-text-muted shrink-0" />
            {tenantName(tid)}
            <button
              type="button"
              onClick={() => handleRemove(tid)}
              disabled={saving}
              className="ml-0.5 text-text-muted hover:text-status-down transition-colors"
              title={t('notifications.removeTenantAccess')}
              aria-label={t('notifications.removeTenantAccess')}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        {saving && <Loader2 size={12} className="animate-spin text-text-muted self-center" />}
      </div>

      {/* Add tenant */}
      {availableTenants.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value ? Number(e.target.value) : '')}
            aria-label={t('notifications.selectTenant')}
            className="rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent coarse:min-h-10"
          >
            <option value="">{t('notifications.selectTenant')}</option>
            {availableTenants.map((tn) => (
              <option key={tn.id} value={tn.id}>
                {tn.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!addingId || saving}
            className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors coarse:min-h-10"
          >
            <Plus size={11} />
            {t('notifications.grantAccess')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

const selectCls =
  'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';

/** Hover-revealed on mouse devices, always visible on touch (and when focused). */
const hoverRevealCls =
  'shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:focus-visible:opacity-100 transition-opacity';

export function NotificationsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const formId = useId();
  const { currentTenantId, tenants } = useTenantStore();
  const tenantName = useTenantName();
  // Sharing a channel with other workspaces: platform admin in god view only (server-enforced).
  const isGodView = useIsGodView();
  const isMultiTenant = tenants.length > 1 && isGodView;

  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [plugins, setPlugins] = useState<NotificationPluginMeta[]>([]);
  const [globalBindings, setGlobalBindings] = useState<NotificationBinding[]>([]);
  // Callers without 'settings' get trimmed rows (id, name, fromAddress).
  const [smtpServers, setSmtpServers] = useState<Array<Pick<SmtpServer, 'id' | 'name'> & Partial<SmtpServer>>>([]);
  const [smtpLoadForbidden, setSmtpLoadForbidden] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedType, setSelectedType] = useState('');
  const [formName, setFormName] = useState('');
  const [formConfig, setFormConfig] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);

  // Which channel IDs have their tenant sharing panel expanded
  const [expandedTenants, setExpandedTenants] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const [ch, pl, gb] = await Promise.all([
        notificationsApi.listChannels(),
        notificationsApi.getPlugins(),
        notificationsApi.getBindings('global', null),
      ]);
      setChannels(ch);
      setPlugins(pl);
      setGlobalBindings(gb);
    } catch {
      toast.error(t('notifications.failedLoad'));
    }
  };

  useEffect(() => {
    load();
    smtpServerApi.list()
      .then((list) => { setSmtpServers(list); setSmtpLoadForbidden(false); })
      .catch((err: unknown) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 403) setSmtpLoadForbidden(true);
      });
  }, []);

  const selectedPlugin = plugins.find((p) => p.type === selectedType);

  const openCreate = () => {
    setEditingId(null);
    setSelectedType(plugins[0]?.type || '');
    setFormName('');
    setFormConfig({});
    setShowForm(true);
  };

  const openEdit = (ch: NotificationChannel) => {
    setEditingId(ch.id);
    setSelectedType(ch.type);
    setFormName(ch.name);
    setFormConfig({ ...ch.config });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await notificationsApi.updateChannel(editingId, {
          name: formName,
          config: formConfig,
        });
        toast.success(t('notifications.updated'));
      } else {
        await notificationsApi.createChannel({
          name: formName,
          type: selectedType,
          config: formConfig,
        });
        toast.success(t('notifications.created'));
      }
      closeForm();
      load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('notifications.failedSave')));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!(await confirm({ message: t('notifications.confirmDelete', { name }), danger: true }))) return;
    try {
      await notificationsApi.deleteChannel(id);
      toast.success(t('notifications.deleted'));
      setExpandedTenants((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      load();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('notifications.failedDelete')));
    }
  };

  const handleTest = async (id: number) => {
    setTesting(id);
    try {
      await notificationsApi.testChannel(id);
      toast.success(t('notifications.testSent'));
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, err instanceof Error ? err.message : t('notifications.testFailed')));
    } finally {
      setTesting(null);
    }
  };

  const toggleGlobalBinding = async (channelId: number) => {
    const existing = globalBindings.find((b) => b.channelId === channelId);
    try {
      if (existing) {
        await notificationsApi.removeBinding(channelId, 'global', null);
        toast.success(t('notifications.removedFromGlobal'));
      } else {
        await notificationsApi.addBinding(channelId, 'global', null);
        toast.success(t('notifications.addedToGlobal'));
      }
      load();
    } catch {
      toast.error(t('notifications.failedBinding'));
    }
  };

  const isGloballyBound = (channelId: number) =>
    globalBindings.some((b) => b.channelId === channelId);

  const toggleTenantPanel = (channelId: number) => {
    setExpandedTenants((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const newChannelButton = (
    <Button size="sm" onClick={openCreate} className="shrink-0">
      <Plus size={16} className="mr-1.5" />
      {t('notifications.newChannel')}
    </Button>
  );

  const description = t(
    'notifications.description',
    'Channels that receive the alerts. A channel enabled globally is notified for every monitor and agent of its workspace; groups, monitors and agents can add or exclude channels.',
  );

  return (
    <PageContainer embedded={embedded}>
      {/* Header — the h1 is dropped when embedded (PoliciesPage renders its own) */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {!embedded && (
            <h1 className="text-2xl font-semibold text-text-primary">{t('notifications.title')}</h1>
          )}
          <p className={embedded ? 'text-sm text-text-muted' : 'mt-1 text-sm text-text-muted'}>{description}</p>
        </div>
        {newChannelButton}
      </div>

      {/* Create / Edit dialog */}
      <Modal
        open={showForm}
        onClose={closeForm}
        title={editingId ? t('notifications.editChannel') : t('notifications.newChannel')}
        icon={<Bell size={16} className="text-accent" />}
        size="md"
        closeOnBackdrop={false}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form={formId} loading={saving}>
              {editingId ? t('common.save') : t('common.create')}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={handleSubmit} className="space-y-4">
          <Input
            label={t('notifications.channelName')}
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t('notifications.channelNamePlaceholder')}
            required
          />

          {!editingId && (
            <div className="space-y-1">
              <label htmlFor={`${formId}-type`} className="block text-sm font-medium text-text-secondary">{t('common.type')}</label>
              <select
                id={`${formId}-type`}
                value={selectedType}
                onChange={(e) => {
                  setSelectedType(e.target.value);
                  setFormConfig({});
                }}
                className={selectCls}
              >
                {plugins.map((p) => (
                  <option key={p.type} value={p.type}>
                    {p.name}
                  </option>
                ))}
              </select>
              {selectedPlugin && (
                <p className="text-xs text-text-muted mt-1">{selectedPlugin.description}</p>
              )}
            </div>
          )}

          {/* Dynamic config fields */}
          {selectedPlugin?.configFields.map((field) => {
            if (field.type === 'boolean') {
              return (
                <div key={field.key} className="flex items-center gap-2">
                  <Checkbox
                    id={`cfg-${field.key}`}
                    checked={Boolean(formConfig[field.key])}
                    onCheckedChange={(v) => setFormConfig({ ...formConfig, [field.key]: v })}
                  />
                  <label htmlFor={`cfg-${field.key}`} className="text-sm text-text-secondary">
                    {field.label}
                  </label>
                </div>
              );
            }
            if (field.type === 'smtp_server_select') {
              return (
                <div key={field.key} className="space-y-1">
                  <label htmlFor={`cfg-${field.key}`} className="block text-sm font-medium text-text-secondary">
                    {field.label}{field.required && <span className="text-status-down ml-1">*</span>}
                  </label>
                  <select
                    id={`cfg-${field.key}`}
                    value={String(formConfig[field.key] ?? '')}
                    onChange={(e) => setFormConfig({ ...formConfig, [field.key]: e.target.value ? Number(e.target.value) : '' })}
                    required={field.required}
                    className={selectCls}
                  >
                    <option value="">{t('notifications.selectSmtp')}</option>
                    {smtpServers.map((s) => (
                      <option key={s.id} value={s.id}>{s.host ? `${s.name} (${s.host}:${s.port})` : s.name}</option>
                    ))}
                  </select>
                  {smtpServers.length === 0 && (
                    <p className="text-xs text-amber-400">
                      {smtpLoadForbidden
                        ? t('notifications.smtpNeedsSettings', 'Listing the SMTP servers requires the settings permission.')
                        : t('notifications.noSmtp')}
                    </p>
                  )}
                </div>
              );
            }
            if (field.type === 'select') {
              return (
                <div key={field.key} className="space-y-1">
                  <label htmlFor={`cfg-${field.key}`} className="block text-sm font-medium text-text-secondary">
                    {field.label}{field.required && <span className="text-status-down ml-1">*</span>}
                  </label>
                  <select
                    id={`cfg-${field.key}`}
                    value={String(formConfig[field.key] ?? field.defaultValue ?? '')}
                    onChange={(e) => setFormConfig({ ...formConfig, [field.key]: e.target.value })}
                    required={field.required}
                    className={selectCls}
                  >
                    {(field.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              );
            }
            return (
              <Input
                key={field.key}
                label={field.label}
                type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                value={String(formConfig[field.key] ?? '')}
                onChange={(e) =>
                  setFormConfig({
                    ...formConfig,
                    [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value,
                  })
                }
                placeholder={field.placeholder}
                required={field.required}
              />
            );
          })}
        </form>
      </Modal>

      {/* Channel list */}
      <div className="rounded-lg border border-border bg-bg-secondary">
        {channels.length === 0 ? (
          <div className="py-12 text-center">
            <Bell size={32} className="mx-auto mb-3 text-text-muted" />
            <p className="text-text-muted">{t('notifications.noChannels')}</p>
            <p className="text-sm text-text-muted mt-1">
              {t('notifications.noChannelsDesc')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {channels.map((ch) => {
              const plugin = plugins.find((p) => p.type === ch.type);
              const isShared = ch.isShared === true;
              const isExpanded = expandedTenants.has(ch.id);
              const bound = isGloballyBound(ch.id);

              return (
                <div key={ch.id} className="px-3 sm:px-4 py-3 group">
                  {/* Main row — phones: name + badges on the first line, actions wrap below */}
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2">
                    <div className="flex-1 min-w-0 max-sm:basis-full">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary break-words">{anonymize(ch.name)}</span>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                          {plugin?.name || ch.type}
                        </span>
                        {!ch.isEnabled && (
                          <span className="rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down">
                            {t('status.disabled')}
                          </span>
                        )}
                        {/* Shared channels: the source workspace; own channels: the
                            owner workspace, in the god view only (TenantBadge) */}
                        {isShared && ch.tenantId != null ? (
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent"
                            title={t('notifications.sharedFrom', 'Shared by the workspace {{name}}', { name: tenantName(ch.tenantId) })}
                          >
                            <Building2 size={9} className="shrink-0" />
                            {tenantName(ch.tenantId)}
                          </span>
                        ) : (
                          <TenantBadge tenantId={ch.tenantId} />
                        )}
                      </div>
                    </div>

                    {/* Global binding toggle */}
                    <button
                      type="button"
                      onClick={() => toggleGlobalBinding(ch.id)}
                      aria-pressed={bound}
                      className={`shrink-0 rounded-md px-2 py-1 coarse:px-3 coarse:py-2 text-xs font-medium transition-colors ${
                        bound
                          ? 'bg-accent/10 text-accent'
                          : 'text-text-muted hover:bg-bg-hover'
                      }`}
                      title={bound
                        ? t('notifications.removeFromGlobalHint', 'Remove from global notifications')
                        : t('notifications.addToGlobalHint', 'Add to global notifications')}
                    >
                      <Zap size={12} className="inline mr-1" />
                      {bound ? t('remediations.globalActive') : t('common.enable')}
                    </button>

                    {/* Tenant sharing toggle — own channels only, multi-tenant mode only */}
                    {isMultiTenant && !isShared && (
                      <button
                        type="button"
                        onClick={() => toggleTenantPanel(ch.id)}
                        aria-expanded={isExpanded}
                        className={`shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 coarse:px-3 coarse:py-2 text-xs font-medium transition-colors ${
                          isExpanded
                            ? 'bg-bg-tertiary text-text-primary'
                            : 'text-text-muted hover:bg-bg-hover'
                        }`}
                        title={t('notifications.manageTenantAccess')}
                      >
                        <Building2 size={12} />
                        {t('notifications.workspaces')}
                        {isExpanded
                          ? <ChevronDown size={11} />
                          : <ChevronRight size={11} />}
                      </button>
                    )}

                    {/* Test / Edit / Delete — hidden for shared channels.
                        md+: inline icons (hover-revealed with a mouse, always
                        visible on touch). Phones: the same actions in a "⋯" menu. */}
                    {!isShared && (
                      <>
                        <IconButton
                          label={t('notifications.sendTest')}
                          icon={testing === ch.id
                            ? <Loader2 size={14} className="animate-spin" />
                            : <TestTube2 size={14} />}
                          variant="plain"
                          onClick={() => { if (testing !== ch.id) void handleTest(ch.id); }}
                          aria-disabled={testing === ch.id}
                          className={`hidden md:inline-flex hover:text-accent ${hoverRevealCls}`}
                        />
                        <IconButton
                          label={t('common.edit')}
                          icon={<Pencil size={14} />}
                          variant="plain"
                          onClick={() => openEdit(ch)}
                          className={`hidden md:inline-flex ${hoverRevealCls}`}
                        />
                        <IconButton
                          label={t('common.delete')}
                          icon={<Trash2 size={14} />}
                          variant="plain"
                          onClick={() => void handleDelete(ch.id, ch.name)}
                          className={`hidden md:inline-flex hover:text-status-down ${hoverRevealCls}`}
                        />
                        <ActionMenu
                          sheetTitle={anonymize(ch.name)}
                          triggerClassName="md:hidden shrink-0 ml-auto"
                          items={[
                            { key: 'test', icon: <TestTube2 size={16} />, label: t('notifications.sendTest'), onClick: () => void handleTest(ch.id), disabled: testing === ch.id },
                            { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit'), onClick: () => openEdit(ch) },
                            { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), onClick: () => void handleDelete(ch.id, ch.name), danger: true, separator: true },
                          ]}
                        />
                      </>
                    )}
                  </div>

                  {/* Tenant sharing panel (expandable, own channels only) */}
                  {isExpanded && !isShared && (
                    <TenantSharingPanel channelId={ch.id} ownerTenantId={ch.tenantId ?? currentTenantId} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
