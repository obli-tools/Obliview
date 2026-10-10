import type { Knex } from 'knex';

/**
 * Persist the time of the last push received by a push monitor.
 *
 * Push timestamps used to live only in PushMonitorWorker's in-memory map, so
 * every server restart made hourly / daily push monitors go DOWN until their
 * next push. heartbeat.routes.ts now writes this column (throttled to once per
 * 10 s per monitor) and PushMonitorWorker seeds its map from it on start.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.timestamp('last_push_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.dropColumn('last_push_at');
  });
}
