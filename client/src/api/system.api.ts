export interface SystemInfo {
  appVersion:    string;
  nodeVersion:   string;
  agentVersion:  string;
  uptimeSeconds: number;
  memory: {
    processRssMb:  number;
    processHeapMb: number;
    systemTotalMb: number;
    systemFreeMb:  number;
  };
  cpu: {
    loadAvg1:  number;
    loadAvg5:  number;
    loadAvg15: number;
    cores:     number;
  };
  environment: {
    isDocker: boolean;
    platform: string;
    dbStatus: 'ok' | 'error';
  };
  /** Chromium found on the server (browser monitors can run). */
  browserAvailable?: boolean;
}

import apiClient from './client';

export const systemApi = {
  async getInfo(): Promise<SystemInfo> {
    const res = await apiClient.get<SystemInfo>('/system');
    return res.data;
  },
};
