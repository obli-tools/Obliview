import type { Knex } from 'knex';

/**
 * Widen user_tenants.role from VARCHAR(16) (an enum of 'admin' | 'member')
 * to VARCHAR(64) so it can carry any permission_set slug — including
 * custom sets created by admins.
 *
 * Backfill 'member' → 'user' so existing rows join cleanly onto the seeded
 * permission_set slug='user' (migration 049).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('user_tenants', (t) => {
    t.string('role', 64).notNullable().defaultTo('user').alter();
  });

  await knex('user_tenants').where({ role: 'member' }).update({ role: 'user' });
}

export async function down(knex: Knex): Promise<void> {
  // Reverse the backfill first so the narrower column stays consistent
  await knex('user_tenants').where({ role: 'user' }).update({ role: 'member' });

  // Any non-{admin,member} slug is collapsed to 'member' on rollback so the
  // narrow VARCHAR(16) doesn't fail. This is lossy by design — custom slugs
  // can't survive the older schema.
  await knex('user_tenants')
    .whereNotIn('role', ['admin', 'member'])
    .update({ role: 'member' });

  await knex.schema.alterTable('user_tenants', (t) => {
    t.string('role', 16).notNullable().defaultTo('member').alter();
  });
}
