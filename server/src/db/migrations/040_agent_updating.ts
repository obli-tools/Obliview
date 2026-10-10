import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    // Set when the agent notifies us it is about to self-update.
    // Cleared when the agent reconnects after the update, or by the cleanup
    // job after 10 minutes of silence (update considered failed at that point).
    t.timestamp('updating_since', { useTz: true }).nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('updating_since');
  });
}
