import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('maintenance_windows', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();

    // Scope
    t.string('scope_type', 20).notNullable();  // 'group' | 'monitor' | 'agent'
    t.integer('scope_id').notNullable();
    t.boolean('is_override').notNullable().defaultTo(false);

    // Schedule
    t.string('schedule_type', 20).notNullable(); // 'one_time' | 'recurring'

    // one_time fields
    t.timestamp('start_at', { useTz: true }).nullable();
    t.timestamp('end_at', { useTz: true }).nullable();

    // recurring fields
    t.string('start_time', 5).nullable();         // 'HH:MM'
    t.string('end_time', 5).nullable();           // 'HH:MM'
    t.string('recurrence_type', 20).nullable();   // 'daily' | 'weekly'
    t.specificType('days_of_week', 'integer[]').nullable(); // 0=Mon … 6=Sun

    t.string('timezone', 100).notNullable().defaultTo('UTC');

    // Optional start/end notifications
    t.specificType('notify_channel_ids', 'integer[]').notNullable().defaultTo('{}');

    // Dedup tracking for transition notifications
    t.timestamp('last_notified_start_at', { useTz: true }).nullable();
    t.timestamp('last_notified_end_at', { useTz: true }).nullable();

    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX idx_mw_scope ON maintenance_windows(scope_type, scope_id)');
  await knex.raw('CREATE INDEX idx_mw_active ON maintenance_windows(active) WHERE active = TRUE');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('maintenance_windows');
}
