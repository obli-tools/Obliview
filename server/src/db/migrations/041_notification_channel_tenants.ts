import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notification_channel_tenants', (t) => {
    t.integer('channel_id').notNullable().references('id').inTable('notification_channels').onDelete('CASCADE');
    t.integer('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['channel_id', 'tenant_id']);
  });

  // Fast lookup: all tenants a channel is shared to
  await knex.raw(`CREATE INDEX nct_channel_id ON notification_channel_tenants(channel_id)`);
  // Fast lookup: all channels shared to a tenant
  await knex.raw(`CREATE INDEX nct_tenant_id ON notification_channel_tenants(tenant_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_channel_tenants');
}
