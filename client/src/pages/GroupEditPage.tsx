import { useState, useEffect, useCallback, useMemo, useRef, type FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, ChevronUp, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { MonitorGroup, GroupTreeNode, NotificationTypeConfig } from '@obliview/shared';
import { groupsApi } from '@/api/groups.api';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { GroupPicker } from '@/components/common/GroupPicker';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { TenantBadge } from '@/components/common/TenantBadge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Checkbox } from '@/components/ui/Checkbox';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationBindingsPanel } from '@/components/notifications/NotificationBindingsPanel';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { RemediationBindingsPanel } from '@/components/remediation/RemediationBindingsPanel';
import { MaintenanceWindowList } from '@/components/maintenance/MaintenanceWindowList';
import { AgentGroupSettingsPanel } from '@/components/groups/AgentGroupSettingsPanel';
import { GroupUpdatePolicySection } from '@/components/groups/GroupUpdatePolicySection';
import { computeWritableGroupIds, canWriteTreeGroup } from '@/components/groups/GroupNode';
import { anonymize } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// The single group-settings page (/group/:id/edit). It carries every knob of
// a group, always — including for an empty group, so it can be prepared
// before monitors or agents are put into it:
//   General · Position · Notifications (channels + agent notification types)
//   · Remediations · Maintenance · Monitor checks · Agents (defaults + thresholds)
// The group page (/group/:id) is read-only.
// ─────────────────────────────────────────────────────────────────────────────

function findNodeById(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNodeById(node.children, id);
    if (found) return found;
  }
  return null;
}

interface GroupFormData {
  name: string;
  description: string;
  isGeneral: boolean;
  groupNotifications: boolean;
}

const formFromGroup = (g: MonitorGroup | null | undefined): GroupFormData => ({
  name: g?.name ?? '',
  description: g?.description ?? '',
  isGeneral: g?.isGeneral ?? false,
  groupNotifications: g?.groupNotifications ?? false,
});

const CARD = 'rounded-lg border border-border bg-bg-secondary p-5 max-sm:p-4';
const CARD_TITLE = 'text-sm font-semibold text-text-secondary uppercase tracking-wide mb-4';

export function GroupEditPage() {
  const { id } = useParams<{ id: string }>();
  const groupId = parseInt(id!, 10);
  // Fresh state per group: the route element is reused across /group/:id/edit.
  return <GroupEditView key={groupId} groupId={groupId} />;
}

function GroupEditView({ groupId }: { groupId: number }) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { canWriteGroup, isAdmin, permissions, hasCapability } = useAuthStore();
  const { getGroup, fetchGroups, fetchTree, updateGroup, tree } = useGroupStore();

  // Write access as the server sees it (requireGroupWrite): RW on the group
  // or on any ancestor (closure table). The store's canWriteGroup only reads
  // direct grants, which still count while the tree is loading.
  const admin = isAdmin();
  // POST /groups/:id/move needs 'groups.manage' (plus write access, checked server-side).
  const canMoveGroup = hasCapability('groups.manage');
  const writableIds = useMemo(
    () => computeWritableGroupIds(tree, admin, permissions?.permissions),
    [tree, admin, permissions],
  );
  const directWrite = canWriteGroup(groupId);
  const canWriteThis = directWrite || canWriteTreeGroup(writableIds, groupId);
  // An inherited grant needs the tree: on a deep link it may not be loaded yet
  // (the sidebar tree is not mounted on a phone or in the collapsed rail).
  const [treeReady, setTreeReady] = useState(() => useGroupStore.getState().tree.length > 0);
  useEffect(() => {
    if (treeReady) return;
    let cancelled = false;
    fetchTree().finally(() => { if (!cancelled) setTreeReady(true); });
    return () => { cancelled = true; };
  }, [treeReady, fetchTree]);

  const [group, setGroup] = useState<MonitorGroup | null>(getGroup(groupId) ?? null);
  const [loading, setLoading] = useState(!group);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<GroupFormData>(() => formFromGroup(group));
  // Once the user has typed, a late fetch must not overwrite the form.
  const formTouched = useRef(false);
  const editForm = (patch: Partial<GroupFormData>) => {
    formTouched.current = true;
    setForm((f) => ({ ...f, ...patch }));
  };

  // Position state
  // undefined = no pending change; null/number = new parent selected but not yet applied
  const [pendingParentId, setPendingParentId] = useState<number | null | undefined>(undefined);
  const [movingSaving, setMovingSaving] = useState(false);
  const [siblingsOrder, setSiblingsOrder] = useState<GroupTreeNode[]>([]);
  const [reorderDirty, setReorderDirty] = useState(false);
  const [reorderSaving, setReorderSaving] = useState(false);

  const getSiblings = useCallback((): GroupTreeNode[] => {
    if (!group) return [];
    const parentId = group.parentId;
    if (parentId === null) return tree;
    const parentNode = findNodeById(tree, parentId);
    return parentNode?.children ?? [];
  }, [group, tree]);

  // Sync sibling list when group or tree changes
  useEffect(() => {
    setSiblingsOrder(getSiblings());
    setReorderDirty(false);
  }, [getSiblings]);

  // Always load the group from the API: the store copy comes from the list
  // and is not refreshed when the agent config / thresholds are saved.
  useEffect(() => {
    let cancelled = false;
    groupsApi.getById(groupId)
      .then((g) => {
        if (cancelled) return;
        setGroup(g);
        if (!formTouched.current) setForm(formFromGroup(g));
      })
      .catch(() => { /* not found / no access: handled by the render below */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [groupId]);

  if (loading || (!treeReady && !directWrite)) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!group || !canWriteThis) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <p className="text-text-muted">{t('groups.notFoundOrDenied', 'Group not found or access denied')}</p>
        <Link to="/" className="mt-4">
          <Button variant="secondary">{t('monitors.backToDashboard')}</Button>
        </Link>
      </div>
    );
  }

  // Group-scope settings routes accept the group's RW holders (requireGroupWrite).
  const canEditSettings = admin || canWriteThis;

  /** Keep the page and the store in sync with a group returned by the server. */
  const applyGroupUpdate = (updated: MonitorGroup) => {
    setGroup(updated);
    updateGroup(updated.id, updated);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await groupsApi.update(groupId, {
        name: form.name,
        description: form.description || null,
        // The "general" flag widens visibility to the whole workspace: admin
        // setting, the checkbox is hidden for others.
        ...(admin ? { isGeneral: form.isGeneral } : {}),
        groupNotifications: form.groupNotifications,
      });
      toast.success(t('groups.updated'));
      fetchGroups();
      fetchTree();
      navigate(`/group/${groupId}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedUpdate')));
    } finally {
      setSaving(false);
    }
  };

  const handleMove = async () => {
    if (pendingParentId === undefined) return;
    setMovingSaving(true);
    try {
      await groupsApi.move(groupId, pendingParentId);
      toast.success(t('groups.moved'));
      setGroup((g) => g ? { ...g, parentId: pendingParentId } : g);
      setPendingParentId(undefined);
      await fetchGroups();
      await fetchTree();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedMove')));
    } finally {
      setMovingSaving(false);
    }
  };

  const moveSibling = (index: number, direction: -1 | 1) => {
    const swapIndex = index + direction;
    if (swapIndex < 0 || swapIndex >= siblingsOrder.length) return;
    const newOrder = [...siblingsOrder];
    [newOrder[index], newOrder[swapIndex]] = [newOrder[swapIndex], newOrder[index]];
    setSiblingsOrder(newOrder);
    setReorderDirty(true);
  };

  const handleReorder = async () => {
    setReorderSaving(true);
    try {
      await groupsApi.reorder(siblingsOrder.map((n, idx) => ({ id: n.id, sortOrder: idx })));
      toast.success(t('groups.orderSaved'));
      await fetchTree();
      setReorderDirty(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedOrder')));
    } finally {
      setReorderSaving(false);
    }
  };

  const handleSaveNotificationTypes = async (notificationTypes: NotificationTypeConfig | null) => {
    try {
      // Partial update: the server merges it into the stored agent config.
      const updated = await groupsApi.updateAgentGroupConfig(groupId, { agentGroupConfig: { notificationTypes } });
      applyGroupUpdate(updated);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedUpdate')));
      throw err; // the panel keeps its previous state
    }
  };

  const effectiveParentId = pendingParentId !== undefined ? pendingParentId : group.parentId;

  return (
    <PageContainer>
      <Link
        to={`/group/${groupId}`}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary mb-4 max-w-full coarse:min-h-10"
      >
        <ArrowLeft size={14} className="shrink-0" />
        <span className="truncate">{t('groups.backToGroup', { name: anonymize(group.name) })}</span>
      </Link>

      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <h1 className="text-2xl font-semibold text-text-primary max-sm:text-xl">{t('groups.edit')}</h1>
        <TenantBadge tenantId={group.tenantId} size="md" />
      </div>

      <div className="space-y-6">
        {/* ── General ── */}
        <section id="general" className={CARD}>
          <h2 className={CARD_TITLE}>{t('monitors.form.sectionGeneral')}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label={t('groups.form.name')}
              value={form.name}
              onChange={(e) => editForm({ name: e.target.value })}
              placeholder={t('groups.form.namePlaceholder')}
              required
            />
            <Input
              label={t('groups.form.description')}
              value={form.description}
              onChange={(e) => editForm({ description: e.target.value })}
              placeholder={t('groups.form.descriptionPlaceholder')}
            />
            {admin && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="is-general"
                  checked={form.isGeneral}
                  onCheckedChange={(v) => editForm({ isGeneral: v })}
                />
                <label htmlFor="is-general" className="text-sm text-text-secondary">
                  {t('groups.form.isGeneral')}
                </label>
              </div>
            )}
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="group-notifications"
                  checked={form.groupNotifications}
                  onCheckedChange={(v) => editForm({ groupNotifications: v })}
                />
                <label htmlFor="group-notifications" className="text-sm text-text-secondary">
                  {t('groups.form.groupNotifications')}
                </label>
              </div>
              <p className="text-xs text-text-muted ml-6">
                {t('groups.form.groupNotificationsDesc')}
              </p>
            </div>
            <div className="flex items-center gap-3 pt-2 flex-wrap">
              <Button type="submit" loading={saving}>{t('groups.save')}</Button>
              <Button type="button" variant="secondary" onClick={() => navigate(`/group/${groupId}`)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        </section>

        {/* ── Position: parent ('groups.manage' — the server also checks write
            access on the target) and order among siblings (admin-only route). ── */}
        {(canMoveGroup || (admin && siblingsOrder.length > 1)) && (
        <section id="position" className={CARD}>
          <h2 className={CARD_TITLE}>{t('groups.position', 'Position')}</h2>

          {canMoveGroup && (
          <div className={siblingsOrder.length > 1 && admin ? 'mb-5' : undefined}>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t('groups.form.parent')}</label>
            <GroupPicker
              value={effectiveParentId}
              onChange={(pid) => setPendingParentId(pid === group.parentId ? undefined : pid)}
              tree={tree}
              placeholder={t('groups.form.parentNone')}
              excludeId={groupId}
            />
            {pendingParentId !== undefined && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <Button size="sm" onClick={handleMove} loading={movingSaving}>
                  {t('groups.applyMove')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingParentId(undefined)}>
                  {t('common.cancel')}
                </Button>
              </div>
            )}
          </div>
          )}

          {admin && siblingsOrder.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-2">
                {t('groups.form.sortOrder')}
              </label>
              <div className="rounded-md border border-border overflow-hidden divide-y divide-border">
                {siblingsOrder.map((sibling, idx) => (
                  <div
                    key={sibling.id}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 text-sm',
                      sibling.id === groupId
                        ? 'bg-accent/5 text-text-primary font-medium'
                        : 'text-text-secondary',
                    )}
                  >
                    <span className="w-5 shrink-0 text-right text-xs text-text-muted">{idx + 1}</span>
                    <span className="flex-1 truncate">{anonymize(sibling.name)}</span>
                    {sibling.id === groupId && (
                      <div className="flex items-center gap-0.5 coarse:gap-1">
                        <IconButton
                          label={t('groups.form.moveUp')}
                          icon={<ChevronUp size={14} className="coarse:h-5 coarse:w-5" />}
                          size="xs"
                          variant="plain"
                          onClick={() => moveSibling(idx, -1)}
                          disabled={idx === 0}
                          className="disabled:opacity-30"
                        />
                        <IconButton
                          label={t('groups.form.moveDown')}
                          icon={<ChevronDown size={14} className="coarse:h-5 coarse:w-5" />}
                          size="xs"
                          variant="plain"
                          onClick={() => moveSibling(idx, 1)}
                          disabled={idx === siblingsOrder.length - 1}
                          className="disabled:opacity-30"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {reorderDirty && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <Button size="sm" onClick={handleReorder} loading={reorderSaving}>
                    {t('groups.saveOrder')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => { setSiblingsOrder(getSiblings()); setReorderDirty(false); }}
                  >
                    {t('common.reset')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
        )}

        {/* ── Notifications: channel bindings ('notifications' capability) and
            agent notification types (admin only — saved through the
            agent-group-config path) ── */}
        {(hasCapability('notifications') || admin) && (
          <section id="notifications" className="space-y-4">
            {hasCapability('notifications') && (
              <NotificationBindingsPanel
                scope="group"
                scopeId={groupId}
                title={t('monitors.sectionNotifications')}
              />
            )}
            {admin && (
              <NotificationTypesPanel
                config={group.agentGroupConfig?.notificationTypes ?? null}
                scope="group"
                title={t('groups.sections.agentNotificationTypes', 'Agent notification types')}
                onSave={handleSaveNotificationTypes}
              />
            )}
          </section>
        )}

        {/* ── Remediations ('remediation' capability) ── */}
        {hasCapability('remediation') && (
          <section id="remediations">
            <RemediationBindingsPanel
              scope="group"
              scopeId={groupId}
              title={t('monitors.sectionRemediations')}
            />
          </section>
        )}

        {/* ── Maintenance ('maintenance' capability) ── */}
        {hasCapability('maintenance') && (
          <section id="maintenance" className="rounded-lg border border-border bg-bg-secondary p-4">
            <MaintenanceWindowList
              scopeType="group"
              scopeId={groupId}
              channels={[]}
              defaultScopeType="group"
              defaultScopeId={groupId}
              title={t('maintenance.title')}
            />
          </section>
        )}

        {/* ── Monitor checks (settings inherited by the monitors of the group) ── */}
        {canEditSettings && (
          <section id="monitor-checks">
            <SettingsPanel
              scope="group"
              scopeId={groupId}
              title={t('groups.sections.monitorChecks', 'Monitor checks')}
            />
          </section>
        )}

        {/* ── Agent update policy (agents.manage on the group's workspace) ── */}
        {hasCapability('agents.manage') && (
          <section id="agent-updates">
            <GroupUpdatePolicySection group={group} onGroupUpdate={applyGroupUpdate} />
          </section>
        )}

        {/* ── Agents: defaults + thresholds (admin only) ── */}
        {admin && (
          <section id="agents">
            <AgentGroupSettingsPanel group={group} onUpdate={applyGroupUpdate} />
          </section>
        )}
      </div>
    </PageContainer>
  );
}
