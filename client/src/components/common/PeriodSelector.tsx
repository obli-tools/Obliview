import { useEffect } from 'react';
import { cn } from '@/utils/cn';

interface PeriodSelectorProps {
  value: string;
  onChange: (period: string) => void;
  /**
   * Effective heartbeat retention in days (heartbeat_retention_days). When
   * given, periods longer than it are hidden: no data exists beyond it.
   */
  maxDays?: number | null;
}

const PERIODS = [
  { value: '1h', label: '1H', days: 1 / 24 },
  { value: '24h', label: '24H', days: 1 },
  { value: '7d', label: '7D', days: 7 },
  { value: '30d', label: '30D', days: 30 },
  { value: '365d', label: '1Y', days: 365 },
];

export function PeriodSelector({ value, onChange, maxDays }: PeriodSelectorProps) {
  // The shortest period always stays available.
  const visible = maxDays != null && maxDays > 0
    ? PERIODS.filter((p, i) => i === 0 || p.days <= maxDays)
    : PERIODS;

  // The selected period got hidden (retention shorter than it): fall back to
  // the longest period still offered.
  const selectedHidden = !visible.some((p) => p.value === value) && PERIODS.some((p) => p.value === value);
  const fallback = visible[visible.length - 1].value;
  useEffect(() => {
    if (selectedHidden) onChange(fallback);
  }, [selectedHidden, fallback, onChange]);

  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden">
      {visible.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onChange(p.value)}
          aria-pressed={value === p.value}
          className={cn(
            'px-3 py-1 text-xs font-medium transition-colors',
            value === p.value
              ? 'bg-accent text-white'
              : 'bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
