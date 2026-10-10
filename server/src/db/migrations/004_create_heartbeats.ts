import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('heartbeats', (table) => {
    table.bigIncrements('id').primary();
    table.integer('monitor_id').notNullable().references('id').inTable('monitors').onDelete('CASCADE');
    table.specificType('status', 'monitor_status').notNullable();
    table.integer('response_time').nullable(); // ms
    table.integer('status_code').nullable();
    table.text('message').nullable();
    table.float('ping').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw('CREATE INDEX idx_heartbeats_monitor_time ON heartbeats(monitor_id, created_at DESC)');

  // Aggregated stats
  await knex.schema.createTable('heartbeat_stats', (table) => {
    table.increments('id').primary();
    table.integer('monitor_id').notNullable().references('id').inTable('monitors').onDelete('CASCADE');
    table.string('period', 10).notNullable(); // '1h', '24h', '7d', '30d', '365d'
    table.float('uptime_pct').notNullable();
    table.float('avg_response').nullable();
    table.float('max_response').nullable();
    table.float('min_response').nullable();
    table.integer('total_checks').notNullable();
    table.integer('total_up').notNullable();
    table.integer('total_down').notNullable();
    table.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['monitor_id', 'period']);
  });

  // Incidents
  await knex.schema.createTable('incidents', (table) => {
    table.increments('id').primary();
    table.integer('monitor_id').notNullable().references('id').inTable('monitors').onDelete('CASCADE');
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('resolved_at', { useTz: true }).nullable();
    table.integer('duration_sec').nullable();
    table.specificType('previous_status', 'monitor_status').notNullable();
    table.specificType('new_status', 'monitor_status').notNullable();
    table.text('message').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.raw('CREATE INDEX idx_incidents_monitor ON incidents(monitor_id, started_at DESC)');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('incidents');
  await knex.schema.dropTableIfExists('heartbeat_stats');
  await knex.schema.dropTableIfExists('heartbeats');
}
