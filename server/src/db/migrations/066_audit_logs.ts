import type { Knex } from 'knex';

/**
 * Audit log: "who did what, when, and from where" (same model as Obliance).
 *
 * - tenant_id: the workspace the action belongs to. NULL for platform-level
 *   actions (sign-in refusals, app config, SMTP servers…) — only the master
 *   tenant's cross-tenant feed shows those. ON DELETE CASCADE: deleting a
 *   tenant drops its trail.
 * - user_id: the actor (NULL for system actions or an unknown user).
 *   ON DELETE SET NULL keeps the row once the account is gone.
 * - action: dotted name ('auth.login', 'team.created', 'monitor.deleted'…).
 * - resource_type / resource_id: the entity acted on. resource_id is text
 *   (it may hold non-numeric keys such as config keys); names are resolved
 *   with `<table>.id = CASE WHEN resource_id ~ '^[0-9]{1,9}$' THEN
 *   resource_id::int END` so the PK index is used and a non-numeric key is
 *   never cast.
 * - resource_path: free-form locator when an id is not enough.
 * - details: JSON context — never secret values.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id').primary();
    t.integer('tenant_id').nullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    t.string('action', 100).notNullable();
    t.string('resource_type', 50).nullable();
    t.string('resource_id', 100).nullable();
    t.text('resource_path').nullable();
    t.jsonb('details').nullable();
    t.string('ip_address', 45).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw('CREATE INDEX idx_audit_logs_tenant_created ON audit_logs (tenant_id, created_at)');
  await knex.raw('CREATE INDEX idx_audit_logs_action ON audit_logs (action)');
  // Cross-tenant feed (ORDER BY created_at DESC, id DESC), date filters and
  // the retention purge (created_at < ?).
  await knex.raw('CREATE INDEX idx_audit_logs_created ON audit_logs (created_at DESC, id DESC)');
  // users ON DELETE SET NULL without a full scan.
  await knex.raw('CREATE INDEX idx_audit_logs_user ON audit_logs (user_id) WHERE user_id IS NOT NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
