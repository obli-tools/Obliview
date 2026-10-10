import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('agent_api_keys', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.uuid('key').notNullable().unique().defaultTo(knex.raw('gen_random_uuid()'));
    t.integer('created_by')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_used_at').nullable();

    t.index('key');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('agent_api_keys');
}
