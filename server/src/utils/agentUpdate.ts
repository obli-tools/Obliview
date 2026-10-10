/**
 * Agent update policy — pure helpers (no DB). Ported from Obliguard
 * server/src/utils/agentUpdate.ts.
 *
 * Policy model: 'auto' | 'manual' | 'off' at four levels (global, workspace,
 * group chain, agent). 'off' at any level is absolute; otherwise the nearest
 * explicit value wins; nothing set anywhere = DEFAULT_AGENT_UPDATE_POLICY
 * ('manual').
 */
import type { AgentUpdatePolicy, ResolvedAgentUpdatePolicy } from '@obliview/shared';
import { AGENT_UPDATE_POLICIES, DEFAULT_AGENT_UPDATE_POLICY } from '@obliview/shared';

/** Go strconv.Atoi: optional sign then digits only, else 0 (the Go agent ignores the error). */
function goAtoi(s: string): number {
  return /^[+-]?\d+$/.test(s) ? Number(s) : 0;
}

/** Mirror of agent/main.go parseSemver: strip one 'v', SplitN(v, '.', 3), Atoi each part. */
export function parseAgentSemver(v: string | null | undefined): [number, number, number] {
  let s = String(v ?? '');
  if (s.startsWith('v')) s = s.slice(1);
  const parts = s.split('.');
  if (parts.length < 3) return [0, 0, 0];
  return [goAtoi(parts[0]), goAtoi(parts[1]), goAtoi(parts.slice(2).join('.'))];
}

/**
 * remote > current (major, minor, patch). Automatic ('auto') updates only
 * ever move an agent forward: an agent running a newer build than the one
 * this server ships is never downgraded behind the admin's back.
 */
export function isStrictlyNewerAgentVersion(remote: string | null | undefined, current: string | null | undefined): boolean {
  const r = parseAgentSemver(remote);
  const c = parseAgentSemver(current);
  if (r[0] !== c[0]) return r[0] > c[0];
  if (r[1] !== c[1]) return r[1] > c[1];
  return r[2] > c[2];
}

export function isAgentUpdatePolicy(v: unknown): v is AgentUpdatePolicy {
  return typeof v === 'string' && (AGENT_UPDATE_POLICIES as readonly string[]).includes(v);
}

/** Request body value of a policy setter: a policy, or null (= inherit / built-in default). */
export function isAgentUpdatePolicyInput(v: unknown): v is AgentUpdatePolicy | null {
  return v === null || isAgentUpdatePolicy(v);
}

export interface GroupPolicyEntry {
  groupId: number;
  tenantId: number;
  groupName: string | null;
  policy: AgentUpdatePolicy;
}

/**
 * Resolve the effective policy over GLOBAL -> WORKSPACE -> GROUP chain ->
 * AGENT. `groupChain` holds the groups with an explicit policy among the
 * device's group and its ancestors, NEAREST FIRST (closure depth ascending,
 * own group = depth 0), and must already be limited to the device's
 * workspace (see filterChainToTenant).
 *
 *   - 'off' at any level is absolute; the highest level that froze it is
 *     reported: global > workspace > farthest group > agent;
 *   - otherwise the nearest explicit value wins: agent > nearest group >
 *     workspace > global; nothing set = DEFAULT_AGENT_UPDATE_POLICY.
 */
export function resolveAgentUpdatePolicy(
  devicePolicy: AgentUpdatePolicy | null,
  groupChain: readonly GroupPolicyEntry[],
  tenantPolicy: AgentUpdatePolicy | null,
  globalPolicy: AgentUpdatePolicy | null,
): ResolvedAgentUpdatePolicy {
  const group = (e: GroupPolicyEntry, policy: AgentUpdatePolicy): ResolvedAgentUpdatePolicy =>
    ({ policy, source: 'group', sourceGroupId: e.groupId, sourceGroupName: e.groupName });
  // 1. Fleet-wide kill-switch.
  if (globalPolicy === 'off') return { policy: 'off', source: 'global', sourceGroupId: null };
  // 2. Workspace freeze.
  if (tenantPolicy === 'off') return { policy: 'off', source: 'tenant', sourceGroupId: null };
  // 3. 'off' on any group of the chain freezes its sub-tree: the farthest one is reported.
  for (let i = groupChain.length - 1; i >= 0; i--) {
    if (groupChain[i].policy === 'off') return group(groupChain[i], 'off');
  }
  // 4. Device: its own freeze, or its own explicit value.
  if (devicePolicy) return { policy: devicePolicy, source: 'agent', sourceGroupId: null };
  // 5. Nearest explicit value above.
  if (groupChain.length > 0) return group(groupChain[0], groupChain[0].policy);
  if (tenantPolicy) return { policy: tenantPolicy, source: 'tenant', sourceGroupId: null };
  if (globalPolicy) return { policy: globalPolicy, source: 'global', sourceGroupId: null };
  return { policy: DEFAULT_AGENT_UPDATE_POLICY, source: 'default', sourceGroupId: null };
}

/** Only groups of the device's own workspace count (legacy cross-workspace nesting is ignored). */
export function filterChainToTenant(chain: readonly GroupPolicyEntry[] | undefined, tenantId: number): GroupPolicyEntry[] {
  return (chain ?? []).filter((e) => Number(e.tenantId) === Number(tenantId));
}

/** Fail-closed value used when a policy lookup failed. */
export const UNRESOLVED_UPDATE_POLICY: ResolvedAgentUpdatePolicy = Object.freeze({
  policy: 'off',
  source: 'unresolved',
  sourceGroupId: null,
}) as ResolvedAgentUpdatePolicy;

/** Human description of the level that froze updates (409 AGENT_UPDATE_FROZEN message). */
export function describeFrozenBy(r: ResolvedAgentUpdatePolicy): string {
  switch (r.source) {
    case 'global': return 'Agent updates are frozen by the global update policy';
    case 'tenant': return 'Agent updates are frozen by the workspace update policy';
    case 'group': return `Agent updates are frozen by the update policy of group "${r.sourceGroupName ?? r.sourceGroupId}"`;
    case 'agent': return 'Agent updates are frozen on this agent';
    case 'unresolved': return 'The agent update policy could not be resolved; updates are held until it can';
    default: return 'Agent updates are frozen';
  }
}

const AGENT_GROUP_CONFIG_KEYS = [
  'pushIntervalSeconds',
  'heartbeatMonitoring',
  'maxMissedPushes',
  'notificationCooldownSeconds',
  'notificationTypes',
] as const;

/**
 * Import sanitiser for monitor_groups.agent_group_config: known keys only,
 * and updatePolicy kept only when 'manual' or 'off' — an import never turns
 * auto-update on ('auto' and invalid values mean "not set").
 *
 * `existing` is the group's current config when the import updates an
 * existing group: when the import carries no usable policy, the group keeps
 * its own value (replacing an 'off' / 'manual' by "inherit" could let an
 * 'auto' from above through).
 */
export function sanitizeImportedAgentGroupConfig(cfg: unknown, existing?: unknown): Record<string, unknown> | null {
  const parse = (v: unknown): Record<string, unknown> | null => {
    let o = v;
    if (typeof o === 'string') {
      try { o = JSON.parse(o); } catch { return null; }
    }
    return o !== null && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  };
  const src = parse(cfg);
  const prev = parse(existing);
  const out: Record<string, unknown> = {};
  if (src) {
    for (const k of AGENT_GROUP_CONFIG_KEYS) {
      if (k in src) out[k] = src[k];
    }
  }
  if (src && (src.updatePolicy === 'manual' || src.updatePolicy === 'off')) {
    out.updatePolicy = src.updatePolicy;
  } else if (prev && isAgentUpdatePolicy(prev.updatePolicy)) {
    out.updatePolicy = prev.updatePolicy;
  }
  return Object.keys(out).length > 0 ? out : null;
}
