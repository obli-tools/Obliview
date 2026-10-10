import { useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Key, ArrowRight, Pencil, Folder, DownloadCloud, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { MASTER_TENANT_ID } from '@obliview/shared';
import type { AgentUpdatePolicyContext, GroupTreeNode } from '@obliview/shared';
import {
  agentApi,
  type AgentApiKeyWithDefault,
  type AgentUpdateRolloutPreview,
} from '@/api/agent.api';
import { groupsApi } from '@/api/groups.api';
import { Button } from '@/components/common/Button';
import { CopyButton } from '@/components/common/CopyButton';
import { GroupPicker } from '@/components/common/GroupPicker';
import { IconButton } from '@/components/common/IconButton';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantBucketHeader } from '@/components/common/TenantBucketHeader';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useTenantStore } from '@/store/tenantStore';
import { useAuthStore } from '@/store/authStore';
import { useIsGodView } from '@/hooks/useIsGodView';
import { useTabParam } from '@/hooks/useTabParam';
import { useTenantCollapse } from '@/hooks/useTenantCollapse';
import { apiErrorMessage } from '@/utils/apiError';
import { agentUpdatePolicyApi } from '@/api/agentUpdatePolicy.api';
import { UpdatePolicyBadge, updatePolicySourceText } from '@/components/agent/UpdatePolicyField';

/**
 * /manage/agents — agent configuration hub (agents.manage). Tabs:
 *   - keys: enrollment API keys and their default group (`?tab=keys`, the
 *     Add-agent modal deep-links here when no key exists);
 *   - rollout: admin-paced agent updates (preview, start, pace).
 * The device list lives at /agents (AgentListPage). Old links to the devices
 * tab (`?tab=devices`, or Obliance's `?tab=agents`) redirect there so
 * bookmarks keep working.
 */
const TABS = ['keys', 'rollout'] as const;
type Tab = (typeof TABS)[number];
const LEGACY_DEVICE_TABS = new Set(['devices', 'agents']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function truncateKey(key: string) {
  return key.slice(0, 8) + '...' + key.slice(-4);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Root groups of one tenant (a group and its descendants share the tenant). */
function treeForTenant(tree: GroupTreeNode[], tenantId: number | null): GroupTreeNode[] {
  if (tenantId == null) return tree;
  return tree.filter((g) => g.tenantId === tenantId);
}

function findGroupName(tree: GroupTreeNode[], id: number): string | null {
  for (const node of tree) {
    if (node.id === id) return node.name;
    const found = findGroupName(node.children, id);
    if (found) return found;
  }
  return null;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function AdminAgentPage() {
  const [searchParams] = useSearchParams();
  // Hooks run unconditionally; the legacy redirect happens in the render.
  const isLegacyDevicesTab = LEGACY_DEVICE_TABS.has(searchParams.get('tab') ?? '');
  const [tab, setTab] = useTabParam<Tab>(TABS, 'keys');
  const { t } = useTranslation();

  if (isLegacyDevicesTab) {
    // Keep the other query parameters (e.g. ?status=pending) for the list.
    const params = new URLSearchParams(searchParams);
    params.delete('tab');
    const qs = params.toString();
    return <Navigate to={qs ? `/agents?${qs}` : '/agents'} replace />;
  }

  const tabs: SegmentedTab<Tab>[] = [
    { id: 'keys', label: t('agents.tabKeys', 'API Keys'), icon: <Key size={13} /> },
    { id: 'rollout', label: t('agents.rollout.tab', 'Update rollout'), icon: <DownloadCloud size={13} /> },
  ];

  return (
    <PageContainer className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">{t('agents.configTitle', 'Agent configuration')}</h1>
        <p className="text-sm text-text-muted mt-0.5">
          {t('agents.configSubtitle', 'API keys and settings used to enroll agents.')}{' '}
          <Link to="/agents" className="inline-flex items-center gap-1 text-accent hover:underline">
            {t('agents.openList', 'Open the agent list')}
            <ArrowRight size={12} />
          </Link>
        </p>
      </div>

      <SegmentedTabs<Tab> tabs={tabs} value={tab} onChange={setTab} fill={false} className="w-fit max-w-full" />

      {tab === 'keys' && <ApiKeysTab />}
      {tab === 'rollout' && <UpdateRolloutTab />}
    </PageContainer>
  );
}

// ── API key dialog (create / edit) ────────────────────────────────────────────

interface KeyDialogProps {
  /** null = create a key in the current workspace. */
  apiKey: AgentApiKeyWithDefault | null;
  /** Groups of the key's workspace only (a default group must share its tenant). */
  tree: GroupTreeNode[];
  onClose: () => void;
  onSaved: () => void;
}

function KeyDialog({ apiKey, tree, onClose, onSaved }: KeyDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(apiKey?.name ?? '');
  const [defaultGroupId, setDefaultGroupId] = useState<number | null>(apiKey?.defaultGroupId ?? null);
  const [saving, setSaving] = useState(false);
  // A default group that is no longer in the tree (deleted / other tenant)
  // is shown as cleared.
  const groupKnown = defaultGroupId == null || findGroupName(tree, defaultGroupId) != null;

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const groupId = groupKnown ? defaultGroupId : null;
      if (apiKey) {
        await agentApi.updateKey(apiKey.id, { name: name.trim(), defaultGroupId: groupId });
        toast.success(t('agents.keyUpdated', 'API key updated'));
      } else {
        await agentApi.createKey(name.trim(), groupId);
        toast.success(t('agents.keyCreated'));
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, apiKey
        ? t('agents.failedUpdateKey', 'Failed to update the key')
        : t('agents.failedCreateKey')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      size="sm"
      icon={<Key className="h-4 w-4 text-accent" />}
      title={apiKey ? t('agents.editKey', 'Edit API key') : t('agents.newApiKey', 'New API key')}
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t('common.cancel')}</Button>
          <Button onClick={() => void save()} loading={saving} disabled={!name.trim()}>
            {apiKey ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="agent-key-name" className="mb-1 block text-sm font-medium text-text-secondary">
            {t('agents.keyNameLabel', 'Key name')}
          </label>
          <Input
            id="agent-key-name"
            placeholder={t('agents.keyNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !saving) { e.preventDefault(); void save(); } }}
            enterKeyHint="done"
            autoFocus
          />
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium text-text-secondary">
            {t('agents.defaultGroup', 'Default group')}
          </span>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <GroupPicker
                value={groupKnown ? defaultGroupId : null}
                onChange={setDefaultGroupId}
                tree={tree}
                placeholder={t('agents.noDefaultGroup', 'No default group')}
              />
            </div>
            {defaultGroupId != null && (
              <Button variant="ghost" size="sm" onClick={() => setDefaultGroupId(null)}>
                {t('agents.clearDefaultGroup', 'Clear')}
              </Button>
            )}
          </div>
          <p className="mt-1 text-xs text-text-muted">
            {t('agents.defaultGroupDesc', 'Devices enrolled with this key are placed in this group when they are approved, unless another group is picked.')}
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ── API keys tab ──────────────────────────────────────────────────────────────

function ApiKeysTab() {
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [keys, setKeys] = useState<AgentApiKeyWithDefault[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tree, setTree] = useState<GroupTreeNode[]>([]);
  /** undefined = closed, null = create, key = edit. */
  const [dialogKey, setDialogKey] = useState<AgentApiKeyWithDefault | null | undefined>(undefined);
  // Listing needs agents.manage; creating / editing / deleting a key is
  // platform-admin only (agent.routes POST/PUT/DELETE /keys).
  const canEditKeys = useAuthStore((s) => s.user?.role === 'admin');

  // God View: keys of every tenant, bucketed per tenant (collapse state shared
  // with the sidebar and the agent list).
  const isGodView = useIsGodView();
  const storeTenants = useTenantStore((s) => s.tenants);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const tenantNameById = new Map(storeTenants.map((tn) => [tn.id, tn.name]));
  const { isCollapsed: tenantCollapsed, toggle: toggleTenantCollapsed } = useTenantCollapse();
  const [tenantFilter, setTenantFilter] = useState<Set<number>>(new Set());

  const loadKeys = useCallback(async () => {
    try {
      setKeys(await agentApi.listKeys());
    } catch {
      toast.error(t('agents.failedLoad'));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  useEffect(() => {
    void loadKeys();
    groupsApi.tree().then(setTree).catch(() => { /* no default-group names / picker */ });
  }, [loadKeys]);

  const handleDeleteKey = async (key: AgentApiKeyWithDefault) => {
    const ok = await confirm({
      message: t('agents.confirmDeleteKey', { name: key.name }),
      danger: true,
    });
    if (!ok) return;
    try {
      await agentApi.deleteKey(key.id);
      toast.success(t('agents.keyDeleted'));
      void loadKeys();
    } catch {
      toast.error(t('agents.failedDeleteKey'));
    }
  };

  const visibleKeys = isGodView && tenantFilter.size > 0
    ? keys.filter(k => tenantFilter.has(k.tenantId))
    : keys;

  const defaultGroupLabel = (key: AgentApiKeyWithDefault): string | null => {
    if (key.defaultGroupId == null) return null;
    return key.defaultGroupName ?? findGroupName(tree, key.defaultGroupId) ?? `#${key.defaultGroupId}`;
  };

  const renderKeyRow = (key: AgentApiKeyWithDefault) => {
    const groupLabel = defaultGroupLabel(key);
    return (
      <div key={key.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 group sm:flex-nowrap">
        <Key size={14} className="shrink-0 text-accent" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-text-primary text-sm break-all">{key.name}</span>
            {/* Collapsed buckets already name the tenant; the badge helps once filtered. */}
            {isGodView && tenantFilter.size > 0 && <TenantBadge tenantId={key.tenantId} />}
          </div>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <span className="text-xs font-mono text-text-muted">{truncateKey(key.key)}</span>
            <CopyButton text={key.key} />
            {key.deviceCount !== undefined && (
              <span className="text-xs text-text-muted">
                {t('agents.deviceCount', '{{count}} device(s)', { count: key.deviceCount })}
              </span>
            )}
          </div>
        </div>
        {/* Default group column */}
        <div className="w-full shrink-0 text-xs sm:w-48 max-sm:order-3 max-sm:pl-[26px]">
          <div className="text-[10px] uppercase tracking-wide text-text-muted">{t('agents.defaultGroup', 'Default group')}</div>
          {groupLabel ? (
            <span className="inline-flex max-w-full items-center gap-1 text-text-secondary">
              <Folder size={11} className="shrink-0 text-accent" />
              <span className="truncate">{groupLabel}</span>
            </span>
          ) : (
            <span className="text-text-muted">{t('agents.noDefaultGroup', 'No default group')}</span>
          )}
        </div>
        <div className="text-xs text-text-muted shrink-0 sm:text-right max-sm:order-4 max-sm:basis-full max-sm:pl-[26px]">
          <div>{t('agents.keyCreatedAt', 'Created {{date}}', { date: formatDate(key.createdAt) })}</div>
          {key.lastUsedAt && (
            <div>{t('agents.keyLastUsedAt', 'Last used {{date}}', { date: formatDate(key.lastUsedAt) })}</div>
          )}
        </div>
        {canEditKeys && (
          <div className="flex shrink-0 items-center gap-1 max-sm:order-2">
            <IconButton
              label={t('agents.editKey', 'Edit API key')}
              icon={<Pencil size={13} />}
              onClick={() => setDialogKey(key)}
              className="can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100"
            />
            <IconButton
              label={t('common.delete')}
              icon={<Trash2 size={13} />}
              variant="danger"
              onClick={() => handleDeleteKey(key)}
              className="can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100"
            />
          </div>
        )}
      </div>
    );
  };

  const renderKeys = (): ReactNode[] => {
    if (!isGodView) return visibleKeys.map(renderKeyRow);

    const byTenant = new Map<number, AgentApiKeyWithDefault[]>();
    for (const k of visibleKeys) {
      if (!byTenant.has(k.tenantId)) byTenant.set(k.tenantId, []);
      byTenant.get(k.tenantId)!.push(k);
    }
    const ordered = Array.from(byTenant.entries()).sort(([a], [b]) => {
      if (a === MASTER_TENANT_ID) return -1;
      if (b === MASTER_TENANT_ID) return 1;
      return (tenantNameById.get(a) ?? '').localeCompare(tenantNameById.get(b) ?? '');
    });
    const nodes: ReactNode[] = [];
    for (const [tid, ks] of ordered) {
      const collapsed = tenantCollapsed(tid);
      nodes.push(
        <TenantBucketHeader
          key={`hdr-${tid}`}
          tenantId={tid}
          variant="bar"
          collapsed={collapsed}
          onToggle={() => toggleTenantCollapsed(tid)}
          countLabel={t('agents.keyCount', '{{count}} key(s)', { count: ks.length })}
        />,
      );
      if (!collapsed) {
        for (const k of ks) nodes.push(renderKeyRow(k));
      }
    }
    return nodes;
  };

  // The default group must belong to the key's workspace: a new key is
  // created in the current one.
  const dialogTenantId = dialogKey ? dialogKey.tenantId : currentTenantId;
  const dialogTree = useMemo(() => treeForTenant(tree, dialogTenantId ?? null), [tree, dialogTenantId]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <p className="text-sm text-text-muted">{t('agents.apiKeyDescription')}</p>
        {canEditKeys && (
          <Button size="sm" onClick={() => setDialogKey(null)}>
            <Plus size={13} className="mr-1" />{t('agents.newKey', 'New key')}
          </Button>
        )}
      </div>

      <TenantFilterChips
        value={tenantFilter}
        onChange={setTenantFilter}
        availableTenantIds={Array.from(new Set(keys.map(k => k.tenantId)))}
        className="mb-4"
      />

      {/* Keys list */}
      <div className="rounded-lg bg-bg-secondary divide-y divide-border overflow-hidden">
        {visibleKeys.length === 0 ? (
          <div className="py-10 text-center">
            <Key size={28} className="mx-auto mb-2 text-text-muted" />
            <p className="text-sm text-text-muted">
              {loaded ? t('agents.noKeys', 'No API keys yet') : t('common.loading')}
            </p>
          </div>
        ) : (
          renderKeys()
        )}
      </div>

      {canEditKeys && dialogKey !== undefined && (
        <KeyDialog
          apiKey={dialogKey}
          tree={dialogTree}
          onClose={() => setDialogKey(undefined)}
          onSaved={() => void loadKeys()}
        />
      )}
    </div>
  );
}

// ── Update rollout tab ────────────────────────────────────────────────────────

/**
 * Read-only summary of the two upper levels of the agent update policy for
 * the active workspace (global -> workspace). Platform admins get links to
 * where each level is edited (Settings, Workspace page); groups and agents
 * are set on their own pages.
 */
function UpdatePolicySummary() {
  const { t } = useTranslation();
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [ctx, setCtx] = useState<AgentUpdatePolicyContext | null>(null);

  useEffect(() => {
    if (currentTenantId == null) return;
    let cancelled = false;
    agentUpdatePolicyApi.getTenant(currentTenantId)
      .then((c) => { if (!cancelled) setCtx(c); })
      .catch(() => { if (!cancelled) setCtx(null); });
    return () => { cancelled = true; };
  }, [currentTenantId]);

  if (!ctx) return null;
  const global = ctx.globalPolicy ?? 'manual';
  return (
    <div className="rounded-lg bg-bg-secondary p-4 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {t('agentUpdatePolicy.policyLabel', 'Update policy')}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="flex items-center gap-2">
          <span className="text-text-muted">{t('agentUpdatePolicy.source.global', 'Global')}</span>
          <UpdatePolicyBadge policy={global} />
          {ctx.globalPolicy == null && (
            <span className="text-xs text-text-muted">{t('agentUpdatePolicy.builtInDefault', 'Built-in default')}</span>
          )}
          {isPlatformAdmin && (
            <Link to="/settings" className="text-xs text-accent hover:underline">{t('common.edit', 'Edit')}</Link>
          )}
        </span>
        <span className="flex items-center gap-2">
          <span className="text-text-muted">{t('agentUpdatePolicy.source.tenant', 'Workspace')}</span>
          <UpdatePolicyBadge policy={ctx.effective.policy} />
          <span className="text-xs text-text-muted">
            {ctx.ownPolicy
              ? (ctx.effective.source === 'tenant'
                  ? t('agentUpdatePolicy.setHere', 'set on this workspace')
                  : t('agentUpdatePolicy.frozenHint', { defaultValue: 'Frozen by {{source}}', source: updatePolicySourceText(t, ctx.effective) }))
              : t('agentUpdatePolicy.inheritedFrom', { defaultValue: 'Inherited from {{source}}', source: updatePolicySourceText(t, ctx.inherited) })}
          </span>
          {isPlatformAdmin && (
            <Link to="/workspace" className="text-xs text-accent hover:underline">{t('common.edit', 'Edit')}</Link>
          )}
        </span>
      </div>
      <p className="text-xs text-text-muted">
        {t('agentUpdatePolicy.summaryDesc', 'Groups (group settings page) and agents (agent page) can override it. Frozen at any level wins: those agents are never updated, not even by this rollout.')}
      </p>
    </div>
  );
}

/**
 * Admin-paced agent updates (W4-B). Agents no longer update themselves on
 * every push: an operator previews how many approved agents are outdated,
 * then starts a rollout that hands out N updates per window (one outstanding
 * update per device, pending devices never updated).
 */
function UpdateRolloutTab() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [preview, setPreview] = useState<AgentUpdateRolloutPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    try {
      setPreview(await agentApi.previewUpdateAll());
    } catch (err) {
      setPreview(null);
      toast.error(apiErrorMessage(err, t('agents.rollout.previewFailed', 'Failed to load the rollout preview')));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const targets = preview?.targets ?? 0;

  const start = async () => {
    if (targets === 0) return;
    const ok = await confirm({
      title: t('agents.rollout.confirmTitle', 'Update every outdated agent?'),
      message: t('agents.rollout.confirmMessage', '{{count}} agent(s) will be updated to version {{version}}, at the rollout pace.', {
        count: targets,
        version: preview?.latestVersion ?? '?',
      }),
      confirmLabel: t('agents.rollout.start', 'Start rollout'),
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await agentApi.startUpdateAll();
      toast.success(t('agents.rollout.started', 'Rollout started: {{count}} update(s) queued', { count: res.queued ?? targets }));
      void loadPreview();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.rollout.startFailed', 'Failed to start the rollout')));
    } finally {
      setStarting(false);
    }
  };

  const stat = (label: string, value: ReactNode) => (
    <div className="rounded-lg bg-bg-tertiary px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="text-lg font-semibold tabular-nums text-text-primary">{value}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-text-muted">
          {t('agents.rollout.description', 'Agents no longer update on their own. Start a rollout to update every outdated approved agent; updates are handed out a few at a time so the fleet never restarts at once.')}
        </p>
        <IconButton
          label={t('common.refresh')}
          icon={<RefreshCw size={14} className={loading ? 'animate-spin' : undefined} />}
          onClick={() => void loadPreview()}
          disabled={loading}
        />
      </div>

      <UpdatePolicySummary />

      <div className="rounded-lg bg-bg-secondary p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stat(t('agents.rollout.latestVersion', 'Latest version'), preview?.latestVersion ?? '—')}
          {stat(t('agents.rollout.outdated', 'Outdated agents'), loading && !preview ? '…' : targets)}
          {stat(t('agents.rollout.queued', 'Already queued'), preview?.alreadyQueued ?? '—')}
          {stat(
            t('agents.rollout.inProgressFailed', 'In progress / failed'),
            preview?.inProgress != null || preview?.failed != null
              ? `${preview?.inProgress ?? 0} / ${preview?.failed ?? 0}`
              : '—',
          )}
        </div>

        {(preview?.frozen != null || preview?.auto != null) && ((preview.frozen ?? 0) > 0 || (preview.auto ?? 0) > 0) && (
          <p className="text-xs text-text-muted">
            {t('agentUpdatePolicy.rolloutCounts', {
              defaultValue: 'Outdated agents with update policy Automatic: {{auto}} (queued on their own) · Frozen: {{frozen}} (never updated, not counted above)',
              auto: preview.auto ?? 0,
              frozen: preview.frozen ?? 0,
            })}
          </p>
        )}

        {preview?.pace != null && (
          <p className="text-xs text-text-muted">
            {preview.windowSeconds
              ? t('agents.rollout.currentPaceWindow', 'Current pace: {{pace}} update(s) every {{seconds}} s', { pace: preview.pace, seconds: preview.windowSeconds })
              : t('agents.rollout.currentPace', 'Current pace: {{pace}} update(s) per window', { pace: preview.pace })}
            {' '}
            {t('agents.rollout.paceServerSetting', '(fleet-wide server setting: AGENT_UPDATE_ROLLOUT_MAX_PER_WINDOW / AGENT_UPDATE_ROLLOUT_WINDOW_SECONDS)')}
          </p>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Button onClick={() => void start()} loading={starting} disabled={targets === 0 || loading}>
            <DownloadCloud size={14} className="mr-1.5" />
            {t('agents.rollout.start', 'Start rollout')}
          </Button>
        </div>
        {preview && targets === 0 && !loading && (
          <p className="text-xs text-status-up">{t('agents.rollout.upToDate', 'Every approved agent is up to date.')}</p>
        )}
      </div>
    </div>
  );
}

export default AdminAgentPage;
