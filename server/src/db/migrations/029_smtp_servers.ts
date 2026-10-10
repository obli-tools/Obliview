import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('smtp_servers', (t) => {
    t.increments('id').primary();
    t.string('name', 128).notNullable();
    t.string('host', 255).notNullable();
    t.integer('port').notNullable().defaultTo(587);
    t.boolean('secure').notNullable().defaultTo(false);
    t.string('username', 255).notNullable();
    t.string('password', 255).notNullable();
    t.string('from_address', 255).notNullable();
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('smtp_servers');
}
