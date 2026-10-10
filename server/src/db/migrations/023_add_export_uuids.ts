import type { Knex } from 'knex';

/**
 * Add UUID columns to the four tables that participate in import/export.
 *
 * UUIDs are used as stable, portable identifiers across server instances so
 * that importing an export file updates existing rows (same UUID) rather than
 * creating duplicates.
 *
 * gen_random_uuid() is available in PostgreSQL 13+ without pgcrypto.
 * Existing rows receive a random UUID automatically via the DEFAULT.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE monitors              ADD COLUMN IF NOT EXISTS uuid UUID NOT NULL DEFAULT gen_random_uuid()`);
  await knex.raw(`ALTER TABLE monitor_groups        ADD COLUMN IF NOT EXISTS uuid UUID NOT NULL DEFAULT gen_random_uuid()`);
  await knex.raw(`ALTER TABLE notification_channels ADD COLUMN IF NOT EXISTS uuid UUID NOT NULL DEFAULT gen_random_uuid()`);
  await knex.raw(`ALTER TABLE user_teams            ADD COLUMN IF NOT EXISTS uuid UUID NOT NULL DEFAULT gen_random_uuid()`);

  // Unique constraints — used by ON CONFLICT (uuid) DO UPDATE in import logic
  // PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS, so we use a DO block instead.
  for (const [table, constraint] of [
    ['monitors',              'monitors_uuid_key'],
    ['monitor_groups',        'monitor_groups_uuid_key'],
    ['notification_channels', 'notification_channels_uuid_key'],
    ['user_teams',            'user_teams_uuid_key'],
  ] as [string, string][]) {
    await knex.raw(`
      DO $$ BEGIN
        ALTER TABLE ${table} ADD CONSTRAINT ${constraint} UNIQUE (uuid);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE user_teams            DROP CONSTRAINT IF EXISTS user_teams_uuid_key`);
  await knex.raw(`ALTER TABLE notification_channels DROP CONSTRAINT IF EXISTS notification_channels_uuid_key`);
  await knex.raw(`ALTER TABLE monitor_groups        DROP CONSTRAINT IF EXISTS monitor_groups_uuid_key`);
  await knex.raw(`ALTER TABLE monitors              DROP CONSTRAINT IF EXISTS monitors_uuid_key`);

  await knex.schema.alterTable('monitors',              t => t.dropColumn('uuid'));
  await knex.schema.alterTable('monitor_groups',        t => t.dropColumn('uuid'));
  await knex.schema.alterTable('notification_channels', t => t.dropColumn('uuid'));
  await knex.schema.alterTable('user_teams',            t => t.dropColumn('uuid'));
}
