import { useRef, useEffect, useState, useCallback, Children, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';

interface PeekedGridProps {
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Text displayed top-right (e.g. "12 total") */
  count?: string;
  children: ReactNode;
  /** Fixed column width in px. Cards will be sized to this. Default: 290 */
  cardWidth?: number;
  /** Initial number of grid rows (user can drag to change). Default: 2 */
  rows?: number;
  /** Gap between cells in px. Default: 12 */
  gap?: number;
  className?: string;
}

/** Pixels of vertical drag required to snap one row change */
const ROW_SNAP_PX = 90;

export function PeekedGrid({
  title,
  icon,
  badge,
  count,
  children,
  cardWidth = 290,
  rows: initialRows = 2,
  gap = 12,
  className,
}: PeekedGridProps) {
  const scrollRef  = useRef<HTMLDivElement>(null);
  const [canLeft,  setCanLeft]  = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [rows,     setRows]     = useState(initialRows);
  const [isDragging, setIsDragging] = useState(false);

  const childCount = Children.count(children);

  // Compute the maximum useful rows (no empty rows)
  const getMaxRows = useCallback(() => {
    const el = scrollRef.current;
    if (!el || childCount === 0) return 1;
    const cols = Math.max(1, Math.floor(el.clientWidth / (cardWidth + gap)));
    return Math.ceil(childCount / cols);
  }, [childCount, cardWidth, gap]);

  // Keep rows clamped and synced when data or container changes
  useEffect(() => {
    setRows((r) => {
      const max = getMaxRows();
      // Grow if initialRows increased (new data loaded); never shrink automatically
      return Math.min(Math.max(r, initialRows), max);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRows, childCount]);

  const updateArrows = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener('scroll', updateArrows, { passive: true });
    const ro = new ResizeObserver(() => {
      updateArrows();
      setRows((r) => Math.min(r, getMaxRows()));
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateArrows);
      ro.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    const colWidth = cardWidth + gap;
    const cols = Math.max(1, Math.floor(el.clientWidth / colWidth) - 1);
    el.scrollBy({ left: dir * colWidth * cols, behavior: 'smooth' });
  };

  // ── Drag-to-resize ────────────────────────────────────────────────────────
  const handleResizeDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY    = e.clientY;
    const startRows = rows;
    setIsDragging(true);

    const onMove = (ev: MouseEvent) => {
      const delta    = ev.clientY - startY;
      const rowDelta = Math.round(delta / ROW_SNAP_PX);
      const max      = getMaxRows();
      setRows(Math.max(1, Math.min(max, startRows + rowDelta)));
    };

    const onUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  };

  const maxRows    = getMaxRows();
  const canExpand  = rows < maxRows;
  const canShrink  = rows > 1;
  const handleActive = canExpand || canShrink;

  return (
    <div className={cn('mb-6', className)}>
      {/* Section header */}
      <div className="flex items-center gap-2 mb-3 pb-1 border-b border-border">
        {icon}
        <span className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          {title}
        </span>
        {badge}
        {count && (
          <span className="text-xs text-text-muted ml-auto">{count}</span>
        )}
      </div>

      {/* Peek wrapper — overflow is visible, arrows are overlay */}
      <div className="relative">

        {/* ── Left fade + arrow ───────────────────────────────────────────── */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-20',
            'bg-gradient-to-r from-bg-primary via-bg-primary/60 to-transparent',
            'transition-opacity duration-200',
            canLeft ? 'opacity-100' : 'opacity-0',
          )}
        />
        <button
          onClick={() => scrollByPage(-1)}
          aria-label="Scroll left"
          className={cn(
            'absolute left-2 top-1/2 -translate-y-1/2 z-20',
            'flex h-9 w-9 items-center justify-center rounded-full',
            'bg-bg-tertiary border border-border shadow-lg',
            'transition-all duration-200',
            canLeft
              ? 'opacity-100 hover:bg-bg-active text-text-primary cursor-pointer'
              : 'opacity-0 pointer-events-none',
          )}
        >
          <ChevronLeft size={18} />
        </button>

        {/* ── Scrollable multi-row grid ─────────────────────────────────── */}
        <div
          ref={scrollRef}
          className="overflow-x-auto"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties}
        >
          <div
            className="scrollbar-none"
            style={{
              display: 'grid',
              gridAutoFlow: 'column',
              gridTemplateRows: `repeat(${rows}, auto)`,
              gridAutoColumns: `${cardWidth}px`,
              gap: `${gap}px`,
              paddingBottom: '4px',
            }}
          >
            {children}
          </div>
        </div>

        {/* ── Right fade + arrow ──────────────────────────────────────────── */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-0 top-0 bottom-0 z-10 w-20',
            'bg-gradient-to-l from-bg-primary via-bg-primary/60 to-transparent',
            'transition-opacity duration-200',
            canRight ? 'opacity-100' : 'opacity-0',
          )}
        />
        <button
          onClick={() => scrollByPage(1)}
          aria-label="Scroll right"
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 z-20',
            'flex h-9 w-9 items-center justify-center rounded-full',
            'bg-bg-tertiary border border-border shadow-lg',
            'transition-all duration-200',
            canRight
              ? 'opacity-100 hover:bg-bg-active text-text-primary cursor-pointer'
              : 'opacity-0 pointer-events-none',
          )}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* ── Resize handle ───────────────────────────────────────────────────── */}
      {childCount > 0 && (
        <div
          onMouseDown={handleActive ? handleResizeDrag : undefined}
          title={
            canExpand  ? `${rows} ligne${rows > 1 ? 's' : ''} — tirer pour agrandir` :
            canShrink  ? `${rows} lignes — tirer pour réduire` :
            `${rows} ligne${rows > 1 ? 's' : ''}`
          }
          className={cn(
            'mt-2 flex flex-col items-center justify-center gap-0.5 py-1.5 group select-none',
            'rounded-md transition-colors',
            handleActive
              ? 'cursor-ns-resize hover:bg-bg-tertiary/60'
              : 'cursor-default opacity-40',
            isDragging && 'bg-bg-tertiary/80',
          )}
        >
          {/* Three horizontal grip lines */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={cn(
                'h-px rounded-full transition-all duration-150',
                'bg-border-light',
                handleActive
                  ? isDragging
                    ? 'w-10 opacity-80'
                    : 'w-8 opacity-40 group-hover:w-10 group-hover:opacity-70'
                  : 'w-6 opacity-25',
              )}
            />
          ))}
          {/* Row count indicator — shown on hover or while dragging */}
          <span className={cn(
            'text-[10px] text-text-muted font-mono transition-opacity mt-0.5',
            isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-60',
          )}>
            {rows} / {maxRows}
          </span>
        </div>
      )}
    </div>
  );
}
