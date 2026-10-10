import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('settings', (t) => {
    t.increments('id').primary();
    t.string('scope', 20).notNullable(); // 'global', 'group', 'monitor'
    t.integer('scope_id').nullable(); // null for global, group_id or monitor_id
    t.string('key', 100).notNullable();
    t.jsonb('value').notNullable();
    t.timestamps(true, true);

    t.unique(['scope', 'scope_id', 'key']);
    t.index(['scope', 'scope_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('settings');
}
