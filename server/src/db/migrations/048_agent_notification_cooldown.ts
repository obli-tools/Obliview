import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.integer('notification_cooldown_seconds').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('notification_cooldown_seconds');
  });
}
