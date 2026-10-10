import type { Knex } from 'knex';

/**
 * Tenant capabilities become enforced (middleware/rbac requireTenantCapability).
 *
 * The permission_sets catalogue (049) is remapped to the capabilities the
 * server now actually checks:
 *   monitors.manage, groups.manage, agents.manage, notifications, remediation,
 *   maintenance, settings, users.manage, supervision:read
 *
 *   - 'monitoring' disappears: read access to monitors and groups comes from
 *     teams, never from a capability.
 *   - Default sets are reseeded: admin = every capability, user =
 *     monitors.manage + groups.manage, viewer = nothing.
 *   - Custom sets keep the capabilities whose name still exists (1:1); any
 *     other entry is dropped.
 *
 * Data-only migration: no table or column is created or dropped.
 * team_permissions.capabilities (048) is left untouched (unused).
 */

const NEW_CATALOG = [
  'monitors.manage',
  'groups.manage',
  'agents.manage',
  'notifications',
  'remediation',
  'maintenance',
  'settings',
  'users.manage',
  'supervision:read',
];

/** Capabilities of the 049 catalogue (for down) */
const OLD_CATALOG = [
  'monitoring',
  'monitors.manage',
  'groups.manage',
  'agents.manage',
  'remediation',
  'settings',
  'users.manage',
];

const NEW_DEFAULTS: Record<string, string[]> = {
  admin: NEW_CATALOG,
  user: ['monitors.manage', 'groups.manage'],
  viewer: [],
};

const OLD_DEFAULTS: Record<string, string[]> = {
  admin: OLD_CATALOG,
  user: ['monitoring', 'monitors.manage', 'groups.manage'],
  viewer: ['monitoring'],
};

function parseCaps(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(String) : [];
}

async function remap(
  knex: Knex,
  defaults: Record<string, string[]>,
  mapCustom: (caps: string[]) => string[],
): Promise<void> {
  const rows = await knex('permission_sets').select('id', 'slug', 'capabilities', 'is_default') as Array<{
    id: number; slug: string; capabilities: unknown; is_default: boolean;
  }>;
  for (const row of rows) {
    const next = row.is_default && defaults[row.slug] !== undefined
      ? defaults[row.slug]
      : mapCustom(parseCaps(row.capabilities));
    await knex('permission_sets')
      .where({ id: row.id })
      .update({ capabilities: JSON.stringify([...new Set(next)]) });
  }

  // The three default sets must exist (049 seeds them; be safe if one was removed)
  for (const [slug, caps] of Object.entries(defaults)) {
    const exists = await knex('permission_sets').where({ slug }).first('id');
    if (!exists) {
      await knex('permission_sets').insert({
        name: slug.charAt(0).toUpperCase() + slug.slice(1),
        slug,
        capabilities: JSON.stringify(caps),
        is_default: true,
      });
    }
  }
}

export async function up(knex: Knex): Promise<void> {
  const known = new Set(NEW_CATALOG);
  await remap(knex, NEW_DEFAULTS, (caps) => caps.filter((c) => known.has(c)));
}

export async function down(knex: Knex): Promise<void> {
  // Best effort: defaults go back to their 049 seed; custom sets keep the
  // capabilities that existed in 049 and get 'monitoring' back.
  const known = new Set(OLD_CATALOG);
  await remap(knex, OLD_DEFAULTS, (caps) => ['monitoring', ...caps.filter((c) => known.has(c))]);
}
