import type { Knex } from 'knex';

/**
 * Agent ↔ agent-monitor reconciliation.
 *
 * Every approved agent_device has a backing monitors row (type='agent'). Its
 * group was stored twice (agent_devices.group_id and monitors.group_id) and
 * nothing kept the two in sync. agent_devices.group_id is now authoritative and
 * agent.service mirrors it to the monitor on every change. This migration:
 *
 *   (0) clears a device group that belongs to ANOTHER workspace (cross-tenant
 *       assignment was possible before the service-level guard), so step (a)
 *       never moves a monitor into another tenant's group — the device ends up
 *       ungrouped in its own workspace;
 *   (0b) a device with no group adopts its agent monitor's group when that
 *       group is in the device's own workspace: the monitor could be moved on
 *       its own from the monitor tree before, and that move must not be undone;
 *   (a) copies agent_devices.group_id onto the device's agent monitor (the
 *       device wins when both are set; the monitors it changes are logged);
 *   (b) drops threshold snapshots: approval used to copy DEFAULT_AGENT_THRESHOLDS
 *       or the group's thresholds into monitors.agent_thresholds, which froze
 *       the group → device cascade. A stored value that is only such a copy
 *       becomes NULL (= inherit live). Explicit per-device overrides stay.
 *
 * Down is a no-op: the drifted / snapshotted values cannot be told apart again.
 */

/**
 * Inline copy of DEFAULT_AGENT_THRESHOLDS (shared/src/types.ts) at the time of
 * writing — migrations must not depend on application code that may change.
 */
const DEFAULT_AGENT_THRESHOLDS: Thresholds = {
  cpu:    { enabled: true,  threshold: 90,         op: '>' },
  memory: { enabled: true,  threshold: 90,         op: '>' },
  disk:   { enabled: true,  threshold: 90,         op: '>' },
  netIn:  { enabled: false, threshold: 12_500_000, op: '>' },
  netOut: { enabled: false, threshold: 12_500_000, op: '>' },
  temp:   { globalEnabled: false, op: '>', threshold: 85, overrides: {} },
};

const METRIC_KEYS = ['cpu', 'memory', 'disk', 'netIn', 'netOut', 'temp'] as const;
type MetricKey = (typeof METRIC_KEYS)[number];
type Thresholds = Partial<Record<MetricKey, unknown>>;

function parseThresholds(value: unknown): Thresholds | null {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Thresholds;
}

/** Metric slots actually set (non-null objects) on a thresholds value. */
function presentSlots(t: Thresholds): MetricKey[] {
  return METRIC_KEYS.filter((k) => t[k] !== null && typeof t[k] === 'object');
}

/** Same per-metric overlay as agent.service (a present slot replaces the one below). */
function overlay(base: Thresholds | null, layer: Thresholds | null): Thresholds | null {
  if (!layer) return base;
  const out: Thresholds = { ...(base ?? {}) };
  for (const k of presentSlots(layer)) out[k] = layer[k];
  return out;
}

/** Structural equality for JSON values (object key order ignored). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * True when every metric slot stored on the monitor equals the candidate's
 * slot. Under the per-metric cascade a slot the monitor does not store is
 * inherited anyway, so a value that matches on all its slots is only a copy.
 */
function isCopyOf(stored: Thresholds, candidate: Thresholds | null): boolean {
  if (!candidate) return false;
  return presentSlots(stored).every(
    (k) => candidate[k] !== null && typeof candidate[k] === 'object' && deepEqual(stored[k], candidate[k]),
  );
}

export async function up(knex: Knex): Promise<void> {
  // (0) Never propagate a cross-workspace device group to the monitor.
  const cleared = await knex.raw(`
    UPDATE agent_devices d
       SET group_id = NULL, updated_at = NOW()
      FROM monitor_groups g
     WHERE d.group_id = g.id
       AND g.tenant_id IS DISTINCT FROM d.tenant_id
    RETURNING d.id, g.id AS old_group_id
  `) as { rows: unknown[] };
  if (cleared.rows.length > 0) {
    console.warn('[056] cleared cross-workspace device groups', cleared.rows);
  }

  // (0b) An ungrouped device adopts its agent monitor's same-tenant group.
  const adopted = await knex.raw(`
    UPDATE agent_devices d
       SET group_id = m.group_id, updated_at = NOW()
      FROM monitors m
      JOIN monitor_groups g ON g.id = m.group_id
     WHERE m.agent_device_id = d.id
       AND m.type = 'agent'
       AND d.group_id IS NULL
       AND m.group_id IS NOT NULL
       AND g.tenant_id = d.tenant_id
    RETURNING d.id, d.group_id
  `) as { rows: unknown[] };
  if (adopted.rows.length > 0) {
    console.warn('[056] ungrouped devices adopted their agent monitor group', adopted.rows);
  }

  // (a) agent_devices.group_id is authoritative.
  const drifted = await knex.raw(`
    SELECT m.id AS monitor_id, m.group_id AS old_group, d.group_id AS new_group
      FROM monitors m
      JOIN agent_devices d ON d.id = m.agent_device_id
     WHERE m.type = 'agent'
       AND m.group_id IS DISTINCT FROM d.group_id
  `) as { rows: unknown[] };
  if (drifted.rows.length > 0) {
    console.warn('[056] agent monitors moved to their device group', drifted.rows);
  }
  await knex.raw(`
    UPDATE monitors m
       SET group_id = d.group_id
      FROM agent_devices d
     WHERE m.agent_device_id = d.id
       AND m.type = 'agent'
       AND m.group_id IS DISTINCT FROM d.group_id
  `);

  // (b) NULL out threshold snapshots.
  const rows = await knex('monitors as m')
    .join('agent_devices as d', 'd.id', 'm.agent_device_id')
    .where('m.type', 'agent')
    .whereNotNull('m.agent_thresholds')
    .select('m.id', 'm.agent_thresholds', 'd.group_id') as Array<{
      id: number;
      agent_thresholds: unknown;
      group_id: number | null;
    }>;
  if (rows.length === 0) return;

  // Direct group thresholds (what approval copied) and the resolved group chain
  // (root → leaf, what a NULL override now inherits), per device group.
  const groupIds = [...new Set(rows.map((r) => r.group_id).filter((g): g is number => g !== null))];
  const directByGroup = new Map<number, Thresholds | null>();
  const chainByGroup = new Map<number, Thresholds | null>();
  if (groupIds.length > 0) {
    const closure = await knex('group_closure as c')
      .join('monitor_groups as g', 'g.id', 'c.ancestor_id')
      .whereIn('c.descendant_id', groupIds)
      .orderBy('c.descendant_id')
      .orderBy('c.depth', 'desc') // root first → direct group last
      .select('c.descendant_id', 'c.depth', 'g.agent_thresholds') as Array<{
        descendant_id: number;
        depth: number;
        agent_thresholds: unknown;
      }>;
    for (const r of closure) {
      const t = parseThresholds(r.agent_thresholds);
      if (Number(r.depth) === 0) directByGroup.set(r.descendant_id, t);
      chainByGroup.set(r.descendant_id, overlay(chainByGroup.get(r.descendant_id) ?? null, t));
    }
  }

  const toClear: number[] = [];
  for (const r of rows) {
    const stored = parseThresholds(r.agent_thresholds);
    // Unreadable or empty values carry no override at all.
    if (!stored || presentSlots(stored).length === 0) {
      toClear.push(r.id);
      continue;
    }
    const candidates: Array<Thresholds | null> = [DEFAULT_AGENT_THRESHOLDS];
    if (r.group_id !== null) {
      candidates.push(directByGroup.get(r.group_id) ?? null);
      candidates.push(overlay(DEFAULT_AGENT_THRESHOLDS, chainByGroup.get(r.group_id) ?? null));
    }
    if (candidates.some((c) => isCopyOf(stored, c))) toClear.push(r.id);
  }

  for (let i = 0; i < toClear.length; i += 500) {
    await knex('monitors')
      .whereIn('id', toClear.slice(i, i + 500))
      .update({ agent_thresholds: null });
  }
}

export async function down(): Promise<void> {
  // Data reconciliation only — the previous (drifted / snapshotted) values
  // cannot be restored.
}
