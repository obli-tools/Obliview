import { useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import type { GroupTreeNode } from '@obliview/shared';
import { groupsApi } from '@/api/groups.api';
import { useGroupStore } from '@/store/groupStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Checkbox } from '@/components/common/Checkbox';
import { GroupPicker } from '@/components/common/GroupPicker';
import { anonymize } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';
import { computeWritableGroupIds, findTreeGroup } from './GroupNode';

export interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  /** Pre-selected parent (e.g. 'New subgroup' on a group page). null / undefined = root level. */
  defaultParentId?: number | null;
}

/**
 * Keep only the groups a non-admin may create under: a writable group keeps
 * its whole subtree (write access is inherited), a read-only one is replaced
 * by its writable descendants so it can never be picked.
 */
function pruneToWritable(nodes: GroupTreeNode[], writable: Set<number>): GroupTreeNode[] {
  const out: GroupTreeNode[] = [];
  for (const n of nodes) {
    if (writable.has(n.id)) out.push(n);
    else out.push(...pruneToWritable(n.children, writable));
  }
  return out;
}

/**
 * "New group" dialog — name, parent, isGeneral (admins) and description.
 * Opened from the sidebar tree header ('+') and from a group page ('New
 * subgroup', with `defaultParentId`). On success it navigates to the new
 * group's settings page (/group/:id/edit).
 */
export function CreateGroupModal(props: CreateGroupModalProps) {
  // Mounted only while open, so every opening starts from a fresh form.
  if (!props.open) return null;
  return <CreateGroupForm {...props} />;
}

function CreateGroupForm({ onClose, defaultParentId = null }: CreateGroupModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const formId = useId();
  const nameId = useId();
  const descriptionId = useId();
  const generalId = useId();
  const tree = useGroupStore((s) => s.tree);
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const permissions = useAuthStore((s) => s.permissions);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentId, setParentId] = useState<number | null>(defaultParentId);
  const [isGeneral, setIsGeneral] = useState(false);
  const [saving, setSaving] = useState(false);

  // Parents the server accepts: POST /groups creates the group in the active
  // tenant and its parent must live there (in god view the tree spans every
  // tenant); non-admins also need write access on the parent.
  const parentTree = useMemo(() => {
    const own = currentTenantId == null ? tree : tree.filter((n) => n.tenantId === currentTenantId);
    const writable = computeWritableGroupIds(tree, isAdmin, permissions?.permissions);
    return writable === null ? own : pruneToWritable(own, writable);
  }, [tree, currentTenantId, isAdmin, permissions]);

  const parentAllowed = parentId === null || findTreeGroup(parentTree, parentId) !== null;
  const blockedParentName = !parentAllowed && parentId !== null
    ? anonymize(findTreeGroup(tree, parentId)?.name ?? `#${parentId}`)
    : null;
  const canSubmit = name.trim().length > 0 && parentAllowed && !saving;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      const group = await groupsApi.create({
        name: name.trim(),
        description: description.trim() || null,
        parentId,
        // isGeneral (visible to every tenant member) is admin-only: the server
        // ignores it from anyone else, and only admins get the checkbox.
        ...(isAdmin ? { isGeneral } : {}),
      });
      if (!isAdmin) {
        // The server just granted RW on the new group to the creator's
        // canCreate teams: reload the permission map before opening its
        // settings page (refreshPermissions swallows its own errors).
        await useAuthStore.getState().refreshPermissions();
      }
      const store = useGroupStore.getState();
      store.addGroup(group);
      toast.success(t('groups.created', 'Group created'));
      onClose();
      navigate(`/group/${group.id}/edit`);
      // group:created only reaches the admin room: refresh the tree ourselves,
      // then open the new group's ancestors in the sidebar.
      void store.fetchTree().then(() => useGroupStore.getState().expandAncestors(group.id));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groups.failedCreate', 'Failed to create group')));
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!saving}
      size="sm"
      icon={<FolderPlus className="h-4 w-4 text-accent" />}
      title={t('groups.new', 'New group')}
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="submit" form={formId} loading={saving} disabled={!canSubmit}>
            {t('common.create', 'Create')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <Input
          id={nameId}
          label={t('groups.form.name', 'Name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('groups.form.namePlaceholder', 'Group name')}
          maxLength={255}
          required
          autoFocus
        />

        <div className="space-y-1">
          <span className="block text-sm font-medium text-text-secondary">
            {t('groups.form.parent', 'Parent Group')}
          </span>
          <GroupPicker
            value={parentId}
            onChange={setParentId}
            tree={parentTree}
            placeholder={t('groups.form.parentNone', 'None (root level)')}
          />
          {blockedParentName !== null && (
            <p className="text-xs text-status-down">
              {t(
                'groups.parentNotAllowed',
                'Subgroups of "{{name}}" cannot be created here (other workspace or read-only access). Choose another parent.',
                { name: blockedParentName },
              )}
            </p>
          )}
        </div>

        {isAdmin && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={generalId}
              checked={isGeneral}
              onCheckedChange={setIsGeneral}
            />
            <label htmlFor={generalId} className="text-sm text-text-secondary">
              {t('groups.form.isGeneral', 'General group (visible to all users)')}
            </label>
          </div>
        )}

        <Input
          id={descriptionId}
          label={t('groups.form.description', 'Description (optional)')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('groups.form.descriptionPlaceholder', 'Optional description')}
          maxLength={2000}
        />
      </form>
    </Modal>
  );
}

export default CreateGroupModal;
