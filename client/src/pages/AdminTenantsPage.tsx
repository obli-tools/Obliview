import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Building2, Plus, Pencil, Trash2, Users, X, Check } from 'lucide-react';
import { isMasterTenant } from '@obliview/shared';
import type { AgentUpdatePolicy, Tenant, TenantRole } from '@obliview/shared';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useTenantStore } from '@/store/tenantStore';
import { anonymize, anonymizeUsername } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';
import apiClient from '@/api/client';
import { appConfigApi } from '@/api/appConfig.api';
import { agentUpdatePolicyApi } from '@/api/agentUpdatePolicy.api';
import { UpdatePolicyField, resolveTenantLevel } from '@/components/agent/UpdatePolicyField';

interface TenantMember {
  id: number;
  username: string;
  display_name: string | null;
  role: string;
  is_active: boolean;
  /** permission_set slug ('admin' | 'user' | 'viewer' | custom) */
  tenantRole: TenantRole;
}

interface TenantWithMemberCount extends Tenant {
  memberCount?: number;
}

interface PermissionSetOption {
  slug: string;
  name: string;
}

/** Default role for new members: the seeded 'user' permission set. */
const DEFAULT_TENANT_ROLE: TenantRole = 'user';

/** Used when GET /permission-sets fails: the three seeded sets (migration 049). */
const FALLBACK_ROLE_OPTIONS: PermissionSetOption[] = [
  { slug: 'admin', name: 'Admin' },
  { slug: 'user', name: 'User' },
  { slug: 'viewer', name: 'Viewer' },
];

/** 'member' is the pre-053 name of the 'user' permission set. */
const normaliseTenantRole = (role: string | null | undefined): TenantRole =>
  (!role || role === 'member' ? DEFAULT_TENANT_ROLE : role);

// ── Tenant role dropdown (permission_set slugs) ─────────────────────────────
function RoleSelect({
  value,
  options,
  onChange,
  disabled,
  compact = true,
}: {
  value: TenantRole;
  options: PermissionSetOption[];
  onChange: (role: TenantRole) => void;
  disabled?: boolean;
  /** Compact (member rows) or form-sized (add-member row). */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const label = t('tenant.memberRole', 'Workspace role');
  // Keep an unknown slug (e.g. a deleted custom set) visible instead of
  // silently displaying the first option.
  const isKnown = options.some((o) => o.slug === value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`border bg-bg-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50 coarse:min-h-10 ${
        compact ? 'rounded-md px-2 py-0.5 text-xs' : 'rounded-lg px-3 py-1.5 text-sm'
      } ${value === 'admin' ? 'border-accent text-accent' : 'border-border text-text-primary'}`}
    >
      {!isKnown && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.slug} value={o.slug}>{o.name}</option>
      ))}
    </select>
  );
}

// ── Inline form for creating / editing a tenant ────────────────────────────
function TenantForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: { name: string; slug: string };
  onSave: (name: string, slug: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const autoSlug = (n: string) =>
    n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const handleNameChange = (v: string) => {
    setName(v);
    if (!initial) setSlug(autoSlug(v));
  };

  const handleSubmit = async () => {
    if (!name.trim() || !slug.trim()) { setError(t('common.requiredField', 'This field is required')); return; }
    setSaving(true);
    setError('');
    try {
      await onSave(name.trim(), slug.trim());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('common.error', 'An error occurred'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => { e.preventDefault(); void handleSubmit(); }}
    >
      <div className="min-w-[10rem] flex-1">
        <label className="block text-xs text-text-muted mb-1">{t('tenant.name')}</label>
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => handleNameChange(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent coarse:min-h-10"
          placeholder={t('tenant.namePlaceholder')}
        />
      </div>
      <div className="w-40 max-sm:flex-1">
        <label className="block text-xs text-text-muted mb-1">{t('tenant.slug')}</label>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm font-mono text-text-primary focus:outline-none focus:ring-1 focus:ring-accent coarse:min-h-10"
          placeholder="my-org"
        />
      </div>
      <Button type="submit" size="sm" disabled={saving} aria-label={t('common.save')} title={t('common.save')}>
        <Check size={14} />
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving} aria-label={t('common.cancel')} title={t('common.cancel')}>
        <X size={14} />
      </Button>
      {error && <p role="alert" className="basis-full text-xs text-red-400">{error}</p>}
    </form>
  );
}

// ── Members panel ───────────────────────────────────────────────────────────
function MembersPanel({ tenantId, tenantName, onClose }: { tenantId: number; tenantName?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [allUsers, setAllUsers] = useState<{ id: number; username: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [addingId, setAddingId] = useState<number | ''>('');
  const [addingRole, setAddingRole] = useState<TenantRole>(DEFAULT_TENANT_ROLE);
  const [permissionSets, setPermissionSets] = useState<PermissionSetOption[]>([]);

  // Role dropdown options: permission_set slugs. 'admin' is always offered
  // (it short-circuits the capability matrix on the server).
  const roleOptions = useMemo<PermissionSetOption[]>(() => {
    const sets = permissionSets.length > 0 ? permissionSets : FALLBACK_ROLE_OPTIONS;
    return sets.some((s) => s.slug === 'admin') ? sets : [{ slug: 'admin', name: 'Admin' }, ...sets];
  }, [permissionSets]);

  const fetchMembers = async () => {
    try {
      const res = await apiClient.get<{ data: TenantMember[] }>(`/tenants/${tenantId}/members`);
      setMembers(
        (res.data.data ?? []).map((m) => ({ ...m, tenantRole: normaliseTenantRole(m.tenantRole) })),
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')), { id: 'tenant-members-load' });
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await apiClient.get<{ data: { id: number; username: string }[] }>('/users');
      setAllUsers(res.data.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')), { id: 'tenant-users-load' });
    }
  };

  const fetchPermissionSets = async () => {
    try {
      const res = await apiClient.get<{ data: PermissionSetOption[] }>('/permission-sets');
      setPermissionSets((res.data.data ?? []).map((s) => ({ slug: s.slug, name: s.name })));
    } catch {
      setPermissionSets([]); // falls back to the seeded sets
    }
  };

  useEffect(() => {
    fetchMembers();
    fetchUsers();
    fetchPermissionSets();
  }, [tenantId]);

  const addMember = async () => {
    if (!addingId) return;
    setBusy(true);
    try {
      await apiClient.post(`/tenants/${tenantId}/members`, { userId: addingId, role: addingRole });
      setAddingId('');
      setAddingRole(DEFAULT_TENANT_ROLE);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')));
    } finally {
      setBusy(false);
      fetchMembers();
    }
  };

  const changeRole = async (userId: number, role: TenantRole) => {
    // Optimistic: the refresh below restores the server value on failure.
    setMembers((prev) => prev.map((m) => (m.id === userId ? { ...m, tenantRole: role } : m)));
    setBusy(true);
    try {
      await apiClient.put(`/tenants/${tenantId}/members/${userId}`, { role });
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')));
    } finally {
      setBusy(false);
      fetchMembers();
    }
  };

  const removeMember = async (member: TenantMember) => {
    if (!(await confirm({
      message: t('tenant.confirmRemoveMember', 'Remove {{username}} from this workspace?', {
        username: anonymizeUsername(member.username),
      }),
      danger: true,
      confirmLabel: t('tenant.removeMember'),
    }))) return;
    setBusy(true);
    try {
      await apiClient.delete(`/tenants/${tenantId}/members/${member.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')));
    } finally {
      setBusy(false);
      fetchMembers();
    }
  };

  const nonMembers = allUsers.filter((u) => !members.find((m) => m.id === u.id));

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      icon={<Users size={15} className="text-text-primary" />}
      title={tenantName
        ? <>{t('tenant.members')} <span className="font-normal text-text-muted">· {anonymize(tenantName)}</span></>
        : t('tenant.members')}
      bodyClassName="px-5 py-4 space-y-3 sm:max-h-80"
      footerClassName="flex-wrap justify-start px-5"
      footer={nonMembers.length > 0 ? (
        <>
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value ? Number(e.target.value) : '')}
            aria-label={t('tenant.selectUser')}
            className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent coarse:min-h-10"
          >
            <option value="">{t('tenant.selectUser')}</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{anonymizeUsername(u.username)}</option>
            ))}
          </select>
          <RoleSelect
            value={addingRole}
            options={roleOptions}
            onChange={setAddingRole}
            disabled={busy}
            compact={false}
          />
          <Button size="sm" onClick={addMember} disabled={!addingId || busy} className="shrink-0">
            {t('tenant.addMember')}
          </Button>
        </>
      ) : undefined}
    >
      {loading ? (
        <p className="text-sm text-text-muted text-center py-4">{t('common.loading')}</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-text-muted text-center py-4">{t('tenant.noMembers')}</p>
      ) : (
        members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="text-sm text-text-primary font-medium">{anonymizeUsername(m.username)}</span>
              {m.display_name && (
                <span className="ml-1 text-xs text-text-muted">({anonymize(m.display_name)})</span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <RoleSelect
                value={m.tenantRole}
                options={roleOptions}
                onChange={(role) => { if (role !== m.tenantRole) changeRole(m.id, role); }}
                disabled={busy}
              />
              <IconButton
                label={t('tenant.removeMember')}
                icon={<X size={13} />}
                size="xs"
                variant="danger"
                onClick={() => void removeMember(m)}
                disabled={busy}
                className="disabled:opacity-50"
              />
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
/**
 * Workspace (tenant) administration — master workspace only (routed at
 * /workspace by App.tsx). `embedded` drops the padding and the h1.
 */
export function AdminTenantsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const refreshTenantStore = useTenantStore((s) => s.fetchTenants);
  const [tenants, setTenants] = useState<TenantWithMemberCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [membersForId, setMembersForId] = useState<number | null>(null);

  // `loading` only covers the first load: later refreshes are silent so an
  // open inline edit form is not unmounted (and its input lost).
  const fetchTenants = async () => {
    try {
      const res = await apiClient.get<{ data: TenantWithMemberCount[] }>('/tenants');
      setTenants(res.data.data ?? []);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')), { id: 'tenants-load' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTenants(); }, []);

  // Global level of the agent update policy: what a workspace without its own value inherits.
  const [globalUpdatePolicy, setGlobalUpdatePolicy] = useState<AgentUpdatePolicy | null | undefined>(undefined);
  useEffect(() => {
    appConfigApi.getAgentGlobal()
      .then((cfg) => setGlobalUpdatePolicy(cfg.updatePolicy ?? null))
      .catch(() => setGlobalUpdatePolicy(null));
  }, []);

  /** Reload the list, and the tenant store (switcher, tenant badges and names). */
  const refreshAll = async () => {
    await fetchTenants();
    void refreshTenantStore();
  };

  // On failure the inline forms stay open so the input can be corrected.
  const handleCreate = async (name: string, slug: string) => {
    try {
      await apiClient.post('/tenants', { name, slug });
      setCreating(false);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')));
    } finally {
      void refreshAll();
    }
  };

  const handleUpdate = async (id: number, name: string, slug: string) => {
    try {
      await apiClient.put(`/tenants/${id}`, { name, slug });
      setEditingId(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')));
    } finally {
      void refreshAll();
    }
  };

  const handleDelete = async (tenant: TenantWithMemberCount) => {
    // Irreversible: type-to-confirm with the workspace slug.
    if (!(await confirm({
      title: anonymize(tenant.name),
      message: t('tenant.confirmDelete'),
      danger: true,
      requireText: tenant.slug,
    }))) return;
    try {
      await apiClient.delete(`/tenants/${tenant.id}`);
      toast.success(t('tenant.deleted', 'Workspace deleted'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('common.error', 'An error occurred')));
    } finally {
      void refreshAll();
    }
  };

  const membersTenant = membersForId !== null ? tenants.find((tn) => tn.id === membersForId) : undefined;

  return (
    <PageContainer embedded={embedded}>
      {/* Header — the h1 is dropped when embedded */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="min-w-0 flex-1">
          {!embedded && (
            <h1 className="text-2xl font-semibold text-text-primary">{t('tenant.pageTitle')}</h1>
          )}
          <p className={embedded ? 'text-sm text-text-muted' : 'mt-1 text-sm text-text-muted'}>{t('tenant.pageDesc')}</p>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)} className="shrink-0">
            <Plus size={16} className="mr-1.5" />
            {t('tenant.create')}
          </Button>
        )}
      </div>

      {creating && (
        <div className="mb-4 p-4 rounded-xl border border-border bg-bg-secondary">
          <TenantForm onSave={handleCreate} onCancel={() => setCreating(false)} />
        </div>
      )}

      {loading ? (
        <p className="text-sm text-text-muted">{t('common.loading')}</p>
      ) : tenants.length === 0 ? (
        <p className="text-sm text-text-muted">{t('tenant.noTenants')}</p>
      ) : (
        <div className="space-y-2">
          {tenants.map((tenant) => (
            <div
              key={tenant.id}
              className="rounded-xl border border-border bg-bg-secondary px-4 py-3"
            >
              {editingId === tenant.id ? (
                <TenantForm
                  initial={{ name: tenant.name, slug: tenant.slug }}
                  onSave={(name, slug) => handleUpdate(tenant.id, name, slug)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Building2 size={14} className="text-accent shrink-0" />
                      <span className="text-sm font-semibold text-text-primary break-words">{anonymize(tenant.name)}</span>
                      {isMasterTenant(tenant.id) && (
                        <span className="text-[10px] bg-accent/15 text-accent rounded px-1.5 py-0.5">
                          {t('tenant.default')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-0.5">
                      /{anonymize(tenant.slug)} · {t('tenant.createdAt')} {new Date(tenant.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 max-sm:ml-auto">
                    <button
                      type="button"
                      onClick={() => setMembersForId(tenant.id)}
                      title={t('tenant.manageMembers')}
                      className="flex items-center gap-1 text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded-md hover:bg-bg-hover transition-colors coarse:min-h-10 coarse:px-3"
                    >
                      <Users size={13} />
                      {t('tenant.members')}
                      {tenant.memberCount != null && (
                        <span className="tabular-nums text-text-muted">({tenant.memberCount})</span>
                      )}
                    </button>
                    <IconButton
                      label={t('common.edit')}
                      icon={<Pencil size={13} />}
                      onClick={() => setEditingId(tenant.id)}
                    />
                    {!isMasterTenant(tenant.id) && (
                      <IconButton
                        label={t('common.delete')}
                        icon={<Trash2 size={13} />}
                        variant="danger"
                        onClick={() => void handleDelete(tenant)}
                      />
                    )}
                  </div>
                  {/* Workspace level of the agent update policy (global -> workspace -> group -> agent). */}
                  {globalUpdatePolicy !== undefined && (
                    <UpdatePolicyField
                      layout="row"
                      level="tenant"
                      className="basis-full border-b-0 border-t py-2"
                      label={t('agentUpdatePolicy.title', 'Agent updates')}
                      ownPolicy={tenant.agentUpdatePolicy ?? null}
                      {...resolveTenantLevel(tenant.agentUpdatePolicy ?? null, globalUpdatePolicy)}
                      canEdit
                      onChange={async (updatePolicy) => {
                        const ctx = await agentUpdatePolicyApi.setTenant(tenant.id, updatePolicy);
                        setTenants((list) => list.map((tn) => (tn.id === tenant.id ? { ...tn, agentUpdatePolicy: ctx.ownPolicy } : tn)));
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {membersForId !== null && (
        <MembersPanel
          tenantId={membersForId}
          tenantName={membersTenant?.name}
          onClose={() => { setMembersForId(null); void fetchTenants(); }}
        />
      )}
    </PageContainer>
  );
}
