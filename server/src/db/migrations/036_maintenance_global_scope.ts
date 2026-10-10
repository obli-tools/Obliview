import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Allow NULL scope_id so global windows can omit it
  await knex.schema.alterTable('maintenance_windows', (t) => {
    t.integer('scope_id').nullable().alter();
  });

  // 2. Add CHECK constraint: scope_id must be NULL iff scope_type = 'global'
  await knex.raw(`
    ALTER TABLE maintenance_windows
    ADD CONSTRAINT chk_mw_scope CHECK (
      (scope_type = 'global' AND scope_id IS NULL) OR
      (scope_type != 'global' AND scope_id IS NOT NULL)
    )
  `);

  // 3. Recreate scope index to handle nullable scope_id
  await knex.raw('DROP INDEX IF EXISTS idx_mw_scope');
  await knex.raw('CREATE INDEX idx_mw_scope ON maintenance_windows(scope_type, scope_id)');
}

export async function down(knex: Knex): Promise<void> {
  // Remove constraint and re-add NOT NULL
  await knex.raw('ALTER TABLE maintenance_windows DROP CONSTRAINT IF EXISTS chk_mw_scope');

  // Delete any global windows before restoring NOT NULL
  await knex('maintenance_windows').where({ scope_type: 'global' }).del();

  await knex.schema.alterTable('maintenance_windows', (t) => {
    t.integer('scope_id').notNullable().alter();
  });
}
