export const config = {
  serverUrl: process.env.OBLIVIEW_SERVER || 'http://localhost:3001',
  apiKey: process.env.OBLIVIEW_API_KEY || '',
  deviceUuid: process.env.DEVICE_UUID || '',
  hostname: process.env.PROXY_HOSTNAME || '',
  /** Heartbeat interval in seconds (how often we tell the server we're alive) */
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '30', 10),
};

if (!config.apiKey) {
  console.error('ERROR: OBLIVIEW_API_KEY is required');
  process.exit(1);
}
