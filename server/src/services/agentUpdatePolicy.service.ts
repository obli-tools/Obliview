import type {
  AgentUpdatePolicy, AgentUpdatePolicyContext, ResolvedAgentUpdatePolicy,
} from '@obliview/shared';
import { db } from '../db';
import { logger } from '../utils/logger';
import {
  filterChainToTenant, isAgentUpdatePolicy, resolveAgentUpdatePolicy,
  UNRESOLVED_UPDATE_POLICY, type GroupPolicyEntry,
} from '../utils/agentUpdate';
import { appConfigService } from './appConfig.service';

// ── Agent update policy lookups (global -> workspace -> group chain -> agent) ──
//
// The three upper levels are read in bulk (one query each, every workspace)
// and cached 15 s, so resolving a whole fleet listing, a push or the rollout
// tick costs no extra query in the steady state. Setters invalidate the cache
// of this process; other processes converge within the TTL.
//
// A failed lookup fails CLOSED: the affected devices resolve to 'off' with
// source 'unresolved' (nothing automatic, manual requests refused, waiting
// requests held) until the lookup succeeds again. The failure itself is
// cached 5 s so a persistent DB error does not re-query on every push.

const CACHE_TTL_MS = 15_000;
const FAILURE_TTL_MS = 5_000;

export interface PolicyLookups {
  global: AgentUpdatePolicy | null;
  tenants: Map<number, AgentUpdatePolicy>;
  /** descendant group id → groups with an explicit policy in its ancestor chain (self included), nearest first. */
  chains: Map<number, GroupPolicyEntry[]>;
}

let cache: { value: PolicyLookups | null; at: number } | null = null;
let inflight: Promise<PolicyLookups | null> | null = null;

/** Drop the cached policies (any level edited, import). */
export function invalidateAgentUpdatePolicyCache(): void {
  cache = null;
}

async function loadGlobal(): Promise<AgentUpdatePolicy | null> {
  const cfg = await appConfigService.getAgentGlobal();
  return isAgentUpdatePolicy(cfg.updatePolicy) ? cfg.updatePolicy : null;
}

async function loadTenants(): Promise<Map<number, AgentUpdatePolicy>> {
  const rows = await db('tenants')
    .whereNotNull('agent_update_policy')
    .select('id', 'agent_update_policy') as Array<{ id: number; agent_update_policy: string }>;
  const map = new Map<number, AgentUpdatePolicy>();
  for (const r of rows) if (isAgentUpdatePolicy(r.agent_update_policy)) map.set(Number(r.id), r.agent_update_policy);
  return map;
}

async function loadChains(): Promise<Map<number, GroupPolicyEntry[]>> {
  const rows = await db('group_closure as gc')
    .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
    .whereRaw("jsonb_typeof(g.agent_group_config) = 'object'")
    .whereRaw("g.agent_group_config->>'updatePolicy' IN ('auto','manual','off')")
    .select(
      'gc.descendant_id as descendantId',
      'gc.ancestor_id as groupId',
      'g.tenant_id as tenantId',
      'g.name as groupName',
      db.raw("g.agent_group_config->>'updatePolicy' as policy"),
    )
    .orderBy([{ column: 'gc.descendant_id' }, { column: 'gc.depth', order: 'asc' }]) as Array<{
      descendantId: number; groupId: number; tenantId: number; groupName: string | null; policy: AgentUpdatePolicy;
    }>;
  const map = new Map<number, GroupPolicyEntry[]>();
  for (const r of rows) {
    let chain = map.get(Number(r.descendantId));
    if (!chain) { chain = []; map.set(Number(r.descendantId), chain); }
    chain.push({ groupId: Number(r.groupId), tenantId: Number(r.tenantId), groupName: r.groupName ?? null, policy: r.policy });
  }
  return map;
}

/** Every level's explicit policies (cached), or null when the lookup failed (fail closed). */
export async function getPolicyLookups(): Promise<PolicyLookups | null> {
  if (cache) {
    const ttl = cache.value === null ? FAILURE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cache.at < ttl) return cache.value;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [global, tenants, chains] = await Promise.all([loadGlobal(), loadTenants(), loadChains()]);
      const value: PolicyLookups = { global, tenants, chains };
      cache = { value, at: Date.now() };
      return value;
    } catch (err) {
      logger.warn({ err }, 'Agent update policy lookup failed: updates are held until it succeeds');
      cache = { value: null, at: Date.now() };
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** The minimal device shape the resolver needs (row or AgentDevice). */
export interface PolicyDeviceRef {
  tenantId: number;
  groupId: number | null;
  updatePolicy: unknown;
}

export interface DevicePolicyResolution {
  effective: ResolvedAgentUpdatePolicy;
  /** Without the device's own value. */
  inherited: ResolvedAgentUpdatePolicy;
}

/** Resolve one device against already-loaded lookups (null lookups = fail closed). */
export function resolveWithLookups(d: PolicyDeviceRef, lookups: PolicyLookups | null): DevicePolicyResolution {
  if (!lookups) return { effective: UNRESOLVED_UPDATE_POLICY, inherited: UNRESOLVED_UPDATE_POLICY };
  const chain = d.groupId != null ? filterChainToTenant(lookups.chains.get(Number(d.groupId)), d.tenantId) : [];
  const tenantPolicy = lookups.tenants.get(Number(d.tenantId)) ?? null;
  const own = isAgentUpdatePolicy(d.updatePolicy) ? d.updatePolicy : null;
  return {
    effective: resolveAgentUpdatePolicy(own, chain, tenantPolicy, lookups.global),
    inherited: resolveAgentUpdatePolicy(null, chain, tenantPolicy, lookups.global),
  };
}

export const agentUpdatePolicyService = {
  async resolveDevice(d: PolicyDeviceRef): Promise<DevicePolicyResolution> {
    return resolveWithLookups(d, await getPolicyLookups());
  },

  /** Global level (platform admin settings). */
  async getGlobalContext(): Promise<AgentUpdatePolicyContext> {
    const globalPolicy = await loadGlobal();
    return {
      ownPolicy: globalPolicy,
      inherited: resolveAgentUpdatePolicy(null, [], null, null),
      effective: resolveAgentUpdatePolicy(null, [], null, globalPolicy),
      globalPolicy,
      tenantPolicy: null,
    };
  },

  /** Workspace level. Fresh reads (no cache): this feeds an editor. */
  async getTenantPolicy(tenantId: number): Promise<AgentUpdatePolicy | null | undefined> {
    const row = await db('tenants').where({ id: tenantId }).first('agent_update_policy') as
      { agent_update_policy: string | null } | undefined;
    if (!row) return undefined;
    return isAgentUpdatePolicy(row.agent_update_policy) ? row.agent_update_policy : null;
  },

  async getTenantContext(tenantId: number): Promise<AgentUpdatePolicyContext | null> {
    const [tenantPolicy, globalPolicy] = await Promise.all([this.getTenantPolicy(tenantId), loadGlobal()]);
    if (tenantPolicy === undefined) return null;
    return {
      ownPolicy: tenantPolicy,
      inherited: resolveAgentUpdatePolicy(null, [], null, globalPolicy),
      effective: resolveAgentUpdatePolicy(null, [], tenantPolicy, globalPolicy),
      globalPolicy,
      tenantPolicy,
    };
  },

  /** Set the workspace level (null = inherit). Returns the previous value, or undefined when the tenant does not exist. */
  async setTenantPolicy(tenantId: number, policy: AgentUpdatePolicy | null): Promise<AgentUpdatePolicy | null | undefined> {
    const before = await this.getTenantPolicy(tenantId);
    if (before === undefined) return undefined;
    await db('tenants').where({ id: tenantId }).update({ agent_update_policy: policy, updated_at: new Date() });
    invalidateAgentUpdatePolicyCache();
    return before;
  },

  /**
   * Group level: the group's own value, and what it inherits from its
   * ancestors (same workspace only), the workspace and the global level.
   * Fresh reads: this feeds an editor.
   */
  async getGroupContext(groupId: number, tenantId: number): Promise<AgentUpdatePolicyContext> {
    const [rows, tenantPolicy, globalPolicy] = await Promise.all([
      db('group_closure as gc')
        .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
        .where('gc.descendant_id', groupId)
        .orderBy('gc.depth', 'asc')
        .select('gc.ancestor_id as groupId', 'gc.depth as depth', 'g.tenant_id as tenantId', 'g.name as groupName', 'g.agent_group_config as cfg') as
        Promise<Array<{ groupId: number; depth: number; tenantId: number; groupName: string | null; cfg: unknown }>>,
      this.getTenantPolicy(tenantId),
      loadGlobal(),
    ]);
    const policyOf = (cfg: unknown): AgentUpdatePolicy | null => {
      let c = cfg;
      if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return null; } }
      const p = c && typeof c === 'object' ? (c as Record<string, unknown>).updatePolicy : null;
      return isAgentUpdatePolicy(p) ? p : null;
    };
    let own: AgentUpdatePolicy | null = null;
    const chain: GroupPolicyEntry[] = [];
    for (const r of rows) {
      const p = policyOf(r.cfg);
      if (Number(r.groupId) === groupId) { own = p; continue; }
      if (p && Number(r.tenantId) === Number(tenantId)) {
        chain.push({ groupId: Number(r.groupId), tenantId: Number(r.tenantId), groupName: r.groupName ?? null, policy: p });
      }
    }
    const tp = tenantPolicy ?? null;
    const self: GroupPolicyEntry[] = own
      ? [{ groupId, tenantId, groupName: rows.find((r) => Number(r.groupId) === groupId)?.groupName ?? null, policy: own }]
      : [];
    return {
      ownPolicy: own,
      inherited: resolveAgentUpdatePolicy(null, chain, tp, globalPolicy),
      effective: resolveAgentUpdatePolicy(null, [...self, ...chain], tp, globalPolicy),
      globalPolicy,
      tenantPolicy: tp,
    };
  },

  /** Ids of the devices of a group's sub-tree (same workspace only). */
  async deviceIdsInGroupTree(groupId: number, tenantId: number): Promise<number[]> {
    return await db('agent_devices')
      .where('tenant_id', tenantId)
      .whereIn('group_id', db('group_closure').where({ ancestor_id: groupId }).select('descendant_id'))
      .pluck('id') as number[];
  },
};
