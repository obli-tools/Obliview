import type { Knex } from 'knex';

/**
 * The original monitor_groups table was created with a globally-unique
 * constraint on `slug` alone.  In a multi-tenant deployment this is too
 * restrictive: two different tenants should be allowed to have a group
 * named "production" (slug "production") without conflicting.
 *
 * This migration replaces the global unique index with a composite unique
 * index on (slug, tenant_id) so that slugs are unique within a tenant but
 * can repeat across tenants.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (t) => {
    // Drop the old global unique constraint
    t.dropUnique(['slug'], 'monitor_groups_slug_unique');

    // Add a per-tenant unique constraint
    t.unique(['slug', 'tenant_id'], { indexName: 'monitor_groups_slug_tenant_unique' });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.dropUnique(['slug', 'tenant_id'], 'monitor_groups_slug_tenant_unique');
    t.unique(['slug'], { indexName: 'monitor_groups_slug_unique' });
  });
}
