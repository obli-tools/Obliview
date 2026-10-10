import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Agent-group level config: push interval default, heartbeat monitoring default, max missed pushes
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.jsonb('agent_group_config').nullable().defaultTo(null);
  });

  // Per-device override for max missed pushes (null = use group/system default of 2)
  await knex.schema.alterTable('agent_devices', (t) => {
    t.integer('agent_max_missed_pushes').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.dropColumn('agent_group_config');
  });
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('agent_max_missed_pushes');
  });
}
