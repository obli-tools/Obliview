export const SETTINGS_KEYS = {
  CHECK_INTERVAL: 'check_interval',
  RETRY_INTERVAL: 'retry_interval',
  MAX_RETRIES: 'max_retries',
  TIMEOUT: 'timeout',
  NOTIFICATION_COOLDOWN: 'notification_cooldown',
  HEARTBEAT_RETENTION_DAYS: 'heartbeat_retention_days',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

export interface SettingDefinition {
  key: SettingsKey;
  /** English label — fallback when `labelKey` has no translation (server logs, API) */
  label: string;
  /** i18n key of the label (client: t(labelKey, label)) */
  labelKey: string;
  /** English description — fallback for `descriptionKey` */
  description: string;
  /** i18n key of the description (client: t(descriptionKey, description)) */
  descriptionKey: string;
  type: 'number';
  unit: string;
  /** i18n key of the unit (client: t(unitKey, unit)) */
  unitKey: string;
  default: number;
  min: number;
  max: number;
}

export const SETTINGS_DEFINITIONS: SettingDefinition[] = [
  {
    key: SETTINGS_KEYS.CHECK_INTERVAL,
    label: 'Check Interval',
    labelKey: 'settingDefs.check_interval.label',
    description: 'How often to perform checks',
    descriptionKey: 'settingDefs.check_interval.description',
    type: 'number',
    unit: 'seconds',
    unitKey: 'settingDefs.units.seconds',
    default: 60,
    min: 1,
    max: 86400,
  },
  {
    key: SETTINGS_KEYS.RETRY_INTERVAL,
    label: 'Retry Interval',
    labelKey: 'settingDefs.retry_interval.label',
    description: 'Interval between retries on failure',
    descriptionKey: 'settingDefs.retry_interval.description',
    type: 'number',
    unit: 'seconds',
    unitKey: 'settingDefs.units.seconds',
    default: 20,
    min: 1,
    max: 3600,
  },
  {
    key: SETTINGS_KEYS.MAX_RETRIES,
    label: 'Max Retries',
    labelKey: 'settingDefs.max_retries.label',
    description: 'Number of retries before marking as DOWN',
    descriptionKey: 'settingDefs.max_retries.description',
    type: 'number',
    unit: 'retries',
    unitKey: 'settingDefs.units.retries',
    default: 3,
    min: 0,
    max: 20,
  },
  {
    key: SETTINGS_KEYS.TIMEOUT,
    label: 'Timeout',
    labelKey: 'settingDefs.timeout.label',
    description: 'Check timeout duration',
    descriptionKey: 'settingDefs.timeout.description',
    type: 'number',
    unit: 'ms',
    unitKey: 'settingDefs.units.ms',
    default: 5000,
    min: 1000,
    max: 60000,
  },
  {
    key: SETTINGS_KEYS.NOTIFICATION_COOLDOWN,
    label: 'Notification Cooldown',
    labelKey: 'settingDefs.notification_cooldown.label',
    description: 'Minimum time between repeated notifications',
    descriptionKey: 'settingDefs.notification_cooldown.description',
    type: 'number',
    unit: 'seconds',
    unitKey: 'settingDefs.units.seconds',
    default: 300,
    min: 0,
    max: 86400,
  },
  {
    key: SETTINGS_KEYS.HEARTBEAT_RETENTION_DAYS,
    label: 'Heartbeat Retention',
    labelKey: 'settingDefs.heartbeat_retention_days.label',
    description: 'How long to keep heartbeat data',
    descriptionKey: 'settingDefs.heartbeat_retention_days.description',
    type: 'number',
    unit: 'days',
    unitKey: 'settingDefs.units.days',
    // 90 days: the hard-coded purge horizon before the setting was honoured
    // (upgraded installs keep their footprint); a workspace can raise it.
    default: 90,
    min: 1,
    max: 3650,
  },
];

export const HARDCODED_DEFAULTS: Record<SettingsKey, number> = {
  [SETTINGS_KEYS.CHECK_INTERVAL]: 60,
  [SETTINGS_KEYS.RETRY_INTERVAL]: 20,
  [SETTINGS_KEYS.MAX_RETRIES]: 3,
  [SETTINGS_KEYS.TIMEOUT]: 5000,
  [SETTINGS_KEYS.NOTIFICATION_COOLDOWN]: 300,
  [SETTINGS_KEYS.HEARTBEAT_RETENTION_DAYS]: 90,
};
