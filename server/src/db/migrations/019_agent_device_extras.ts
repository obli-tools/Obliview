import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    // Custom display name (shown instead of hostname when set)
    t.string('name', 255).nullable().defaultTo(null);
    // When false: agent going offline → 'inactive' (grey), no notification sent.
    // Useful for workstations that sleep/shutdown intentionally.
    t.boolean('heartbeat_monitoring').notNullable().defaultTo(true);
  });
  // Note: the 'status' column is a varchar — 'suspended' is a new valid value.
  // No enum constraint to alter in PostgreSQL for this column.
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('name');
    t.dropColumn('heartbeat_monitoring');
  });
}
