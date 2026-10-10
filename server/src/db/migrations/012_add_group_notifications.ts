import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (table) => {
    table.boolean('group_notifications').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (table) => {
    table.dropColumn('group_notifications');
  });
}
