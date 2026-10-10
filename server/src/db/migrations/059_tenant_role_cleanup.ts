import type { Knex } from 'knex';

/**
 * Re-run the 'member' → 'user' backfill of user_tenants.role.
 *
 * Since 053_user_tenants_role_varchar.ts, user_tenants.role is a
 * permission_set slug ('admin' | 'user' | 'viewer' | custom, seeded by 049).
 * Until this release the tenant routes, the Workspaces page and the users
 * service still wrote the legacy 'member' value, which matches no
 * permission_set and would fail closed once tenant capabilities are enforced.
 * The application now writes and validates slugs only; this converts the
 * rows written in between.
 *
 * Data-only migration: no table or column is created or dropped.
 */
export async function up(knex: Knex): Promise<void> {
  await knex('user_tenants').where({ role: 'member' }).update({ role: 'user' });
}

export async function down(_knex: Knex): Promise<void> {
  // Intentionally a no-op: converted rows cannot be told apart from rows
  // that were 'user' already, and 'member' is not a valid slug anyway.
  // (053's down still maps 'user' back to 'member' if the schema is rolled
  // further back.)
}
