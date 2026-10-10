import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. User teams
  await knex.schema.createTable('user_teams', (t) => {
    t.increments('id').primary();
    t.string('name', 255).notNullable().unique();
    t.text('description').nullable();
    t.boolean('can_create').notNullable().defaultTo(false);
    t.timestamps(true, true);
  });

  // 2. Team memberships (user ↔ team)
  await knex.schema.createTable('team_memberships', (t) => {
    t.integer('team_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('user_teams')
      .onDelete('CASCADE');
    t.integer('user_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    t.primary(['team_id', 'user_id']);
  });

  // 3. Team permissions (team ↔ resource)
  await knex.schema.createTable('team_permissions', (t) => {
    t.increments('id').primary();
    t.integer('team_id')
      .unsigned()
      .notNullable()
      .references('id')
      .inTable('user_teams')
      .onDelete('CASCADE');
    t.string('scope', 20).notNullable(); // 'group' or 'monitor'
    t.integer('scope_id').notNullable();
    t.string('level', 5).notNullable(); // 'ro' or 'rw'
    t.unique(['team_id', 'scope', 'scope_id']);
    t.index(['scope', 'scope_id']);
    t.index('team_id');
  });

  // 4. Drop old user_group_assignments table
  await knex.schema.dropTableIfExists('user_group_assignments');
}

export async function down(knex: Knex): Promise<void> {
  // Recreate old table
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

  await knex.schema.dropTableIfExists('team_permissions');
  await knex.schema.dropTableIfExists('team_memberships');
  await knex.schema.dropTableIfExists('user_teams');
}
