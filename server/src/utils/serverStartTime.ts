/**
 * Timestamp (ms) of when the server process started.
 * Used by AgentMonitorWorker to suppress false "offline" notifications
 * during the startup grace period, while agents reconnect.
 */
export const SERVER_START_TIME = Date.now();
