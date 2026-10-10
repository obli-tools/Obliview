import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Monitor groups table
  await knex.schema.createTable('monitor_groups', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable();
    t.string('slug', 255).notNullable().unique();
    t.text('description').nullable();
    t.integer('parent_id')
      .unsigned()
      .nullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('CASCADE');
    t.integer('sort_order').notNullable().defaultTo(0);
    t.boolean('is_general').notNullable().defaultTo(false);
    t.timestamps(true, true);

    t.index('parent_id');
    t.index('slug');
  });

  // 2. Closure table for hierarchical queries
  await knex.schema.createTable('group_closure', (t) => {
    t.integer('ancestor_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('CASCADE');
    t.integer('descendant_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('CASCADE');
    t.integer('depth').notNullable();

    t.primary(['ancestor_id', 'descendant_id']);
    t.index('descendant_id');
    t.index('ancestor_id');
  });

  // 3. User-group visibility assignments
  await knex.schema.createTable('user_group_assignments', (t) => {
    t.integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.integer('group_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('CASCADE');

    t.primary(['user_id', 'group_id']);
  });

  // 4. Add foreign key on monitors.group_id → monitor_groups.id
  await knex.schema.alterTable('monitors', (t) => {
    t.foreign('group_id')
      .references('id')
      .inTable('monitor_groups')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (t) => {
    t.dropForeign('group_id');
  });
  await knex.schema.dropTableIfExists('user_group_assignments');
  await knex.schema.dropTableIfExists('group_closure');
  await knex.schema.dropTableIfExists('monitor_groups');
}
