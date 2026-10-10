import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Create monitor_type enum
  await knex.schema.raw(`
    CREATE TYPE monitor_type AS ENUM (
      'http', 'ping', 'tcp', 'dns', 'ssl', 'smtp',
      'docker', 'game_server', 'push', 'script', 'json_api'
    )
  `);

  // Create monitor_status enum
  await knex.schema.raw(`
    CREATE TYPE monitor_status AS ENUM (
      'up', 'down', 'pending', 'maintenance', 'paused'
    )
  `);

  await knex.schema.createTable('monitors', (table) => {
    table.increments('id').primary();
    table.string('name', 255).notNullable();
    table.text('description').nullable();
    table.specificType('type', 'monitor_type').notNullable();
    table.integer('group_id').nullable(); // FK added in groups migration
    table.boolean('is_active').notNullable().defaultTo(true);
    table.specificType('status', 'monitor_status').notNullable().defaultTo('pending');

    // Common config (nullable = inherit from group/global)
    table.integer('interval_seconds').nullable();
    table.integer('retry_interval_seconds').nullable();
    table.integer('max_retries').nullable();
    table.integer('timeout_ms').nullable();
    table.boolean('upside_down').notNullable().defaultTo(false);

    // HTTP / JSON API
    table.text('url').nullable();
    table.string('method', 10).nullable().defaultTo('GET');
    table.jsonb('headers').nullable();
    table.text('body').nullable();
    table.specificType('expected_status_codes', 'integer[]').nullable();
    table.string('keyword', 255).nullable();
    table.boolean('keyword_is_present').nullable().defaultTo(true);

    // JSON API
    table.string('json_path', 255).nullable();
    table.string('json_expected_value', 255).nullable();

    // Ping / TCP
    table.string('hostname', 255).nullable();
    table.integer('port').nullable();

    // DNS
    table.string('dns_record_type', 10).nullable();
    table.string('dns_resolver', 255).nullable();
    table.string('dns_expected_value', 255).nullable();

    // SSL
    table.integer('ssl_warn_days').nullable().defaultTo(30);

    // SMTP
    table.string('smtp_host', 255).nullable();
    table.integer('smtp_port').nullable().defaultTo(25);

    // Docker
    table.text('docker_host').nullable();
    table.string('docker_container_name', 255).nullable();

    // Game server
    table.string('game_type', 32).nullable();
    table.string('game_host', 255).nullable();
    table.integer('game_port').nullable();

    // Push monitoring
    table.string('push_token', 64).nullable().unique();
    table.integer('push_max_interval_sec').nullable().defaultTo(300);

    // Script
    table.text('script_command').nullable();
    table.integer('script_expected_exit').nullable().defaultTo(0);

    // Metadata
    table.integer('created_by').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamps(true, true);
  });

  // Indexes
  await knex.schema.raw('CREATE INDEX idx_monitors_type ON monitors(type)');
  await knex.schema.raw('CREATE INDEX idx_monitors_status ON monitors(status)');
  await knex.schema.raw('CREATE INDEX idx_monitors_push_token ON monitors(push_token) WHERE push_token IS NOT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('monitors');
  await knex.schema.raw('DROP TYPE IF EXISTS monitor_status');
  await knex.schema.raw('DROP TYPE IF EXISTS monitor_type');
}
