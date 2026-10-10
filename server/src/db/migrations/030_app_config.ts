import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_config', (t) => {
    t.string('key', 64).primary();
    t.text('value').notNullable();
  });

  // Default values
  await knex('app_config').insert([
    { key: 'allow_2fa', value: 'false' },
    { key: 'force_2fa', value: 'false' },
    { key: 'otp_smtp_server_id', value: '' },
  ]);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_config');
}
