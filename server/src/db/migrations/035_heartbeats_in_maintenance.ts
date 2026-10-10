import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('heartbeats', (t) => {
    t.boolean('in_maintenance').notNullable().defaultTo(false);
  });

  // Partial index — only indexes the minority of rows that are in maintenance
  await knex.raw(
    'CREATE INDEX idx_hb_in_maintenance ON heartbeats(monitor_id) WHERE in_maintenance = TRUE',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS idx_hb_in_maintenance');
  await knex.schema.alterTable('heartbeats', (t) => {
    t.dropColumn('in_maintenance');
  });
}
