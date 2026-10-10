import type { IncomingHttpHeaders } from 'http';
import { db } from '../db';
import { logger } from '../utils/logger';
import { auditService } from './audit.service';
import { obligateService } from './obligate.service';

// Obli* device identity v2 — server side (same model as Obliance).
//
// An upgraded agent keeps its legacy UUID (X-Device-UUID / ?uuid=) until we
// acknowledge the switch: X-Obli-Device-Id-Ack on the HTTP push, `identityAck`
// in the WS config reply (the Go agent's heartbeat on its command channel is
// its push). Until then it announces the shared ID it wants (X-Obli-Device-Id)
// and the IDs it used before (X-Obli-Previous-Ids). A claimed row is re-keyed
// ("adopted") only when the presenting key may act for it AND the hostname
// matches: a machine sharing a junk SMBIOS UUID with another must not take
// over the other's history.

export const IDENTITY_HEADER_TARGET = 'x-obli-device-id';
export const IDENTITY_HEADER_PREVIOUS = 'x-obli-previous-ids';
export const IDENTITY_HEADER_ACK = 'X-Obli-Device-Id-Ack';

const ALIASES = 'agent_device_uuid_aliases';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CLAIMS = 8;

export interface IdentityClaim {
  target: string;
  claims: string[];
}

function normUuid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return UUID_RE.test(s) ? s : null;
}

function shortHost(h: unknown): string {
  return typeof h === 'string' ? h.trim().toLowerCase().split('.')[0] : '';
}

/** Key binding: a row bound to another key of the tenant is not ours to act
 *  on (for adoption / aliases only — the ordinary push path is unchanged). */
function keyMayActFor(row: { api_key_id: number | null }, apiKeyId: number): boolean {
  return row.api_key_id == null || row.api_key_id === apiKeyId;
}

/** uuid null = ignore the v2 headers (no ack): the agent stays on its legacy
 *  ID and the push is handled exactly as a v1 push — never worse than v1. */
export type PushIdentityResult = { uuid: string | null; adoptedFrom: string | null; deviceId: number | null };

const IGNORE: PushIdentityResult = { uuid: null, adoptedFrom: null, deviceId: null };

export const deviceIdentityService = {
  /** Reads the v2 headers (Express request or raw upgrade request); null
   *  when absent or malformed (v1 agent). */
  parseHeaders(req: { headers: IncomingHttpHeaders }): IdentityClaim | null {
    const target = normUuid(req.headers[IDENTITY_HEADER_TARGET]);
    if (!target) return null;
    const raw = req.headers[IDENTITY_HEADER_PREVIOUS];
    const list = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).split(',');
    const claims: string[] = [];
    for (const c of list) {
      const u = normUuid(c);
      if (u && u !== target && !claims.includes(u)) claims.push(u);
      if (claims.length >= MAX_CLAIMS) break;
    }
    return { target, claims };
  },

  /**
   * Case 1 only: a row already keyed by the shared ID. 'use' when it is in
   * the key's tenant and passes the key binding, 'refuse' when it exists but
   * not for us (ignore the headers), 'none' when there is no such row.
   * Needs no hostname: used when the command channel opens, before the
   * agent's first heartbeat.
   */
  async resolveExisting(target: string, tenantId: number, apiKeyId: number): Promise<{ verdict: 'use' | 'refuse' | 'none'; deviceId: number | null }> {
    // agent_devices.uuid is unique across tenants.
    const existing = await db('agent_devices').where({ uuid: target })
      .first('id', 'tenant_id', 'api_key_id') as { id: number; tenant_id: number; api_key_id: number | null } | undefined;
    if (!existing) return { verdict: 'none', deviceId: null };
    if (existing.tenant_id !== tenantId) {
      logger.warn({ target, tenantId, ownerTenant: existing.tenant_id }, 'identity v2: shared ID already enrolled in another tenant — switch not acknowledged');
      return { verdict: 'refuse', deviceId: null };
    }
    if (!keyMayActFor(existing, apiKeyId)) {
      logger.warn({ deviceId: existing.id, target, apiKeyId }, 'identity v2: shared ID bound to another API key — switch not acknowledged');
      return { verdict: 'refuse', deviceId: null };
    }
    return { verdict: 'use', deviceId: existing.id };
  },

  /**
   * Decides which UUID a push (HTTP push or WS heartbeat) is about, adopting
   * a claimed row when allowed. The caller then hands `uuid` to
   * agentService.handlePush and acknowledges it.
   */
  async resolvePush(opts: {
    tenantId: number;
    apiKeyId: number;
    /** The X-Device-UUID / ?uuid= the agent presents (its current ID). */
    legacyUuid: string;
    hostname: string | undefined;
    claim: IdentityClaim;
  }): Promise<PushIdentityResult> {
    const { tenantId, apiKeyId, legacyUuid, hostname, claim } = opts;
    const { target, claims } = claim;

    // 1. Already keyed by the shared ID (normal case after the switch, or a
    //    replay after a lost ack).
    const existing = await this.resolveExisting(target, tenantId, apiKeyId);
    if (existing.verdict === 'refuse') return IGNORE;
    if (existing.verdict === 'use') return { uuid: target, adoptedFrom: null, deviceId: existing.deviceId };

    // 2. Adopt the first claimable row.
    const host = shortHost(hostname);
    for (const old of claims) {
      const row = await db('agent_devices').where({ uuid: old, tenant_id: tenantId })
        .first('id', 'api_key_id', 'hostname') as { id: number; api_key_id: number | null; hostname: string } | undefined;
      if (!row) continue;
      if (!keyMayActFor(row, apiKeyId)) {
        logger.warn({ deviceId: row.id, old, target }, 'identity v2: claim refused (API key not bound to the claimed device)');
        await auditService.log({
          tenantId, action: 'device.identity_claim_refused', resourceType: 'agent_device', resourceId: row.id,
          details: { from: old, to: target, reason: 'api_key' },
        });
        continue;
      }
      if (!host || shortHost(row.hostname) !== host) {
        logger.warn({ deviceId: row.id, old, target, rowHost: row.hostname, pushHost: hostname }, 'identity v2: claim refused (hostname differs: another machine with the same legacy ID)');
        await auditService.log({
          tenantId, action: 'device.identity_claim_refused', resourceType: 'agent_device', resourceId: row.id,
          details: { from: old, to: target, reason: 'hostname', hostname: hostname ?? null },
        });
        continue;
      }
      const adopted = await db.transaction(async (trx) => {
        // Re-check under lock: two pushes racing for the same row.
        const locked = await trx('agent_devices').where({ id: row.id, uuid: old }).forUpdate().first('id');
        if (!locked) return false;
        await trx(ALIASES).insert({ device_id: row.id, tenant_id: tenantId, uuid: old, reason: 'migrated' });
        await trx('agent_devices').where({ id: row.id }).update({ uuid: target, updated_at: new Date() });
        return true;
      });
      if (!adopted) continue;
      logger.info({ deviceId: row.id, from: old, to: target }, 'identity v2: agent device re-keyed to the shared ID');
      await auditService.log({
        tenantId, action: 'device.identity_migrated', resourceType: 'agent_device', resourceId: row.id,
        details: { from: old, to: target },
      });
      // The old link stays registered: apps that have not migrated yet still
      // match this device through it.
      void obligateService.registerDeviceLink(target, `/agents/${row.id}`).catch(() => {});
      // Admin lists show the UUID: refresh them (lazy import: agent.service
      // loads the hub, which loads this service).
      void import('./agent.service')
        .then(({ agentService }) => agentService.emitDevicesByIds([row.id]))
        .catch(() => {});
      return { uuid: target, adoptedFrom: old, deviceId: row.id };
    }

    // Tenant transfer in flight: the agent still presents its former key and
    // its row (under its current or a claimed ID) moved to another workspace.
    // A v1 push hands it the new key ('reconfigure'); registering a fresh row
    // under the shared ID here would break that — stay v1 for this push.
    const candidates = [...new Set([normUuid(legacyUuid) ?? legacyUuid, ...claims])];
    const transferring = await db('agent_devices')
      .whereIn('uuid', candidates)
      .whereNot({ tenant_id: tenantId })
      .where({ transfer_from_api_key_id: apiKeyId })
      .first('id');
    if (transferring) return IGNORE;

    // 3. Nothing adoptable: the caller registers a new row under the shared ID.
    return { uuid: target, adoptedFrom: null, deviceId: null };
  },

  /**
   * Device lookup for agent endpoints other than the push: by UUID, then by
   * alias (requests in flight while the agent switches). Same tenant, key
   * binding enforced on the alias path, most recent alias wins. Returns the
   * device's CURRENT uuid, or null. The push NEVER uses this.
   */
  async currentUuidFor(uuid: string, tenantId: number, apiKeyId: number): Promise<string | null> {
    const direct = await db('agent_devices').where({ uuid, tenant_id: tenantId }).first('uuid') as { uuid: string } | undefined;
    if (direct) return direct.uuid;
    const u = normUuid(uuid);
    if (!u) return null;
    const viaAlias = await db(`${ALIASES} as a`)
      .join('agent_devices as d', 'd.id', 'a.device_id')
      .where({ 'a.uuid': u, 'a.tenant_id': tenantId, 'd.tenant_id': tenantId })
      .where(function () { this.whereNull('d.api_key_id').orWhere('d.api_key_id', apiKeyId); })
      .orderBy('a.created_at', 'desc')
      .first('d.uuid') as { uuid: string } | undefined;
    return viaAlias?.uuid ?? null;
  },

  /** Previous UUIDs of a device (newest first). */
  async aliasesOf(deviceId: number): Promise<string[]> {
    const rows = await db(ALIASES).where({ device_id: deviceId })
      .orderBy('created_at', 'desc').select('uuid') as Array<{ uuid: string }>;
    return [...new Set(rows.map((r) => r.uuid))];
  },

  /** Every UUID the device is or was known by: current first. */
  async allUuidsOf(device: { id: number; uuid: string }): Promise<string[]> {
    return [device.uuid, ...(await this.aliasesOf(device.id)).filter((u) => u !== device.uuid)];
  },
};
