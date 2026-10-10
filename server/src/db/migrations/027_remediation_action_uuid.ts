import type { Knex } from 'knex';

/**
 * Add UUID column to remediation_actions so that actions can participate in
 * import/export with stable, portable identifiers across server instances.
 *
 * gen_random_uuid() is available in PostgreSQL 13+ without pgcrypto.
 * Existing rows receive a random UUID automatically via the DEFAULT.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE remediation_actions ADD COLUMN IF NOT EXISTS uuid UUID NOT NULL DEFAULT gen_random_uuid()`);

  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE remediation_actions ADD CONSTRAINT remediation_actions_uuid_key UNIQUE (uuid);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE remediation_actions DROP CONSTRAINT IF EXISTS remediation_actions_uuid_key`);
  await knex.schema.alterTable('remediation_actions', t => t.dropColumn('uuid'));
}
