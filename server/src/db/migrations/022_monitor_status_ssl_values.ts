import type { Knex } from 'knex';

/**
 * Add 'ssl_expired' and 'ssl_warning' to the monitor_status PostgreSQL enum.
 *
 * These statuses are produced by HttpMonitorWorker, SslMonitorWorker, and
 * JsonApiMonitorWorker but were never added to the DB enum, causing
 * "invalid input value for enum monitor_status" errors every time an SSL
 * problem was detected and whenever groupNotification.service initializes.
 *
 * NOTE: PostgreSQL does not support removing enum values, so the down
 * migration is a no-op.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TYPE monitor_status ADD VALUE IF NOT EXISTS 'ssl_expired'`);
  await knex.raw(`ALTER TYPE monitor_status ADD VALUE IF NOT EXISTS 'ssl_warning'`);
}

export async function down(_knex: Knex): Promise<void> {
  // PostgreSQL does not support DROP VALUE on enums — no-op.
}
