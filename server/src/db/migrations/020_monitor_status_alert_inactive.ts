import type { Knex } from 'knex';

/**
 * Add 'alert' and 'inactive' to the monitor_status PostgreSQL enum.
 *
 * - alert   : agent threshold violation (CPU/RAM/disk/net exceeded) — orange
 * - inactive: agent offline + heartbeat_monitoring=false (workstation) — grey, no notification
 *
 * NOTE: PostgreSQL does not support removing enum values, so the down migration
 * is a no-op. These values are safe to leave in the enum even if unused.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TYPE monitor_status ADD VALUE IF NOT EXISTS 'alert'`);
  await knex.raw(`ALTER TYPE monitor_status ADD VALUE IF NOT EXISTS 'inactive'`);
}

export async function down(_knex: Knex): Promise<void> {
  // PostgreSQL does not support DROP VALUE on enums — no-op.
}
