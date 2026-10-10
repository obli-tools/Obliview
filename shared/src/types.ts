import type { MonitorType, MonitorStatus, UserRole } from './monitorTypes';
import type { SettingsKey } from './settingsDefaults';

// ============================================
// User types
// ============================================
export type AppTheme = 'obli-operator' | 'obli-daylight' | 'obli-dim' | 'modern' | 'neon';

export interface UserPreferences {
  toastEnabled: boolean;
  toastPosition: 'top-center' | 'bottom-right';
  multiTenantNotificationsEnabled?: boolean;
  preferredTheme?: AppTheme;
  /** When true, sensitive data (hostnames, IPs, usernames, MACs) is masked in the UI. Synced from Obligate. */
  anonymousMode?: boolean;
}

/** Shape of a live alert as returned by the server (used in socket NOTIFICATION_NEW + REST API). */
export interface LiveAlertData {
  id: number;
  tenantId: number;
  tenantName?: string;
  /** 'critical' | 'warning' | 'info' since migration 065; 'down' / 'up' only from older servers. */
  severity: 'critical' | 'warning' | 'info' | 'down' | 'up';
  title: string;
  message: string;
  navigateTo: string | null;
  stableKey: string | null;
  read: boolean;
  createdAt: string; // ISO 8601
  monitorId?: number | null;
  agentDeviceId?: number | null;
  readAt?: string | null;
  /** The incident is over (recovery). */
  resolved?: boolean;
  resolvedAt?: string | null;
}

export interface User {
  id: number;
  username: string;
  displayName: string | null;
  role: UserRole;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  preferences?: UserPreferences | null;
  email?: string | null;
  /** Profile photo URL (synced from Obligate). Null when the user has no avatar. */
  avatar?: string | null;
  preferredLanguage: string;
  enrollmentVersion: number;
  totpEnabled?: boolean;
  emailOtpEnabled?: boolean;
  /** SSO foreign user fields — null for local users */
  foreignSource?: string | null;
  foreignId?: number | null;
  foreignSourceUrl?: string | null;
  /** True when user has no local password (SSO-only account) */
  hasPassword?: boolean;
}

export interface UserWithPassword extends User {
  passwordHash: string;
}

// ============================================
// Monitor types
// ============================================
export interface Monitor {
  id: number;
  /** Owner workspace (sent by the server; optional for older payloads). */
  tenantId?: number;
  name: string;
  description: string | null;
  type: MonitorType;
  groupId: number | null;
  isActive: boolean;
  status: MonitorStatus;

  // Common config
  intervalSeconds: number | null;
  retryIntervalSeconds: number | null;
  maxRetries: number | null;
  timeoutMs: number | null;
  upsideDown: boolean;

  // HTTP / JSON API
  url: string | null;
  method: string | null;
  headers: Record<string, string> | null;
  body: string | null;
  expectedStatusCodes: number[] | null;
  keyword: string | null;
  keywordIsPresent: boolean | null;
  ignoreSsl: boolean;

  // JSON API
  jsonPath: string | null;
  jsonExpectedValue: string | null;

  // Ping / TCP
  hostname: string | null;
  port: number | null;

  // DNS
  dnsRecordType: string | null;
  dnsResolver: string | null;
  dnsExpectedValue: string | null;

  // SSL
  sslWarnDays: number | null;

  // SMTP
  smtpHost: string | null;
  smtpPort: number | null;

  // Docker
  dockerHost: string | null;
  dockerContainerName: string | null;

  // Game server
  gameType: string | null;
  gameHost: string | null;
  gamePort: number | null;

  // Push
  pushToken: string | null;
  pushMaxIntervalSec: number | null;

  // Script
  scriptCommand: string | null;
  scriptExpectedExit: number | null;

  // Browser (Playwright)
  browserUrl: string | null;
  browserKeyword: string | null;
  browserKeywordIsPresent: boolean | null;
  browserWaitForSelector: string | null;
  browserScreenshotOnFailure: boolean;

  // Value Watcher
  valueWatcherUrl: string | null;
  valueWatcherJsonPath: string | null;
  valueWatcherOperator: string | null;
  valueWatcherThreshold: number | null;
  valueWatcherThresholdMax: number | null;
  valueWatcherPreviousValue: string | null;
  valueWatcherHeaders: Record<string, string> | null;

  // Agent Monitor
  agentDeviceId: number | null;
  agentDeviceName: string | null;  // display name from agent_devices.name (null if not set)
  agentThresholds: AgentThresholds | null;

  // Proxy Agent — when set, the monitor check is executed by this remote agent
  proxyAgentDeviceId: number | null;

  // Metadata
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  inMaintenance?: boolean;
}

// ============================================
// Heartbeat types
// ============================================
export interface Heartbeat {
  id: number;
  monitorId: number;
  status: MonitorStatus;
  responseTime: number | null;
  statusCode: number | null;
  message: string | null;
  ping: number | null;
  isRetrying: boolean;
  value: string | null;
  inMaintenance?: boolean;
  createdAt: string;
}

export interface HeartbeatStats {
  monitorId: number;
  period: string;
  uptimePct: number;
  avgResponse: number | null;
  maxResponse: number | null;
  minResponse: number | null;
  totalChecks: number;
  totalUp: number;
  totalDown: number;
}

/** Periods accepted by GET /monitors/:id/stats (and the heartbeat period fetch). */
export type MonitorStatsPeriod = '1h' | '24h' | '7d' | '30d' | '365d';

/** GET /monitors/:id/stats — one monitor over a period (maintenance beats excluded). */
export interface MonitorPeriodStats {
  /** Checks in the period (beats recorded during a maintenance window excluded). */
  total: number;
  up: number;
  down: number;
  uptimePct: number;
  avgResponseTime: number | null;
  minResponseTime: number | null;
  maxResponseTime: number | null;
  period: string;
}

/** Periods accepted by GET /monitors/uptime-series. 24h is bucketed per hour, the others per day. */
export const UPTIME_SERIES_PERIODS = ['24h', '7d', '14d', '30d'] as const;
export type UptimeSeriesPeriod = (typeof UPTIME_SERIES_PERIODS)[number];

/**
 * One bucket of GET /monitors/uptime-series: the average uptime % of the
 * caller's visible monitors (agents excluded) over the bucket starting at `t`.
 */
export interface UptimeSeriesPoint {
  /** Bucket start (ISO 8601). */
  t: string;
  /** Average per-monitor uptime % in the bucket (0-100, 2 decimals). */
  uptime: number;
}

// ============================================
// Group types
// ============================================
export interface MonitorGroup {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  parentId: number | null;
  sortOrder: number;
  isGeneral: boolean;
  groupNotifications: boolean;
  tenantId: number;
  /** Agent-specific settings stored on every group — only meaningful when the
   *  group contains devices. Inert for groups that only hold monitors. */
  agentThresholds?: AgentThresholds | null;
  agentGroupConfig?: AgentGroupConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface GroupTreeNode extends MonitorGroup {
  children: GroupTreeNode[];
  monitors: Monitor[];
}

// ============================================
// Notification types
// ============================================
export interface NotificationChannel {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  createdBy: number | null;
  /** Owner tenant of this channel */
  tenantId?: number;
  /** True when this channel belongs to another tenant and is shared to the current one */
  isShared?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OverrideMode = 'merge' | 'replace' | 'exclude';

// ============================================
// Settings types
// ============================================
export type SettingsScope = 'global' | 'group' | 'monitor';

export interface SettingValue {
  value: number;
  source: SettingsScope | 'default';
  sourceId: number | null;
  sourceName: string;
}

export type ResolvedSettings = Record<SettingsKey, SettingValue>;

// ============================================
// Incident types
// ============================================
export interface Incident {
  id: number;
  monitorId: number;
  startedAt: string;
  resolvedAt: string | null;
  durationSec: number | null;
  previousStatus: MonitorStatus;
  newStatus: MonitorStatus;
  message: string | null;
}

// ============================================
// Maintenance Window types
// ============================================
export type MaintenanceScopeType = 'global' | 'group' | 'monitor' | 'agent';
export type MaintenanceScheduleType = 'one_time' | 'recurring';
export type MaintenanceRecurrenceType = 'daily' | 'weekly';

export interface MaintenanceWindow {
  id: number;
  /** Owner workspace (god-view badge). */
  tenantId?: number;
  name: string;
  scopeType: MaintenanceScopeType;
  scopeId: number | null;       // null for 'global' scope
  isOverride: boolean;          // DEPRECATED — kept for DB compat, ignored in logic
  scheduleType: MaintenanceScheduleType;
  // one_time
  startAt: string | null;
  endAt: string | null;
  // recurring
  startTime: string | null;   // 'HH:MM'
  endTime: string | null;     // 'HH:MM'
  recurrenceType: MaintenanceRecurrenceType | null;
  daysOfWeek: number[] | null; // 0=Mon … 6=Sun
  timezone: string;
  notifyChannelIds: number[];
  lastNotifiedStartAt: string | null;
  lastNotifiedEndAt: string | null;
  active: boolean;
  createdAt: string;
  // Computed by server (always present on API responses)
  isActiveNow?: boolean;
  scopeName?: string;
  // Computed for effective-windows view (present when fetched via /effective endpoint)
  source?: 'local' | 'group' | 'global';
  sourceId?: number | null;     // id of the owning group/monitor/agent (null for global)
  sourceName?: string;          // display name of the owning scope
  isDisabledHere?: boolean;     // true if this scope has disabled this inherited window
  canEdit?: boolean;            // true if the current scope owns this window
  canDelete?: boolean;          // true if the current scope owns this window
  canDisable?: boolean;         // true if inherited AND not yet disabled at this scope
  canEnable?: boolean;          // true if inherited AND currently disabled at this scope
}

export interface MaintenanceWindowDisable {
  id: number;
  windowId: number;
  scopeType: 'group' | 'monitor' | 'agent';
  scopeId: number;
  createdAt: string;
}

export interface CreateMaintenanceWindowRequest {
  name: string;
  scopeType: MaintenanceScopeType;
  scopeId?: number | null;      // omit / null for 'global'
  isOverride?: boolean;         // DEPRECATED, accepted for backward compat
  scheduleType: MaintenanceScheduleType;
  startAt?: string | null;
  endAt?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  recurrenceType?: MaintenanceRecurrenceType | null;
  daysOfWeek?: number[] | null;
  timezone?: string;
  notifyChannelIds?: number[];
  active?: boolean;
}

export type UpdateMaintenanceWindowRequest = Partial<CreateMaintenanceWindowRequest>;

// ============================================
// API types
// ============================================
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  pageSize: number;
}

export interface BulkEditRequest {
  monitorIds: number[];
  changes: Partial<Monitor>;
}

export interface CreateGroupRequest {
  name: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string | null;
  parentId?: number | null;
  sortOrder?: number;
  isGeneral?: boolean;
  groupNotifications?: boolean;
}

export interface MoveGroupRequest {
  newParentId: number | null;
}

// ============================================
// Notification API types
// ============================================
export interface CreateNotificationChannelRequest {
  name: string;
  type: string;
  config: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface UpdateNotificationChannelRequest {
  name?: string;
  config?: Record<string, unknown>;
  isEnabled?: boolean;
}

export interface NotificationBinding {
  id: number;
  channelId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId: number | null;
  overrideMode: OverrideMode;
}

export interface NotificationPluginMeta {
  type: string;
  name: string;
  description: string;
  configFields: NotificationConfigField[];
}

export interface NotificationConfigField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'url' | 'textarea' | 'boolean' | 'smtp_server_select' | 'select';
  placeholder?: string;
  required?: boolean;
  /** Choices for type: 'select' */
  options?: { value: string; label: string }[];
  /** Pre-selected value for type: 'select' when the config has no value yet */
  defaultValue?: string;
}

// ============================================
// SMTP Server types
// ============================================
export interface SmtpServer {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  fromAddress: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// App Config types
// ============================================

/** Obligate SSO gateway config — returned to clients (never exposes raw apiKey). */
export interface ObligateConfig {
  url: string | null;
  apiKeySet: boolean;
  enabled: boolean;
}

export interface AppConfig {
  allow_2fa: boolean;
  force_2fa: boolean;
  otp_smtp_server_id: number | null;
  /** Obligate SSO gateway URL — null when not configured. */
  obligate_url: string | null;
  /** Whether Obligate SSO is enabled. */
  obligate_enabled: boolean;
}


/**
 * Global agent defaults stored in app_config as JSON under key "agent_global_config".
 * These apply to all agents and agent groups unless overridden at the group or device level.
 * null = use the hardcoded system default.
 */
export interface AgentGlobalConfig {
  /** Default push interval in seconds (null = 60) */
  checkIntervalSeconds: number | null;
  /** Default heartbeat monitoring toggle (null = true) */
  heartbeatMonitoring: boolean | null;
  /** Default max missed pushes before offline (null = 2) */
  maxMissedPushes: number | null;
  /** Default notification types (null fields = use hardcoded DEFAULT_NOTIFICATION_TYPES) */
  notificationTypes: NotificationTypeConfig | null;
  /**
   * Global level of the agent update policy (null / absent = built-in
   * DEFAULT_AGENT_UPDATE_POLICY). 'off' here is the fleet-wide kill-switch.
   */
  updatePolicy?: AgentUpdatePolicy | null;
}

/** Hardcoded fallback for agent global config (bottom of inheritance chain) */
export const DEFAULT_AGENT_GLOBAL_CONFIG: Required<{
  checkIntervalSeconds: number;
  heartbeatMonitoring: boolean;
  maxMissedPushes: number;
}> = {
  checkIntervalSeconds: 60,
  heartbeatMonitoring: true,
  maxMissedPushes: 2,
};

// ============================================
// Team & Permission types
// ============================================
export type PermissionLevel = 'ro' | 'rw';
export type PermissionScope = 'group' | 'monitor';

export interface UserTeam {
  id: number;
  name: string;
  description: string | null;
  canCreate: boolean;
  tenantId: number;
  tenantName?: string; // populated by JOIN in getAll()
  createdAt: string;
  updatedAt: string;
}

export interface TeamPermission {
  id: number;
  teamId: number;
  scope: PermissionScope;
  scopeId: number;
  level: PermissionLevel;
}

export interface UserPermissions {
  canCreate: boolean;
  teams: number[];
  /**
   * EFFECTIVE map of "group:<id>" or "monitor:<id>" → permission level on the
   * active tenant: group grants are expanded to every descendant group and to
   * the monitors inside them (highest level wins), so a plain key lookup is
   * enough on the client. Empty for platform admins (they have everything).
   */
  permissions: Record<string, PermissionLevel>;
  /**
   * Tenant-wide capabilities on the active tenant, from the permission set of
   * the user's tenant role (user_tenants.role). Tenant role 'admin' and
   * platform admins get the whole catalogue (see TENANT_CAPABILITIES).
   */
  tenantCapabilities: string[];
}

/** Catalogue of tenant capabilities enforced by the server. */
export const TENANT_CAPABILITIES = [
  'monitors.manage',
  'groups.manage',
  'agents.manage',
  'notifications',
  'remediation',
  'maintenance',
  'settings',
  'users.manage',
  'supervision:read',
] as const;
export type TenantCapability = typeof TENANT_CAPABILITIES[number];

// ============================================
// Team API types
// ============================================
export interface CreateTeamRequest {
  name: string;
  description?: string | null;
  canCreate?: boolean;
  /** God View only: target tenant (ignored elsewhere; req.tenantId is used). */
  tenantId?: number;
}

export interface UpdateTeamRequest {
  name?: string;
  description?: string | null;
  canCreate?: boolean;
}

export interface SetTeamMembersRequest {
  userIds: number[];
}

export interface SetTeamPermissionsRequest {
  permissions: Array<{
    scope: PermissionScope;
    scopeId: number;
    level: PermissionLevel;
  }>;
}

// ============================================
// User API types
// ============================================
export interface CreateUserRequest {
  username: string;
  password: string;
  displayName?: string | null;
  role?: UserRole;
}

export interface UpdateUserRequest {
  username?: string;
  displayName?: string | null;
  role?: UserRole;
  isActive?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: User;
}

// ============================================
// Agent threshold types
// ============================================
export interface AgentMetricThreshold {
  enabled: boolean;
  threshold: number;
  op: '>' | '<' | '>=' | '<=';
}

/** Per-sensor temperature override (key = sensor label) */
export interface AgentTempSensorOverride {
  enabled: boolean;   // true = this sensor has its own settings (overrides global)
  op: '>' | '<' | '>=' | '<=';
  threshold: number;  // °C
}

/** Global temperature threshold + optional per-sensor overrides */
export interface AgentTempThreshold {
  globalEnabled: boolean;              // master on/off for all temp monitoring
  op: '>' | '<' | '>=' | '<=';        // global operator
  threshold: number;                   // global threshold in °C
  overrides: Record<string, AgentTempSensorOverride>;  // key = sensor label
}

export interface AgentThresholds {
  cpu: AgentMetricThreshold;
  memory: AgentMetricThreshold;
  disk: AgentMetricThreshold;
  netIn: AgentMetricThreshold;
  netOut: AgentMetricThreshold;
  temp?: AgentTempThreshold;
}

export const DEFAULT_AGENT_THRESHOLDS: AgentThresholds = {
  cpu:    { enabled: true,  threshold: 90,         op: '>' },
  memory: { enabled: true,  threshold: 90,         op: '>' },
  disk:   { enabled: true,  threshold: 90,         op: '>' },
  // Network thresholds stored in bytes/sec; 100 Mbps = 100 × 125 000 bytes/sec
  netIn:  { enabled: false, threshold: 12_500_000, op: '>' },
  netOut: { enabled: false, threshold: 12_500_000, op: '>' },
  temp:   { globalEnabled: false, op: '>', threshold: 85, overrides: {} },
};

/**
 * Per-type notification toggles.
 * Each field is `boolean | null` where null means "inherit from parent group / system default".
 * System defaults: global=true, down=true, up=true, alert=true, update=false.
 */
export interface NotificationTypeConfig {
  /** Master switch — if false no notifications are sent (channels remain bound but muted) */
  global: boolean | null;
  /** Notify when agent/monitor goes DOWN / offline */
  down: boolean | null;
  /** Notify when agent/monitor recovers (back UP) */
  up: boolean | null;
  /** Notify when agent threshold is breached (alert status) */
  alert: boolean | null;
  /** Notify when agent starts a self-update (default off) */
  update: boolean | null;
}

/** System defaults for notification types (used when no group/device override is set) */
export const DEFAULT_NOTIFICATION_TYPES: Required<{ [K in keyof NotificationTypeConfig]: boolean }> = {
  global: true,
  down:   true,
  up:     true,
  alert:  true,
  update: false,
};

/** Default group-level config for agent groups */
export interface AgentGroupConfig {
  /** Default push interval for agents in this group (null = device keeps its own) */
  pushIntervalSeconds: number | null;
  /** Default heartbeat monitoring toggle (null = device keeps its own) */
  heartbeatMonitoring: boolean | null;
  /** Consecutive missed pushes before declaring agent offline (null = system default of 2) */
  maxMissedPushes: number | null;
  /** Minimum seconds between repeated alert notifications (null = system default of 300) */
  notificationCooldownSeconds: number | null;
  /** Notification type toggles (null = inherit from parent group / system defaults) */
  notificationTypes: NotificationTypeConfig | null;
  /**
   * Group level of the agent update policy (null / absent = inherit), set
   * through PUT /groups/:id/agent-update-policy only. Inherited by the
   * sub-groups of the same workspace; 'off' freezes the whole sub-tree.
   */
  updatePolicy?: AgentUpdatePolicy | null;
}

// ============================================
// Agent update policy (global -> workspace -> group chain -> agent)
// ============================================

/**
 * - 'auto': the server queues the agent into the paced rollout as soon as a
 *   newer agent version is served;
 * - 'manual': nothing automatic, an admin queues updates (default);
 * - 'off': frozen — nothing automatic and manual update requests are refused.
 */
export type AgentUpdatePolicy = 'auto' | 'manual' | 'off';
export const AGENT_UPDATE_POLICIES: readonly AgentUpdatePolicy[] = ['auto', 'manual', 'off'];
/** Built-in default when no level sets a policy (the admin-paced behaviour). */
export const DEFAULT_AGENT_UPDATE_POLICY: AgentUpdatePolicy = 'manual';

/**
 * Level an effective policy comes from. 'unresolved': the policy lookup
 * failed — the server fails closed (treated as 'off', nothing is updated).
 */
export type AgentUpdatePolicySource = 'agent' | 'group' | 'tenant' | 'global' | 'default' | 'unresolved';

export interface ResolvedAgentUpdatePolicy {
  policy: AgentUpdatePolicy;
  source: AgentUpdatePolicySource;
  /** Group that sets the policy when source = 'group'. */
  sourceGroupId: number | null;
  sourceGroupName?: string | null;
}

/**
 * One level of the cascade as the settings UIs show it
 * (GET /admin/config/agent-update-policy, /tenants/:id/agent-update-policy,
 * /groups/:id/agent-update-policy).
 */
export interface AgentUpdatePolicyContext {
  /** Explicit value of this level (null = inherit). */
  ownPolicy: AgentUpdatePolicy | null;
  /** What applies at this level without its own value. */
  inherited: ResolvedAgentUpdatePolicy;
  /** What applies at this level (own value included; 'off' above always wins). */
  effective: ResolvedAgentUpdatePolicy;
  /** Explicit global value (null = built-in default). */
  globalPolicy: AgentUpdatePolicy | null;
  /** Explicit workspace value (null = inherit, and always null at the global level). */
  tenantPolicy: AgentUpdatePolicy | null;
}

// ============================================
// Agent types
// ============================================
export interface AgentApiKey {
  id: number;
  name: string;
  key: string;
  tenantId: number;
  createdBy: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceCount?: number;
  /**
   * Group a device enrolled with this key is approved into when the approval
   * names no group (single and bulk approval). Always a group of the key's
   * workspace; null = no default (the device stays without a group).
   */
  defaultGroupId: number | null;
  /** Name of defaultGroupId (listKeys only). */
  defaultGroupName?: string | null;
}

/** Approval state of an agent device (agent_devices.status). */
export type AgentApprovalStatus = 'pending' | 'approved' | 'refused' | 'suspended';

/**
 * Runtime state of an agent device, derived server-side (listDevices /
 * getDevice / AGENT_DEVICE_UPDATED) from the agent monitor status, the
 * update / uninstall lifecycle, maintenance windows and suspension.
 * Precedence: pending_uninstall > suspended (suspended or refused) >
 * updating > maintenance > alert / offline > update_error > online.
 */
export type AgentRuntimeStatus =
  | 'online'
  | 'offline'
  | 'alert'
  | 'maintenance'
  | 'updating'
  | 'update_error'
  | 'pending_uninstall'
  | 'suspended';

export const AGENT_RUNTIME_STATUSES: readonly AgentRuntimeStatus[] = [
  'online', 'offline', 'alert', 'maintenance', 'updating', 'update_error', 'pending_uninstall', 'suspended',
];

/**
 * One-shot commands the server may queue for an agent (pending_command).
 * Delivered as `command` (+ `commandPayload`) in the HTTP push response and
 * in the WS `config` frame:
 *  - 'uninstall': no payload;
 *  - 'update': { targetVersion } — admin-paced rollout;
 *  - 'reconfigure': { apiKey, serverUrl? } — tenant transfer.
 */
export const AGENT_COMMANDS = ['uninstall', 'update', 'reconfigure'] as const;
export type AgentCommand = typeof AGENT_COMMANDS[number];

/** GET-like preview / state of the admin-paced agent update rollout. */
export interface AgentUpdateRolloutState {
  /** Version this server ships (agent/VERSION); null when unknown. */
  latestVersion: string | null;
  /** Eligible outdated devices (approved, not uninstalling) with no outstanding update. */
  targets: number;
  /** Updates queued, waiting for a free slot / the device's next contact. */
  queued: number;
  /** Updates handed to the agent, not confirmed yet. */
  inProgress: number;
  /** Devices whose last update failed (update_error). */
  failed: number;
  /** Outdated eligible devices whose update policy is 'off' (frozen, never updated; not in targets). */
  frozen: number;
  /** Outdated eligible devices whose update policy is 'auto' (queued automatically). */
  auto: number;
  /** Rollout pace: at most maxPerWindow updates handed out per windowSeconds (fleet-wide). */
  pace: { maxPerWindow: number; windowSeconds: number };
  /** AGENT_LEGACY_AUTO_UPDATE=true: agents still self-update on every push. */
  legacyAutoUpdate: boolean;
}

/** Result of POST /agent/devices/:id/update, /devices/bulk-update and /update-all. */
export interface AgentUpdateRequestResult {
  targetVersion: string | null;
  /** Updates newly queued. */
  queued: number;
  /** Devices that already had an outstanding update (one per device). */
  alreadyQueued: number;
  /** Devices already running targetVersion. */
  upToDate: number;
  /** Devices that never receive an update (pending / refused / suspended / uninstalling / proxy). */
  ineligible: number;
  /** Devices whose effective update policy is 'off' (frozen): nothing queued. */
  frozen: number;
}

/** Result of POST /agent/devices/batch/transfer. */
export interface AgentTransferResult {
  transferred: number;
  /** Ids not found in the caller's scope, or already in the target workspace. */
  skipped: number;
  failed: number;
}

/**
 * Per-device UI display preferences stored in agent_devices.display_config (JSONB).
 * All fields are optional; missing fields fall back to defaults (everything visible).
 */
export interface AgentDisplayConfig {
  cpu: {
    /** Show 2 stacked mini-bars per physical core instead of 2-column thread grid */
    groupCoreThreads: boolean;
    /** Physical core indices (0-based) to hide from the overview card */
    hiddenCores: number[];
    /** Temperature sensor label to use for the CPU temp chart (null = average all) */
    tempSensor: string | null;
    /** Detail-page chart IDs to hide: 'load-avg' | 'temp' | 'freq' */
    hiddenCharts: string[];
  };
  ram: {
    hideUsed: boolean;
    hideFree: boolean;
    hideSwap: boolean;
    /** Detail-page chart IDs to hide: 'pct' | 'used-mb' | 'swap' */
    hiddenCharts: string[];
  };
  gpu: {
    /** Row labels to hide from the overview card (e.g. 'Copy', 'Encode', 'VRAM') */
    hiddenRows: string[];
    /** Detail-page chart IDs to hide: 'util' | 'vram' | 'temp' */
    hiddenCharts: string[];
  };
  drives: {
    /** Mount paths to hide from the overview card */
    hiddenMounts: string[];
    /** mount → custom display name */
    renames: Record<string, string>;
    /** Detail page: combine Read+Write into one dual-series chart */
    combineReadWrite: boolean;
  };
  network: {
    /** Interface names to hide from the overview card */
    hiddenInterfaces: string[];
    /** interface name → custom display name */
    renames: Record<string, string>;
    /** Detail page: combine IN+OUT into one dual-series chart */
    combineInOut: boolean;
  };
  temps: {
    /** Sensor labels to hide from the overview card */
    hiddenLabels: string[];
  };
}

export interface AgentDevice {
  id: number;
  uuid: string;
  hostname: string;
  tenantId: number;
  /** Custom display name — shown instead of hostname when set */
  name: string | null;
  ip: string | null;
  osInfo: {
    platform: string;
    distro: string | null;
    release: string | null;
    arch: string;
  } | null;
  agentVersion: string | null;
  apiKeyId: number | null;
  /** 'agent' = lightweight Go agent, 'proxy' = full Obliview proxy stub */
  deviceType: 'agent' | 'proxy';
  /** Approval state (agent_devices.status). Same value as approvalStatus. */
  status: AgentApprovalStatus;
  /** Approval state — explicit alias of `status`. */
  approvalStatus: AgentApprovalStatus;
  /** Derived runtime state (see AgentRuntimeStatus). */
  runtimeStatus: AgentRuntimeStatus;
  /** When false: agent going offline → 'inactive' (grey), no notification */
  heartbeatMonitoring: boolean;
  checkIntervalSeconds: number;
  /** Per-device notification cooldown override (null = inherit from group/global default of 300s) */
  notificationCooldownSeconds: number | null;
  approvedBy: number | null;
  approvedAt: string | null;
  groupId: number | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Map of sensorKey → human-readable display name.
   * Key format: "temp:<raw_label>" — matches threshold override keys.
   * Example: { "temp:acpitz-acpi-0": "Motherboard", "temp:CPU Package": "CPU" }
   */
  sensorDisplayNames: Record<string, string> | null;
  /**
   * When false the device inherits checkIntervalSeconds, heartbeatMonitoring and
   * maxMissedPushes from the parent group's agent_group_config.
   * The existing checkIntervalSeconds field holds the device-level value and is
   * used when overrideGroupSettings = true.
   */
  overrideGroupSettings: boolean;
  /** Resolved effective settings (accounts for group inheritance when override=false) */
  resolvedSettings: {
    checkIntervalSeconds: number;
    heartbeatMonitoring: boolean;
    maxMissedPushes: number;
  };
  /**
   * Raw agent_group_config from the parent group (null if device has no group or
   * the group has no config set).  Unlike resolvedSettings this is never affected
   * by overrideGroupSettings — it always reflects what the group itself defines.
   * The UI uses this to display "inherited from group" values and to write the
   * correct value to the device column when a per-field override is disabled.
   */
  groupSettings: AgentGroupConfig | null;
  /** Parent group's agent_thresholds — used as the "inherited" baseline in the threshold editor */
  groupThresholds?: AgentThresholds | null;
  /** Per-device UI display preferences (hidden cores, renamed drives, combined charts, etc.) */
  displayConfig: AgentDisplayConfig | null;
  /**
   * Command queued by an admin, delivered to the agent on its next push.
   * Cleared once the command has been sent to the agent.
   * Values: AgentCommand ('uninstall' | 'update' | 'reconfigure').
   */
  pendingCommand?: string | null;
  /**
   * Timestamp at which the 'uninstall' command was delivered to the agent.
   * Used by the cleanup job to auto-delete the device ~10 minutes after delivery.
   */
  uninstallCommandedAt?: string | null;
  /** When an admin queued the uninstall (null = none requested). */
  uninstallRequestedAt?: string | null;
  /** An admin-queued agent update is outstanding since this time (null = none). */
  updateRequestedAt?: string | null;
  /** When the queued 'update' command was handed to the agent. */
  updateSentAt?: string | null;
  /** The last update failed at this time (cleared by a new request or a success). */
  updateErrorAt?: string | null;
  /** Short reason of the last update failure ('timeout', 'version_unchanged'…). */
  updateError?: string | null;
  /** Version the outstanding update installs. */
  targetVersion?: string | null;
  /** Device level of the update policy (null = inherit). */
  updatePolicy?: AgentUpdatePolicy | null;
  /** Effective update policy and the level it comes from ('off' above always wins). */
  resolvedUpdatePolicy?: ResolvedAgentUpdatePolicy;
  /** What the device would get without its own value (the "inherited" display). */
  inheritedUpdatePolicy?: ResolvedAgentUpdatePolicy;
  /**
   * Set when the agent notifies the server it is about to self-update.
   * While set (and within 10 minutes), the device shows "UPDATING" status and
   * is excluded from downtime / uptime calculations.
   * Cleared on the next successful push, or by the cleanup job after 10 minutes.
   */
  updatingSince?: string | null;
  /** Free-form notes about this device */
  notes: string | null;
  inMaintenance?: boolean;
  /**
   * Device-level notification type override.
   * null = inherit from parent group chain (see resolvedNotificationTypes for effective values).
   * When set, overrides the group's notification type settings.
   */
  notificationTypes?: NotificationTypeConfig | null;
  /** Resolved effective notification types (device → group hierarchy → defaults) */
  resolvedNotificationTypes?: {
    global: boolean;
    down: boolean;
    up: boolean;
    alert: boolean;
    update: boolean;
  };
}

// ============================================
// Remediation types
// ============================================
export type RemediationActionType = 'webhook' | 'n8n' | 'script' | 'docker_restart' | 'ssh';
export type RemediationTrigger   = 'down' | 'up' | 'both';
export type RemediationRunStatus = 'success' | 'failed' | 'timeout' | 'cooldown_skip';
export type OverrideModeR        = 'merge' | 'replace' | 'exclude';

/** Config shapes stored in remediation_actions.config (JSONB) */
export interface WebhookRemediationConfig {
  platform?: 'n8n' | 'make' | 'zapier' | null;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers?: Record<string, string>;
  bodyExtra?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ScriptRemediationConfig {
  script: string;
  shell?: string;
  timeoutMs?: number;
}

export interface DockerRestartRemediationConfig {
  containerName: string;
  socketPath?: string;
}

export interface SshRemediationConfig {
  host: string;
  port?: number;
  username: string;
  authType: 'password' | 'key';
  /** AES-256-GCM encrypted credential — never returned in plaintext */
  credentialEnc?: string;
  command: string;
  timeoutMs?: number;
}

export interface RemediationAction {
  id: number;
  name: string;
  type: RemediationActionType;
  config: WebhookRemediationConfig | ScriptRemediationConfig | DockerRestartRemediationConfig | SshRemediationConfig;
  enabled: boolean;
  /** Owning tenant — an action only ever runs for monitors of this tenant */
  tenantId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemediationBinding {
  id: number;
  actionId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId: number | null;
  overrideMode: OverrideModeR;
  triggerOn: RemediationTrigger;
  cooldownSeconds: number;
}

export interface ResolvedRemediationBinding extends RemediationBinding {
  action: RemediationAction;
  inheritedFrom?: 'global' | 'group';  // present when not directly bound at this scope
}

/** Config-free action view returned outside the admin action CRUD (never exposes url/headers/script/SSH target) */
export interface RemediationActionSummary {
  id: number;
  name: string;
  type: RemediationActionType;
  enabled: boolean;
}

/** Entry returned by GET /remediation/resolved (inheritance display) */
export interface ResolvedRemediationBindingView extends RemediationBinding {
  action: RemediationActionSummary;
  source: 'global' | 'group' | 'monitor';
  sourceId: number | null;
  isDirect: boolean;
}

/** GET /remediation/resolved result (`data` entries + top-level `tenantId` of the target) */
export interface ResolvedRemediationBindings {
  bindings: ResolvedRemediationBindingView[];
  /** Only actions of this tenant can be bound to / run for the target */
  tenantId: number;
}

export interface RemediationRun {
  id: number;
  actionId: number;
  monitorId: number;
  triggeredBy: 'down' | 'up';
  status: RemediationRunStatus;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  triggeredAt: string;
  actionName?: string;  // joined
}

export interface CreateRemediationActionRequest {
  name: string;
  type: RemediationActionType;
  config: Record<string, unknown>;
  enabled?: boolean;
  /** Target tenant — honored only in God View (defaults to the active tenant) */
  tenantId?: number;
}

export interface UpdateRemediationActionRequest {
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface AddRemediationBindingRequest {
  actionId: number;
  scope: 'global' | 'group' | 'monitor';
  scopeId?: number | null;
  overrideMode?: OverrideModeR;
  triggerOn?: RemediationTrigger;
  cooldownSeconds?: number;
}

// ============================================
// Tenant types (multi-tenancy)
// ============================================
export interface Tenant {
  id: number;
  name: string;
  slug: string;
  /** Workspace level of the agent update policy (null = inherit the global one). */
  agentUpdatePolicy?: AgentUpdatePolicy | null;
  createdAt: string;
  updatedAt: string;
}

/** Tenant-level role (user_tenants.role). Since migration 053 this is a
 *  permission_set slug: 'admin' | 'user' | 'viewer' | any custom slug.
 *  'admin' is special: it short-circuits the capability matrix on the server.
 *  The legacy 'member' value is obsolete (migrated to 'user'). */
export type TenantRole = string;

export interface TenantMembership {
  tenantId: number;
  userId: number;
  role: TenantRole;
}

export interface TenantWithRole extends Tenant {
  role: TenantRole;
}

/** Returned by GET /api/users/:id/tenants — all tenants with this user's membership info.
 *  `role` is a permission_set slug (e.g. 'admin', 'user', 'viewer', or a custom slug).
 *  'admin' is special: it short-circuits the capability matrix on the server. */
export interface UserTenantAssignment {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  isMember: boolean;
  role: string;
}
