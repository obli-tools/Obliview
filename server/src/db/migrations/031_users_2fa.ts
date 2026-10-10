import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.string('email', 255).nullable();
    t.text('totp_secret').nullable();
    t.boolean('totp_enabled').notNullable().defaultTo(false);
    t.boolean('email_otp_enabled').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('email');
    t.dropColumn('totp_secret');
    t.dropColumn('totp_enabled');
    t.dropColumn('email_otp_enabled');
  });
}
