import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('maintenance_window_disables', (t) => {
    t.increments('id').primary();
    t.integer('window_id')
      .notNullable()
      .references('id')
      .inTable('maintenance_windows')
      .onDelete('CASCADE');
    // The scope that is opting out of this window ('group' | 'monitor' | 'agent')
    t.string('scope_type', 20).notNullable();
    t.integer('scope_id').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    t.unique(['window_id', 'scope_type', 'scope_id']);
  });

  await knex.raw('CREATE INDEX idx_mwd_window ON maintenance_window_disables(window_id)');
  await knex.raw('CREATE INDEX idx_mwd_scope  ON maintenance_window_disables(scope_type, scope_id)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('maintenance_window_disables');
}
