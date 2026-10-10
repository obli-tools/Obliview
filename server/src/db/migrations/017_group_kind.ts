import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.string('kind', 16).notNullable().defaultTo('monitor');
    // kind: 'monitor' (standard group) | 'agent' (agent group)
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitor_groups', (t) => {
    t.dropColumn('kind');
  });
}
