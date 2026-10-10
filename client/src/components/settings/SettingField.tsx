import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SettingValue, SettingsScope } from '@obliview/shared';
import type { SettingsKey, SettingDefinition } from '@obliview/shared';
import { InheritanceBadge, OverrideBadge } from './InheritanceBadge';

interface SettingFieldProps {
  definition: SettingDefinition;
  inheritedValue: SettingValue;
  overrideValue: number | undefined;
  scope: SettingsScope;
  onSave: (key: SettingsKey, value: number) => Promise<void>;
  onReset: (key: SettingsKey) => Promise<void>;
}

/**
 * Translated label / description / unit of a setting definition:
 * SETTINGS_DEFINITIONS carries the i18n keys (labelKey / descriptionKey /
 * unitKey) and the English text, used as the fallback.
 */
export function settingDefinitionText(t: TFunction, definition: SettingDefinition) {
  return {
    label: t(definition.labelKey, definition.label),
    description: t(definition.descriptionKey, definition.description),
    unit: t(definition.unitKey, definition.unit),
  };
}

export function SettingField({
  definition,
  inheritedValue,
  overrideValue,
  scope,
  onSave,
  onReset,
}: SettingFieldProps) {
  const { t } = useTranslation();
  const text = settingDefinitionText(t, definition);
  const hasOverride = overrideValue !== undefined;
  const [isOverriding, setIsOverriding] = useState(hasOverride);
  const [localValue, setLocalValue] = useState<number>(overrideValue ?? inheritedValue.value);
  const [saving, setSaving] = useState(false);

  const handleToggleOverride = async () => {
    if (isOverriding) {
      // Reset to inherited
      setSaving(true);
      try {
        await onReset(definition.key);
        setIsOverriding(false);
        setLocalValue(inheritedValue.value);
      } finally {
        setSaving(false);
      }
    } else {
      // Start overriding
      setIsOverriding(true);
      setLocalValue(inheritedValue.value);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(definition.key, localValue);
    } finally {
      setSaving(false);
    }
  };

  const handleBlur = () => {
    if (isOverriding && localValue !== overrideValue) {
      handleSave();
    }
  };

  const inputId = `setting-${scope}-${definition.key}`;

  return (
    <div className="flex items-center gap-4 py-3 border-b border-border last:border-b-0">
      {/* Label and description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <label htmlFor={inputId} className="text-sm font-medium text-text-primary">{text.label}</label>
          {scope !== 'global' && (
            isOverriding ? <OverrideBadge /> : <InheritanceBadge setting={inheritedValue} />
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5">{text.description}</p>
      </div>

      {/* Value input */}
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="number"
          value={isOverriding ? localValue : inheritedValue.value}
          onChange={(e) => setLocalValue(parseInt(e.target.value, 10) || 0)}
          onBlur={handleBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleBlur();
          }}
          disabled={scope !== 'global' && !isOverriding}
          min={definition.min}
          max={definition.max}
          className={`w-24 rounded-md border px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-accent ${
            scope !== 'global' && !isOverriding
              ? 'border-border bg-bg-tertiary text-text-muted cursor-not-allowed'
              : 'border-border bg-bg-tertiary text-text-primary'
          }`}
        />
        <span className="text-xs text-text-muted w-12">{text.unit}</span>
      </div>

      {/* Override toggle / reset button (not shown for global scope) */}
      {scope !== 'global' && (
        <button
          type="button"
          onClick={handleToggleOverride}
          disabled={saving}
          className={`shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors ${
            isOverriding
              ? 'text-amber-500 hover:bg-amber-500/10'
              : 'text-text-muted hover:bg-bg-hover hover:text-text-primary'
          }`}
          title={isOverriding
            ? t('settingsInheritance.resetTitle', 'Reset to inherited')
            : t('settingsInheritance.overrideTitle', 'Override locally')}
        >
          {isOverriding ? (
            <span className="flex items-center gap-1">
              <RotateCcw size={12} />
              {t('common.reset', 'Reset')}
            </span>
          ) : (
            t('common.override', 'Override')
          )}
        </button>
      )}
    </div>
  );
}
