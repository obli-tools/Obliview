import { useState, useEffect, useId } from 'react';
import { CalendarClock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  MaintenanceWindow,
  CreateMaintenanceWindowRequest,
  MaintenanceScopeType,
  MaintenanceScheduleType,
  MaintenanceRecurrenceType,
  NotificationChannel,
} from '@obliview/shared';
import { cn } from '@/utils/cn';
import { apiErrorMessage } from '@/utils/apiError';
import { anonymize } from '@/utils/anonymize';
import { maintenanceApi } from '@/api/maintenance.api';
import { notificationsApi } from '@/api/notifications.api';
import { ScopeSelector } from './ScopeSelector';
import type { ScopeTarget } from './ScopeSelector';
import { Checkbox } from '@/components/ui/Checkbox';
import { Modal } from '@/components/common/Modal';
import { TenantBadge } from '@/components/common/TenantBadge';

/**
 * Convert a UTC ISO string to the "YYYY-MM-DDTHH:MM" format expected by
 * <input type="datetime-local">, expressed in the browser's local timezone.
 * (The datetime-local input has no timezone concept — it always shows/reads
 *  local time, so we must convert accordingly.)
 */
function utcToLocalInput(isoString: string): string {
  const date = new Date(isoString);
  // getTimezoneOffset() returns minutes BEHIND UTC (negative for UTC+ zones)
  const localMs = date.getTime() - date.getTimezoneOffset() * 60_000;
  return new Date(localMs).toISOString().slice(0, 16);
}

const TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called for EDIT mode only — update the existing window */
  onSave: (data: CreateMaintenanceWindowRequest) => Promise<void>;
  /** Called after multi-create completes (CREATE mode) — parent should reload */
  onSaved?: () => void;
  initial?: MaintenanceWindow | null;
  /** scopeOptions is no longer used — kept for backward-compat callers */
  scopeOptions?: unknown[];
  /**
   * No longer used — the modal loads the notification channels usable by the
   * window's scope itself. Kept optional for backward-compat callers.
   */
  channelOptions?: unknown[];
  /** Pre-select this scope when opening in CREATE mode */
  defaultScopeType?: MaintenanceScopeType;
  defaultScopeId?: number;
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-text-muted uppercase tracking-wider mb-1">
      {children}
    </label>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary',
        'focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent',
        props.className,
      )}
    />
  );
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...props}
      className={cn(
        'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary',
        'focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent',
        props.className,
      )}
    />
  );
}

export function MaintenanceWindowModal({
  open,
  onClose,
  onSave,
  onSaved,
  initial,
  defaultScopeType,
  defaultScopeId,
}: Props) {
  const { t } = useTranslation();
  const formId = useId();
  const isEdit = !!initial;

  // Translated day labels — computed here so they react to language changes
  const DAYS = [
    t('maintenance.dayMon'), t('maintenance.dayTue'), t('maintenance.dayWed'),
    t('maintenance.dayThu'), t('maintenance.dayFri'), t('maintenance.daySat'), t('maintenance.daySun'),
  ];

  // ── Schedule fields ───────────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [scheduleType, setScheduleType] = useState<MaintenanceScheduleType>('one_time');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [startTime, setStartTime] = useState('02:00');
  const [endTime, setEndTime] = useState('04:00');
  const [recurrenceType, setRecurrenceType] = useState<MaintenanceRecurrenceType>('weekly');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [timezone, setTimezone] = useState('UTC');
  const [notifyChannelIds, setNotifyChannelIds] = useState<number[]>([]);
  const [active, setActive] = useState(true);

  // ── Edit-mode scope fields (single scope, from the existing window) ───────
  const [editScopeType, setEditScopeType] = useState<MaintenanceScopeType>('monitor');
  const [editScopeId, setEditScopeId] = useState<number | ''>('');

  // ── Create-mode scope selection (multi-scope via ScopeSelector) ───────────
  const [scopeTargets, setScopeTargets] = useState<ScopeTarget[]>([]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Notification channels (loaded here, scoped to the window's workspace) ──
  // null while loading
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);

  // Channels usable by the window's scope entity (its workspace's own +
  // shared channels — what the server accepts); for a global window, the
  // channels of the active workspace (all workspaces in the god view).
  const channelScopeType = isEdit ? initial?.scopeType : defaultScopeType;
  const channelScopeId = isEdit ? initial?.scopeId ?? undefined : defaultScopeId;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setChannels(null);
    const entityScope = channelScopeType && channelScopeType !== 'global' && channelScopeId
      ? { type: channelScopeType, id: channelScopeId }
      : null;
    (entityScope
      ? notificationsApi.listChannels(entityScope.type, entityScope.id)
      : notificationsApi.listChannels())
      .then((list) => { if (!cancelled) setChannels(list); })
      .catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, [open, channelScopeType, channelScopeId]);

  // ── Reset form when opening ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (initial) {
      setName(initial.name);
      setScheduleType(initial.scheduleType);
      setStartAt(initial.startAt ? utcToLocalInput(initial.startAt) : '');
      setEndAt(initial.endAt ? utcToLocalInput(initial.endAt) : '');
      setStartTime(initial.startTime ?? '02:00');
      setEndTime(initial.endTime ?? '04:00');
      setRecurrenceType(initial.recurrenceType ?? 'weekly');
      setDaysOfWeek(initial.daysOfWeek ?? []);
      setTimezone(initial.timezone ?? 'UTC');
      setNotifyChannelIds(initial.notifyChannelIds ?? []);
      setActive(initial.active);
      setEditScopeType(initial.scopeType);
      setEditScopeId(initial.scopeId ?? '');
    } else {
      setName('');
      setScheduleType('one_time');
      setStartAt('');
      setEndAt('');
      setStartTime('02:00');
      setEndTime('04:00');
      setRecurrenceType('weekly');
      setDaysOfWeek([]);
      setTimezone('UTC');
      setNotifyChannelIds([]);
      setActive(true);
      setScopeTargets([]);
    }
    setError('');
  }, [open, initial]);

  const toggleDay = (d: number) =>
    setDaysOfWeek((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const toggleChannel = (id: number) =>
    setNotifyChannelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // ── Build base window data (schedule fields) ──────────────────────────────
  function buildBaseData(): Omit<CreateMaintenanceWindowRequest, 'scopeType' | 'scopeId'> {
    return {
      name: name.trim(),
      scheduleType,
      startAt: scheduleType === 'one_time' ? new Date(startAt).toISOString() : null,
      endAt: scheduleType === 'one_time' ? new Date(endAt).toISOString() : null,
      startTime: scheduleType === 'recurring' ? startTime : null,
      endTime: scheduleType === 'recurring' ? endTime : null,
      recurrenceType: scheduleType === 'recurring' ? recurrenceType : null,
      daysOfWeek: scheduleType === 'recurring' && recurrenceType === 'weekly' ? daysOfWeek : null,
      timezone,
      notifyChannelIds,
      active,
    };
  }

  // ── Validate shared fields ────────────────────────────────────────────────
  function validateBase(): string | null {
    if (!name.trim()) return t('maintenance.validationName');
    if (scheduleType === 'one_time') {
      if (!startAt || !endAt) return t('maintenance.validationDates');
      if (new Date(startAt) >= new Date(endAt)) return t('maintenance.validationEndAfterStart');
    }
    if (scheduleType === 'recurring' && recurrenceType === 'weekly' && daysOfWeek.length === 0) {
      return t('maintenance.validationDays');
    }
    return null;
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const baseErr = validateBase();
    if (baseErr) return setError(baseErr);

    setSaving(true);
    setError('');

    try {
      if (isEdit) {
        // ── EDIT mode: single scope, delegate to parent ──────────────────
        await onSave({
          ...buildBaseData(),
          scopeType: editScopeType,
          scopeId: editScopeType === 'global' ? null : Number(editScopeId),
        });
        onClose();
      } else {
        // ── CREATE mode: one window per selected scope target ────────────
        if (scopeTargets.length === 0) {
          setSaving(false);
          return setError(t('maintenance.validationScope'));
        }

        const base = buildBaseData();
        for (const target of scopeTargets) {
          const created = await maintenanceApi.create({
            ...base,
            scopeType: target.scopeType,
            scopeId: target.scopeId,
          });
          // Disable for excluded children (e.g. agent deselected within a group)
          if (target.disables) {
            for (const d of target.disables) {
              await maintenanceApi.disableForScope(created.id, d.scopeType, d.scopeId);
            }
          }
        }
        onSaved?.();
        onClose();
      }
    } catch (err) {
      // Server message first (e.g. a notify channel not usable by that workspace)
      setError(apiErrorMessage(err, err instanceof Error ? err.message : t('maintenance.failedSave')));
    } finally {
      setSaving(false);
    }
  }

  // Channels already selected on the window but no longer listed (e.g.
  // unshared since) stay visible so they can be unticked.
  const channelOptions: Array<Pick<NotificationChannel, 'id' | 'name' | 'type' | 'tenantId'>> = channels === null ? [] : [
    ...channels,
    ...notifyChannelIds
      .filter((id) => !channels.some((ch) => ch.id === id))
      .map((id) => ({
        id,
        name: t('maintenance.unavailableChannel', 'Unavailable channel #{{id}}', { id }),
        type: '',
        tenantId: undefined,
      })),
  ];

  const willCreateSummary = !isEdit && scopeTargets.length > 0 ? (
    <p className="mr-auto min-w-0 text-xs text-text-muted">
      {t('maintenance.willCreate', { count: scopeTargets.length })}
      {scopeTargets.some((st) => st.disables?.length) && (
        <span className="text-text-muted/70">
          {t('maintenance.withExclusions', { count: scopeTargets.reduce((n, st) => n + (st.disables?.length ?? 0), 0) })}
        </span>
      )}
    </p>
  ) : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? t('maintenance.editTitle') : t('maintenance.newTitle')}
      icon={<CalendarClock size={18} className="text-accent" />}
      size="lg"
      closeOnBackdrop={false}
      dismissible={!saving}
      bodyClassName="px-5 py-4"
      footer={
        <>
          {willCreateSummary}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md px-4 py-2 text-sm font-medium text-text-secondary bg-bg-tertiary hover:bg-bg-hover border border-border transition-colors disabled:opacity-50 coarse:min-h-10"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form={formId}
            disabled={saving}
            className="rounded-md px-4 py-2 text-sm font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50 transition-colors coarse:min-h-10"
          >
            {saving
              ? (isEdit ? t('common.saving') : t('maintenance.creating'))
              : (isEdit ? t('maintenance.saveChanges') : t('common.create'))}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">

        {/* Name */}
        <div>
          <Label>{t('maintenance.fieldName')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('maintenance.namePlaceholder')} />
        </div>

        {/* ── Scope ────────────────────────────────────────────────────── */}
        <div>
          <Label>{t('maintenance.fieldScope')}</Label>

          {isEdit ? (
            /* Edit mode: simple dropdowns (scope already set, allow changing) */
            <div className={cn('gap-3', editScopeType === 'global' ? 'flex' : 'grid grid-cols-2')}>
              <div className={editScopeType === 'global' ? 'w-1/2' : undefined}>
                <Select
                  value={editScopeType}
                  onChange={(e) => { setEditScopeType(e.target.value as MaintenanceScopeType); setEditScopeId(''); }}
                >
                  <option value="monitor">{t('common.monitor')}</option>
                  <option value="agent">{t('common.agent')}</option>
                  <option value="group">{t('common.group')}</option>
                  <option value="global">{t('maintenance.scopeGlobal')}</option>
                </Select>
              </div>
              {editScopeType !== 'global' && (
                <div>
                  <Input
                    type="number"
                    value={editScopeId}
                    onChange={(e) => setEditScopeId(Number(e.target.value))}
                    placeholder={t('maintenance.scopeIdPlaceholder')}
                  />
                </div>
              )}
            </div>
          ) : (
            /* Create mode: visual two-column selector */
            <ScopeSelector
              defaultScopeType={defaultScopeType}
              defaultScopeId={defaultScopeId}
              onChange={setScopeTargets}
            />
          )}
        </div>

        {/* Schedule type tabs */}
        <div>
          <Label>{t('maintenance.fieldScheduleType')}</Label>
          <div className="flex rounded-md overflow-hidden border border-border">
            {(['one_time', 'recurring'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setScheduleType(st)}
                className={cn(
                  'flex-1 py-1.5 text-sm font-medium transition-colors',
                  scheduleType === st
                    ? 'bg-accent text-white'
                    : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                )}
              >
                {st === 'one_time' ? t('maintenance.oneTime') : t('maintenance.recurring')}
              </button>
            ))}
          </div>
        </div>

        {/* One-time fields */}
        {scheduleType === 'one_time' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t('maintenance.fieldStart')}</Label>
              <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </div>
            <div>
              <Label>{t('maintenance.fieldEnd')}</Label>
              <Input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
            </div>
          </div>
        )}

        {/* Recurring fields */}
        {scheduleType === 'recurring' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('maintenance.fieldRecurrence')}</Label>
                <Select
                  value={recurrenceType}
                  onChange={(e) => setRecurrenceType(e.target.value as MaintenanceRecurrenceType)}
                >
                  <option value="daily">{t('maintenance.recurrenceDaily')}</option>
                  <option value="weekly">{t('maintenance.recurrenceWeekly')}</option>
                </Select>
              </div>
              <div>
                <Label>{t('maintenance.fieldTimezone')}</Label>
                <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </Select>
              </div>
            </div>

            {recurrenceType === 'weekly' && (
              <div>
                <Label>{t('maintenance.fieldDaysOfWeek')}</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {DAYS.map((d, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleDay(i)}
                      className={cn(
                        'px-2.5 py-1 rounded text-xs font-semibold border transition-colors',
                        daysOfWeek.includes(i)
                          ? 'bg-accent border-accent text-white'
                          : 'bg-bg-tertiary border-border text-text-secondary hover:border-accent',
                      )}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('maintenance.fieldStartTime')}</Label>
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </div>
              <div>
                <Label>{t('maintenance.fieldEndTime')}</Label>
                <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              </div>
            </div>
          </>
        )}

        {/* Notification channels */}
        {channelOptions.length > 0 && (
          <div>
            <Label>{t('maintenance.notifyChannels')}</Label>
            <p className="text-xs text-text-muted mb-2">
              {t('maintenance.notifyChannelsDesc')}
            </p>
            <div className="space-y-1.5 max-h-40 overflow-y-auto overscroll-contain">
              {channelOptions.map((ch) => (
                <label key={ch.id} className="flex flex-wrap items-center gap-2 cursor-pointer coarse:min-h-10">
                  <Checkbox
                    checked={notifyChannelIds.includes(ch.id)}
                    onCheckedChange={() => toggleChannel(ch.id)}
                  />
                  <span className="text-sm text-text-primary">{anonymize(ch.name)}</span>
                  {ch.type && <span className="text-xs text-text-muted">({ch.type})</span>}
                  <TenantBadge tenantId={ch.tenantId} />
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Active toggle */}
        <label className="flex items-center gap-2.5 cursor-pointer">
          <Checkbox
            checked={active}
            onCheckedChange={setActive}
          />
          <span className="text-sm font-medium text-text-primary">{t('maintenance.fieldActive')}</span>
        </label>

        {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      </form>
    </Modal>
  );
}
