export const MONITOR_TYPES = [
  'http',
  'ping',
  'tcp',
  'dns',
  'ssl',
  'smtp',
  'docker',
  'game_server',
  'push',
  'script',
  'json_api',
  'browser',
  'value_watcher',
  'agent',
] as const;

export type MonitorType = (typeof MONITOR_TYPES)[number];

/** Remote device kinds that can execute monitor checks (agent_devices.device_type). */
export type ProxyDeviceType = 'agent' | 'proxy';

/**
 * Monitor types each kind of proxy device can execute on behalf of the server.
 *  - 'agent': the Go agent — see executeCheck in agent/proxy_check.go.
 *  - 'proxy': the Node proxy stub — see executeCheck in proxy/src/checks/index.ts
 *    (every active check type).
 * 'agent' (the backing monitor of a device) and 'push' (passive, fed by
 * external callers) can never run through a proxy.
 */
export const PROXY_SUPPORTED_TYPES: Record<ProxyDeviceType, MonitorType[]> = {
  agent: ['http', 'json_api', 'ping', 'tcp', 'dns', 'ssl', 'smtp'],
  proxy: MONITOR_TYPES.filter((t) => t !== 'agent' && t !== 'push'),
};

/**
 * True when a device of the given device_type can run checks of the given
 * monitor type. Unknown / missing device types are treated as the Go agent
 * (agent_devices.device_type defaults to 'agent').
 */
export function isProxySupportedType(deviceType: string | null | undefined, monitorType: string): boolean {
  const kind: ProxyDeviceType = deviceType === 'proxy' ? 'proxy' : 'agent';
  return (PROXY_SUPPORTED_TYPES[kind] as string[]).includes(monitorType);
}

export const MONITOR_STATUS = [
  'up', 'down', 'pending', 'maintenance', 'paused',
  'ssl_warning', 'ssl_expired',
  'alert',    // threshold violation on an agent monitor (orange)
  'inactive', // agent offline + heartbeat_monitoring=false (grey, no notification)
  'updating', // agent is performing a self-update (blue, not counted in uptime)
] as const;
export type MonitorStatus = (typeof MONITOR_STATUS)[number];

export const MONITOR_TYPE_LABELS: Record<MonitorType, string> = {
  http: 'HTTP(S)',
  ping: 'Ping',
  tcp: 'TCP Port',
  dns: 'DNS',
  ssl: 'SSL Certificate',
  smtp: 'SMTP',
  docker: 'Docker Container',
  game_server: 'Game Server',
  push: 'Push (Heartbeat)',
  script: 'Custom Script',
  json_api: 'JSON API',
  browser: 'Browser (Playwright)',
  value_watcher: 'Value Watcher',
  agent: 'Agent Monitor',
};

export const USER_ROLES = ['admin', 'user'] as const;
export type UserRole = (typeof USER_ROLES)[number];
