import fs from 'fs';
import path from 'path';

// ── Windows "nt6" build line of the agent (server side) ─────────────────────
//
// Windows 7 SP1 / 8.1 / Server 2008 R2 / 2012 / 2012 R2 (NT 6.x) run the
// agent built with Go 1.20 ("nt6"): obliview-agent-nt6.msi. The modern MSI
// refuses Windows 7 / 2008 R2 (launch condition, agent/installer/product.wxs).
//
// Agents built before the nt6 line do not know it: they always download
// `obliview-agent.msi` (anonymous GET /api/agent/download/<file>), start
// msiexec and stop their service. On a host where that MSI would be refused
// the service would stay stopped. These agents never send `agentBuild` in
// their heartbeat; newer ones do and pick the right MSI themselves
// (agent/build_flavor.go currentAgentMSIName).
//
// Identification: every heartbeat (HTTP push or WS) records (client address,
// NT 6.x?, Windows 7 / 2008 R2?) here for a while; a download of the modern
// MSI from that address then gets the nt6 MSI when every recent Windows
// device seen from it is NT 6.x. Mixed address (NT 6.x and Windows 10+ behind
// one NAT): the requested modern MSI is served — it installs fine on
// 8 / 8.1 / 2012 / 2012 R2 — unless one of them is Windows 7 / 2008 R2, which
// gets a 404 (the agent logs "download failed", keeps running and retries):
// never a package msiexec would refuse after the service stopped.

export const AGENT_MSI_MODERN = 'obliview-agent.msi';
export const AGENT_MSI_NT6 = 'obliview-agent-nt6.msi';

const AGENT_DIST_DIR = path.resolve(__dirname, '../../../../agent/dist');

/** How long a heartbeat counts for the downloads that follow it. */
const NT6_WINDOW_MS = 15 * 60_000;
/** Bound of the in-memory table (oldest dropped first). */
const MAX_ENTRIES = 10_000;

export interface AgentOsInfo {
  platform?: string | null;
  release?: string | null;
}

interface SeenEntry { ip: string; deviceUuid: string; nt6: boolean; nt61: boolean; at: number }

/** Keyed by device UUID (the latest heartbeat replaces the previous one). */
const seen = new Map<string, SeenEntry>();

/** Parsed Windows version "major.minor" from the reported OS, or null when not Windows / unknown. */
export function windowsVersion(os: AgentOsInfo | null | undefined): { major: number; minor: number } | null {
  if (!os) return null;
  const platform = String(os.platform ?? '').toLowerCase();
  if (platform !== 'windows' && platform !== 'win32') return null;
  // gopsutil PlatformVersion: "6.3.9600 Build 9600", "10.0.19045 Build 19045"
  const m = /^\s*(\d+)\.(\d+)/.exec(String(os.release ?? ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

/** True for Windows NT 6.x (7 / 8 / 8.1 / 2008 R2 / 2012 / 2012 R2). */
export function isWindowsNt6(os: AgentOsInfo | null | undefined): boolean {
  const v = windowsVersion(os);
  return !!v && v.major === 6;
}

/** True for Windows 7 / Server 2008 R2 (NT 6.1) or older: the modern MSI refuses them. */
export function isWindowsNt61OrOlder(os: AgentOsInfo | null | undefined): boolean {
  const v = windowsVersion(os);
  return !!v && (v.major < 6 || (v.major === 6 && v.minor <= 1));
}

let nt6Cache: { at: number; present: boolean } | null = null;

/** Whether agent/dist holds the nt6 MSI (checked at most once a minute). */
export function nt6MsiAvailable(now = Date.now()): boolean {
  if (nt6Cache && now - nt6Cache.at < 60_000) return nt6Cache.present;
  let present = false;
  try {
    present = fs.statSync(path.join(AGENT_DIST_DIR, AGENT_MSI_NT6)).isFile();
  } catch { /* missing */ }
  nt6Cache = { at: now, present };
  return present;
}

function prune(now: number): void {
  for (const [uuid, e] of seen) {
    if (now - e.at >= NT6_WINDOW_MS) seen.delete(uuid);
  }
  while (seen.size > MAX_ENTRIES) {
    const oldest = seen.keys().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
}

/** Records the heartbeat of a Windows device (others are ignored). */
export function noteAgentHeartbeat(input: { ip: string | null | undefined; deviceUuid: string; os: AgentOsInfo | null | undefined }, now = Date.now()): void {
  const ip = String(input.ip ?? '').trim();
  if (!ip || !windowsVersion(input.os)) {
    seen.delete(input.deviceUuid);
    return;
  }
  seen.delete(input.deviceUuid); // re-insert last (Map order = age)
  seen.set(input.deviceUuid, {
    ip,
    deviceUuid: input.deviceUuid,
    nt6: isWindowsNt6(input.os),
    nt61: isWindowsNt61OrOlder(input.os),
    at: now,
  });
  if (seen.size > MAX_ENTRIES || Math.random() < 0.01) prune(now);
}

export interface AgentDownloadChoice {
  /** The dist file to serve, or null = answer 404 (never a refused package). */
  file: string | null;
  substituted: boolean;
  reason: 'as_requested' | 'nt6_device' | 'nt6_missing' | 'mixed_address' | 'mixed_address_win7';
}

/**
 * The file to serve for GET /api/agent/download/<requested> from `ip`. Only
 * the modern MSI can be substituted; every other name is served as requested.
 */
export function chooseAgentDownload(requested: string, ip: string | null | undefined, now = Date.now()): AgentDownloadChoice {
  if (requested !== AGENT_MSI_MODERN) return { file: requested, substituted: false, reason: 'as_requested' };
  const addr = String(ip ?? '').trim();
  if (!addr) return { file: requested, substituted: false, reason: 'as_requested' };
  const recent = [...seen.values()].filter((e) => e.ip === addr && now - e.at < NT6_WINDOW_MS);
  if (recent.length === 0) return { file: requested, substituted: false, reason: 'as_requested' };
  const anyWin7 = recent.some((e) => e.nt61);
  if (recent.every((e) => e.nt6)) {
    if (nt6MsiAvailable(now)) return { file: AGENT_MSI_NT6, substituted: true, reason: 'nt6_device' };
    // 8 / 8.1 / 2012 / 2012 R2 still accept the modern MSI; Windows 7 / 2008 R2 do not.
    return anyWin7
      ? { file: null, substituted: false, reason: 'nt6_missing' }
      : { file: requested, substituted: false, reason: 'nt6_missing' };
  }
  if (anyWin7) return { file: null, substituted: false, reason: 'mixed_address_win7' };
  return { file: requested, substituted: false, reason: recent.some((e) => e.nt6) ? 'mixed_address' : 'as_requested' };
}

/**
 * Whether an approved device may be offered `latestVersion`. A pre-nt6-line
 * agent (no agentBuild) on Windows 7 / 2008 R2 would download the modern MSI,
 * which refuses that OS: only offer the update when the nt6 MSI can be
 * substituted. Everything else is offered as before.
 */
export function mayOfferAgentUpdate(os: AgentOsInfo | null | undefined, agentBuild: string | null | undefined): boolean {
  if (agentBuild) return true;
  if (!isWindowsNt61OrOlder(os)) return true;
  return nt6MsiAvailable();
}

/** Tests only. */
export function __resetAgentNt6ForTests(): void {
  seen.clear();
  nt6Cache = null;
}
