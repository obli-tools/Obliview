import WebSocket from 'ws';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { handleProxySync } from './scheduler.js';
import type { CheckResult } from './types.js';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 60000;
let backoff = RECONNECT_BASE;

/**
 * File holding the generated device UUID. Mount its directory as a volume
 * (e.g. `-v obliview-proxy-data:/data`) so a restarted or re-created container
 * keeps its identity instead of registering a new pending device.
 */
const DEVICE_UUID_FILE = process.env.DEVICE_UUID_FILE || '/data/device-uuid';

/** agent_devices.uuid is a varchar(64); anything else in the file is ignored. */
const STORED_UUID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Device identity: DEVICE_UUID when set; otherwise the UUID saved in
 * DEVICE_UUID_FILE; otherwise a new random UUID, written to that file so the
 * next start reuses it.
 */
function resolveDeviceUuid(): string {
  if (config.deviceUuid) return config.deviceUuid;

  try {
    const saved = fs.readFileSync(DEVICE_UUID_FILE, 'utf-8').trim();
    if (STORED_UUID_RE.test(saved)) {
      console.log(`Loaded device UUID from ${DEVICE_UUID_FILE}: ${saved}`);
      return saved;
    }
    if (saved) console.warn(`Ignoring malformed device UUID in ${DEVICE_UUID_FILE}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Cannot read ${DEVICE_UUID_FILE}: ${(err as Error).message}`);
    }
  }

  const generated = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(DEVICE_UUID_FILE), { recursive: true });
    fs.writeFileSync(DEVICE_UUID_FILE, `${generated}\n`, { encoding: 'utf-8', mode: 0o600 });
    console.log(`Generated device UUID ${generated} (saved to ${DEVICE_UUID_FILE})`);
  } catch (err) {
    console.warn(
      `Generated device UUID ${generated} but could not save it to ${DEVICE_UUID_FILE} ` +
      `(${(err as Error).message}). The next restart will register a new device — ` +
      'mount a writable volume there or set DEVICE_UUID.',
    );
  }
  return generated;
}

config.deviceUuid = resolveDeviceUuid();

// ── Persisted credentials ('reconfigure' / tenant transfer) ─────────────────

/**
 * Credentials received through a 'reconfigure' command, saved next to the
 * UUID file so they survive a container restart (the environment still holds
 * the old OBLIVIEW_API_KEY / OBLIVIEW_SERVER).
 */
const PERSISTED_CONFIG_FILE = path.join(path.dirname(DEVICE_UUID_FILE), 'proxy-config.json');

interface PersistedConfig {
  apiKey?: string;
  serverUrl?: string;
  /** SHA-256 (hex) of the API keys a reconfigure replaced — never the keys. */
  supersededApiKeys?: string[];
  /** Server URLs a reconfigure replaced. */
  supersededServerUrls?: string[];
}

const MAX_SUPERSEDED = 8;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readPersistedConfig(): PersistedConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(PERSISTED_CONFIG_FILE, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as PersistedConfig) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Cannot read ${PERSISTED_CONFIG_FILE}: ${(err as Error).message}`);
    }
    return {};
  }
}

/** Atomic write (temp file + rename), mode 0600 — the file holds the API key. */
function writePersistedConfig(data: PersistedConfig): void {
  fs.mkdirSync(path.dirname(PERSISTED_CONFIG_FILE), { recursive: true });
  const tmp = `${PERSISTED_CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, PERSISTED_CONFIG_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
}

/**
 * Apply persisted credentials over the environment. The environment wins only
 * when it holds a value that is neither the persisted one nor one a
 * reconfigure replaced — i.e. the operator deliberately set a new key / URL.
 */
function applyPersistedConfig(): void {
  const saved = readPersistedConfig();
  const envKey = config.apiKey;
  const envUrl = config.serverUrl.replace(/\/$/, '');

  if (saved.apiKey && envKey !== saved.apiKey) {
    if ((saved.supersededApiKeys ?? []).includes(sha256(envKey))) {
      config.apiKey = saved.apiKey;
      console.log(`Using the API key from ${PERSISTED_CONFIG_FILE} (set by a reconfigure command)`);
    } else {
      console.log('OBLIVIEW_API_KEY differs from the reconfigured key — using the environment value');
    }
  }
  if (saved.serverUrl && envUrl !== saved.serverUrl) {
    if ((saved.supersededServerUrls ?? []).includes(envUrl)) {
      config.serverUrl = saved.serverUrl;
      console.log(`Using server ${saved.serverUrl} from ${PERSISTED_CONFIG_FILE} (set by a reconfigure command)`);
    } else {
      console.log('OBLIVIEW_SERVER differs from the reconfigured server — using the environment value');
    }
  }
}

applyPersistedConfig();

function pushBounded(list: string[] | undefined, value: string): string[] {
  const out = (list ?? []).filter((v) => v !== value);
  out.push(value);
  return out.slice(-MAX_SUPERSEDED);
}

function validateApiKey(key: string): string | null {
  if (key.length < 8 || key.length > 512) return 'apiKey has an invalid length';
  if (!/^[\x21-\x7e]+$/.test(key) || /["'`\\]/.test(key)) return 'apiKey contains invalid characters';
  return null;
}

function normalizeServerUrl(raw: string, current: string): { url?: string; error?: string } {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(trimmed); } catch { return { error: 'serverUrl is not a valid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'serverUrl must use http or https' };
  if (u.username || u.password || u.search || u.hash) return { error: 'serverUrl must be a plain http(s) URL' };
  if (current.toLowerCase().startsWith('https://') && u.protocol === 'http:') {
    return { error: 'refusing to downgrade the server URL from https to http' };
  }
  return { url: trimmed };
}

/**
 * 'reconfigure' {apiKey, serverUrl?}: persist the new credentials next to the
 * UUID file, switch to them in memory and reconnect. Returns an error message,
 * or null on success.
 */
function handleReconfigure(payload: Record<string, unknown>): string | null {
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = payload[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const apiKey = str('apiKey', 'api_key');
  const keyError = apiKey ? validateApiKey(apiKey) : 'apiKey is required';
  if (keyError) return keyError;

  const currentUrl = config.serverUrl.replace(/\/$/, '');
  let serverUrl = currentUrl;
  const rawUrl = str('serverUrl', 'server_url');
  if (rawUrl) {
    const n = normalizeServerUrl(rawUrl, currentUrl);
    if (n.error) return n.error;
    serverUrl = n.url!;
  }
  if (apiKey === config.apiKey && serverUrl === currentUrl) return null;

  const saved = readPersistedConfig();
  const next: PersistedConfig = { ...saved, apiKey, serverUrl };
  if (apiKey !== config.apiKey) {
    next.supersededApiKeys = pushBounded(saved.supersededApiKeys, sha256(config.apiKey))
      .filter((h) => h !== sha256(apiKey));
  }
  if (serverUrl !== currentUrl) {
    next.supersededServerUrls = pushBounded(saved.supersededServerUrls, currentUrl)
      .filter((u) => u !== serverUrl);
  }
  try {
    writePersistedConfig(next);
  } catch (err) {
    return `could not write ${PERSISTED_CONFIG_FILE}: ${(err as Error).message}`;
  }

  config.apiKey = apiKey;
  config.serverUrl = serverUrl;
  console.log(`Reconfigured: new credentials saved to ${PERSISTED_CONFIG_FILE} (server: ${serverUrl}) — reconnecting`);

  // Let the ack go out, then drop the socket: the close handler reconnects
  // with the new credentials.
  backoff = RECONNECT_BASE;
  const current = ws;
  setTimeout(() => current?.close(), 500);
  return null;
}

/**
 * Parse the one-shot command piggy-backed on a 'config' message: a plain name
 * (+ commandPayload or flat fields), an object {type, ...payload}, or that
 * object JSON-encoded as a string.
 */
function parseConfigCommand(msg: Record<string, unknown>): { name: string; payload: Record<string, unknown> } | null {
  let cmd: unknown = msg.command;
  if (typeof cmd === 'string' && cmd.trim().startsWith('{')) {
    try { cmd = JSON.parse(cmd); } catch { return null; }
  }
  if (typeof cmd === 'string' && cmd.trim()) {
    const payload: Record<string, unknown> = {
      ...(msg.commandPayload && typeof msg.commandPayload === 'object' ? msg.commandPayload as Record<string, unknown> : {}),
    };
    for (const k of ['apiKey', 'serverUrl', 'targetVersion']) {
      if (msg[k] !== undefined) payload[k] = msg[k];
    }
    return { name: cmd.trim().toLowerCase(), payload };
  }
  if (cmd && typeof cmd === 'object') {
    const o = cmd as Record<string, unknown>;
    const name = [o.type, o.commandType, o.command].find((v) => typeof v === 'string') as string | undefined;
    if (!name) return null;
    const nested = o.payload && typeof o.payload === 'object' ? o.payload as Record<string, unknown> : {};
    return { name: name.trim().toLowerCase(), payload: { ...o, ...nested } };
  }
  return null;
}

export function connect(): void {
  const base = config.serverUrl.replace(/\/$/, '');
  const wsBase = base.replace(/^http/, 'ws');
  const url = `${wsBase}/api/agent/ws?uuid=${encodeURIComponent(config.deviceUuid)}`;

  console.log(`Connecting to ${base}...`);
  ws = new WebSocket(url, { headers: { 'X-API-Key': config.apiKey } });

  ws.on('open', () => {
    console.log('Connected to Obliview server');
    backoff = RECONNECT_BASE;
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, config.heartbeatInterval * 1000);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'config': {
          // Server config response — interval is managed locally; only a
          // piggy-backed one-shot command matters here.
          const cmd = parseConfigCommand(msg);
          if (!cmd) break;
          if (cmd.name === 'reconfigure') {
            const error = handleReconfigure(cmd.payload);
            if (error) console.warn(`Reconfigure rejected: ${error}`);
          } else {
            console.log(`Ignoring unsupported command "${cmd.name}"`);
          }
          break;
        }
        case 'proxy_sync':
          handleProxySync(msg.monitors ?? []);
          break;
        case 'command': {
          if (msg.commandType === 'reconfigure') {
            const payload = msg.payload && typeof msg.payload === 'object' ? msg.payload as Record<string, unknown> : {};
            const error = handleReconfigure(payload);
            if (error) console.warn(`Reconfigure rejected: ${error}`);
            if (msg.id) {
              send(error
                ? { type: 'ack', id: msg.id, commandType: msg.commandType, success: false, error }
                : { type: 'ack', id: msg.id, commandType: msg.commandType, success: true, result: { message: 'reconfigured' } });
            }
            break;
          }
          // Other one-shot commands are not supported by the proxy stub.
          console.log(`Ignoring unsupported command "${String(msg.commandType)}"`);
          if (msg.id) {
            send({ type: 'ack', id: msg.id, commandType: msg.commandType, success: false, error: 'not implemented' });
          }
          break;
        }
      }
    } catch { /* malformed JSON */ }
  });

  ws.on('close', () => {
    console.log(`Disconnected — reconnecting in ${backoff}ms`);
    cleanup();
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error(`WS error: ${err.message}`);
    cleanup();
    scheduleReconnect();
  });
}

function cleanup(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  ws = null;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoff = Math.min(backoff * 1.5, RECONNECT_MAX);
    connect();
  }, backoff);
}

function sendHeartbeat(): void {
  const hostname = config.hostname || os.hostname();
  send({
    type: 'heartbeat',
    hostname,
    agentVersion: '1.0.0',
    deviceType: 'proxy',
    osInfo: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
    },
    metrics: {
      cpu: { percent: 0 },
      memory: {
        totalMB: Math.round(os.totalmem() / 1048576),
        usedMB: Math.round((os.totalmem() - os.freemem()) / 1048576),
        percent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10,
      },
    },
  });
}

export function send(data: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function sendProxyResult(monitorId: number, result: CheckResult): void {
  send({ type: 'proxy_result', monitorId, result });
}
