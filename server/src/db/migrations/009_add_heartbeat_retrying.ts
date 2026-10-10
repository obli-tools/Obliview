import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('heartbeats', (table) => {
    table.boolean('is_retrying').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('heartbeats', (table) => {
    table.dropColumn('is_retrying');
  });
}
