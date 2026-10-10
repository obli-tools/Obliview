import { TENANT_CAPABILITIES, type TenantCapability } from '@obliview/shared';
import { db } from '../db';

interface PermissionSetRow {
  id: number;
  name: string;
  slug: string;
  capabilities: string | string[];
  is_default: boolean;
  created_at: Date;
}

export interface PermissionSet {
  id: number;
  name: string;
  slug: string;
  capabilities: string[];
  isDefault: boolean;
  createdAt: string;
}

interface CapabilityDef {
  key: string;
  label: string;
}

// Tenant-wide capabilities, all wired to runtime gates
// (permission.service.userHasTenantCapability → middleware/rbac
// requireTenantCapability / requireAnyTenantCapability / requireCanCreate).
// Read access to monitors and groups never comes from a capability: it comes
// from teams (WHERE). The capability decides WHAT a user may do there.
// Tenant role 'admin' holds every capability; platform admins bypass them.
// Same order as the shared TENANT_CAPABILITIES catalogue.
const AVAILABLE_CAPABILITIES: Array<CapabilityDef & { key: TenantCapability }> = [
  { key: 'monitors.manage',  label: 'Monitors · Create / delete (with team RW)' },
  { key: 'groups.manage',    label: 'Groups · Create / delete / move (with team RW)' },
  { key: 'agents.manage',    label: 'Agents · Approve, configure, keys, commands' },
  { key: 'notifications',    label: 'Notifications · Channels and bindings' },
  { key: 'remediation',      label: 'Remediation · Actions and bindings' },
  { key: 'maintenance',      label: 'Maintenance windows' },
  { key: 'settings',         label: 'Settings · Workspace settings and SMTP servers' },
  { key: 'users.manage',     label: 'Users & teams' },
  { key: 'supervision:read', label: 'Supervision · Read' },
];

function rowToPermissionSet(row: PermissionSetRow): PermissionSet {
  const caps = typeof row.capabilities === 'string'
    ? JSON.parse(row.capabilities)
    : row.capabilities;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    capabilities: caps,
    isDefault: row.is_default,
    createdAt: row.created_at.toISOString(),
  };
}

export const permissionSetService = {
  async getAll(): Promise<PermissionSet[]> {
    const rows = await db('permission_sets')
      .orderBy('is_default', 'desc')
      .orderBy('name', 'asc') as PermissionSetRow[];
    return rows.map(rowToPermissionSet);
  },

  async getBySlug(slug: string): Promise<PermissionSet | null> {
    const row = await db('permission_sets').where({ slug }).first() as PermissionSetRow | undefined;
    return row ? rowToPermissionSet(row) : null;
  },

  async create(data: { name: string; slug: string; capabilities: string[] }): Promise<PermissionSet> {
    const [row] = await db('permission_sets')
      .insert({
        name: data.name,
        slug: data.slug,
        capabilities: JSON.stringify(this.sanitizeCapabilities(data.capabilities)),
        is_default: false,
      })
      .returning('*') as PermissionSetRow[];
    return rowToPermissionSet(row);
  },

  async update(id: number, data: { name?: string; capabilities?: string[] }): Promise<PermissionSet | null> {
    const update: Record<string, unknown> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.capabilities !== undefined) update.capabilities = JSON.stringify(this.sanitizeCapabilities(data.capabilities));

    if (Object.keys(update).length === 0) {
      const row = await db('permission_sets').where({ id }).first() as PermissionSetRow | undefined;
      return row ? rowToPermissionSet(row) : null;
    }

    const [row] = await db('permission_sets')
      .where({ id })
      .update(update)
      .returning('*') as PermissionSetRow[];
    return row ? rowToPermissionSet(row) : null;
  },

  /**
   * Delete a custom set. Default sets cannot be deleted, nor can a set whose
   * slug is still the role of some user_tenants row (those users would
   * silently lose every capability).
   */
  async delete(id: number): Promise<'deleted' | 'not_found' | 'default' | 'in_use'> {
    const row = await db('permission_sets').where({ id }).first() as PermissionSetRow | undefined;
    if (!row) return 'not_found';
    if (row.is_default) return 'default';
    const used = await db('user_tenants').where({ role: row.slug }).first('user_id');
    if (used) return 'in_use';
    await db('permission_sets').where({ id }).del();
    return 'deleted';
  },

  /** Keep only known capability keys, deduplicated. */
  sanitizeCapabilities(caps: unknown[]): string[] {
    const known = new Set<string>(TENANT_CAPABILITIES);
    return [...new Set(caps.map(String).filter((c) => known.has(c)))];
  },

  getAvailableCapabilities(): CapabilityDef[] {
    return AVAILABLE_CAPABILITIES;
  },
};
