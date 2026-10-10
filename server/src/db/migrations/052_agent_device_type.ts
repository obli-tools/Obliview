import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    // 'agent' = lightweight Go agent, 'proxy' = full Obliview proxy stub (Node.js + Playwright)
    t.string('device_type', 16).notNullable().defaultTo('agent');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('device_type');
  });
}
