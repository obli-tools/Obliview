import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    // Replaces the per-metric columns (agent_metric, agent_mount, agent_threshold,
    // agent_threshold_op) with a single JSONB object containing all thresholds.
    // Old columns are kept in the DB but are no longer used.
    t.jsonb('agent_thresholds').nullable().defaultTo(null);
  });

  await knex.schema.alterTable('monitor_groups', (t) => {
    // Default thresholds for agent groups. Applied when approving a device into this group.
    t.jsonb('agent_thresholds').nullable().defaultTo(null);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.dropColumn('agent_thresholds');
  });
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.dropColumn('agent_thresholds');
  });
}
