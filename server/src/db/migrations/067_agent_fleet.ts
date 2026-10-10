import type { Knex } from 'knex';

/**
 * Agent fleet lifecycle (wave 4).
 *
 * agent_api_keys
 *  - default_group_id: group a device enrolled with this key is approved into
 *    when the approval names no group (single and bulk approval). Must belong
 *    to the key's workspace (checked by the API). ON DELETE SET NULL.
 *
 * agent_devices — admin-paced agent updates (agents no longer self-update on
 * every server deploy, see services/agentUpdateRollout.service.ts):
 *  - update_requested_at: an admin queued an update (NULL = none outstanding;
 *    at most one outstanding update per device);
 *  - target_version: version the queued / delivered update installs;
 *  - update_sent_at: the 'update' command was handed to the agent and has not
 *    completed yet (cleared on success / timeout / cancel);
 *  - update_dispatched_at: time of the last hand-out, KEPT after success,
 *    timeout and cancel — used only by the rollout pace window (a fast agent
 *    must not free its slot before the window ends);
 *  - update_error_at / update_error: the last update did not complete
 *    (timeout, version unchanged…); cleared by a new request or a success.
 *
 * agent_devices — uninstall / tenant transfer:
 *  - uninstall_requested_at: when an admin queued the uninstall (the existing
 *    uninstall_commanded_at keeps its meaning: delivery time, which starts the
 *    10-minute auto-delete countdown);
 *  - transfer_from_api_key_id: after a tenant transfer, the key the agent still
 *    authenticates with until it applies the 'reconfigure' command. Only that
 *    key may receive the new key (handlePush / agentHub);
 *  - transfer_requested_at: when that transfer was made. The former key gets
 *    the new key only within a bounded window (TTL), after which the pending
 *    reconfigure is dropped by the cleanup job.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('agent_api_keys', (t) => {
    t.integer('default_group_id')
      .nullable()
      .references('id')
      .inTable('monitor_groups')
      .onDelete('SET NULL');
  });

  await knex.schema.alterTable('agent_devices', (t) => {
    t.timestamp('update_requested_at', { useTz: true }).nullable();
    t.timestamp('update_sent_at', { useTz: true }).nullable();
    t.timestamp('update_dispatched_at', { useTz: true }).nullable();
    t.timestamp('update_error_at', { useTz: true }).nullable();
    t.string('update_error', 255).nullable();
    t.string('target_version', 50).nullable();
    t.timestamp('uninstall_requested_at', { useTz: true }).nullable();
    t.integer('transfer_from_api_key_id')
      .nullable()
      .references('id')
      .inTable('agent_api_keys')
      .onDelete('SET NULL');
    t.timestamp('transfer_requested_at', { useTz: true }).nullable();
  });

  // Small partial indexes: the rollout tick and the pace window only ever
  // look at the few devices with an outstanding update.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS agent_devices_update_requested_idx
      ON agent_devices (update_requested_at)
      WHERE update_requested_at IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS agent_devices_update_sent_idx
      ON agent_devices (update_sent_at)
      WHERE update_sent_at IS NOT NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS agent_devices_update_dispatched_idx
      ON agent_devices (update_dispatched_at)
      WHERE update_dispatched_at IS NOT NULL
  `);

  // Uninstalls already queued keep a request time for the UI.
  await knex('agent_devices')
    .where({ pending_command: 'uninstall' })
    .whereNull('uninstall_requested_at')
    .update({ uninstall_requested_at: knex.ref('updated_at') });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS agent_devices_update_dispatched_idx');
  await knex.raw('DROP INDEX IF EXISTS agent_devices_update_sent_idx');
  await knex.raw('DROP INDEX IF EXISTS agent_devices_update_requested_idx');
  await knex.schema.alterTable('agent_devices', (t) => {
    t.dropColumn('transfer_requested_at');
    t.dropColumn('transfer_from_api_key_id');
    t.dropColumn('uninstall_requested_at');
    t.dropColumn('target_version');
    t.dropColumn('update_error');
    t.dropColumn('update_error_at');
    t.dropColumn('update_dispatched_at');
    t.dropColumn('update_sent_at');
    t.dropColumn('update_requested_at');
  });
  await knex.schema.alterTable('agent_api_keys', (t) => {
    t.dropColumn('default_group_id');
  });
}
