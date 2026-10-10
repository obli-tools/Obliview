import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Notes on agent_devices only. Monitors already have a 'description' field.
  await knex.schema.alterTable('agent_devices', (t) => {
    t.text('notes').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('notes');
  });
}
