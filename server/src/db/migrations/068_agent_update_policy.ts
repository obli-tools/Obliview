import type { Knex } from 'knex';

/**
 * Agent update policy (ported from Obliguard 027 / 031).
 *
 * Four levels decide whether an agent is updated automatically, manually or
 * not at all: GLOBAL (app_config 'agent_global_config'.updatePolicy) ->
 * WORKSPACE (tenants.agent_update_policy, this migration) -> GROUP CHAIN
 * (monitor_groups.agent_group_config->>'updatePolicy', inherited by the
 * sub-groups of the same workspace) -> AGENT (agent_devices.update_policy,
 * this migration).
 *   - values 'auto' | 'manual' | 'off'; NULL / absent = inherit;
 *   - 'off' at any level is absolute (freezes the subtree; global 'off' is
 *     the fleet-wide kill-switch); otherwise the nearest explicit value wins;
 *   - nothing set anywhere = 'manual', enforced in code: nothing is written
 *     here, so every existing install keeps today's admin-paced behaviour.
 *
 * Nullable columns only, each step guarded (idempotent, re-runnable).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('tenants', 'agent_update_policy'))) {
    await knex.schema.alterTable('tenants', (t) => {
      t.string('agent_update_policy', 16).nullable().defaultTo(null);
    });
  }
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_agent_update_policy_check');
  await knex.raw(
    "ALTER TABLE tenants ADD CONSTRAINT tenants_agent_update_policy_check CHECK (agent_update_policy IS NULL OR agent_update_policy IN ('auto','manual','off'))",
  );

  if (!(await knex.schema.hasColumn('agent_devices', 'update_policy'))) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.string('update_policy', 16).nullable().defaultTo(null);
    });
  }
  await knex.raw('ALTER TABLE agent_devices DROP CONSTRAINT IF EXISTS agent_devices_update_policy_check');
  await knex.raw(
    "ALTER TABLE agent_devices ADD CONSTRAINT agent_devices_update_policy_check CHECK (update_policy IS NULL OR update_policy IN ('auto','manual','off'))",
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('ALTER TABLE agent_devices DROP CONSTRAINT IF EXISTS agent_devices_update_policy_check');
  if (await knex.schema.hasColumn('agent_devices', 'update_policy')) {
    await knex.schema.alterTable('agent_devices', (t) => {
      t.dropColumn('update_policy');
    });
  }
  await knex.raw('ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_agent_update_policy_check');
  if (await knex.schema.hasColumn('tenants', 'agent_update_policy')) {
    await knex.schema.alterTable('tenants', (t) => {
      t.dropColumn('agent_update_policy');
    });
  }
  // Group policies live in monitor_groups.agent_group_config (JSON): strip the key.
  await knex.raw(
    "UPDATE monitor_groups SET agent_group_config = agent_group_config - 'updatePolicy' WHERE jsonb_typeof(agent_group_config) = 'object' AND agent_group_config -> 'updatePolicy' IS NOT NULL",
  );
}
