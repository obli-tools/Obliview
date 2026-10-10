import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Add 'agent' to the monitor_type enum
  await knex.raw("ALTER TYPE monitor_type ADD VALUE IF NOT EXISTS 'agent'");

  // 2. Add agent-specific columns to monitors
  await knex.schema.alterTable('monitors', (t) => {
    t.integer('agent_device_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('agent_devices')
      .onDelete('CASCADE');

    // Which metric this monitor tracks
    // cpu_percent | memory_percent | disk_percent | network_in_bytes | network_out_bytes | load_avg
    t.string('agent_metric', 64).nullable();

    // For disk monitors: which mount point (e.g. "/" or "C:")
    t.string('agent_mount', 255).nullable();

    // Threshold for alerting
    t.decimal('agent_threshold', 15, 4).nullable();

    // Comparison operator: > | < | >= | <=
    t.string('agent_threshold_op', 4).nullable();

    t.index('agent_device_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.dropColumn('agent_device_id');
    t.dropColumn('agent_metric');
    t.dropColumn('agent_mount');
    t.dropColumn('agent_threshold');
    t.dropColumn('agent_threshold_op');
  });
  // Note: PostgreSQL doesn't support removing enum values easily; skipping enum rollback
}
