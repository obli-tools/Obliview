import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { agentService } from '../services/agent.service';
import { agentUpdateRollout } from '../services/agentUpdateRollout.service';
import { auditService } from '../services/audit.service';
import { agentHub } from '../services/agentHub.service';
import { deviceIdentityService, IDENTITY_HEADER_ACK } from '../services/deviceIdentity.service';
import type { AgentDevice, AgentRuntimeStatus, AgentThresholds } from '@obliview/shared';
import { AGENT_COMMANDS, AGENT_RUNTIME_STATUSES } from '@obliview/shared';
import { getEffectiveTenantScope } from '../utils/tenantScope';
import { logger } from '../utils/logger';
import { lookupAgentKey, invalidateAgentKeyCache } from '../middleware/agentAuth';
import { chooseAgentDownload } from '../services/agentNt6.service';
import { permissionService } from '../services/permission.service';
import { canManageAgents } from '../middleware/agentRbac';
import { describeFrozenBy, isAgentUpdatePolicyInput } from '../utils/agentUpdate';

// All handlers below are wrapped with asyncHandler in agent.routes.ts, so a
// rejected promise reaches the global errorHandler instead of crashing the
// process (Express 4 does not catch async rejections on its own).

const MAX_PG_INT = 2_147_483_647;

/**
 * Parse a numeric route param (`:id`). Answers 400 and returns null when it
 * is not a positive integer that fits in a Postgres `integer` column — a
 * non-numeric id would otherwise reach knex and make Postgres raise 22P02.
 */
function parseIdParam(req: Request, res: Response, param = 'id'): number | null {
  const raw = req.params[param];
  const id = /^\d+$/.test(raw ?? '') ? parseInt(raw, 10) : NaN;
  if (Number.isNaN(id) || id <= 0 || id > MAX_PG_INT) {
    res.status(400).json({ success: false, error: `Invalid ${param}` });
    return null;
  }
  return id;
}

/** True when `ids` is a non-empty array of positive integers. */
function isIdArray(ids: unknown): ids is number[] {
  return Array.isArray(ids)
    && ids.length > 0
    && ids.every((v) => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_PG_INT);
}

// ── Push endpoint (called by agent) ──────────────────────────────────────────

export async function agentPush(req: Request, res: Response): Promise<void> {
  try {
    // agentApiKeyId and agentTenantId are set by agentAuth middleware
    const agentApiKeyId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId;
    const agentTenantId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentTenantId;
    const deviceUuid = req.headers['x-device-uuid'] as string | undefined;

    if (!deviceUuid) {
      res.status(400).json({ error: 'X-Device-UUID header required' });
      return;
    }

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '';

    // Identity v2 (shared Obli* device ID): an
    // upgraded agent announces the shared Obli* device ID it wants and the IDs
    // it used before. The row is re-keyed (or created) under the shared ID and
    // the ack header tells the agent to switch. Without the headers (v1 agent)
    // nothing changes — and the push never falls back to an alias: a v1 push
    // under a migrated UUID comes from another machine and gets its own row.
    let pushUuid = deviceUuid;
    const identityClaim = deviceIdentityService.parseHeaders(req);
    if (identityClaim) {
      const ident = await deviceIdentityService.resolvePush({
        tenantId: agentTenantId,
        apiKeyId: agentApiKeyId,
        legacyUuid: deviceUuid,
        hostname: typeof req.body?.hostname === 'string' ? req.body.hostname : undefined,
        claim: identityClaim,
      });
      if (ident.uuid) {
        pushUuid = ident.uuid;
        res.setHeader(IDENTITY_HEADER_ACK, ident.uuid);
        // A command channel still filed under the old ID redials (under the
        // new one once its agent switched).
        if (ident.adoptedFrom) agentHub.closeRekeyedChannel(ident.adoptedFrom);
      }
    }

    const result = await agentService.handlePush(
      agentApiKeyId,
      agentTenantId,
      pushUuid,
      clientIp,
      req.body,
    );

    const statusCode =
      result.status === 'ok' ? 200
      : result.status === 'pending' ? 202
      : result.status === 'conflict' ? 409 // UUID registered in another workspace
      : 401;
    res.status(statusCode).json(result);
  } catch (error) {
    logger.error(error, 'Agent push failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Pre-update notification (called by agent before self-updating) ────────────

export async function notifyingUpdate(req: Request, res: Response): Promise<void> {
  try {
    const agentApiKeyId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentApiKeyId;
    const agentTenantId = (req as unknown as { agentApiKeyId: number; agentTenantId: number }).agentTenantId;
    const deviceUuid = req.headers['x-device-uuid'] as string | undefined;
    if (!deviceUuid) {
      res.status(400).json({ error: 'X-Device-UUID header required' });
      return;
    }
    // Identify device — must belong to the authenticated API key. Identity
    // v2: an agent switching to the shared ID may still call in with its
    // previous one (alias lookup, same tenant, key binding enforced).
    const currentUuid = await deviceIdentityService.currentUuidFor(deviceUuid, agentTenantId, agentApiKeyId);
    const device = currentUuid ? await agentService.getDeviceByUuid(currentUuid, agentTenantId) : null;
    if (!device || device.apiKeyId !== agentApiKeyId) {
      res.status(404).json({ error: 'Device not found' });
      return;
    }
    await agentService.setDeviceUpdating(device.id, agentTenantId);
    res.json({ ok: true });
  } catch (error) {
    logger.error(error, 'Agent notifying-update failed');
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ── Public: version + download ──────────────────────────────────────────────

export function agentVersion(_req: Request, res: Response): void {
  try {
    const info = agentService.getAgentVersion();
    res.json(info);
  } catch {
    res.status(503).json({ error: 'Agent version info unavailable' });
  }
}

export function desktopVersion(_req: Request, res: Response): void {
  try {
    const info = agentService.getDesktopVersion();
    res.json(info);
  } catch {
    res.status(503).json({ error: 'Desktop version info unavailable' });
  }
}

const AGENT_DIST_DIR = path.resolve(__dirname, '../../../../agent/dist');
const WIZARD_FILE = 'obliview-install-wizard.exe';
const NT6_MSI_FILE = 'obliview-agent-nt6.msi';

const ALLOWED_AGENT_BINARIES: Record<string, string> = {
  // Windows: full MSI installer (handles service, PawnIO driver, etc.)
  'obliview-agent.msi':             'obliview-agent.msi',
  // Windows NT 6.x (7 SP1 / 8.1 / Server 2008 R2 / 2012 / 2012 R2): the same
  // agent built with Go 1.20 ("nt6" build line, agent/go120.mod). The modern
  // MSI refuses Windows 7 / 2008 R2; the nt6 agent self-updates to this file only
  // (agent/build_flavor.go). Same UpgradeCode: upgrades a modern install in place.
  [NT6_MSI_FILE]:                   NT6_MSI_FILE,
  // Windows: bare exe (kept for manual / legacy use)
  'obliview-agent.exe':             'obliview-agent.exe',
  'obliview-agent-linux-amd64':     'obliview-agent-linux-amd64',
  'obliview-agent-linux-arm64':     'obliview-agent-linux-arm64',
  'obliview-agent-darwin-amd64':    'obliview-agent-darwin-amd64',
  'obliview-agent-darwin-arm64':    'obliview-agent-darwin-arm64',
  'obliview-agent-freebsd-amd64':   'obliview-agent-freebsd-amd64',
  // Manual-install Wizard template (no config tail). Only produced by
  // the release pipeline: the client probes it (HEAD) to decide whether to
  // offer the 'Manual / Wizard' option, so a missing file answers
  // 404 {error:'not_built'}.
  [WIZARD_FILE]:                    WIZARD_FILE,
};

// ── SHA-256 of served dist files ─────────────────────────────────────────────
// The agent verifies the X-Content-SHA256 + Content-Length headers before it
// installs an update. The hash is computed once per file content (streamed,
// cached on path + mtime + size), and concurrent requests for the same file
// (a fleet updating at once) share one computation.

interface FileHashEntry { mtimeMs: number; size: number; sha256: string }
const fileHashCache = new Map<string, FileHashEntry>();
const fileHashInFlight = new Map<string, Promise<string>>();

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function getFileSha256(filePath: string, stat: fs.Stats): Promise<string> {
  const cached = fileHashCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.sha256;
  }
  const flightKey = `${filePath}|${stat.mtimeMs}|${stat.size}`;
  let pending = fileHashInFlight.get(flightKey);
  if (!pending) {
    pending = hashFile(filePath)
      .then((sha256) => {
        fileHashCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 });
        return sha256;
      })
      .finally(() => { fileHashInFlight.delete(flightKey); });
    fileHashInFlight.set(flightKey, pending);
  }
  return pending;
}

/**
 * Send a file from agent/dist with integrity headers (X-Content-SHA256,
 * Content-Length). Returns false (and sends nothing) when the file is missing,
 * so the caller can choose its own 404 body.
 */
async function sendDistFile(
  res: Response,
  fileName: string,
  downloadName: string,
  contentType: string,
): Promise<boolean> {
  const filePath = path.join(AGENT_DIST_DIR, fileName);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const sha256 = await getFileSha256(filePath, stat);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('X-Content-SHA256', sha256);
  res.sendFile(filePath, (err) => {
    if (!err) return;
    if (!res.headersSent) {
      // File replaced or removed between stat and send.
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Length');
      res.removeHeader('X-Content-SHA256');
      res.status(404).json({ error: 'File not available' });
      return;
    }
    if ((err as NodeJS.ErrnoException).code !== 'ECONNABORTED') {
      logger.warn({ err, file: fileName }, 'Agent dist file download interrupted');
    }
  });
  return true;
}

export async function agentDownload(req: Request, res: Response): Promise<void> {
  const { filename } = req.params;

  const binaryName = Object.prototype.hasOwnProperty.call(ALLOWED_AGENT_BINARIES, filename)
    ? ALLOWED_AGENT_BINARIES[filename]
    : undefined;
  if (!binaryName) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Pre-nt6-line agents on Windows NT 6.x ask for the modern MSI: answer
  // with the nt6 MSI (same UpgradeCode, in-place upgrade), or 404 rather
  // than a package msiexec would refuse (services/agentNt6.service.ts).
  const clientIp =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    '';
  const choice = chooseAgentDownload(binaryName, clientIp);
  if (choice.file === null) {
    logger.warn({ clientIp, reason: choice.reason }, 'Agent MSI download refused: Windows 7 / 2008 R2 agent and no nt6 MSI to serve');
    res.status(404).json({ error: 'Agent binary not available' });
    return;
  }
  if (choice.substituted) {
    logger.info({ clientIp, requested: binaryName, served: choice.file }, 'Agent MSI download: nt6 MSI served to a Windows NT 6.x agent');
  }
  const servedName = choice.file;
  const sent = await sendDistFile(res, servedName, servedName, 'application/octet-stream');
  if (!sent) {
    res.status(404).json(
      binaryName === WIZARD_FILE ? { error: 'not_built' } : { error: 'Agent binary not available' },
    );
  }
}

// ── Public: installer scripts ───────────────────────────────────────────────
// These endpoints are unauthenticated by design (`curl ... | bash`), so the
// served script must never contain attacker-controlled text: the key must be
// a real, existing agent API key (UUID format, checked against the DB through
// the agentAuth cache) and the server URL is rebuilt from a validated host.

// hostname[:port] or [ipv6][:port] — no quotes, spaces, '$', '`' or ';'.
const SAFE_HOST_RE = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** Public base URL of this server for injection into scripts, or null when the Host header is not a plain hostname. */
function safeServerUrl(req: Request): string | null {
  const host = req.get('host') ?? '';
  if (!SAFE_HOST_RE.test(host)) return null;
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

async function serveInstallerScript(
  req: Request,
  res: Response,
  scriptFile: string,
  downloadName: string,
  notAvailableMessage: string,
): Promise<void> {
  const rawKey = req.query.key;
  const key = typeof rawKey === 'string' ? await lookupAgentKey(rawKey) : null;
  if (!key) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const serverUrl = safeServerUrl(req);
  if (!serverUrl) {
    res.status(400).json({ error: 'Invalid Host header' });
    return;
  }

  const scriptPath = path.resolve(__dirname, '../../../../agent/installer', scriptFile);
  if (!fs.existsSync(scriptPath)) {
    res.status(404).json({ error: notAvailableMessage });
    return;
  }

  // Only the first occurrence of each placeholder is replaced: the scripts
  // compare against the sentinel later on ("[ "$API_KEY" = "__API_KEY__" ]").
  // Replacer functions so '$' sequences are never interpreted.
  const apiKey = (rawKey as string).toLowerCase();
  const script = fs.readFileSync(scriptPath, 'utf-8')
    .replace('__SERVER_URL__', () => serverUrl)
    .replace('__API_KEY__', () => apiKey);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
  res.send(script);
}

export async function agentInstallerLinux(req: Request, res: Response): Promise<void> {
  await serveInstallerScript(req, res, 'install.sh', 'install.sh', 'Installer not available');
}

export async function agentInstallerMacos(req: Request, res: Response): Promise<void> {
  await serveInstallerScript(req, res, 'install-macos.sh', 'install-macos.sh', 'macOS installer not available');
}

export async function agentInstallerFreebsd(req: Request, res: Response): Promise<void> {
  await serveInstallerScript(req, res, 'install-freebsd.sh', 'install-freebsd.sh', 'FreeBSD installer not available');
}

export async function agentInstallerWindowsMsi(_req: Request, res: Response): Promise<void> {
  const sent = await sendDistFile(res, 'obliview-agent.msi', 'obliview-agent.msi', 'application/x-msi');
  if (!sent) {
    res.status(404).json({ error: 'MSI installer not available (not yet built)' });
  }
}

/**
 * Windows NT 6.x MSI (7 SP1 / 8.1 / Server 2008 R2 / 2012 / 2012 R2) for the
 * Add Agent command — same integrity headers as every agent/dist download.
 */
export async function agentInstallerWindowsMsiNt6(_req: Request, res: Response): Promise<void> {
  const sent = await sendDistFile(res, NT6_MSI_FILE, NT6_MSI_FILE, 'application/x-msi');
  if (!sent) {
    res.status(404).json({ error: 'Windows 7 / 8.1 / 2008 R2 / 2012 MSI installer not available (not yet built)' });
  }
}

/**
 * Serve the manual-install Wizard with a config tail blob appended.
 * Layout: <static wizard.exe bytes><JSON config><magic "OBLI_CFG" (8B)><uint32 LE length>
 * The wizard reads its own .exe at startup and unwinds the tail to pre-fill its
 * server URL + API key fields. The MSI inside stays Authenticode-signed —
 * only the outer wizard wrapper has its signature broken by the tail append.
 */
export async function agentInstallerWizard(req: Request, res: Response): Promise<void> {
  try {
    const keyIdRaw = req.query.keyId as string | undefined;
    const keyId = Number(keyIdRaw);
    if (!keyIdRaw || !Number.isFinite(keyId)) {
      res.status(400).json({ error: 'keyId query param required' });
      return;
    }

    const tenantScope = getEffectiveTenantScope(req);
    const keys = await agentService.listKeys(tenantScope);
    const key = keys.find((k) => k.id === keyId);
    if (!key) {
      res.status(404).json({ error: 'API key not found' });
      return;
    }

    const wizardPath = path.join(AGENT_DIST_DIR, WIZARD_FILE);
    if (!fs.existsSync(wizardPath)) {
      res.status(404).json({ error: 'not_built' });
      return;
    }

    const serverUrl = (req.query.server as string | undefined)
      || `${(req.headers['x-forwarded-proto'] as string | undefined) || req.protocol}://${(req.headers['x-forwarded-host'] as string | undefined) || req.get('host')}`;

    const cfg = JSON.stringify({ serverUrl, apiKey: key.key });
    const cfgBuf = Buffer.from(cfg, 'utf8');
    const magic = Buffer.from('OBLI_CFG', 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(cfgBuf.length, 0);
    const tail = Buffer.concat([cfgBuf, magic, lenBuf]);

    const exe = fs.readFileSync(wizardPath);
    const out = Buffer.concat([exe, tail]);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${WIZARD_FILE}"`);
    res.setHeader('Content-Length', out.length.toString());
    res.send(out);
  } catch (err) {
    res.status(500).json({ error: 'Failed to build wizard', detail: (err as Error).message });
  }
}

// ── Admin: API Keys ──────────────────────────────────────────────────────────

export async function listKeys(req: Request, res: Response): Promise<void> {
  // `?tenantId=X` lets a platform admin read another workspace's keys (the
  // transfer modal's target-key picker); everyone else stays on their scope.
  let scope = getEffectiveTenantScope(req);
  const rawTenant = req.query.tenantId;
  if (req.session.role === 'admin' && typeof rawTenant === 'string' && /^\d+$/.test(rawTenant)) {
    const requested = Number(rawTenant);
    if (requested > 0 && requested <= MAX_PG_INT) scope = requested;
  }
  const keys = await agentService.listKeys(scope);
  res.json({ success: true, data: keys });
}

/** `defaultGroupId` of a key body: number, null (clear) or undefined (absent). Answers 400 on garbage. */
function parseDefaultGroupId(body: Record<string, unknown>, res: Response): number | null | undefined | false {
  if (!('defaultGroupId' in body) || body.defaultGroupId === undefined) return undefined;
  const v = body.defaultGroupId;
  if (v === null) return null;
  if (Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_PG_INT) return v as number;
  res.status(400).json({ success: false, error: 'Invalid defaultGroupId' });
  return false;
}

export async function createKey(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { name } = body;
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ success: false, error: 'Name is required' });
    return;
  }
  const defaultGroupId = parseDefaultGroupId(body, res);
  if (defaultGroupId === false) return;
  const userId = req.session?.userId ?? 0;
  const key = await agentService.createKey(name.trim(), userId, req.tenantId, defaultGroupId ?? null);
  await auditService.logReq(req, 'agent_key.created', {
    resourceType: 'agent_key', resourceId: key.id,
    details: { name: key.name, defaultGroupId: key.defaultGroupId },
  });
  res.status(201).json({ success: true, data: key });
}

/**
 * PUT /agent/keys/:id {name?, defaultGroupId?} — rename a key and / or set
 * the group its devices are approved into by default (a group of the key's
 * own workspace, null = none).
 */
export async function updateKey(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  let name: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ success: false, error: 'Name must be a non-empty string' });
      return;
    }
    name = body.name.trim();
  }
  const defaultGroupId = parseDefaultGroupId(body, res);
  if (defaultGroupId === false) return;
  const key = await agentService.updateKey(id, { name, defaultGroupId }, getEffectiveTenantScope(req));
  if (!key) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }
  await auditService.logReq(req, 'agent_key.updated', {
    resourceType: 'agent_key', resourceId: id,
    details: {
      ...(name !== undefined ? { name } : {}),
      ...(defaultGroupId !== undefined ? { defaultGroupId } : {}),
    },
  });
  res.json({ success: true, data: key });
}

export async function deleteKey(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const ok = await agentService.deleteKey(id, getEffectiveTenantScope(req));
  if (!ok) {
    res.status(404).json({ success: false, error: 'API key not found' });
    return;
  }
  await auditService.logReq(req, 'agent_key.deleted', { resourceType: 'agent_key', resourceId: id });
  // The key string is not known here: drop the whole cache so the deleted key
  // stops authenticating immediately (the others are re-read on next use).
  invalidateAgentKeyCache();
  res.json({ success: true });
}

// ── Devices ──────────────────────────────────────────────────────────────────
// Read/write access to a single device is checked by requireAgentDeviceRead /
// requireAgentDeviceWrite (middleware/agentRbac.ts), which also set
// req.agentAccess. Every by-id service call is still restricted to the
// caller's tenant scope (null = God View) and answers 404 on a miss.

/**
 * PATCH /devices/:id fields that change the device lifecycle or its
 * monitoring behaviour: they need agents.manage on top of write access.
 * Write access alone covers name, notes, displayConfig, sensorDisplayNames
 * and agentThresholds.
 */
const MANAGE_ONLY_FIELDS = [
  'status',
  'groupId',
  'overrideGroupSettings',
  'checkIntervalSeconds',
  'heartbeatMonitoring',
  'notificationCooldownSeconds',
  'notificationTypes',
  'updatePolicy',
] as const;

export async function getDevice(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const raw = await agentService.getDeviceById(id, getEffectiveTenantScope(req));
  if (!raw) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  // runtimeStatus + inMaintenance (approval state stays in status / approvalStatus).
  const [device] = await agentService.withRuntime([raw]);
  // `access` tells the page which controls to offer; every write is
  // re-checked server-side anyway.
  const access = req.agentAccess;
  res.json({
    success: true,
    data: {
      ...device,
      monitorId: access?.monitorId ?? null,
      access: {
        canWrite: access?.canWrite ?? false,
        canManage: access?.canManage ?? false,
      },
    },
  });
}

/**
 * GET /agent/devices/:id/thresholds-resolved
 * Effective thresholds of a device: DEFAULT <- group chain <- device override.
 * Returns { resolved, override, groupResolved } (override = null when the
 * device inherits everything).
 */
export async function getDeviceResolvedThresholds(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const data = await agentService.resolveDeviceThresholds(id);
  if (!data) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  res.json({ success: true, data });
}

export async function listDevices(req: Request, res: Response): Promise<void> {
  const status = req.query.status as string | undefined;
  const validStatuses = ['pending', 'approved', 'refused', 'suspended'];
  let devices = await agentService.listDevices(
    getEffectiveTenantScope(req),
    validStatuses.includes(status ?? '') ? (status as 'pending' | 'approved' | 'refused' | 'suspended') : undefined,
  );

  // Without agents.manage: only the devices whose agent monitor the user can
  // see through their teams (pending / refused devices have none).
  if (!(await canManageAgents(req))) {
    const visible = await permissionService.getVisibleMonitorIds(req.session.userId!, false);
    if (visible !== 'all') {
      devices = await agentService.filterDevicesByVisibleMonitors(devices, visible);
    }
  }

  // Runtime state in one batched pass: agent monitor statuses (one query)
  // and maintenance (a single ~3-query resolution — never per device, the
  // N+1 exploded in God View with hundreds of devices).
  let enriched = await agentService.withRuntime(devices);

  // ?runtimeStatus=online,offline,… filters on the derived runtime state.
  const rawRuntime = req.query.runtimeStatus;
  if (typeof rawRuntime === 'string' && rawRuntime.trim()) {
    const wanted = new Set(
      rawRuntime.split(',').map((v) => v.trim())
        .filter((v): v is AgentRuntimeStatus => (AGENT_RUNTIME_STATUSES as readonly string[]).includes(v)),
    );
    if (wanted.size > 0) enriched = enriched.filter((d) => wanted.has(d.runtimeStatus));
  }

  res.json({ success: true, data: enriched });
}

export async function updateDevice(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const {
    status, groupId, checkIntervalSeconds, agentThresholds, name, notes,
    heartbeatMonitoring, sensorDisplayNames, overrideGroupSettings, displayConfig,
    notificationTypes, notificationCooldownSeconds, updatePolicy,
  } = body as {
    status?: 'approved' | 'refused' | 'pending' | 'suspended';
    groupId?: number | null;
    checkIntervalSeconds?: number;
    /** null = clear the device override and inherit the group thresholds. */
    agentThresholds?: AgentThresholds | null;
    name?: string | null;
    notes?: string | null;
    heartbeatMonitoring?: boolean;
    sensorDisplayNames?: Record<string, string> | null;
    overrideGroupSettings?: boolean;
    displayConfig?: import('@obliview/shared').AgentDisplayConfig | null;
    notificationTypes?: import('@obliview/shared').NotificationTypeConfig | null;
    notificationCooldownSeconds?: number | null;
    /** Device level of the agent update policy; null = inherit. */
    updatePolicy?: import('@obliview/shared').AgentUpdatePolicy | null;
  };

  const hasPolicy = 'updatePolicy' in body;
  if (hasPolicy && !isAgentUpdatePolicyInput(updatePolicy)) {
    res.status(400).json({ success: false, error: "updatePolicy must be 'auto', 'manual', 'off' or null" });
    return;
  }
  // The approval branch below does not apply updatePolicy: refuse rather than drop it silently.
  if (hasPolicy && status === 'approved') {
    res.status(400).json({ success: false, error: 'updatePolicy cannot be combined with an approval' });
    return;
  }

  const hasCooldown = 'notificationCooldownSeconds' in body;
  if (
    hasCooldown
    && notificationCooldownSeconds !== null
    && !(Number.isInteger(notificationCooldownSeconds) && (notificationCooldownSeconds as number) >= 0
      && (notificationCooldownSeconds as number) <= MAX_PG_INT)
  ) {
    res.status(400).json({ success: false, error: 'notificationCooldownSeconds must be an integer >= 0 or null' });
    return;
  }
  if (
    agentThresholds !== undefined
    && agentThresholds !== null
    && (typeof agentThresholds !== 'object' || Array.isArray(agentThresholds))
  ) {
    res.status(400).json({ success: false, error: 'agentThresholds must be an object or null' });
    return;
  }
  if (groupId !== undefined && groupId !== null && !(Number.isInteger(groupId) && groupId > 0 && groupId <= MAX_PG_INT)) {
    res.status(400).json({ success: false, error: 'Invalid groupId' });
    return;
  }
  const cooldownPatch = hasCooldown ? { notificationCooldownSeconds } : {};

  // Lifecycle / monitoring fields need agents.manage (write access itself is
  // checked by requireAgentDeviceWrite).
  const manageField = MANAGE_ONLY_FIELDS.find((field) => body[field] !== undefined);
  if (manageField && !(req.agentAccess?.canManage ?? false)) {
    res.status(403).json({ success: false, error: `Missing capability: agents.manage (${manageField})` });
    return;
  }

  const tenantScope = getEffectiveTenantScope(req);
  const currentDevice = await agentService.getDeviceById(id, tenantScope);
  if (!currentDevice) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }

  // Special handling for approval
  if (status === 'approved') {
    if (currentDevice.status === 'suspended') {
      // Reinstate a suspended device: re-activate its monitor, no new monitor created
      await agentService.reinstateDevice(id);
      const device = await agentService.updateDevice(id, { status: 'approved', name, heartbeatMonitoring, ...cooldownPatch }, tenantScope);
      await auditService.logReq(req, 'agent.reinstated', {
        resourceType: 'agent_device', resourceId: id, tenantId: currentDevice.tenantId,
        details: { hostname: currentDevice.hostname },
      });
      res.json({ success: true, data: device });
      return;
    }

    // First-time approval (pending → approved): create monitor.
    // groupId absent = keep the device's current group; agentThresholds
    // absent = no override (the monitor inherits the live group cascade).
    const userId = req.session?.userId ?? 0;
    const device = await agentService.approveDevice(
      id,
      userId,
      'groupId' in body ? (groupId ?? null) : undefined,
      agentThresholds,
    );
    if (!device) {
      res.status(404).json({ success: false, error: 'Device not found' });
      return;
    }
    await auditService.logReq(req, 'agent.approved', {
      resourceType: 'agent_device', resourceId: id, tenantId: currentDevice.tenantId,
      details: { hostname: currentDevice.hostname, groupId: device.groupId },
    });
    // Apply name/heartbeatMonitoring/cooldown if provided alongside approval
    if (name !== undefined || heartbeatMonitoring !== undefined || hasCooldown) {
      const updated = await agentService.updateDevice(id, { name, heartbeatMonitoring, ...cooldownPatch }, tenantScope);
      res.json({ success: true, data: updated ?? device });
      return;
    }
    res.json({ success: true, data: device });
    return;
  }

  // Suspend: pause the agent monitor
  if (status === 'suspended') {
    await agentService.suspendDevice(id);
  }

  // Update thresholds if provided (device already approved).
  // null clears the device override (inherit the group thresholds).
  if (agentThresholds !== undefined) {
    await agentService.updateDeviceThresholds(id, agentThresholds);
  }

  const device = await agentService.updateDevice(id, {
    status,
    groupId,
    checkIntervalSeconds,
    name,
    heartbeatMonitoring,
    sensorDisplayNames,
    overrideGroupSettings,
    displayConfig,
    ...('notificationTypes' in body ? { notificationTypes } : {}),
    ...('notes' in body ? { notes } : {}),
    ...(hasPolicy ? { updatePolicy } : {}),
    ...cooldownPatch,
  }, tenantScope);

  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }

  if (status !== undefined && status !== currentDevice.status) {
    const action = status === 'suspended' ? 'agent.suspended'
      : status === 'refused' ? 'agent.refused'
      : 'agent.status_changed';
    await auditService.logReq(req, action, {
      resourceType: 'agent_device', resourceId: id, tenantId: currentDevice.tenantId,
      details: { hostname: currentDevice.hostname, from: currentDevice.status, to: status },
    });
  } else {
    // Lifecycle / monitoring fields, names only (presentation tweaks such as
    // displayConfig or notes are not audited).
    // (updatePolicy has its own event below.)
    const audited = new Set<string>([...MANAGE_ONLY_FIELDS, 'name', 'agentThresholds']);
    const fields = Object.keys(body).filter((k) => body[k] !== undefined && audited.has(k) && k !== 'updatePolicy');
    if (fields.length > 0) {
      await auditService.logReq(req, 'agent.updated', {
        resourceType: 'agent_device', resourceId: id, tenantId: currentDevice.tenantId,
        details: { fields },
      });
    }
  }

  if (hasPolicy) {
    const from = currentDevice.updatePolicy ?? null;
    const to = updatePolicy ?? null;
    if (from !== to) {
      await auditService.logReq(req, 'agent_update_policy.changed', {
        resourceType: 'agent_device', resourceId: id, tenantId: currentDevice.tenantId,
        details: { level: 'agent', scopeId: id, hostname: currentDevice.hostname, from, to },
      });
    }
    // Frozen: the update still waiting for this device is cancelled (one
    // already handed to the agent cannot be recalled). Otherwise the device
    // may now resolve to 'auto': let the rollout look at it right away.
    if (to === 'off') {
      const cancelled = await agentUpdateRollout.cancelPending(null, [id]);
      await agentService.emitDevicesByIds(cancelled);
    } else {
      agentUpdateRollout.nudge();
    }
    res.json({ success: true, data: await loadDeviceWithRuntime(id, tenantScope) ?? device });
    return;
  }

  res.json({ success: true, data: device });
}

// ── Device Metrics ───────────────────────────────────────────────────────────

export async function getDeviceMetrics(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  // Try in-memory first, fall back to DB (handles server restarts). The
  // in-memory map is keyed by id only: requireAgentDeviceRead has already
  // confirmed that the device is in the caller's tenant scope.
  const snapshot = agentService.getLatestMetrics(id)
    ?? await agentService.getMetricsFromDB(id, getEffectiveTenantScope(req));
  if (!snapshot) {
    res.status(404).json({ success: false, error: 'No metrics available yet for this device' });
    return;
  }
  res.json({
    success: true,
    data: {
      monitorId: snapshot.monitorId,
      receivedAt: snapshot.receivedAt instanceof Date
        ? snapshot.receivedAt.toISOString()
        : snapshot.receivedAt,
      metrics: snapshot.metrics,
      violations: snapshot.violations,
      overallStatus: snapshot.overallStatus,
    },
  });
}

export async function deleteDevice(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const before = await agentService.getDeviceById(id, getEffectiveTenantScope(req));
  const ok = before ? await agentService.deleteDevice(id, getEffectiveTenantScope(req)) : false;
  if (!ok || !before) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  await auditService.logReq(req, 'agent.deleted', {
    resourceType: 'agent_device', resourceId: id, tenantId: before.tenantId,
    details: { hostname: before.hostname, name: before.name },
  });
  res.json({ success: true });
}

// ── Bulk Device Operations (agents.manage) ──────────────────────────────────
// Ids outside the caller's tenant scope are ignored by the service.

export async function bulkDeleteDevices(req: Request, res: Response): Promise<void> {
  const { deviceIds } = (req.body ?? {}) as { deviceIds?: unknown };
  if (!isIdArray(deviceIds)) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const affected = await agentService.bulkDeleteDevices(deviceIds, getEffectiveTenantScope(req));
  // One entry per workspace actually affected (God View may span several).
  for (const [tenantId, ids] of groupIdsByTenant(affected)) {
    await auditService.logReq(req, 'agent.bulk_deleted', {
      tenantId, resourceType: 'agent_device', resourcePath: ids.join(','),
      details: { count: ids.length },
    });
  }
  res.json({ success: true });
}

/** Group affected devices by workspace, for per-tenant audit entries. */
function groupIdsByTenant(rows: Array<{ id: number; tenant_id: number }>): Map<number, number[]> {
  const byTenant = new Map<number, number[]>();
  for (const r of rows) {
    const list = byTenant.get(r.tenant_id);
    if (list) list.push(r.id);
    else byTenant.set(r.tenant_id, [r.id]);
  }
  return byTenant;
}

export async function bulkUpdateDevices(req: Request, res: Response): Promise<void> {
  const { deviceIds, groupId, heartbeatMonitoring, overrideGroupSettings, status } = (req.body ?? {}) as {
    deviceIds?: unknown;
    groupId?: number | null;
    heartbeatMonitoring?: boolean;
    overrideGroupSettings?: boolean;
    status?: 'approved' | 'suspended';
  };
  if (!isIdArray(deviceIds)) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  if (groupId !== undefined && groupId !== null && !(Number.isInteger(groupId) && groupId > 0 && groupId <= MAX_PG_INT)) {
    res.status(400).json({ success: false, error: 'Invalid groupId' });
    return;
  }
  if (status !== undefined && status !== 'approved' && status !== 'suspended') {
    res.status(400).json({ success: false, error: 'Invalid status' });
    return;
  }
  // Bulk approval without a group: each pending device lands in its current
  // group, else its API key's default group (agentService.approveDevice).
  const affected = await agentService.bulkUpdateDevices(deviceIds, {
    groupId,
    heartbeatMonitoring,
    overrideGroupSettings,
    status,
    approvedBy: req.session.userId,
  }, getEffectiveTenantScope(req));
  const action = status === 'approved' ? 'agent.bulk_approved'
    : status === 'suspended' ? 'agent.bulk_suspended'
    : 'agent.bulk_updated';
  for (const [tenantId, ids] of groupIdsByTenant(affected)) {
    await auditService.logReq(req, action, {
      tenantId, resourceType: 'agent_device', resourcePath: ids.join(','),
      details: {
        count: ids.length,
        ...(groupId !== undefined ? { groupId } : {}),
        ...(heartbeatMonitoring !== undefined ? { heartbeatMonitoring } : {}),
        ...(overrideGroupSettings !== undefined ? { overrideGroupSettings } : {}),
      },
    });
  }
  res.json({ success: true });
}

// ── Lifecycle: uninstall (agents.manage) ────────────────────────────────────
// The free-form /command endpoint is gone: commands are a whitelist
// (AGENT_COMMANDS) and each one has its own flow — 'uninstall' here,
// 'update' through the rollout, 'reconfigure' through the tenant transfer.

/** Full device (runtime state included) for a lifecycle response, or null. */
async function loadDeviceWithRuntime(id: number, tenantScope: number | null): Promise<AgentDevice | null> {
  const device = await agentService.getDeviceById(id, tenantScope);
  if (!device) return null;
  const [withRuntime] = await agentService.withRuntime([device]);
  return withRuntime;
}

/** POST /agent/devices/:id/uninstall */
export async function uninstallDevice(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const scope = getEffectiveTenantScope(req);
  const result = await agentService.requestUninstall([id], scope);
  if (result.skippedIds.length > 0) {
    res.status(409).json({
      success: false,
      error: 'Proxy devices cannot be uninstalled remotely — stop the proxy and delete the device',
    });
    return;
  }
  if (result.deviceIds.length === 0) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  const device = await loadDeviceWithRuntime(id, scope);
  await auditService.logReq(req, 'agent.uninstall_requested', {
    resourceType: 'agent_device', resourceId: id, tenantId: device?.tenantId,
    details: { hostname: device?.hostname, deliveredNow: result.deliveredNow > 0 },
  });
  res.json({ success: true, data: device });
}

/** POST /agent/devices/bulk-uninstall {deviceIds} */
export async function bulkUninstallDevices(req: Request, res: Response): Promise<void> {
  const { deviceIds } = (req.body ?? {}) as { deviceIds?: unknown };
  if (!isIdArray(deviceIds)) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const result = await agentService.requestUninstall(deviceIds, getEffectiveTenantScope(req));
  await auditService.logReq(req, 'agent.bulk_uninstall_requested', {
    resourceType: 'agent_device', resourcePath: result.deviceIds.join(','),
    details: { count: result.deviceIds.length, deliveredNow: result.deliveredNow, skippedProxies: result.skippedIds.length },
  });
  res.json({
    success: true,
    data: { requested: result.deviceIds.length, deliveredNow: result.deliveredNow, skipped: result.skippedIds.length },
  });
}

/** POST /agent/devices/:id/cancel-uninstall */
export async function cancelUninstallDevice(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const scope = getEffectiveTenantScope(req);
  const device = await agentService.cancelUninstall(id, scope);
  if (!device) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  await auditService.logReq(req, 'agent.uninstall_cancelled', {
    resourceType: 'agent_device', resourceId: id, tenantId: device.tenantId,
    details: { hostname: device.hostname },
  });
  res.json({ success: true, data: await loadDeviceWithRuntime(id, scope) });
}

// ── Lifecycle: admin-paced agent updates (agents.manage) ────────────────────

/** POST /agent/devices/:id/update — queue an update of this agent (paced, one outstanding). */
export async function updateDeviceAgent(req: Request, res: Response): Promise<void> {
  const id = parseIdParam(req, res);
  if (id === null) return;
  const scope = getEffectiveTenantScope(req);
  const existing = await agentService.getDeviceById(id, scope);
  if (!existing) {
    res.status(404).json({ success: false, error: 'Device not found' });
    return;
  }
  const { changedIds, frozenBy, ...result } = await agentUpdateRollout.request([id], scope);
  if (result.ineligible > 0) {
    res.status(409).json({ success: false, error: 'This device cannot be updated (not approved, being uninstalled or transferred, or a proxy)', data: result });
    return;
  }
  // Update policy 'off' at some level: refused, naming the level that froze it.
  if (result.frozen > 0 && frozenBy) {
    res.status(409).json({
      success: false,
      code: 'AGENT_UPDATE_FROZEN',
      error: describeFrozenBy(frozenBy),
      data: { ...result, frozenBy },
    });
    return;
  }
  await agentService.emitDevicesByIds(changedIds);
  if (result.queued > 0) {
    await auditService.logReq(req, 'agent.update_requested', {
      resourceType: 'agent_device', resourceId: id, tenantId: existing.tenantId,
      details: { hostname: existing.hostname, from: existing.agentVersion, targetVersion: result.targetVersion },
    });
  }
  res.json({ success: true, data: { ...result, device: await loadDeviceWithRuntime(id, scope) } });
}

/** POST /agent/devices/bulk-update {deviceIds} */
export async function bulkUpdateAgents(req: Request, res: Response): Promise<void> {
  const { deviceIds } = (req.body ?? {}) as { deviceIds?: unknown };
  if (!isIdArray(deviceIds)) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  // Frozen devices (update policy 'off') are skipped and counted in result.frozen.
  const { changedIds, frozenBy: _frozenBy, ...result } = await agentUpdateRollout.request(deviceIds, getEffectiveTenantScope(req));
  await agentService.emitDevicesByIds(changedIds);
  if (result.queued > 0) {
    await auditService.logReq(req, 'agent.bulk_update_requested', {
      resourceType: 'agent_device', resourcePath: changedIds.join(','),
      details: { ...result },
    });
  }
  res.json({ success: true, data: result });
}

/**
 * POST /agent/update-all {preview?}
 * preview:true → the rollout state of the scope (outdated targets, queued,
 * in progress, failed, pace) without queuing anything; otherwise every
 * eligible outdated agent of the scope (God View: every workspace) is queued.
 */
export async function updateAllAgents(req: Request, res: Response): Promise<void> {
  const scope = getEffectiveTenantScope(req);
  const { preview } = (req.body ?? {}) as { preview?: unknown };
  if (preview === true) {
    res.json({ success: true, data: await agentUpdateRollout.preview(scope) });
    return;
  }
  const { changedIds, frozenBy: _frozenBy, ...result } = await agentUpdateRollout.request('all', scope);
  await agentService.emitDevicesByIds(changedIds);
  await auditService.logReq(req, 'agent.update_all', {
    resourceType: 'agent_device',
    details: { ...result, allWorkspaces: scope === null },
  });
  res.json({ success: true, data: { ...result, state: await agentUpdateRollout.preview(scope) } });
}

/**
 * POST /agent/update-all/cancel {deviceIds?} — stop the rollout: cancel the
 * updates still waiting in the scope (or for these devices). Updates already
 * handed to an agent cannot be recalled.
 */
export async function cancelAgentUpdates(req: Request, res: Response): Promise<void> {
  const { deviceIds } = (req.body ?? {}) as { deviceIds?: unknown };
  if (deviceIds !== undefined && !isIdArray(deviceIds)) {
    res.status(400).json({ success: false, error: 'deviceIds must be a non-empty array of ids' });
    return;
  }
  const scope = getEffectiveTenantScope(req);
  const cancelledIds = await agentUpdateRollout.cancelPending(scope, deviceIds as number[] | undefined);
  await agentService.emitDevicesByIds(cancelledIds);
  if (cancelledIds.length > 0) {
    await auditService.logReq(req, 'agent.update_cancelled', {
      resourceType: 'agent_device', resourcePath: cancelledIds.join(','),
      details: { cancelled: cancelledIds.length },
    });
  }
  res.json({ success: true, data: { cancelled: cancelledIds.length, state: await agentUpdateRollout.preview(scope) } });
}

// ── Legacy command endpoints (compatibility) ────────────────────────────────
// POST /devices/:id/command and /devices/bulk-command {command} now only
// accept the whitelisted lifecycle commands that have a flow of their own:
// 'uninstall' and 'update' ('reconfigure' is only issued by a transfer).

function parseLegacyCommand(req: Request, res: Response): 'uninstall' | 'update' | null {
  const { command } = (req.body ?? {}) as { command?: unknown };
  if (typeof command !== 'string' || !(AGENT_COMMANDS as readonly string[]).includes(command)) {
    res.status(400).json({ success: false, error: `command must be one of: ${AGENT_COMMANDS.join(', ')}` });
    return null;
  }
  if (command === 'reconfigure') {
    res.status(400).json({ success: false, error: "'reconfigure' is issued by POST /agent/devices/batch/transfer only" });
    return null;
  }
  return command as 'uninstall' | 'update';
}

export async function sendDeviceCommand(req: Request, res: Response): Promise<void> {
  const command = parseLegacyCommand(req, res);
  if (!command) return;
  if (command === 'uninstall') await uninstallDevice(req, res);
  else await updateDeviceAgent(req, res);
}

export async function bulkDeviceCommand(req: Request, res: Response): Promise<void> {
  const command = parseLegacyCommand(req, res);
  if (!command) return;
  if (command === 'uninstall') await bulkUninstallDevices(req, res);
  else await bulkUpdateAgents(req, res);
}

// ── Tenant transfer (platform admins) ───────────────────────────────────────

/**
 * POST /agent/devices/batch/transfer {deviceIds, targetTenantId, targetApiKeyId}
 * Devices are taken from the caller's scope (current workspace, or every one
 * in the God View); the key must belong to the target workspace. See
 * agentService.transferDevices for what moves and what is purged.
 */
export async function transferDevices(req: Request, res: Response): Promise<void> {
  const { deviceIds, targetTenantId, targetApiKeyId } = (req.body ?? {}) as {
    deviceIds?: unknown; targetTenantId?: unknown; targetApiKeyId?: unknown;
  };
  if (!isIdArray(deviceIds)) {
    res.status(400).json({ success: false, error: 'deviceIds array required' });
    return;
  }
  const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= MAX_PG_INT;
  if (!isId(targetTenantId) || !isId(targetApiKeyId)) {
    res.status(400).json({ success: false, error: 'targetTenantId and targetApiKeyId required' });
    return;
  }
  const { transferredIds, sourceTenantIds, transferKeyId, ...result } = await agentService.transferDevices(
    deviceIds,
    getEffectiveTenantScope(req),
    targetTenantId,
    targetApiKeyId,
    req.session.userId!,
  );
  if (result.transferred === 0 && result.failed === 0) {
    res.status(404).json({ success: false, error: 'No matching devices to transfer', data: result });
    return;
  }
  const details = {
    toTenantId: targetTenantId,
    targetApiKeyId,
    transferKeyId,
    deviceIds: transferredIds,
    transferred: result.transferred,
    failed: result.failed,
    skipped: result.skipped,
  };
  // One entry in each source workspace's log and one in the target's.
  for (const tenantId of sourceTenantIds) {
    await auditService.logReq(req, 'agent.transferred_out', {
      resourceType: 'agent_device', resourcePath: transferredIds.join(','), tenantId, details,
    });
  }
  await auditService.logReq(req, 'agent.transferred_in', {
    resourceType: 'agent_device', resourcePath: transferredIds.join(','), tenantId: targetTenantId,
    details: { ...details, fromTenantIds: sourceTenantIds },
  });
  res.json({ success: true, data: result });
}

// ── Proxy candidates ────────────────────────────────────────────────────────

/**
 * GET /agent/proxy-candidates
 * Approved devices of the current workspace the caller may route monitor
 * checks through: all of them for platform admins and agents.manage holders,
 * otherwise those whose agent monitor the caller has RW on.
 * `?tenantId=` is honoured in the God View only (the edited monitor's workspace).
 * Returns [{ id, name, hostname, deviceType }].
 */
export async function listProxyCandidates(req: Request, res: Response): Promise<void> {
  const strip = (rows: Awaited<ReturnType<typeof agentService.listProxyCandidates>>) =>
    rows.map(({ id, name, hostname, deviceType }) => ({ id, name, hostname, deviceType }));

  if (await canManageAgents(req)) {
    // God View: the picker asks for the edited monitor's own workspace (a
    // proxy must belong to the monitor's tenant).
    let tenantId = req.tenantId;
    const raw = req.query.tenantId;
    if (getEffectiveTenantScope(req) === null && typeof raw === 'string' && /^\d+$/.test(raw)) {
      const requested = parseInt(raw, 10);
      if (requested > 0 && requested <= MAX_PG_INT) tenantId = requested;
    }
    res.json({ success: true, data: strip(await agentService.listProxyCandidates(tenantId, null)) });
    return;
  }

  const userId = req.session.userId!;
  // Narrow to the visible agent monitors first, then keep the RW ones.
  const visible = await permissionService.getVisibleMonitorIds(userId, false);
  const candidates = await agentService.listProxyCandidates(req.tenantId, visible === 'all' ? null : visible);
  const levels = await Promise.all(candidates.map((c) => (
    c.monitorId === null ? Promise.resolve(null) : permissionService.getMonitorPermission(userId, c.monitorId, false)
  )));
  res.json({ success: true, data: strip(candidates.filter((_c, i) => levels[i] === 'rw')) });
}
