export interface CheckResult {
  status: string;
  responseTime?: number;
  statusCode?: number;
  message?: string;
  ping?: number;
  value?: string;
  valueChanged?: boolean;
}

export interface ProxyMonitorConfig {
  monitorId: number;
  type: string;
  intervalSeconds: number;
  timeoutMs: number;
  // HTTP / JSON API
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  expectedStatusCodes?: number[];
  keyword?: string;
  keywordIsPresent?: boolean;
  ignoreSsl?: boolean;
  jsonPath?: string;
  jsonExpectedValue?: string;
  // Network
  hostname?: string;
  port?: number;
  // DNS
  dnsRecordType?: string;
  dnsResolver?: string;
  dnsExpectedValue?: string;
  // SSL
  sslWarnDays?: number;
  // SMTP
  smtpHost?: string;
  smtpPort?: number;
  // Docker
  dockerHost?: string;
  dockerContainerName?: string;
  // Game Server
  gameType?: string;
  gameHost?: string;
  gamePort?: number;
  // Script
  scriptCommand?: string;
  scriptExpectedExit?: number;
  // Browser (Playwright)
  browserUrl?: string;
  browserKeyword?: string;
  browserKeywordIsPresent?: boolean;
  browserWaitForSelector?: string;
  // Value Watcher
  valueWatcherUrl?: string;
  valueWatcherJsonPath?: string;
  valueWatcherOperator?: string;
  valueWatcherThreshold?: number;
  valueWatcherThresholdMax?: number;
  valueWatcherPreviousValue?: string;
  valueWatcherHeaders?: Record<string, string>;
}
