import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.increments('id').primary();
    table.string('username', 64).notNullable().unique();
    table.string('password_hash', 255).notNullable();
    table.string('display_name', 128).nullable();
    table.string('role', 16).notNullable().defaultTo('user');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamps(true, true);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
