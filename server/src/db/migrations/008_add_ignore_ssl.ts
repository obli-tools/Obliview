import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (table) => {
    table.boolean('ignore_ssl').defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (table) => {
    table.dropColumn('ignore_ssl');
  });
}
