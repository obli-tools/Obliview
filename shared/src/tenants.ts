/**
 * The "master" (God View) tenant. Seeded at id=1 with slug='default' by
 * migration 039_tenants.ts and treated as immutable by the application.
 *
 * Platform admins connected to this tenant get cross-tenant fan-out on all
 * listing endpoints (agents, monitors, teams, channels…). Non-platform-admins
 * have no special privileges there — the tenant is just the default workspace.
 */
export const MASTER_TENANT_ID = 1;
export const MASTER_TENANT_SLUG = 'default';

export function isMasterTenant(tenantId: number | null | undefined): boolean {
  return tenantId === MASTER_TENANT_ID;
}
