import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // This table is managed by connect-pg-simple, but we create it
  // here so the migration system tracks it.
  await knex.schema.createTable('session', (table) => {
    table.string('sid').primary();
    table.json('sess').notNullable();
    table.timestamp('expire', { useTz: true }).notNullable();
  });

  await knex.schema.raw(
    'CREATE INDEX idx_session_expire ON session(expire)'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('session');
}
