import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/utils/cn';
import { Tip } from '@/components/common/Tip';
import { useCanHover } from '@/hooks/useMediaQuery';

export interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
  /** Optional red pill with a pending-work count next to the label (hidden at 0). */
  badgeCount?: number;
  /** Accessible / tooltip text for the badge (e.g. "3 awaiting approval"). Default: the count. */
  badgeLabel?: string;
}

/**
 * Active for the item's own path and every nested page under it
 * (/agents → /agents/5, /policies → /policies?tab=…). '/' only matches itself.
 */
export function isNavItemActive(pathname: string, path: string): boolean {
  return pathname === path || (path !== '/' && pathname.startsWith(path));
}

function formatBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

interface NavLinkProps {
  item: NavItem;
  /** 64 px icon rail: icon only, the label becomes a tooltip (mouse) / aria-label. */
  collapsed?: boolean;
}

/** Sidebar navigation entry — expanded row or collapsed icon (Obliance Sidebar NavLink). */
export function NavLink({ item, collapsed = false }: NavLinkProps) {
  const location = useLocation();
  const canHover = useCanHover();
  const isActive = isNavItemActive(location.pathname, item.path);
  const badge = item.badgeCount !== undefined && item.badgeCount > 0 ? item.badgeCount : 0;
  const badgeLabel = badge > 0 ? (item.badgeLabel ?? String(badge)) : undefined;

  if (collapsed) {
    return (
      // Tooltip only with a hovering pointer: on touch a tap must navigate,
      // not toggle a popover (the aria-label still names the link).
      <Tip
        content={badgeLabel ? `${item.label} · ${badgeLabel}` : item.label}
        placement="bottom"
        align="start"
        disabled={!canHover}
      >
        <Link
          to={item.path}
          aria-label={badgeLabel ? `${item.label} (${badgeLabel})` : item.label}
          aria-current={isActive ? 'page' : undefined}
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-md transition-colors coarse:h-10 coarse:w-10',
            isActive
              ? 'bg-accent/10 text-accent-hover'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          {item.icon}
          {badge > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-1 -top-1 min-w-[1.1rem] rounded-full bg-red-500/20 px-1 text-center text-[9px] font-semibold leading-4 text-red-400"
            >
              {formatBadge(badge)}
            </span>
          )}
        </Link>
      </Tip>
    );
  }

  return (
    <Link
      to={item.path}
      aria-current={isActive ? 'page' : undefined}
      className={cn(
        'mb-0.5 flex h-[38px] items-center gap-3 rounded-[7px] px-3 text-sm font-medium transition-colors coarse:h-11',
        isActive
          ? 'bg-accent/10 text-accent-hover'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
      )}
    >
      {item.icon}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {badge > 0 && (
        <>
          <span
            aria-hidden="true"
            title={canHover ? badgeLabel : undefined}
            className="min-w-[1.25rem] shrink-0 rounded-full border border-red-500/30 bg-red-500/20 px-1.5 py-0.5 text-center text-[10px] font-semibold text-red-400"
          >
            {formatBadge(badge)}
          </span>
          <span className="sr-only">{badgeLabel}</span>
        </>
      )}
    </Link>
  );
}
