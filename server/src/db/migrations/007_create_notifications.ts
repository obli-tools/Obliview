import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Notification channels (e.g. "My Discord", "Ops Telegram")
  await knex.schema.createTable('notification_channels', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.string('type', 50).notNullable(); // plugin type: 'webhook', 'discord', etc.
    t.jsonb('config').notNullable().defaultTo('{}');
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.integer('created_by')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    t.timestamps(true, true);
  });

  // 2. Bindings: which channels are attached to which scope
  await knex.schema.createTable('notification_bindings', (t) => {
    t.increments('id').primary();
    t.integer('channel_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('notification_channels')
      .onDelete('CASCADE');
    t.string('scope', 20).notNullable(); // 'global', 'group', 'monitor'
    t.integer('scope_id').nullable(); // null for global
    t.string('override_mode', 10).notNullable().defaultTo('merge'); // 'merge' or 'replace'

    t.unique(['channel_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
  });

  // 3. Notification log
  await knex.schema.createTable('notification_log', (t) => {
    t.increments('id').primary();
    t.integer('channel_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('notification_channels')
      .onDelete('CASCADE');
    t.integer('monitor_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('monitors')
      .onDelete('SET NULL');
    t.string('event_type', 50).notNullable(); // 'status_change', 'test'
    t.boolean('success').notNullable();
    t.text('message').nullable();
    t.text('error').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index('monitor_id');
    t.index('channel_id');
    t.index('created_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_log');
  await knex.schema.dropTableIfExists('notification_bindings');
  await knex.schema.dropTableIfExists('notification_channels');
}
