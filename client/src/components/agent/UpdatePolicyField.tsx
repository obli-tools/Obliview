import { useState } from 'react';
import { Lock, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import toast from 'react-hot-toast';
import type { AgentUpdatePolicy, ResolvedAgentUpdatePolicy } from '@obliview/shared';
import { AGENT_UPDATE_POLICIES, DEFAULT_AGENT_UPDATE_POLICY } from '@obliview/shared';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// Agent update policy UI (global -> workspace -> group chain -> agent).
// 'off' at any level is absolute; otherwise the nearest explicit value wins;
// nothing set = 'manual'. The server resolves; these only display.
// ─────────────────────────────────────────────────────────────────────────────

export type UpdatePolicyLevel = 'global' | 'tenant' | 'group' | 'agent';

/** "Automatic" / "Manual" / "Frozen". */
export function updatePolicyLabel(t: TFunction, policy: AgentUpdatePolicy): string {
  switch (policy) {
    case 'auto': return t('agentUpdatePolicy.policy.auto', 'Automatic');
    case 'manual': return t('agentUpdatePolicy.policy.manual', 'Manual');
    default: return t('agentUpdatePolicy.policy.off', 'Frozen');
  }
}

/** Option label of the policy select (more explicit than the badge). */
function updatePolicyOptionLabel(t: TFunction, policy: AgentUpdatePolicy): string {
  switch (policy) {
    case 'auto': return t('agentUpdatePolicy.option.auto', 'Automatic — update as soon as a new version is served');
    case 'manual': return t('agentUpdatePolicy.option.manual', 'Manual — an admin starts updates');
    default: return t('agentUpdatePolicy.option.off', 'Frozen — no updates, even manual');
  }
}

/** Where a resolved policy comes from: "Global", "Workspace", group "X", "this agent"… */
export function updatePolicySourceText(t: TFunction, r: ResolvedAgentUpdatePolicy): string {
  switch (r.source) {
    case 'agent': return t('agentUpdatePolicy.source.agent', 'this agent');
    case 'group': return t('agentUpdatePolicy.source.group', {
      defaultValue: 'group "{{name}}"',
      name: r.sourceGroupName ?? `#${r.sourceGroupId ?? '?'}`,
    });
    case 'tenant': return t('agentUpdatePolicy.source.tenant', 'Workspace');
    case 'global': return t('agentUpdatePolicy.source.global', 'Global');
    case 'unresolved': return t('agentUpdatePolicy.source.unresolved', 'unresolved (updates held)');
    default: return t('agentUpdatePolicy.source.default', 'Built-in default');
  }
}

/**
 * Message of a failed update request: a 409 AGENT_UPDATE_FROZEN names the
 * level that froze the agent (translated here); anything else falls back to
 * the server message / `fallback`.
 */
export function agentUpdateErrorMessage(err: unknown, t: TFunction, fallback: string): string {
  const data = (err as { response?: { data?: { code?: unknown; data?: { frozenBy?: ResolvedAgentUpdatePolicy } } } })
    ?.response?.data;
  if (data?.code === 'AGENT_UPDATE_FROZEN') {
    const by = data.data?.frozenBy;
    return by
      ? t('agentUpdatePolicy.errors.frozenBy', {
          defaultValue: 'Updates of this agent are frozen by {{source}}',
          source: updatePolicySourceText(t, by),
        })
      : t('agentUpdatePolicy.errors.frozen', 'Updates of this agent are frozen');
  }
  return apiErrorMessage(err, fallback);
}

/** Label of a disabled "Update now" action on a frozen agent. */
export function frozenUpdateHint(t: TFunction, r: ResolvedAgentUpdatePolicy | undefined | null): string | undefined {
  if (!r || r.policy !== 'off') return undefined;
  return t('agentUpdatePolicy.frozenHint', {
    defaultValue: 'Frozen by {{source}}',
    source: updatePolicySourceText(t, r),
  });
}

/** Pill of an effective policy; 'off' is shown as a padlocked "Frozen". */
export function UpdatePolicyBadge({ policy, title, className }: {
  policy: AgentUpdatePolicy;
  title?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
        policy === 'auto' && 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500',
        policy === 'manual' && 'border-border bg-bg-tertiary text-text-secondary',
        policy === 'off' && 'border-amber-500/40 bg-amber-500/10 text-amber-500',
        className,
      )}
    >
      {policy === 'off' && <Lock size={10} />}
      {updatePolicyLabel(t, policy)}
    </span>
  );
}

/** Badge + "(source)" tooltip for an agent row. */
export function ResolvedUpdatePolicyBadge({ resolved }: { resolved: ResolvedAgentUpdatePolicy | undefined | null }) {
  const { t } = useTranslation();
  if (!resolved) return null;
  return (
    <UpdatePolicyBadge
      policy={resolved.policy}
      title={t('agentUpdatePolicy.effectiveFrom', {
        defaultValue: 'Update policy: {{policy}} (from {{source}})',
        policy: updatePolicyLabel(t, resolved.policy),
        source: updatePolicySourceText(t, resolved),
      })}
    />
  );
}

/**
 * Workspace level, client mirror of the server resolver for the two upper
 * levels: global 'off' wins, else the workspace value, else the global one,
 * else the built-in default.
 */
export function resolveTenantLevel(
  tenantPolicy: AgentUpdatePolicy | null,
  globalPolicy: AgentUpdatePolicy | null,
): { inherited: ResolvedAgentUpdatePolicy; effective: ResolvedAgentUpdatePolicy } {
  const inherited: ResolvedAgentUpdatePolicy = globalPolicy
    ? { policy: globalPolicy, source: 'global', sourceGroupId: null }
    : { policy: DEFAULT_AGENT_UPDATE_POLICY, source: 'default', sourceGroupId: null };
  const effective: ResolvedAgentUpdatePolicy = globalPolicy === 'off' || !tenantPolicy
    ? inherited
    : { policy: tenantPolicy, source: 'tenant', sourceGroupId: null };
  return { inherited, effective };
}

/** True when a level ABOVE the edited one froze updates (its own value has no effect). */
function isFrozenAbove(effective: ResolvedAgentUpdatePolicy, level: UpdatePolicyLevel, selfGroupId?: number | null): boolean {
  if (effective.policy !== 'off') return false;
  if (effective.source === 'unresolved') return true;
  if (effective.source !== level) return true;
  return level === 'group' && selfGroupId != null && effective.sourceGroupId !== selfGroupId;
}

export interface UpdatePolicyFieldProps {
  level: UpdatePolicyLevel;
  /** Id of the edited group (level 'group'), to tell its own freeze from an ancestor's. */
  selfGroupId?: number | null;
  /** Explicit value of this level (null = inherit / built-in default). */
  ownPolicy: AgentUpdatePolicy | null;
  /** What applies here without the own value. */
  inherited: ResolvedAgentUpdatePolicy;
  /** What applies here. */
  effective: ResolvedAgentUpdatePolicy;
  canEdit: boolean;
  /** Persist a new value (null = reset to inherited). Throws on failure. */
  onChange: (policy: AgentUpdatePolicy | null) => Promise<void>;
  label?: string;
  description?: string;
  /** 'row': compact single line (agent detail); 'block': label + description above. */
  layout?: 'row' | 'block';
  className?: string;
}

/**
 * Update policy field with the settings-inheritance UX: inherited value and
 * its source, Override (pins the inherited value, then pick another one) and
 * Reset (back to inherited).
 */
export function UpdatePolicyField({
  level, selfGroupId, ownPolicy, inherited, effective, canEdit, onChange,
  label, description, layout = 'block', className,
}: UpdatePolicyFieldProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const overriding = ownPolicy !== null;
  const frozenAbove = isFrozenAbove(effective, level, selfGroupId);
  const title = label ?? t('agentUpdatePolicy.title', 'Agent updates');

  const save = async (policy: AgentUpdatePolicy | null) => {
    setSaving(true);
    try {
      await onChange(policy);
      toast.success(t('agentUpdatePolicy.saved', 'Update policy saved'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agentUpdatePolicy.failedSave', 'Failed to save the update policy')));
    } finally {
      setSaving(false);
    }
  };

  const inheritedLabel = level === 'global'
    ? t('agentUpdatePolicy.builtInDefault', 'Built-in default')
    : t('agentUpdatePolicy.inheritedFrom', {
        defaultValue: 'Inherited from {{source}}',
        source: updatePolicySourceText(t, inherited),
      });

  const control = (
    <div className="flex items-center gap-2 flex-wrap min-w-0">
      {overriding ? (
        <select
          value={ownPolicy ?? inherited.policy}
          onChange={(e) => void save(e.target.value as AgentUpdatePolicy)}
          disabled={!canEdit || saving}
          aria-label={title}
          className="rounded-md border border-border bg-bg-tertiary px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60 max-w-full"
        >
          {AGENT_UPDATE_POLICIES.map((p) => (
            <option key={p} value={p}>{updatePolicyOptionLabel(t, p)}</option>
          ))}
        </select>
      ) : (
        <>
          <UpdatePolicyBadge policy={inherited.policy} />
          <span className="text-xs text-text-muted">{inheritedLabel}</span>
        </>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={() => void save(overriding ? null : inherited.policy)}
          disabled={saving}
          className={cn(
            'shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors coarse:min-h-10',
            overriding
              ? 'text-amber-500 hover:bg-amber-500/10'
              : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
          )}
          title={overriding
            ? (level === 'global'
                ? t('agentUpdatePolicy.resetDefaultTitle', 'Back to the built-in default (manual)')
                : t('agentUpdatePolicy.resetTitle', 'Reset to inherited'))
            : t('agentUpdatePolicy.overrideTitle', 'Set a value at this level')}
        >
          {overriding ? (
            <span className="flex items-center gap-1"><RotateCcw size={12} />{t('common.reset', 'Reset')}</span>
          ) : t('common.override', 'Override')}
        </button>
      )}
    </div>
  );

  const chip = overriding ? (
    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 font-medium">{t('common.override', 'Override')}</span>
  ) : (
    <span className="text-xs px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">
      {level === 'global' ? t('agentUpdatePolicy.default', 'Default') : t('common.inherit', 'Inherit')}
    </span>
  );

  const frozenNote = frozenAbove ? (
    <p className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-500">
      <Lock size={12} className="mt-0.5 shrink-0" />
      <span>
        {t('agentUpdatePolicy.frozenAbove', {
          defaultValue: 'Updates are frozen by {{source}}: nothing set here applies until it is unfrozen.',
          source: updatePolicySourceText(t, effective),
        })}
      </span>
    </p>
  ) : null;

  if (layout === 'row') {
    return (
      <div className={cn('py-3 border-b border-border', className)}>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-text-primary w-40">{title}</span>
          {chip}
          {control}
        </div>
        {frozenNote}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-start justify-between gap-4 max-sm:flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-primary flex items-center gap-2 flex-wrap">
            {title}
            {chip}
          </div>
          <div className="text-xs text-text-muted mt-0.5">
            {description ?? t(
              'agentUpdatePolicy.description',
              'Automatic: agents are queued into the paced rollout as soon as a newer version is served. Manual: an admin starts updates. Frozen: no update at all, even manual ("off" at any level wins over everything below it).',
            )}
          </div>
        </div>
        <div className="shrink-0 max-w-full">{control}</div>
      </div>
      {frozenNote}
    </div>
  );
}
