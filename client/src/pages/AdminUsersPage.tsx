import { useState, useEffect, type FormEvent } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Key,
  Shield,
  UserIcon,
  UserX,
  Users,
  FolderOpen,
  Monitor,
  Check,
  ChevronRight,
  ChevronDown,
  Eye,
  Building2,
  ShieldOff,
} from 'lucide-react';
import type {
  User,
  UserTeam,
  TeamPermission,
  GroupTreeNode,
  Monitor as MonitorType,
  PermissionLevel,
  PermissionScope,
  UserTenantAssignment,
} from '@obliview/shared';
import apiClient from '@/api/client';
import { usersApi } from '@/api/users.api';
import { teamsApi } from '@/api/teams.api';
import { groupsApi } from '@/api/groups.api';
import { monitorsApi } from '@/api/monitors.api';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { anonymize, anonymizeUsername } from '@/utils/anonymize';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Checkbox } from '@/components/common/Checkbox';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import { MasterDetail } from '@/components/common/MasterDetail';
import { Drawer } from '@/components/common/Drawer';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs, type SegmentedTab } from '@/components/common/SegmentedTabs';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useIsGodView } from '@/hooks/useIsGodView';
import { useIsCoarsePointer } from '@/hooks/useMediaQuery';
import { useTabParam } from '@/hooks/useTabParam';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { PermissionSetsTab } from '@/components/PermissionSetsTab';

const TABS = ['users', 'teams', 'permissionSets'] as const;
type Tab = (typeof TABS)[number];
/** Permission sets are platform-admin only: ?tab=permissionSets resolves to 'users' for others. */
const TABS_NON_ADMIN = ['users', 'teams'] as const satisfies readonly Tab[];
type RightTab = 'members' | 'permissions';
type UserFormMode = 'create' | 'edit' | 'password' | null;
type TeamFormMode = 'create' | 'edit' | null;
type TenantDraft = Record<number, { isMember: boolean; role: string }>;

interface PermissionSetSummary {
  slug: string;
  name: string;
  isDefault: boolean;
}

// Row actions: inline icons from md (hover-revealed with a mouse, always
// visible on touch), everything in a "⋯" menu below md.
const ROW_ACTION_CLS = 'hidden md:inline-flex shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100';

const SELECT_CLS =
  'w-full rounded-md bg-bg-tertiary px-3 py-2 text-sm text-text-primary coarse:min-h-10 focus:outline-none focus:ring-2 focus:ring-accent';

/** SSO users carry an `og_` prefix that is never shown. */
function displayUsername(username: string): string {
  return username.startsWith('og_') ? username.slice(3) : username;
}

export function AdminUsersPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  // Touch: team-member rows toggle from anywhere in the row (mouse keeps the
  // box-only click, so selecting the username text does not toggle).
  const coarse = useIsCoarsePointer();
  const { user: currentUser, isAdmin } = useAuthStore();
  // Tenant user managers (users.manage, not platform admin) cannot set the
  // platform role, edit workspace assignments or write permission sets: the
  // server answers 403 on those (users.routes guardUserTarget,
  // /users/:id/tenants and permission-set writes are platform-admin only).
  const platformAdmin = isAdmin();
  const storeTenants = useTenantStore((s) => s.tenants);
  const currentTenantId = useTenantStore((s) => s.currentTenantId);
  // God view (platform admin on the master tenant): teams of every tenant are
  // listed, and a new team must be given its tenant (teams are mono-tenant).
  const isGodView = useIsGodView();
  const [tab, setTab] = useTabParam<Tab>(platformAdmin ? TABS : TABS_NON_ADMIN, 'users');

  // Data
  const [users, setUsers] = useState<User[]>([]);
  const [teams, setTeams] = useState<UserTeam[]>([]);
  const [tree, setTree] = useState<GroupTreeNode[]>([]);
  const [monitors, setMonitors] = useState<MonitorType[]>([]);

  // User form
  const [userFormMode, setUserFormMode] = useState<UserFormMode>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [formUsername, setFormUsername] = useState('');
  const [formDisplayName, setFormDisplayName] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formRole, setFormRole] = useState<'admin' | 'user'>('user');
  const [saving, setSaving] = useState(false);

  // Team form
  const [teamFormMode, setTeamFormMode] = useState<TeamFormMode>(null);
  const [editingTeam, setEditingTeam] = useState<UserTeam | null>(null);
  const [formTeamName, setFormTeamName] = useState('');
  const [formTeamDesc, setFormTeamDesc] = useState('');
  const [formCanCreate, setFormCanCreate] = useState(false);
  const [formTeamTenantId, setFormTeamTenantId] = useState<number | ''>('');

  // Selected team for the detail pane
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null);
  const [teamMembers, setTeamMembers] = useState<number[]>([]);
  const [teamPermissions, setTeamPermissions] = useState<TeamPermission[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>('members');

  // Members of the selected team's tenant (god view only: elsewhere the users
  // list is already the active tenant's). null = no filtering needed.
  const [teamTenantUserIds, setTeamTenantUserIds] = useState<Set<number> | null>(null);

  // Team tenant filter (god view only)
  const [teamTenantFilter, setTeamTenantFilter] = useState<number | 'all'>('all');

  // Tenant assignment panel
  const [tenantPanelUser, setTenantPanelUser] = useState<User | null>(null);
  const [tenantAssignments, setTenantAssignments] = useState<UserTenantAssignment[]>([]);
  const [tenantDraft, setTenantDraft] = useState<TenantDraft>({});
  const [tenantPanelLoading, setTenantPanelLoading] = useState(false);
  const [tenantSaving, setTenantSaving] = useState(false);

  // Available permission_set slugs (feeds the tenant role dropdown). Includes
  // 'admin' implicitly even when not in the table — that slug is the canonical
  // tenant-admin escape hatch (short-circuit in permission.service).
  const [permissionSets, setPermissionSets] = useState<PermissionSetSummary[]>([]);
  useEffect(() => {
    apiClient
      .get<{ success: boolean; data: PermissionSetSummary[] }>('/permission-sets')
      .then((res) => setPermissionSets(res.data.data ?? []))
      .catch(() => setPermissionSets([]));
  }, []);

  const load = async () => {
    try {
      // Always scope teams to the current tenant — admins switch tenants via the
      // top-bar selector when they need to manage another tenant's teams. Using
      // listAll() here previously made teams of every tenant appear regardless
      // of the current context, which the user reasonably reported as a bug.
      const [u, t, tr, m] = await Promise.all([
        usersApi.list(),
        teamsApi.list(),
        groupsApi.tree(),
        monitorsApi.list(),
      ]);
      setUsers(u);
      setTeams(t);
      setTree(tr);
      setMonitors(m);
    } catch {
      toast.error(t('users.failedLoad'));
    }
  };

  useEffect(() => { load(); }, []);

  // Narrow screens: the inline forms open at the top of a possibly long list.
  useEffect(() => {
    if (!userFormMode && !teamFormMode) return;
    const id = requestAnimationFrame(() => {
      document.getElementById('admin-users-form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [userFormMode, teamFormMode]);

  const loadTeamDetails = async (teamId: number) => {
    try {
      const detail = await teamsApi.getById(teamId);
      setTeamMembers(detail.memberIds);
      setTeamPermissions(detail.permissions);
    } catch {
      toast.error(t('users.teams.failedMembers'));
    }
  };

  const selectTeam = (teamId: number) => {
    setSelectedTeamId(teamId);
    setRightTab('members');
    loadTeamDetails(teamId);
  };

  // Teams are mono-tenant: in the god view the member picker only offers the
  // users of the selected team's tenant (the server rejects the others).
  const selectedTeamTenantId = teams.find((t2) => t2.id === selectedTeamId)?.tenantId ?? null;
  useEffect(() => {
    if (!isGodView || selectedTeamTenantId === null) {
      setTeamTenantUserIds(null);
      return;
    }
    let cancelled = false;
    setTeamTenantUserIds(new Set());
    apiClient
      .get<{ success: boolean; data: Array<{ id: number }> }>(`/tenants/${selectedTeamTenantId}/members`)
      .then((res) => { if (!cancelled) setTeamTenantUserIds(new Set((res.data.data ?? []).map((m) => m.id))); })
      .catch(() => { if (!cancelled) toast.error(t('users.teams.failedMembers')); });
    return () => { cancelled = true; };
  }, [isGodView, selectedTeamTenantId]);

  // ── Derived: unique tenants from teams list ──
  const teamTenants: { id: number; name: string }[] = [];
  const seenTenantIds = new Set<number>();
  for (const team of teams) {
    if (team.tenantId && !seenTenantIds.has(team.tenantId)) {
      seenTenantIds.add(team.tenantId);
      teamTenants.push({
        id: team.tenantId,
        name: team.tenantName ?? t('ui.tenant.fallback', 'Tenant {{id}}', { id: team.tenantId }),
      });
    }
  }
  teamTenants.sort((a, b) => a.name.localeCompare(b.name));

  const filteredTeams = (isGodView && teamTenantFilter !== 'all')
    ? teams.filter((t) => t.tenantId === teamTenantFilter)
    : teams;

  // ── User form handlers ──

  const resetUserForm = () => {
    setUserFormMode(null);
    setEditingUser(null);
    setFormUsername('');
    setFormDisplayName('');
    setFormPassword('');
    setFormRole('user');
  };

  const startEditUser = (user: User) => {
    setEditingUser(user);
    setFormUsername(user.username);
    setFormDisplayName(user.displayName || '');
    setFormRole(user.role);
    setUserFormMode('edit');
  };

  const startPasswordUser = (user: User) => {
    setEditingUser(user);
    setFormPassword('');
    setUserFormMode('password');
  };

  const handleCreateUser = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await usersApi.create({
        username: formUsername,
        password: formPassword,
        displayName: formDisplayName || undefined,
        ...(platformAdmin ? { role: formRole } : {}),
      });
      toast.success(t('users.created'));
      resetUserForm();
      load();
    } catch {
      toast.error(t('users.failedCreate'));
    } finally {
      setSaving(false);
    }
  };

  const handleEditUser = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.update(editingUser.id, {
        username: formUsername,
        displayName: formDisplayName || null,
        ...(platformAdmin ? { role: formRole } : {}),
      });
      toast.success(t('users.updated'));
      resetUserForm();
      load();
    } catch {
      toast.error(t('users.failedUpdate'));
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setSaving(true);
    try {
      await usersApi.changePassword(editingUser.id, formPassword);
      toast.success(t('users.passwordChangedToast'));
      resetUserForm();
    } catch {
      toast.error(t('users.failedChangePasswordToast'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteUser = async (user: User) => {
    const ok = await confirm({
      message: t('users.confirmDelete', { username: displayUsername(user.username) }),
      danger: true,
    });
    if (!ok) return;
    try {
      await usersApi.delete(user.id);
      toast.success(t('users.deleted'));
      load();
    } catch {
      toast.error(t('users.failedDelete'));
    }
  };

  // Admin reset of a locked-out user's second factors (lost authenticator,
  // unreachable OTP mailbox). The user's sessions end; they sign in with the
  // password alone and set 2FA up again from their profile.
  const handleResetTwoFactor = async (user: User) => {
    const ok = await confirm({
      title: t('users.reset2fa.title', 'Reset two-factor authentication'),
      message: t('users.reset2fa.confirm', {
        username: displayUsername(user.username),
        defaultValue: 'Remove every second factor (authenticator app and e-mail codes) of {{username}}? Their sessions will be ended and they will sign in with their password only until they set two-factor authentication up again.',
      }),
      confirmLabel: t('users.reset2fa.action', 'Reset 2FA'),
      danger: true,
    });
    if (!ok) return;
    try {
      await usersApi.resetTwoFactor(user.id);
      toast.success(t('users.reset2fa.done', 'Two-factor authentication reset'));
      load();
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || t('users.reset2fa.failed', 'Could not reset two-factor authentication'));
    }
  };

  const handleToggleActive = async (user: User) => {
    try {
      await usersApi.update(user.id, { isActive: !user.isActive });
      toast.success(user.isActive ? t('users.disabled') : t('users.enabled'));
      load();
    } catch {
      toast.error(t('users.failedUpdate'));
    }
  };

  // ── Team form handlers ──

  const resetTeamForm = () => {
    setTeamFormMode(null);
    setEditingTeam(null);
    setFormTeamName('');
    setFormTeamDesc('');
    setFormCanCreate(false);
    setFormTeamTenantId('');
  };

  const startEditTeam = (team: UserTeam) => {
    setEditingTeam(team);
    setFormTeamName(team.name);
    setFormTeamDesc(team.description || '');
    setFormCanCreate(team.canCreate);
    setTeamFormMode('edit');
  };

  const handleCreateTeam = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Teams are mono-tenant: from the god view the tenant is mandatory; from
      // any other tenant the server forces the active one.
      const team = await teamsApi.create({
        name: formTeamName,
        description: formTeamDesc || null,
        canCreate: formCanCreate,
        ...(isGodView && formTeamTenantId !== '' ? { tenantId: Number(formTeamTenantId) } : {}),
      });
      toast.success(t('users.teams.created'));
      resetTeamForm();
      load();
      selectTeam(team.id);
    } catch {
      toast.error(t('users.teams.failedCreate'));
    } finally {
      setSaving(false);
    }
  };

  const handleEditTeam = async (e: FormEvent) => {
    e.preventDefault();
    if (!editingTeam) return;
    setSaving(true);
    try {
      await teamsApi.update(editingTeam.id, {
        name: formTeamName,
        description: formTeamDesc || null,
        canCreate: formCanCreate,
      });
      toast.success(t('users.teams.updated'));
      resetTeamForm();
      load();
    } catch {
      toast.error(t('users.teams.failedUpdate'));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTeam = async (team: UserTeam) => {
    const ok = await confirm({
      message: t('users.teams.confirmDelete', { name: team.name }),
      danger: true,
    });
    if (!ok) return;
    try {
      await teamsApi.delete(team.id);
      toast.success(t('users.teams.deleted'));
      if (selectedTeamId === team.id) setSelectedTeamId(null);
      load();
    } catch {
      toast.error(t('users.teams.failedDelete'));
    }
  };

  // ── Tenant panel handlers ──

  const openTenantPanel = async (user: User) => {
    setTenantPanelUser(user);
    setTenantPanelLoading(true);
    try {
      const assignments = await usersApi.getTenants(user.id);
      setTenantAssignments(assignments);
      const draft: TenantDraft = {};
      for (const a of assignments) {
        draft[a.tenantId] = { isMember: a.isMember, role: a.role };
      }
      setTenantDraft(draft);
    } catch {
      toast.error(t('users.failedLoadTenants'));
      setTenantPanelUser(null);
    } finally {
      setTenantPanelLoading(false);
    }
  };

  const closeTenantPanel = () => {
    setTenantPanelUser(null);
    setTenantAssignments([]);
    setTenantDraft({});
  };

  const toggleTenantMember = (tenantId: number) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: false, role: 'user' };
      return { ...prev, [tenantId]: { ...current, isMember: !current.isMember } };
    });
  };

  const setTenantRole = (tenantId: number, role: string) => {
    setTenantDraft((prev) => {
      const current = prev[tenantId] ?? { isMember: true, role };
      return { ...prev, [tenantId]: { ...current, role } };
    });
  };

  const saveTenantAssignments = async () => {
    if (!tenantPanelUser) return;
    setTenantSaving(true);
    try {
      const assignments = Object.entries(tenantDraft)
        .filter(([, v]) => v.isMember)
        .map(([tenantId, v]) => ({ tenantId: Number(tenantId), role: v.role }));
      await usersApi.setTenants(tenantPanelUser.id, assignments);
      toast.success(t('users.tenantsSaved'));
      closeTenantPanel();
    } catch {
      toast.error(t('users.failedSaveTenants'));
    } finally {
      setTenantSaving(false);
    }
  };

  // ── Members management ──

  const toggleMember = async (userId: number) => {
    if (!selectedTeamId) return;
    const newMembers = teamMembers.includes(userId)
      ? teamMembers.filter((id) => id !== userId)
      : [...teamMembers, userId];
    try {
      await teamsApi.setMembers(selectedTeamId, { userIds: newMembers });
      setTeamMembers(newMembers);
    } catch {
      toast.error(t('users.teams.failedUpdateMembers'));
    }
  };

  // ── Permissions management ──

  const addPermission = async (scope: PermissionScope, scopeId: number, level: PermissionLevel) => {
    if (!selectedTeamId) return;
    const existing = teamPermissions.find((p) => p.scope === scope && p.scopeId === scopeId);
    if (existing) {
      const newPerms = teamPermissions.map((p) =>
        p.id === existing.id ? { ...p, level } : p,
      );
      try {
        await teamsApi.setPermissions(selectedTeamId, {
          permissions: newPerms.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
        });
        await loadTeamDetails(selectedTeamId);
      } catch {
        toast.error(t('users.teams.failedUpdatePermission'));
      }
    } else {
      const newPerms = [
        ...teamPermissions.map((p) => ({ scope: p.scope, scopeId: p.scopeId, level: p.level })),
        { scope, scopeId, level },
      ];
      try {
        await teamsApi.setPermissions(selectedTeamId, { permissions: newPerms });
        await loadTeamDetails(selectedTeamId);
      } catch {
        toast.error(t('users.teams.failedAddPermission'));
      }
    }
  };

  const removePermission = async (permId: number) => {
    if (!selectedTeamId) return;
    try {
      await teamsApi.removePermission(selectedTeamId, permId);
      setTeamPermissions((prev) => prev.filter((p) => p.id !== permId));
    } catch {
      toast.error(t('users.teams.failedRemovePermission'));
    }
  };

  const togglePermissionLevel = async (perm: TeamPermission) => {
    const newLevel: PermissionLevel = perm.level === 'ro' ? 'rw' : 'ro';
    await addPermission(perm.scope, perm.scopeId, newLevel);
  };

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);
  const teamDetailOpen = tab === 'teams' && !!selectedTeam;

  // Teams are mono-tenant: the grant tree only offers the selected team's
  // tenant (in the god view, groups / monitors of every tenant are loaded).
  // An entity without tenantId belongs to the active tenant.
  const inTeamTenant = (tenantId: number | undefined) =>
    !selectedTeam || (tenantId ?? currentTenantId) === selectedTeam.tenantId;
  const teamTree = tree.filter((node) => inTeamTenant(node.tenantId));
  const teamMonitors = monitors.filter((m) => inTeamTenant(m.tenantId));

  // Build sets for quick lookup
  const assignedGroupIds = new Set(teamPermissions.filter((p) => p.scope === 'group').map((p) => p.scopeId));
  const assignedMonitorIds = new Set(teamPermissions.filter((p) => p.scope === 'monitor').map((p) => p.scopeId));

  // Collect all descendant group IDs covered by a group permission (implicit coverage)
  const coveredGroupIds = new Set<number>();
  const coveredByGroupId = new Map<number, number>(); // descendant → assigned ancestor
  const collectDescendants = (nodes: GroupTreeNode[], coveredBy: number | null) => {
    for (const node of nodes) {
      const directlyAssigned = assignedGroupIds.has(node.id);
      const effectiveCover = directlyAssigned ? node.id : coveredBy;
      if (coveredBy && !directlyAssigned) {
        coveredGroupIds.add(node.id);
        coveredByGroupId.set(node.id, coveredBy);
      }
      collectDescendants(node.children, effectiveCover);
      if (effectiveCover) {
        for (const m of teamMonitors.filter((mon) => mon.groupId === node.id)) {
          if (!assignedMonitorIds.has(m.id)) {
            coveredByGroupId.set(-m.id, effectiveCover);
          }
        }
      }
    }
  };
  collectDescendants(teamTree, null);

  // Merge monitors into tree nodes for display
  const monitorsByGroup = new Map<number, MonitorType[]>();
  const ungroupedMonitors: MonitorType[] = [];
  for (const m of teamMonitors) {
    if (m.groupId) {
      if (!monitorsByGroup.has(m.groupId)) monitorsByGroup.set(m.groupId, []);
      monitorsByGroup.get(m.groupId)!.push(m);
    } else {
      ungroupedMonitors.push(m);
    }
  }

  // Get permission for a group/monitor
  const getGroupPerm = (groupId: number) => teamPermissions.find((p) => p.scope === 'group' && p.scopeId === groupId);
  const getMonitorPerm = (monitorId: number) => teamPermissions.find((p) => p.scope === 'monitor' && p.scopeId === monitorId);

  // ── Row action gating (same rules for the inline icons and the phone menu) ──

  const userRowFlags = (user: User) => {
    const isSso = user.foreignSource === 'obligate';
    const isSelf = user.id === currentUser?.id;
    // Platform admins are managed by platform admins only (server guardUserTarget).
    const lockedAdmin = !platformAdmin && user.role === 'admin';
    return {
      canPassword: !isSelf && !isSso && !user.foreignSource && !lockedAdmin,
      canToggleActive: !isSelf && !isSso && !lockedAdmin,
      canEdit: !isSso && !lockedAdmin,
      // Tenant assignment — hidden for SSO users (managed from Obligate)
      canTenants: !isSso && platformAdmin,
      canDelete: !isSelf && !isSso && !lockedAdmin,
      // Own factors: from the profile. SSO users: 2FA lives in Obligate.
      canResetTwoFactor: !isSelf && !isSso && !lockedAdmin && !!(user.totpEnabled || user.emailOtpEnabled),
    };
  };

  const userMenuItems = (user: User): ActionMenuItem[] => {
    const f = userRowFlags(user);
    return [
      { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit'), onClick: () => startEditUser(user), hidden: !f.canEdit },
      { key: 'password', icon: <Key size={16} />, label: t('users.actions.password', 'Change password'), onClick: () => startPasswordUser(user), hidden: !f.canPassword },
      { key: 'tenants', icon: <Building2 size={16} />, label: t('users.actions.tenants', 'Manage tenant access'), onClick: () => openTenantPanel(user), hidden: !f.canTenants },
      { key: 'reset2fa', icon: <ShieldOff size={16} />, label: t('users.reset2fa.action', 'Reset 2FA'), onClick: () => handleResetTwoFactor(user), hidden: !f.canResetTwoFactor },
      { key: 'active', icon: user.isActive ? <UserX size={16} /> : <UserIcon size={16} />, label: user.isActive ? t('common.disable') : t('common.enable'), onClick: () => handleToggleActive(user), hidden: !f.canToggleActive },
      { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), onClick: () => handleDeleteUser(user), hidden: !f.canDelete, danger: true, separator: true },
    ];
  };

  const mainTabs: SegmentedTab<Tab>[] = [
    { id: 'users', label: t('users.tabUsers'), icon: <UserIcon size={14} /> },
    { id: 'teams', label: t('users.tabTeams'), icon: <Users size={14} /> },
    { id: 'permissionSets', label: t('users.tabPermissions', 'Permissions'), icon: <Shield size={14} /> },
  ].filter((tb) => tb.id !== 'permissionSets' || platformAdmin) as SegmentedTab<Tab>[];

  const rightTabs: SegmentedTab<RightTab>[] = [
    { id: 'members', label: t('users.teams.tabMembers') },
    { id: 'permissions', label: t('users.teams.tabPermissions') },
  ];

  // Member picker: non-admin users of the selected team's tenant only.
  const nonAdminUsers = users.filter((u) =>
    u.role !== 'admin' && (teamTenantUserIds === null || teamTenantUserIds.has(u.id)),
  );

  // Tenant choices when creating a team from the god view.
  const creatableTenants = [...storeTenants].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <PageContainer className="h-full">
      <MasterDetail
        className="lg:gap-6"
        // The permission matrix needs the full width; the lists keep max-w-xl.
        masterClassName={tab === 'permissionSets' ? 'lg:flex-1' : 'lg:flex-1 lg:max-w-xl'}
        detailClassName={teamDetailOpen ? 'lg:flex-1 lg:max-w-2xl' : 'lg:hidden'}
        hasDetail={teamDetailOpen}
        onBack={() => setSelectedTeamId(null)}
        detailTitle={selectedTeam ? anonymize(selectedTeam.name) : undefined}
        master={
          <>
            {/* Tab switcher (?tab= deep link) */}
            <SegmentedTabs<Tab>
              tabs={mainTabs}
              value={tab}
              onChange={setTab}
              className="mb-4"
              tabClassName="gap-1.5"
              ariaLabel={t('nav.users', 'Users')}
            />

            {/* ── Users Tab ── */}
            {tab === 'users' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('users.tabUsers')}</h2>
                  <Button size="sm" onClick={() => { resetUserForm(); setUserFormMode('create'); }}>
                    <Plus size={14} className="mr-1" />{t('common.new')}
                  </Button>
                </div>

                {/* User form */}
                {(userFormMode === 'create' || userFormMode === 'edit') && (
                  <div id="admin-users-form" className="mb-4 rounded-lg bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {userFormMode === 'create' ? t('users.newUser') : t('users.editUser', { username: editingUser?.username })}
                    </h3>
                    <form onSubmit={userFormMode === 'create' ? handleCreateUser : handleEditUser} className="space-y-3">
                      <Input label={t('users.usernameLabel')} value={formUsername} onChange={(e) => setFormUsername(e.target.value)} required pattern="[a-zA-Z0-9_.\-]+" disabled={userFormMode === 'edit' && !!editingUser?.foreignSource} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" />
                      <Input label={t('users.displayNameLabel')} value={formDisplayName} onChange={(e) => setFormDisplayName(e.target.value)} />
                      {userFormMode === 'create' && (
                        <Input label={t('users.passwordLabel')} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
                      )}
                      {platformAdmin && <div className="space-y-1">
                        <label htmlFor="admin-user-role" className="block text-sm font-medium text-text-secondary">{t('users.roleLabel')}</label>
                        <select id="admin-user-role" value={formRole} onChange={(e) => setFormRole(e.target.value as 'admin' | 'user')} className={SELECT_CLS}>
                          <option value="user">{t('users.roleUser')}</option>
                          <option value="admin">{t('users.roleAdmin')}</option>
                        </select>
                      </div>}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{userFormMode === 'create' ? t('common.create') : t('common.save')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetUserForm}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {userFormMode === 'password' && editingUser && (
                  <div id="admin-users-form" className="mb-4 rounded-lg bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {t('users.changePasswordTitle', { username: editingUser.username })}
                    </h3>
                    <form onSubmit={handlePasswordChange} className="space-y-3">
                      <Input label={t('users.newPassword')} type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} required minLength={6} autoComplete="new-password" />
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{t('users.changePassword')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetUserForm}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {/* User list */}
                <div className="rounded-lg bg-bg-secondary divide-y divide-border">
                  {users.map((user) => {
                    const flags = userRowFlags(user);
                    const shownName = displayUsername(user.username);
                    return (
                      <div key={user.id} className="flex items-center gap-2 px-3 py-2.5 group">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-text-primary truncate">{anonymizeUsername(shownName)}</span>
                            {user.displayName && <span className="text-xs text-text-muted">({anonymize(user.displayName)})</span>}
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                              user.role === 'admin' ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-muted'
                            }`}>
                              {user.role === 'admin' ? <><Shield size={10} className="inline mr-0.5" />{t('users.roleAdmin')}</> : t('users.roleUser')}
                            </span>
                            {user.foreignSource === 'obligate' && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[#D3AB52]/15 border border-[#D3AB52]/40 px-1.5 py-0.5 text-[10px] font-medium text-[#D3AB52]">
                                SSO
                              </span>
                            )}
                            {user.totpEnabled && (
                              <span
                                className="rounded-full bg-status-up/10 px-1.5 py-0.5 text-[10px] font-medium text-status-up"
                                title={t('users.badge2faTotpTitle', 'Two-factor authentication: authenticator app')}
                              >
                                {t('users.badge2faTotp', 'TOTP')}
                              </span>
                            )}
                            {user.emailOtpEnabled && (
                              <span
                                className="rounded-full bg-status-up/10 px-1.5 py-0.5 text-[10px] font-medium text-status-up"
                                title={t('users.badge2faEmailTitle', 'Two-factor authentication: e-mail codes')}
                              >
                                {t('users.badge2faEmail', 'Email')}
                              </span>
                            )}
                            {!user.isActive && (
                              <span className="rounded-full bg-status-down/10 px-1.5 py-0.5 text-[10px] font-medium text-status-down">{t('common.off', 'Off')}</span>
                            )}
                          </div>
                        </div>
                        {flags.canPassword && (
                          <IconButton
                            label={t('users.actions.password', 'Change password')}
                            icon={<Key size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => startPasswordUser(user)}
                            className={`${ROW_ACTION_CLS} hover:text-accent`}
                          />
                        )}
                        {flags.canToggleActive && (
                          <IconButton
                            label={user.isActive ? t('common.disable') : t('common.enable')}
                            icon={user.isActive ? <UserX size={13} /> : <UserIcon size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => handleToggleActive(user)}
                            className={ROW_ACTION_CLS}
                          />
                        )}
                        {flags.canEdit && (
                          <IconButton
                            label={t('common.edit')}
                            icon={<Pencil size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => startEditUser(user)}
                            className={ROW_ACTION_CLS}
                          />
                        )}
                        {flags.canTenants && (
                          <IconButton
                            label={t('users.actions.tenants', 'Manage tenant access')}
                            icon={<Building2 size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => openTenantPanel(user)}
                            className={`${ROW_ACTION_CLS} hover:text-accent`}
                          />
                        )}
                        {flags.canResetTwoFactor && (
                          <IconButton
                            label={t('users.reset2fa.action', 'Reset 2FA')}
                            icon={<ShieldOff size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => handleResetTwoFactor(user)}
                            className={`${ROW_ACTION_CLS} hover:text-status-down`}
                          />
                        )}
                        {flags.canDelete && (
                          <IconButton
                            label={t('common.delete')}
                            icon={<Trash2 size={13} />}
                            size="sm"
                            variant="plain"
                            onClick={() => handleDeleteUser(user)}
                            className={`${ROW_ACTION_CLS} hover:text-status-down`}
                          />
                        )}
                        {/* Phone: every action in one menu. */}
                        {userMenuItems(user).some((i) => !i.hidden) && (
                          <ActionMenu
                            items={userMenuItems(user)}
                            sheetTitle={anonymizeUsername(shownName)}
                            triggerSize="sm"
                            triggerClassName="md:hidden shrink-0"
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* ── Teams Tab ── */}
            {tab === 'teams' && (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-semibold text-text-primary">{t('users.tabTeams')}</h2>
                  <Button size="sm" onClick={() => {
                    resetTeamForm();
                    // Default tenant to the current filter (god view only)
                    if (isGodView && teamTenantFilter !== 'all') {
                      setFormTeamTenantId(teamTenantFilter as number);
                    }
                    setTeamFormMode('create');
                  }}>
                    <Plus size={14} className="mr-1" />{t('common.new')}
                  </Button>
                </div>

                {/* Tenant filter chips (god view only, when multiple tenants) */}
                {isGodView && teamTenants.length > 1 && (
                  <div className="flex items-center gap-1 mb-3 overflow-x-auto overscroll-x-contain scrollbar-none pb-1">
                    <button
                      type="button"
                      aria-pressed={teamTenantFilter === 'all'}
                      onClick={() => setTeamTenantFilter('all')}
                      className={`shrink-0 px-3 py-1 coarse:py-2 rounded-full text-xs font-medium transition-colors ${
                        teamTenantFilter === 'all'
                          ? 'bg-accent text-white'
                          : 'bg-bg-secondary text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {t('common.all', 'All')}
                    </button>
                    {teamTenants.map((tenant) => (
                      <button
                        key={tenant.id}
                        type="button"
                        aria-pressed={teamTenantFilter === tenant.id}
                        onClick={() => setTeamTenantFilter(tenant.id)}
                        className={`shrink-0 px-3 py-1 coarse:py-2 rounded-full text-xs font-medium transition-colors ${
                          teamTenantFilter === tenant.id
                            ? 'bg-accent text-white'
                            : 'bg-bg-secondary text-text-muted hover:text-text-primary'
                        }`}
                      >
                        <Building2 size={10} className="inline mr-1" />
                        {anonymize(tenant.name)}
                      </button>
                    ))}
                  </div>
                )}

                {/* Team form */}
                {(teamFormMode === 'create' || teamFormMode === 'edit') && (
                  <div id="admin-users-form" className="mb-4 rounded-lg bg-bg-secondary p-4 scroll-mt-4">
                    <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wide mb-3">
                      {teamFormMode === 'create' ? t('users.teams.newTeam') : t('users.teams.editTeam', { name: editingTeam?.name })}
                    </h3>
                    <form onSubmit={teamFormMode === 'create' ? handleCreateTeam : handleEditTeam} className="space-y-3">
                      <Input label={t('users.teams.nameLabel')} value={formTeamName} onChange={(e) => setFormTeamName(e.target.value)} required />
                      <Input label={t('users.teams.descLabel')} value={formTeamDesc} onChange={(e) => setFormTeamDesc(e.target.value)} />
                      <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                        <Checkbox
                          checked={formCanCreate}
                          onCheckedChange={setFormCanCreate}
                        />
                        {t('users.teams.canCreate')}
                      </label>
                      {/* Tenant selector: god view, create mode only. Mandatory,
                          a team only grants access inside its own tenant. */}
                      {isGodView && teamFormMode === 'create' && (
                        <div className="space-y-1">
                          <label htmlFor="admin-team-tenant" className="block text-sm font-medium text-text-secondary">
                            <Building2 size={12} className="inline mr-1" />{t('users.teams.tenantLabel', 'Tenant')}
                          </label>
                          <select
                            id="admin-team-tenant"
                            value={formTeamTenantId}
                            onChange={(e) => setFormTeamTenantId(e.target.value ? Number(e.target.value) : '')}
                            className={SELECT_CLS}
                            required
                          >
                            <option value="">{t('users.teams.selectTenant', '— Select tenant —')}</option>
                            {creatableTenants.map((tenant) => (
                              <option key={tenant.id} value={tenant.id}>{anonymize(tenant.name)}</option>
                            ))}
                          </select>
                          <p className="text-xs text-text-muted">
                            {t('users.teams.tenantHint', 'A team only grants access inside its tenant. To give access to several tenants, create one team per tenant.')}
                          </p>
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button type="submit" size="sm" loading={saving}>{teamFormMode === 'create' ? t('common.create') : t('common.save')}</Button>
                        <Button type="button" size="sm" variant="secondary" onClick={resetTeamForm}>{t('common.cancel')}</Button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Team list */}
                <div className="rounded-lg bg-bg-secondary divide-y divide-border">
                  {filteredTeams.length === 0 ? (
                    <div className="py-8 text-center">
                      <Users size={28} className="mx-auto mb-2 text-text-muted" />
                      <p className="text-sm text-text-muted">{t('users.teams.noTeams')}</p>
                    </div>
                  ) : (
                    filteredTeams.map((team) => {
                      return (
                        <div
                          key={team.id}
                          onClick={() => selectTeam(team.id)}
                          className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer group transition-colors ${
                            selectedTeamId === team.id ? 'bg-accent/5 border-l-2 border-l-accent' : 'hover:bg-bg-hover'
                          }`}
                        >
                          <Users size={14} className="shrink-0 text-text-muted" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-medium text-text-primary">{anonymize(team.name)}</span>
                              {team.canCreate && (
                                <span className="rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                                  {t('users.teams.createBadge')}
                                </span>
                              )}
                              {/* Tenant badge */}
                              {team.tenantName && isGodView && (
                                <span className="rounded bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted flex items-center gap-0.5">
                                  <Building2 size={9} />
                                  {anonymize(team.tenantName)}
                                </span>
                              )}
                            </div>
                            {team.description && (
                              <p className="text-xs text-text-muted truncate">{team.description}</p>
                            )}
                          </div>
                          <>
                              <IconButton
                                label={t('common.edit')}
                                icon={<Pencil size={13} />}
                                size="sm"
                                variant="plain"
                                onClick={(e) => { e.stopPropagation(); startEditTeam(team); }}
                                className={ROW_ACTION_CLS}
                              />
                              <IconButton
                                label={t('common.delete')}
                                icon={<Trash2 size={13} />}
                                size="sm"
                                variant="plain"
                                onClick={(e) => { e.stopPropagation(); handleDeleteTeam(team); }}
                                className={`${ROW_ACTION_CLS} hover:text-status-down`}
                              />
                              {/* Phone: actions in a menu — clicks (portal included) must not select the row. */}
                              <span className="md:hidden shrink-0" onClick={(e) => e.stopPropagation()}>
                                <ActionMenu
                                  sheetTitle={anonymize(team.name)}
                                  triggerSize="sm"
                                  items={[
                                    { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit'), onClick: () => startEditTeam(team) },
                                    { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), onClick: () => handleDeleteTeam(team), danger: true, separator: true },
                                  ]}
                                />
                              </span>
                            </>
                          <ChevronRight size={14} className="shrink-0 text-text-muted" />
                        </div>
                      );
                    })
                  )}
                </div>
              </>
            )}

            {/* ── Permission Sets Tab ── */}
            {tab === 'permissionSets' && platformAdmin && <PermissionSetsTab />}
          </>
        }
        detail={teamDetailOpen && selectedTeam ? (
          <div className="lg:sticky lg:top-6">
            {/* Below lg the name is in MasterDetail's back bar. */}
            <h2 className="hidden lg:block text-lg font-semibold text-text-primary mb-1">{anonymize(selectedTeam.name)}</h2>
            {selectedTeam.description && (
              <p className="text-sm text-text-muted mb-4">{selectedTeam.description}</p>
            )}

            {/* Detail tabs */}
            <SegmentedTabs<RightTab>
              tabs={rightTabs}
              value={rightTab}
              onChange={setRightTab}
              size="sm"
              className="mb-4"
              tabClassName="text-sm"
            />

            {/* Members panel */}
            {rightTab === 'members' && (
              <div className="rounded-lg bg-bg-secondary divide-y divide-border lg:max-h-[60dvh] lg:supports-[not(height:100dvh)]:max-h-[60vh] lg:overflow-y-auto">
                {nonAdminUsers.length === 0 ? (
                  <p className="p-4 text-sm text-text-muted text-center">{t('users.teams.noUsers')}</p>
                ) : (
                  nonAdminUsers.map((user) => {
                    const isMember = teamMembers.includes(user.id);
                    return (
                      // Touch: the whole row toggles membership. Mouse: only the
                      // 16px box, as before (a click / text selection on the
                      // username must not add or remove the user).
                      <div
                        key={user.id}
                        role="checkbox"
                        aria-checked={isMember}
                        tabIndex={0}
                        onClick={coarse ? () => toggleMember(user.id) : undefined}
                        onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleMember(user.id); } }}
                        className="flex items-center gap-3 px-3 py-2 coarse:min-h-11 hover:bg-bg-hover cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                      >
                        <div
                          onClick={coarse ? undefined : () => toggleMember(user.id)}
                          className={`flex h-4 w-4 coarse:h-5 coarse:w-5 items-center justify-center rounded border shrink-0 ${
                            isMember ? 'border-accent bg-accent' : 'border-border bg-bg-tertiary'
                          }`}
                        >
                          {isMember && <Check size={12} className="text-white" />}
                        </div>
                        <span className="text-sm text-text-primary min-w-0 break-all">{anonymizeUsername(displayUsername(user.username))}</span>
                        {user.displayName && <span className="text-xs text-text-muted">({anonymize(user.displayName)})</span>}
                        {!user.isActive && <span className="text-[10px] text-status-down">{t('users.disabled')}</span>}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Permissions panel — Hierarchical tree */}
            {rightTab === 'permissions' && (
              <div className="rounded-lg bg-bg-secondary lg:max-h-[70dvh] lg:supports-[not(height:100dvh)]:max-h-[70vh] lg:overflow-y-auto">
                {teamTree.length === 0 && ungroupedMonitors.length === 0 ? (
                  <p className="p-4 text-sm text-text-muted text-center">{t('users.teams.noResources')}</p>
                ) : (
                  <div className="py-1">
                    {teamTree.map((node) => (
                      <PermTreeNode
                        key={node.id}
                        node={node}
                        depth={0}
                        monitorsByGroup={monitorsByGroup}
                        getGroupPerm={getGroupPerm}
                        getMonitorPerm={getMonitorPerm}
                        assignedGroupIds={assignedGroupIds}
                        coveredGroupIds={coveredGroupIds}
                        coveredByGroupId={coveredByGroupId}
                        addPermission={addPermission}
                        removePermission={removePermission}
                        togglePermissionLevel={togglePermissionLevel}
                      />
                    ))}
                    {/* Ungrouped monitors */}
                    {ungroupedMonitors.map((m) => {
                      const perm = getMonitorPerm(m.id);
                      return (
                        <PermMonitorRow
                          key={m.id}
                          monitor={m}
                          depth={0}
                          perm={perm}
                          isCovered={false}
                          addPermission={addPermission}
                          removePermission={removePermission}
                          togglePermissionLevel={togglePermissionLevel}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        ) : null}
      />

      {/* ── Tenant Assignment Panel ── */}
      {/* Shared Drawer: near full width on phones, Escape / Android back close it. */}
      <Drawer
        open={!!tenantPanelUser}
        onClose={closeTenantPanel}
        side="right"
        size="md"
        className="bg-bg-primary"
        overlayClassName="bg-black/40 backdrop-blur-none"
        bodyClassName="p-4 space-y-2"
        icon={<Building2 size={16} className="text-accent shrink-0" />}
        title={
          <span className="block">
            <span className="block truncate">{t('users.tenantPanel.title', 'Tenants')}</span>
            <span className="block truncate text-xs font-normal text-text-muted">
              {tenantPanelUser ? anonymizeUsername(displayUsername(tenantPanelUser.username)) : ''}
            </span>
          </span>
        }
        footer={tenantPanelUser?.role !== 'admin' ? (
          <>
            <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.cancel')}</Button>
            <Button size="sm" loading={tenantSaving} disabled={tenantPanelLoading} onClick={saveTenantAssignments}>{t('common.save')}</Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={closeTenantPanel}>{t('common.close')}</Button>
        )}
      >
        {tenantPanelUser && (tenantPanelLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="text-sm text-text-muted">{t('common.loading')}</div>
          </div>
        ) : tenantPanelUser.role === 'admin' ? (
          /* Platform admin notice */
          <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
            <div className="flex items-start gap-2">
              <Shield size={14} className="text-accent mt-0.5 shrink-0" />
              <p className="text-xs text-text-secondary">
                {t('users.tenantPanel.adminNotice', 'Platform admins automatically access all tenants. No per-tenant assignment is needed.')}
              </p>
            </div>
          </div>
        ) : tenantAssignments.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-8">{t('users.tenantPanel.none', 'No tenants available')}</p>
        ) : (
          tenantAssignments.map((assignment) => {
            const draft = tenantDraft[assignment.tenantId] ?? { isMember: assignment.isMember, role: assignment.role };
            return (
              <div
                key={assignment.tenantId}
                className={`rounded-lg border p-3 transition-colors ${
                  draft.isMember ? 'border-accent/30 bg-accent/5' : 'border-transparent bg-bg-secondary'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Building2 size={14} className={draft.isMember ? 'text-accent shrink-0' : 'text-text-muted shrink-0'} />
                    <span className="text-sm font-medium text-text-primary truncate">{assignment.tenantName}</span>
                  </div>
                  {/* Toggle switch (invisible 40px+ hit area on touch) */}
                  <button
                    type="button"
                    onClick={() => toggleTenantMember(assignment.tenantId)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 transition-colors coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-[''] ${
                      draft.isMember
                        ? 'border-accent bg-accent'
                        : 'border-border bg-bg-tertiary'
                    }`}
                    role="switch"
                    aria-checked={draft.isMember}
                    aria-label={assignment.tenantName}
                  >
                    <span
                      className={`pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform mt-px ${
                        draft.isMember ? 'translate-x-4' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
                {/* Role selector — only when assigned. Driven by permission_sets;
                    'admin' is appended explicitly because it short-circuits the
                    capability matrix (tenant-admin escape hatch). */}
                {draft.isMember && (
                  <div className="flex items-center gap-2 mt-2">
                    <label htmlFor={`tenant-role-${assignment.tenantId}`} className="text-[10px] text-text-muted">
                      {t('users.tenantPanel.role', 'Role:')}
                    </label>
                    <select
                      id={`tenant-role-${assignment.tenantId}`}
                      value={draft.role}
                      onChange={(e) => setTenantRole(assignment.tenantId, e.target.value)}
                      className="bg-bg-tertiary rounded px-2 py-1 coarse:min-h-9 text-[11px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      <option value="admin">{t('users.roleAdmin')}</option>
                      {permissionSets
                        .filter((ps) => ps.slug !== 'admin')
                        .map((ps) => (
                          <option key={ps.slug} value={ps.slug}>
                            {ps.name}
                          </option>
                        ))}
                    </select>
                    {draft.role === 'admin' && (
                      <Shield size={10} className="text-accent" />
                    )}
                  </div>
                )}
              </div>
            );
          })
        ))}
      </Drawer>
    </PageContainer>
  );
}


// ── Permission Tree Sub-Components ──

interface PermTreeNodeProps {
  node: GroupTreeNode;
  depth: number;
  monitorsByGroup: Map<number, MonitorType[]>;
  getGroupPerm: (groupId: number) => TeamPermission | undefined;
  getMonitorPerm: (monitorId: number) => TeamPermission | undefined;
  assignedGroupIds: Set<number>;
  coveredGroupIds: Set<number>;
  coveredByGroupId: Map<number, number>;
  addPermission: (scope: PermissionScope, scopeId: number, level: PermissionLevel) => Promise<void>;
  removePermission: (permId: number) => Promise<void>;
  togglePermissionLevel: (perm: TeamPermission) => Promise<void>;
}

function PermTreeNode({
  node,
  depth,
  monitorsByGroup,
  getGroupPerm,
  getMonitorPerm,
  assignedGroupIds,
  coveredGroupIds,
  coveredByGroupId,
  addPermission,
  removePermission,
  togglePermissionLevel,
}: PermTreeNodeProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const perm = getGroupPerm(node.id);
  const isCovered = coveredGroupIds.has(node.id);
  const hasChildren = node.children.length > 0 || (monitorsByGroup.get(node.id)?.length ?? 0) > 0;

  return (
    <div>
      {/* Group row */}
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover transition-colors ${
          perm ? 'bg-accent/5' : isCovered ? 'bg-accent/[0.02]' : ''
        }`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {/* Expand toggle */}
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={hasChildren ? expanded : undefined}
          aria-label={anonymize(node.name)}
          className={`shrink-0 p-0.5 text-text-muted hover:text-text-primary transition-colors ${!hasChildren ? 'invisible' : ''}`}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>

        <FolderOpen size={13} className={`shrink-0 ${perm ? 'text-accent' : isCovered ? 'text-accent/40' : 'text-text-muted'}`} />
        <span className={`flex-1 text-sm truncate ${perm ? 'text-text-primary font-medium' : isCovered ? 'text-text-muted' : 'text-text-primary'}`}>
          {anonymize(node.name)}
        </span>

        {node.isGeneral && (
          <span className="text-[10px] text-accent bg-accent/10 px-1 rounded shrink-0">{t('users.teams.generalBadge')}</span>
        )}

        {/* Permission controls */}
        {perm ? (
          <>
            <button
              onClick={() => togglePermissionLevel(perm)}
              className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors shrink-0 ${
                perm.level === 'rw'
                  ? 'bg-accent/10 text-accent hover:bg-accent/20'
                  : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover'
              }`}
              title={t('users.teams.toggleLevel', 'Click to toggle read-only / read-write')}
            >
              {perm.level === 'rw' ? <><Pencil size={10} className="inline mr-0.5" />{t('users.teams.rwLabel')}</> : <><Eye size={10} className="inline mr-0.5" />{t('users.teams.roLabel')}</>}
            </button>
            <button type="button" onClick={() => removePermission(perm.id)} aria-label={t('users.teams.removePermission', 'Remove permission')} className="p-0.5 text-text-muted hover:text-status-down shrink-0 relative coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-['']">
              <Trash2 size={11} />
            </button>
          </>
        ) : isCovered ? (
          <span className="text-[10px] text-text-muted italic shrink-0">{t('users.teams.inherited')}</span>
        ) : (
          <>
            <button onClick={() => addPermission('group', node.id, 'ro')}
              className="px-1.5 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-muted hover:bg-bg-hover shrink-0" title={t('users.teams.readOnly', 'Read only')}>
              {t('users.teams.roLabel')}
            </button>
            <button onClick={() => addPermission('group', node.id, 'rw')}
              className="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 shrink-0" title={t('users.teams.readWrite', 'Read/write')}>
              {t('users.teams.rwLabel')}
            </button>
          </>
        )}
      </div>

      {/* Children (groups + monitors) */}
      {expanded && (
        <>
          {node.children.map((child) => (
            <PermTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              monitorsByGroup={monitorsByGroup}
              getGroupPerm={getGroupPerm}
              getMonitorPerm={getMonitorPerm}
              assignedGroupIds={assignedGroupIds}
              coveredGroupIds={coveredGroupIds}
              coveredByGroupId={coveredByGroupId}
              addPermission={addPermission}
              removePermission={removePermission}
              togglePermissionLevel={togglePermissionLevel}
            />
          ))}
          {(monitorsByGroup.get(node.id) ?? []).map((m) => {
            const mPerm = getMonitorPerm(m.id);
            const mCovered = !mPerm && (assignedGroupIds.has(node.id) || coveredGroupIds.has(node.id));
            return (
              <PermMonitorRow
                key={m.id}
                monitor={m}
                depth={depth + 1}
                perm={mPerm}
                isCovered={mCovered}
                addPermission={addPermission}
                removePermission={removePermission}
                togglePermissionLevel={togglePermissionLevel}
              />
            );
          })}
        </>
      )}
    </div>
  );
}

interface PermMonitorRowProps {
  monitor: MonitorType;
  depth: number;
  perm: TeamPermission | undefined;
  isCovered: boolean;
  addPermission: (scope: PermissionScope, scopeId: number, level: PermissionLevel) => Promise<void>;
  removePermission: (permId: number) => Promise<void>;
  togglePermissionLevel: (perm: TeamPermission) => Promise<void>;
}

function PermMonitorRow({
  monitor,
  depth,
  perm,
  isCovered,
  addPermission,
  removePermission,
  togglePermissionLevel,
}: PermMonitorRowProps) {
  const { t } = useTranslation();
  return (
    <div
      className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover transition-colors ${
        perm ? 'bg-accent/5' : ''
      }`}
      style={{ paddingLeft: `${depth * 20 + 28}px` }}
    >
      <Monitor size={13} className={`shrink-0 ${perm ? 'text-accent' : isCovered ? 'text-accent/40' : 'text-text-muted'}`} />
      <span className={`flex-1 text-sm truncate ${perm ? 'text-text-primary font-medium' : isCovered ? 'text-text-muted' : 'text-text-primary'}`}>
        {anonymize(monitor.name)}
      </span>

      {perm ? (
        <>
          <button
            onClick={() => togglePermissionLevel(perm)}
            className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors shrink-0 ${
              perm.level === 'rw'
                ? 'bg-accent/10 text-accent hover:bg-accent/20'
                : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover'
            }`}
            title={t('users.teams.toggleLevel', 'Click to toggle read-only / read-write')}
          >
            {perm.level === 'rw' ? <><Pencil size={10} className="inline mr-0.5" />{t('users.teams.rwLabel')}</> : <><Eye size={10} className="inline mr-0.5" />{t('users.teams.roLabel')}</>}
          </button>
          <button type="button" onClick={() => removePermission(perm.id)} aria-label={t('users.teams.removePermission', 'Remove permission')} className="p-0.5 text-text-muted hover:text-status-down shrink-0 relative coarse:after:absolute coarse:after:-inset-2.5 coarse:after:content-['']">
            <Trash2 size={11} />
          </button>
        </>
      ) : isCovered ? (
        <span className="text-[10px] text-text-muted italic shrink-0">{t('users.teams.inherited')}</span>
      ) : (
        <>
          <button onClick={() => addPermission('monitor', monitor.id, 'ro')}
            className="px-1.5 py-0.5 text-[10px] rounded bg-bg-tertiary text-text-muted hover:bg-bg-hover shrink-0" title={t('users.teams.readOnly', 'Read only')}>
            {t('users.teams.roLabel')}
          </button>
          <button onClick={() => addPermission('monitor', monitor.id, 'rw')}
            className="px-1.5 py-0.5 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 shrink-0" title={t('users.teams.readWrite', 'Read/write')}>
            {t('users.teams.rwLabel')}
          </button>
        </>
      )}
    </div>
  );
}
