import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add is_global flag to user_teams
  await knex.schema.alterTable('user_teams', (t) => {
    t.boolean('is_global').defaultTo(false).notNullable();
  });

  // Junction table: which tenants a global team is pushed to
  await knex.schema.createTable('team_tenant_scopes', (t) => {
    t.integer('team_id').notNullable().references('id').inTable('user_teams').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.primary(['team_id', 'tenant_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('team_tenant_scopes');
  await knex.schema.alterTable('user_teams', (t) => {
    t.dropColumn('is_global');
  });
}
