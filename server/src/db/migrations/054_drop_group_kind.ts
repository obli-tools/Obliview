import type { Knex } from 'knex';

/**
 * Drop monitor_groups.kind. Groups are now hybrid — every group can contain
 * both monitors and agent devices. The existing JSONB columns
 * `agent_thresholds` and `agent_group_config` still apply per group; they
 * just activate when the group has agents in it (otherwise inert).
 *
 * No data migration on monitor/device assignments is needed: monitors point
 * to a group via `monitors.group_id` and devices via `agent_devices.group_id`,
 * which are independent and survive the column drop.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.dropColumn('kind');
  });
}

export async function down(knex: Knex): Promise<void> {
  // Re-introduce the column with a sensible default. We can't reliably
  // re-derive which groups used to be 'agent' kind, so everything rolls
  // back as 'monitor'.
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.string('kind', 16).notNullable().defaultTo('monitor');
  });
}
