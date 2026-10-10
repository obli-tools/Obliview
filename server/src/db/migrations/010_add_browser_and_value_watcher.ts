import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add new monitor types to the enum
  await knex.raw("ALTER TYPE monitor_type ADD VALUE IF NOT EXISTS 'browser'");
  await knex.raw("ALTER TYPE monitor_type ADD VALUE IF NOT EXISTS 'value_watcher'");

  await knex.schema.alterTable('monitors', (table) => {
    // Browser (Playwright) fields
    table.string('browser_url', 2048).nullable();
    table.string('browser_keyword', 255).nullable();
    table.boolean('browser_keyword_is_present').nullable();
    table.string('browser_wait_for_selector', 255).nullable();
    table.boolean('browser_screenshot_on_failure').notNullable().defaultTo(false);

    // Value Watcher fields
    table.string('value_watcher_url', 2048).nullable();
    table.string('value_watcher_json_path', 255).nullable();
    table.string('value_watcher_operator', 20).nullable();
    table.double('value_watcher_threshold').nullable();
    table.double('value_watcher_threshold_max').nullable();
    table.text('value_watcher_previous_value').nullable();
    table.jsonb('value_watcher_headers').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('monitors', (table) => {
    table.dropColumn('browser_url');
    table.dropColumn('browser_keyword');
    table.dropColumn('browser_keyword_is_present');
    table.dropColumn('browser_wait_for_selector');
    table.dropColumn('browser_screenshot_on_failure');

    table.dropColumn('value_watcher_url');
    table.dropColumn('value_watcher_json_path');
    table.dropColumn('value_watcher_operator');
    table.dropColumn('value_watcher_threshold');
    table.dropColumn('value_watcher_threshold_max');
    table.dropColumn('value_watcher_previous_value');
    table.dropColumn('value_watcher_headers');
  });

  // Note: PostgreSQL does not support removing values from enums easily
}
