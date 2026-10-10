import { useTranslation } from 'react-i18next';
import type { SettingValue } from '@obliview/shared';

interface InheritanceBadgeProps {
  setting: SettingValue;
}

/** Amber pill: the value is set at this level (overrides what is inherited). */
export function OverrideBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
      {t('settingsInheritance.overridden', 'Override')}
    </span>
  );
}

/**
 * Where an inherited setting value comes from: the hardcoded default, the
 * workspace defaults (scope 'global', tenant-wide), a group, or the monitor's
 * own override.
 */
export function InheritanceBadge({ setting }: InheritanceBadgeProps) {
  const { t } = useTranslation();

  if (setting.source === 'default') {
    return (
      <span className="text-xs text-text-muted" title={t('settingsInheritance.defaultTitle', 'Built-in default value')}>
        {t('settingsInheritance.default', 'Default')}
      </span>
    );
  }

  if (setting.source === 'global') {
    return (
      <span className="text-xs text-accent" title={t('settingsInheritance.workspaceTitle', 'Inherited from the workspace defaults')}>
        {t('settingsInheritance.workspace', 'Workspace')}
      </span>
    );
  }

  if (setting.source === 'group') {
    return (
      <span
        className="text-xs text-accent truncate max-w-[12rem]"
        title={t('settingsInheritance.groupTitle', { defaultValue: 'Inherited from the group "{{name}}"', name: setting.sourceName })}
      >
        {setting.sourceName}
      </span>
    );
  }

  if (setting.source === 'monitor') {
    return <OverrideBadge />;
  }

  return null;
}
