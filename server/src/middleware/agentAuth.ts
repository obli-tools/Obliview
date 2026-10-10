import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';

/**
 * agent_api_keys.key is a Postgres `uuid` column: querying it with anything
 * that is not a UUID makes Postgres raise 22P02 (invalid_text_representation).
 * Every caller must check the format first and treat a malformed key exactly
 * like an unknown one.
 */
export const AGENT_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentKeyFormat(value: unknown): value is string {
  return typeof value === 'string' && AGENT_KEY_RE.test(value);
}

// ── Hot-path caching ─────────────────────────────────────────────────────────
// agentAuth runs on EVERY agent push. Without a cache each push costs one
// SELECT plus one UPDATE on agent_api_keys, and a fleet sharing one key
// hammers the SAME row with last_used_at writes (MVCC churn on a tiny table).
//
// 1. The key lookup is cached in memory for 60 s. A deleted key keeps working
//    for at most 60 s, unless invalidateAgentKeyCache() is called on delete.
// 2. last_used_at is written at most once per key per minute: it is a coarse
//    "when did we last hear from this key" indicator, not an audit log.

interface CachedKey { id: number; tenantId: number; at: number }
const KEY_TTL_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;
const keyCache = new Map<string, CachedKey>();
const lastUsedWrittenAt = new Map<number, number>();

/**
 * Drop a key from the cache immediately (call on delete / rotate for an
 * instant cutoff). Without an argument the whole cache is cleared.
 */
export function invalidateAgentKeyCache(apiKey?: string): void {
  if (apiKey) {
    keyCache.delete(apiKey.toLowerCase());
  } else {
    keyCache.clear();
    lastUsedWrittenAt.clear();
  }
}

/**
 * Resolve an agent API key through the 60 s cache.
 * Returns null when the value is missing, malformed or unknown — never throws
 * on bad input (only on a real DB failure).
 */
export async function lookupAgentKey(
  apiKey: unknown,
): Promise<{ id: number; tenantId: number } | null> {
  if (!isAgentKeyFormat(apiKey)) return null;
  const cacheKey = apiKey.toLowerCase();

  const now = Date.now();
  const cached = keyCache.get(cacheKey);
  if (cached && now - cached.at < KEY_TTL_MS) {
    return { id: cached.id, tenantId: cached.tenantId };
  }

  const keyRow = await db('agent_api_keys')
    .where({ key: cacheKey })
    .first('id', 'tenant_id') as { id: number; tenant_id: number } | undefined;
  if (!keyRow) {
    keyCache.delete(cacheKey);
    return null;
  }

  keyCache.set(cacheKey, { id: keyRow.id, tenantId: keyRow.tenant_id, at: now });
  return { id: keyRow.id, tenantId: keyRow.tenant_id };
}

/** Throttled last_used_at write (fire and forget, at most 1 write/min per key). */
function touchLastUsed(keyId: number): void {
  const now = Date.now();
  const lastWrite = lastUsedWrittenAt.get(keyId) ?? 0;
  if (now - lastWrite < LAST_USED_THROTTLE_MS) return;
  lastUsedWrittenAt.set(keyId, now);
  db('agent_api_keys')
    .where({ id: keyId })
    .update({ last_used_at: new Date() })
    .catch(() => {});
}

/**
 * Validates the X-API-Key header for agent push requests.
 * Attaches the api key id and tenant id to req for downstream use.
 */
export async function agentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!isAgentKeyFormat(apiKey)) {
      res.status(401).json({ status: 'unauthorized' });
      return;
    }

    const key = await lookupAgentKey(apiKey);
    if (!key) {
      res.status(401).json({ status: 'unauthorized' });
      return;
    }

    touchLastUsed(key.id);

    (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId = key.id;
    (req as Request & { agentApiKeyId: number; agentTenantId: number }).agentTenantId = key.tenantId;
    next();
  } catch (err) {
    next(err);
  }
}
