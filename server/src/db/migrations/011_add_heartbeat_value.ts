import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('heartbeats', (table) => {
    table.text('value').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('heartbeats', (table) => {
    table.dropColumn('value');
  });
}
