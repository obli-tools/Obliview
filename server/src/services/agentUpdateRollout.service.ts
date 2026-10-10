import type { Knex } from 'knex';
import type {
  AgentDevice, AgentUpdateRequestResult, AgentUpdateRolloutState, ResolvedAgentUpdatePolicy,
} from '@obliview/shared';
import { db } from '../db';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { mayOfferAgentUpdate } from './agentNt6.service';
import { getPolicyLookups, resolveWithLookups } from './agentUpdatePolicy.service';
import { isStrictlyNewerAgentVersion } from '../utils/agentUpdate';

// ── Update policy (agentUpdatePolicy.service, migration 068) ────────────────
//
// Each device resolves to 'auto' | 'manual' | 'off' over global -> workspace
// -> group chain -> agent ('off' anywhere is absolute). It plugs in here:
//  - 'manual' (default): this file as described below — admin requests only;
//  - 'auto': the tick queues every eligible device running an OLDER version
//    than the one served (strictly newer, never a downgrade) that has no
//    outstanding request and no failed update (a failure waits for an
//    admin "Retry"), then the normal pace / claim path delivers it;
//  - 'off': request() refuses it (counted as `frozen`; the single-device
//    route answers 409 AGENT_UPDATE_FROZEN), claimForDevice() drops a waiting
//    request instead of delivering it, and the tick drops waiting requests of
//    frozen devices (a level switched to 'off', a device moved into a frozen
//    group). An update already handed to an agent cannot be recalled.
// A failed policy lookup fails closed: nothing is queued or delivered.

// ── Admin-paced agent updates (ported from Obliance agentUpdateRollout) ─────
//
// Agents no longer self-update on every server deploy (the server stopped
// piggybacking `latestVersion` on push responses). An update is an explicit
// admin action — one device, a selection, or "update all outdated agents" —
// and then:
//
//  1. It WAITS for its device: queued on agent_devices.update_requested_at,
//     handed out on the device's next contact (HTTP push, WS heartbeat, WS
//     reconnect probe — every path goes through agentService.handlePush →
//     claimForDevice), or pushed right away by the rollout tick when the
//     device has an open command channel.
//  2. ONE outstanding update per device: update_requested_at is set only when
//     it is NULL, and cleared on success / failure / cancel.
//  3. Decided at DELIVERY time: a device already running the version this
//     server ships gets nothing (the request is closed as up to date), and
//     target_version is refreshed to the current build.
//  4. Paced: at most MAX_PER_WINDOW updates handed out per WINDOW, fleet-wide
//     (every agent downloading a 10-20 MB MSI in the same minute would
//     saturate the uplink). The count lives in agent_devices.update_dispatched_at
//     (time of the last hand-out, kept after success / timeout / cancel so a
//     fast agent does not free its slot early) and the claim runs under a
//     transaction-scoped advisory lock: exact across concurrent pushes and
//     server processes, survives restarts. The window is shared fairly: while
//     several workspaces have updates waiting, each gets an equal share of it
//     and the tick serves them round-robin (one workspace cannot starve the
//     others).
//  5. Never sent to pending / refused / suspended devices, devices being
//     uninstalled or transferred (pending_command set), or proxy stubs (a
//     Docker image, updated by pulling the image).
//
// Outcome: the agent comes back with target_version (or the latest version,
// or any new version) → success (fields cleared, handlePush or the sweep).
// Otherwise it stays in 'updating' (updating_since, set at delivery and again
// by /notifying-update) for a short grace while it keeps pushing on its old
// version, and the stuck-update cleanup (agentService.cleanupStuckUpdating,
// on updating_since or update_sent_at) turns it into update_error.
//
// AGENT_LEGACY_AUTO_UPDATE=true restores the old behaviour (latestVersion +
// autoUpdate:true on every approved push) for operators who want it.

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** Legacy fleet-wide self-update (pre wave 4). Read lazily: env.ts may load after this module. */
export function isLegacyAutoUpdate(): boolean {
  return (process.env.AGENT_LEGACY_AUTO_UPDATE ?? 'false').trim().toLowerCase() === 'true';
}

/** Updates handed out per window, fleet-wide (all tenants). */
export function rolloutMaxPerWindow(): number {
  return envInt('AGENT_UPDATE_ROLLOUT_MAX_PER_WINDOW', 25, 1, 100_000);
}

/** Rolling window of the pace, in ms. */
export function rolloutWindowMs(): number {
  return envInt('AGENT_UPDATE_ROLLOUT_WINDOW_SECONDS', 60, 10, 86_400) * 1000;
}

/** Period of the rollout tick scheduled in index.ts. */
export const UPDATE_ROLLOUT_TICK_MS = 15_000;

/** pg_advisory_xact_lock key of the pace (arbitrary, unique to it). */
const ROLLOUT_LOCK_KEY = 670_067_001;

/** Devices examined per tick for an immediate WS delivery. */
const TICK_BATCH = 500;

/** While the window is known to be full, claims skip the transaction. */
let windowFullUntil = 0;
let tickRunning = false;

/** 'auto' devices are looked for at most this often (or right after a policy change). */
const AUTO_ENQUEUE_INTERVAL_MS = 60_000;
let lastAutoEnqueueAt = 0;

/** Version this server ships (agent/VERSION). agent.service imports this module: lazy require. */
function latestAgentVersion(): string | null {
  try {
    const { agentService } = require('./agent.service') as typeof import('./agent.service');
    const v = agentService.getAgentVersion().version;
    return v && v !== '0.0.0' ? v : null;
  } catch {
    return null;
  }
}

function scoped<Q extends Knex.QueryBuilder>(q: Q, tenantScope: number | null, column = 'tenant_id'): Q {
  if (tenantScope !== null) q.where(column, tenantScope);
  return q;
}

/** Devices that may receive an agent update (approved Go agents, nothing else queued). */
function eligible<Q extends Knex.QueryBuilder>(q: Q): Q {
  q.where('status', 'approved')
    .whereNot('device_type', 'proxy')
    .whereNull('pending_command')
    .whereNull('uninstall_requested_at')
    .whereNull('uninstall_commanded_at');
  return q;
}

function countOf(row: unknown): number {
  const c = (row as { c?: string | number } | undefined)?.c;
  return Number(c ?? 0);
}

const CLEARED_REQUEST = {
  update_requested_at: null,
  update_sent_at: null,
};

/** Error fields cleared once a device is known to run the latest version. */
const CLEARED_ERROR = {
  update_error_at: null,
  update_error: null,
  target_version: null,
};

export type UpdateClaim =
  | { kind: 'claimed'; targetVersion: string }
  | { kind: 'up_to_date' }
  | { kind: 'dropped' };

interface ClaimRow {
  tenant_id: number;
  group_id: number | null;
  update_policy: string | null;
  status: string;
  device_type: string | null;
  pending_command: string | null;
  uninstall_requested_at: Date | null;
  uninstall_commanded_at: Date | null;
  agent_version: string | null;
  update_requested_at: Date | null;
  update_sent_at: Date | null;
}

export const agentUpdateRollout = {
  /**
   * Queue an update for `deviceIds` ('all' = every eligible outdated device)
   * within `tenantScope` (null = every workspace). Returns the counts and the
   * ids whose request changed (for live events).
   */
  async request(
    deviceIds: number[] | 'all',
    tenantScope: number | null,
  ): Promise<AgentUpdateRequestResult & { changedIds: number[]; frozenBy: ResolvedAgentUpdatePolicy | null }> {
    const latest = latestAgentVersion();
    if (!latest) {
      throw new AppError(409, 'Cannot determine the latest agent version (agent/VERSION missing)');
    }

    const q = scoped(db('agent_devices'), tenantScope)
      .select(
        'id', 'tenant_id', 'group_id', 'update_policy', 'status', 'device_type', 'pending_command',
        'uninstall_requested_at', 'uninstall_commanded_at', 'agent_version', 'update_requested_at',
      );
    if (deviceIds === 'all') q.where('status', 'approved');
    else q.whereIn('id', deviceIds);
    const rows = await q as Array<ClaimRow & { id: number }>;
    const lookups = rows.length > 0 ? await getPolicyLookups() : null;

    const result: AgentUpdateRequestResult = {
      targetVersion: latest, queued: 0, alreadyQueued: 0, upToDate: 0, ineligible: 0, frozen: 0,
    };
    // First frozen device's resolution: names the level that froze it.
    let frozenBy: ResolvedAgentUpdatePolicy | null = null;
    const toQueue: number[] = [];
    const upToDateIds: number[] = [];
    for (const r of rows) {
      const isEligible = r.status === 'approved'
        && r.device_type !== 'proxy'
        && !r.pending_command
        && !r.uninstall_requested_at
        && !r.uninstall_commanded_at;
      if (!isEligible) { result.ineligible++; continue; }
      // Update policy 'off' (or an unresolvable policy: fail closed) — refused.
      // "Update all" only counts the outdated ones.
      const policy = resolveWithLookups(
        { tenantId: r.tenant_id, groupId: r.group_id, updatePolicy: r.update_policy },
        lookups,
      ).effective;
      if (policy.policy === 'off') {
        if (deviceIds !== 'all' || r.agent_version !== latest) {
          result.frozen++;
          frozenBy ??= policy;
        }
        continue;
      }
      if (r.update_requested_at) { result.alreadyQueued++; continue; }
      if (r.agent_version === latest) { result.upToDate++; upToDateIds.push(r.id); continue; }
      toQueue.push(r.id);
    }

    const changedIds: number[] = [];
    if (upToDateIds.length > 0) {
      // Already on the latest version: a stale update_error ("Retry update")
      // is cleared rather than left to mask the device's real state.
      const cleared = await db('agent_devices')
        .whereIn('id', upToDateIds)
        .whereNotNull('update_error_at')
        .update({ ...CLEARED_ERROR, updated_at: new Date() })
        .returning('id') as Array<{ id: number }>;
      changedIds.push(...cleared.map((r) => r.id));
    }
    if (toQueue.length > 0) {
      const now = new Date();
      const updated = await db('agent_devices')
        .whereIn('id', toQueue)
        .whereNull('update_requested_at') // one outstanding update per device (race-safe)
        .update({
          update_requested_at: now,
          update_sent_at: null,
          update_error_at: null,
          update_error: null,
          target_version: latest,
          updated_at: now,
        })
        .returning('id') as Array<{ id: number }>;
      const queuedIds = updated.map((r) => r.id);
      changedIds.push(...queuedIds);
      result.queued = queuedIds.length;
      result.alreadyQueued += toQueue.length - queuedIds.length;
    }

    if (result.queued > 0) {
      // Devices with an open command channel start right away (within the pace).
      setImmediate(() => { void this.tick(); });
    }
    return { ...result, changedIds, frozenBy };
  },

  /**
   * Cancel the updates still WAITING (not handed out yet) in the scope —
   * `deviceIds` restricts it to those devices. An update already handed to
   * an agent cannot be recalled. Returns the cancelled device ids.
   */
  async cancelPending(tenantScope: number | null, deviceIds?: number[]): Promise<number[]> {
    const q = scoped(db('agent_devices'), tenantScope)
      .whereNotNull('update_requested_at')
      .whereNull('update_sent_at');
    if (deviceIds) q.whereIn('id', deviceIds);
    const rows = await q
      .update({ ...CLEARED_REQUEST, target_version: null, updated_at: new Date() })
      .returning('id') as Array<{ id: number }>;
    return rows.map((r) => r.id);
  },

  /** Rollout state of a scope (dashboard / "update all" preview). */
  async preview(tenantScope: number | null): Promise<AgentUpdateRolloutState> {
    const latest = latestAgentVersion();
    const targetsQ = eligible(scoped(db('agent_devices'), tenantScope))
      .whereNull('update_requested_at');
    if (latest) {
      targetsQ.where((w) => w.whereNull('agent_version').orWhereNot('agent_version', latest));
    }
    // Outdated candidates split by their effective update policy: frozen
    // ones are not targets; 'auto' ones are queued by the tick on their own.
    const candidatesP = latest
      ? targetsQ.select('tenant_id', 'group_id', 'update_policy') as Promise<Array<Pick<ClaimRow, 'tenant_id' | 'group_id' | 'update_policy'>>>
      : Promise.resolve([] as Array<Pick<ClaimRow, 'tenant_id' | 'group_id' | 'update_policy'>>);
    const [candidates, lookups] = await Promise.all([candidatesP, getPolicyLookups()]);
    let targetCount = 0;
    let frozen = 0;
    let auto = 0;
    for (const r of candidates) {
      const p = resolveWithLookups({ tenantId: r.tenant_id, groupId: r.group_id, updatePolicy: r.update_policy }, lookups).effective.policy;
      if (p === 'off') { frozen++; continue; }
      targetCount++;
      if (p === 'auto') auto++;
    }
    const [queued, inProgress, failed] = await Promise.all([
      scoped(db('agent_devices'), tenantScope)
        .whereNotNull('update_requested_at').whereNull('update_sent_at')
        .count({ c: '*' }).first(),
      scoped(db('agent_devices'), tenantScope)
        .whereNotNull('update_sent_at')
        .count({ c: '*' }).first(),
      scoped(db('agent_devices'), tenantScope)
        .whereNotNull('update_error_at')
        .count({ c: '*' }).first(),
    ]);
    return {
      latestVersion: latest,
      targets: targetCount,
      queued: countOf(queued),
      inProgress: countOf(inProgress),
      failed: countOf(failed),
      frozen,
      auto,
      pace: { maxPerWindow: rolloutMaxPerWindow(), windowSeconds: Math.round(rolloutWindowMs() / 1000) },
      legacyAutoUpdate: isLegacyAutoUpdate(),
    };
  },

  /**
   * Try to hand out the outstanding update of a device (called on each of
   * its contacts while one is waiting, and by the tick). Returns:
   *  - claimed: deliver the 'update' command with targetVersion now
   *    (update_sent_at + updating_since set);
   *  - up_to_date / dropped: the request was closed (already on the
   *    version, or the device is no longer eligible) — emit the device;
   *  - null: nothing to do now (no request, already handed out, pace window
   *    full, or the update cannot be offered to this OS yet).
   */
  async claimForDevice(
    deviceId: number,
    osInfo: Parameters<typeof mayOfferAgentUpdate>[0],
    agentBuild: string | null | undefined,
  ): Promise<UpdateClaim | null> {
    const latest = latestAgentVersion();
    if (!latest) return null;
    // Window known to be full: no transaction (the sweep closes requests
    // that became up to date / ineligible in the meantime).
    if (Date.now() < windowFullUntil) return null;
    // Read before the row lock (a cache miss queries the DB).
    const lookups = await getPolicyLookups();

    return db.transaction(async (trx) => {
      const row = await trx('agent_devices')
        .where({ id: deviceId })
        .select(
          'tenant_id', 'group_id', 'update_policy', 'status', 'device_type', 'pending_command',
          'uninstall_requested_at', 'uninstall_commanded_at', 'agent_version', 'update_requested_at',
          'update_sent_at',
        )
        .forUpdate()
        .first() as ClaimRow | undefined;
      if (!row || !row.update_requested_at || row.update_sent_at) return null;

      const now = new Date();
      if (row.status !== 'approved' || row.device_type === 'proxy'
        || row.uninstall_requested_at || row.uninstall_commanded_at) {
        await trx('agent_devices').where({ id: deviceId })
          .update({ ...CLEARED_REQUEST, target_version: null, updated_at: now });
        return { kind: 'dropped' } as const;
      }
      // Update policy: frozen → the waiting request is dropped; lookup
      // failed → hold it (fail closed) until the policy can be resolved.
      const policy = resolveWithLookups(
        { tenantId: row.tenant_id, groupId: row.group_id, updatePolicy: row.update_policy },
        lookups,
      ).effective;
      if (policy.source === 'unresolved') return null;
      if (policy.policy === 'off') {
        await trx('agent_devices').where({ id: deviceId })
          .update({ ...CLEARED_REQUEST, target_version: null, updated_at: now });
        return { kind: 'dropped' } as const;
      }
      // A transfer / uninstall command goes first; the update waits.
      if (row.pending_command) return null;
      if (row.agent_version === latest) {
        await trx('agent_devices').where({ id: deviceId })
          .update({ ...CLEARED_REQUEST, ...CLEARED_ERROR, updated_at: now });
        return { kind: 'up_to_date' } as const;
      }
      // Pre-nt6-line agent on Windows 7 / 2008 R2 and no nt6 MSI to serve:
      // keep waiting rather than hand it a package msiexec refuses.
      if (!mayOfferAgentUpdate(osInfo ?? null, agentBuild ?? null)) return null;

      if (Date.now() < windowFullUntil) return null;
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [ROLLOUT_LOCK_KEY]);
      const windowMs = rolloutWindowMs();
      const since = new Date(Date.now() - windowMs);
      const maxPerWindow = rolloutMaxPerWindow();
      const recent = await trx('agent_devices')
        .where('update_dispatched_at', '>=', since)
        .count({ c: '*' })
        .min({ oldest: 'update_dispatched_at' })
        .first() as { c: string | number; oldest: Date | null } | undefined;
      if (countOf(recent) >= maxPerWindow) {
        windowFullUntil = recent?.oldest
          ? new Date(recent.oldest).getTime() + windowMs
          : Date.now() + 5_000;
        return null;
      }

      // Fair share of the window between the workspaces that are rolling out
      // (an update waiting, or one handed out in the window). A workspace
      // over its share yields while another one has an update waiting. The
      // global window is not full: windowFullUntil is left alone so the
      // other workspaces can still claim the remaining slots.
      const active = await trx('agent_devices')
        .where((w) => w
          .where((q) => q.whereNotNull('update_requested_at').whereNull('update_sent_at'))
          .orWhere('update_dispatched_at', '>=', since))
        .countDistinct({ c: 'tenant_id' })
        .first();
      const activeTenants = Math.max(1, countOf(active));
      if (activeTenants > 1) {
        const share = Math.max(1, Math.floor(maxPerWindow / activeTenants));
        const mine = await trx('agent_devices')
          .where('tenant_id', row.tenant_id)
          .where('update_dispatched_at', '>=', since)
          .count({ c: '*' })
          .first();
        if (countOf(mine) >= share) {
          const otherWaiting = await trx('agent_devices')
            .whereNot('tenant_id', row.tenant_id)
            .whereNotNull('update_requested_at')
            .whereNull('update_sent_at')
            .select('id')
            .first();
          if (otherWaiting) return null;
        }
      }

      await trx('agent_devices').where({ id: deviceId }).update({
        update_sent_at: now,
        update_dispatched_at: now,
        updating_since: now,
        target_version: latest,
        update_error_at: null,
        update_error: null,
        updated_at: now,
      });
      return { kind: 'claimed', targetVersion: latest } as const;
    });
  },

  /** A claimed update could not be written to the agent: back to waiting. */
  async unclaim(deviceId: number): Promise<void> {
    await db('agent_devices')
      .where({ id: deviceId })
      .whereNotNull('update_sent_at')
      // The command never reached the agent: it does not use up a pace slot.
      .update({ update_sent_at: null, updating_since: null, update_dispatched_at: null, updated_at: new Date() });
    windowFullUntil = 0;
  },

  /**
   * Housekeeping (each tick):
   *  - outstanding updates whose device already runs target_version → done;
   *  - waiting updates of devices that became ineligible (suspended, refused,
   *    uninstalling, transferred…) → dropped.
   * Returns the ids whose state changed.
   */
  async sweep(): Promise<number[]> {
    const now = new Date();
    const done = await db('agent_devices')
      .whereNotNull('update_requested_at')
      .whereNotNull('target_version')
      .whereRaw('agent_version = target_version')
      .update({ ...CLEARED_REQUEST, target_version: null, updating_since: null, updated_at: now })
      .returning('id') as Array<{ id: number }>;

    const dropped = await db('agent_devices')
      .whereNotNull('update_requested_at')
      .whereNull('update_sent_at')
      .where((w) => w
        .whereNot('status', 'approved')
        .orWhere('device_type', 'proxy')
        .orWhereNotNull('uninstall_requested_at')
        .orWhereNotNull('uninstall_commanded_at'))
      .update({ ...CLEARED_REQUEST, target_version: null, updated_at: now })
      .returning('id') as Array<{ id: number }>;

    // Failed updates of devices that run the latest version since (installed
    // by hand, or a later rollout) are no longer failures.
    const latest = latestAgentVersion();
    const recovered = latest
      ? await db('agent_devices')
        .whereNotNull('update_error_at')
        .whereNull('update_requested_at')
        .where('agent_version', latest)
        .update({ ...CLEARED_ERROR, updated_at: now })
        .returning('id') as Array<{ id: number }>
      : [];

    return [...done.map((r) => r.id), ...dropped.map((r) => r.id), ...recovered.map((r) => r.id)];
  },

  /**
   * Rollout tick (scheduled in index.ts): sweep, then hand out waiting
   * updates to devices with an open command channel, oldest request first,
   * within the pace. Devices without a channel get theirs on their next push.
   */
  /**
   * Waiting (not handed out) requests of devices whose update policy is now
   * 'off' are dropped: a level switched to 'off' on another process, a device
   * moved into a frozen group, a frozen import… A failed lookup drops nothing.
   */
  async dropFrozenWaiting(): Promise<number[]> {
    const waiting = await db('agent_devices')
      .whereNotNull('update_requested_at')
      .whereNull('update_sent_at')
      .select('id', 'tenant_id', 'group_id', 'update_policy') as Array<
        { id: number } & Pick<ClaimRow, 'tenant_id' | 'group_id' | 'update_policy'>>;
    if (waiting.length === 0) return [];
    const lookups = await getPolicyLookups();
    if (!lookups) return [];
    const frozenIds = waiting
      .filter((r) => resolveWithLookups(
        { tenantId: r.tenant_id, groupId: r.group_id, updatePolicy: r.update_policy },
        lookups,
      ).effective.policy === 'off')
      .map((r) => r.id);
    if (frozenIds.length === 0) return [];
    return this.cancelPending(null, frozenIds);
  },

  /**
   * Update policy 'auto': queue every eligible device that runs an older
   * version than the one served (strictly older — never a downgrade), has no
   * outstanding request and no failed update (a failure waits for an admin
   * "Retry update", so a broken build is not retried forever), and can be
   * offered the update on its OS (nt6 line). Delivery then follows the normal
   * pace. Skipped while AGENT_LEGACY_AUTO_UPDATE is on (agents self-update).
   * Returns the queued ids.
   */
  async autoEnqueue(): Promise<number[]> {
    const latest = latestAgentVersion();
    if (!latest || isLegacyAutoUpdate()) return [];
    const rows = await eligible(db('agent_devices'))
      .whereNull('update_requested_at')
      .whereNull('update_sent_at')
      .whereNull('update_error_at')
      .whereNull('updating_since') // already updating (legacy / manual path)
      .whereNotNull('agent_version')
      .whereNot('agent_version', latest)
      .select('id', 'tenant_id', 'group_id', 'update_policy', 'agent_version', 'os_info') as Array<
        { id: number; os_info: unknown } & Pick<ClaimRow, 'tenant_id' | 'group_id' | 'update_policy' | 'agent_version'>>;
    if (rows.length === 0) return [];
    const lookups = await getPolicyLookups();
    if (!lookups) return [];
    const ids = rows
      .filter((r) => isStrictlyNewerAgentVersion(latest, r.agent_version))
      .filter((r) => resolveWithLookups(
        { tenantId: r.tenant_id, groupId: r.group_id, updatePolicy: r.update_policy },
        lookups,
      ).effective.policy === 'auto')
      .filter((r) => {
        const osInfo = (typeof r.os_info === 'string' ? safeJson(r.os_info) : r.os_info) as AgentDevice['osInfo'];
        return mayOfferAgentUpdate(osInfo, null);
      })
      .map((r) => r.id);
    if (ids.length === 0) return [];
    const now = new Date();
    const queued = await eligible(db('agent_devices'))
      .whereIn('id', ids)
      .whereNull('update_requested_at') // one outstanding update per device (race-safe)
      .whereNull('update_error_at')
      .update({
        update_requested_at: now,
        update_sent_at: null,
        target_version: latest,
        updated_at: now,
      })
      .returning('id') as Array<{ id: number }>;
    if (queued.length > 0) {
      logger.info({ count: queued.length, targetVersion: latest }, 'Agent update policy auto: updates queued');
    }
    return queued.map((r) => r.id);
  },

  /** A policy changed: look for 'auto' devices on the next tick, and run it now. */
  nudge(): void {
    lastAutoEnqueueAt = 0;
    setImmediate(() => { void this.tick(); });
  },

  async tick(): Promise<void> {
    if (tickRunning) return;
    tickRunning = true;
    const changed = new Set<number>();
    try {
      for (const id of await this.sweep()) changed.add(id);
      for (const id of await this.dropFrozenWaiting()) changed.add(id);
      if (Date.now() - lastAutoEnqueueAt >= AUTO_ENQUEUE_INTERVAL_MS) {
        lastAutoEnqueueAt = Date.now();
        for (const id of await this.autoEnqueue()) changed.add(id);
      }

      if (Date.now() >= windowFullUntil) {
        const { agentHub } = require('./agentHub.service') as typeof import('./agentHub.service');
        // Round-robin across workspaces: each workspace's oldest waiting
        // request is tried before anyone's second.
        const waiting = eligible(db('agent_devices'))
          .whereNotNull('update_requested_at')
          .whereNull('update_sent_at')
          .select(
            'id', 'uuid', 'os_info', 'update_requested_at',
            db.raw('ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY update_requested_at, id) AS rn'),
          )
          .as('w');
        const rows = await db.from(waiting)
          .orderBy('rn')
          .orderBy('update_requested_at')
          .orderBy('id')
          .limit(TICK_BATCH)
          .select('id', 'uuid', 'os_info') as Array<{ id: number; uuid: string; os_info: unknown }>;

        for (const r of rows) {
          if (Date.now() < windowFullUntil) break;
          if (!agentHub.isConnected(r.uuid)) continue;
          const osInfo = (typeof r.os_info === 'string' ? safeJson(r.os_info) : r.os_info) as AgentDevice['osInfo'];
          const claim = await this.claimForDevice(r.id, osInfo, null);
          if (!claim) continue;
          changed.add(r.id);
          if (claim.kind !== 'claimed') continue;
          const sent = agentHub.pushCommand(r.uuid, 'update', { targetVersion: claim.targetVersion });
          if (!sent) await this.unclaim(r.id);
        }
      }
    } catch (err) {
      logger.error(err, 'Agent update rollout tick failed');
    } finally {
      tickRunning = false;
    }

    if (changed.size > 0) {
      try {
        const { agentService } = require('./agent.service') as typeof import('./agent.service');
        await agentService.emitDevicesByIds([...changed]);
      } catch (err) {
        logger.error(err, 'Agent update rollout: failed to emit device updates');
      }
    }
  },

  /** Tests only. */
  __resetForTests(): void {
    windowFullUntil = 0;
    tickRunning = false;
    lastAutoEnqueueAt = 0;
  },
};

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
