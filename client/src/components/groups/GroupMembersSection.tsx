import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, FolderOpen, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GroupTreeNode, Monitor, MonitorStatus } from '@obliview/shared';
import { useGroupStore } from '@/store/groupStore';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { anonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// Member list of a group page (monitors or agents of the group subtree),
// grouped by sub-group: the group's own members first, then one collapsible
// block per sub-group (tree order, "Child / Grandchild" path labels).
// ─────────────────────────────────────────────────────────────────────────────

const PROBLEM_STATUSES = new Set<MonitorStatus>(['down', 'ssl_expired', 'ssl_warning', 'alert']);

/** A member in planned maintenance is not a problem (it is shown as MAINT.). */
function isProblem(m: Monitor): boolean {
  return !m.inMaintenance && PROBLEM_STATUSES.has(m.status);
}

interface MemberSection {
  groupId: number;
  /** Path of the sub-group relative to the page's group ('' for the group itself). */
  label: string;
  members: Monitor[];
}

function buildSections(
  rootGroupId: number,
  rootNode: GroupTreeNode | null,
  members: Monitor[],
  nameOf: (groupId: number) => string,
  displayName: (m: Monitor) => string,
): MemberSection[] {
  const byGroup = new Map<number, Monitor[]>();
  for (const m of members) {
    if (m.groupId === null) continue;
    const list = byGroup.get(m.groupId);
    if (list) list.push(m);
    else byGroup.set(m.groupId, [m]);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }

  const sections: MemberSection[] = [];
  if (rootNode) {
    const walk = (node: GroupTreeNode, path: string[]) => {
      const list = byGroup.get(node.id);
      if (list && list.length > 0) sections.push({ groupId: node.id, label: path.join(' / '), members: list });
      byGroup.delete(node.id);
      for (const child of node.children) walk(child, [...path, anonymize(child.name)]);
    };
    walk(rootNode, []);
  }

  // Group outside the loaded tree, or members of groups the tree does not
  // list: the group itself first, then the others by name.
  const rest = [...byGroup.entries()]
    .map(([groupId, list]) => ({
      groupId,
      label: groupId === rootGroupId ? '' : anonymize(nameOf(groupId)),
      members: list,
    }))
    .sort((a, b) => (a.groupId === rootGroupId ? -1 : b.groupId === rootGroupId ? 1 : a.label.localeCompare(b.label)));

  return [...sections, ...rest];
}

export interface GroupMembersSectionProps {
  /** The group of the page: its own members are listed first, without a sub-header. */
  rootGroupId: number;
  /** Tree node of that group (null when it is not in the loaded tree). */
  rootNode: GroupTreeNode | null;
  members: Monitor[];
  title: ReactNode;
  /** Shown instead of the list when `members` is empty. */
  emptyText?: ReactNode;
  /** Right side of the card header (e.g. actions). */
  headerExtra?: ReactNode;
  linkFor: (m: Monitor) => string;
  /** Right side of a row (e.g. the monitor type). */
  metaFor?: (m: Monitor) => ReactNode;
  /** Label of a row (defaults to the monitor name). */
  nameFor?: (m: Monitor) => string;
  className?: string;
}

export function GroupMembersSection({
  rootGroupId, rootNode, members, title, emptyText, headerExtra, linkFor, metaFor, nameFor, className,
}: GroupMembersSectionProps) {
  const { t } = useTranslation();
  const groups = useGroupStore((s) => s.groups);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

  const displayName = useMemo(() => nameFor ?? ((m: Monitor) => m.name), [nameFor]);

  const sections = useMemo(
    () => buildSections(
      rootGroupId,
      rootNode,
      members,
      (gid) => groups.get(gid)?.name ?? t('groups.detail.subgroupFallback', 'Group #{{id}}', { id: gid }),
      displayName,
    ),
    [rootGroupId, rootNode, members, groups, displayName, t],
  );

  const toggle = (groupId: number) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  const renderRow = (m: Monitor) => (
    <Link
      key={m.id}
      to={linkFor(m)}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-hover transition-colors coarse:min-h-11"
    >
      <MonitorStatusBadge status={m.status} size="sm" inMaintenance={m.inMaintenance} />
      <span className="flex-1 min-w-0 text-sm text-text-primary truncate">{anonymize(displayName(m))}</span>
      {metaFor && <span className="shrink-0 text-xs text-text-muted">{metaFor(m)}</span>}
    </Link>
  );

  return (
    <div className={cn('rounded-lg border border-border bg-bg-secondary', className)}>
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wide">{title}</h3>
        {headerExtra}
      </div>

      {members.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-text-muted">
          {emptyText ?? t('common.noData')}
        </p>
      ) : (
        <div className="divide-y divide-border">
          {sections.map((section) => {
            // The group's own members: plain rows, no sub-header.
            if (section.label === '' && section.groupId === rootGroupId) {
              return (
                <div key={section.groupId} className="divide-y divide-border">
                  {section.members.map(renderRow)}
                </div>
              );
            }

            const isCollapsed = collapsed.has(section.groupId);
            const problems = section.members.filter(isProblem).length;
            const inMaintenance = section.members.filter((m) => m.inMaintenance).length;
            return (
              <div key={section.groupId}>
                <div className="flex items-center gap-1 bg-bg-tertiary/40 pr-2">
                  <button
                    type="button"
                    onClick={() => toggle(section.groupId)}
                    aria-expanded={!isCollapsed}
                    className="flex flex-1 min-w-0 items-center gap-2 px-4 py-2 text-left hover:bg-bg-hover transition-colors coarse:min-h-11"
                  >
                    {isCollapsed
                      ? <ChevronRight size={14} className="shrink-0 text-text-muted" />
                      : <ChevronDown size={14} className="shrink-0 text-text-muted" />}
                    <FolderOpen size={13} className="shrink-0 text-text-muted" />
                    <span className="truncate text-xs font-medium text-text-secondary">{section.label}</span>
                    <span className="shrink-0 text-xs text-text-muted">({section.members.length})</span>
                    {problems > 0 && (
                      <span className="shrink-0 rounded-full bg-status-down-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-down">
                        {problems}
                      </span>
                    )}
                    {inMaintenance > 0 && (
                      <span className="shrink-0 rounded-full bg-status-maintenance-bg px-1.5 py-0.5 text-[10px] font-semibold text-status-maintenance">
                        {inMaintenance}
                      </span>
                    )}
                  </button>
                  <Link
                    to={`/group/${section.groupId}`}
                    aria-label={t('groups.detail.openSubgroup', 'Open group')}
                    title={t('groups.detail.openSubgroup', 'Open group')}
                    className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors coarse:min-h-10 coarse:min-w-10 coarse:flex coarse:items-center coarse:justify-center"
                  >
                    <ArrowUpRight size={14} />
                  </Link>
                </div>
                {!isCollapsed && (
                  <div className="divide-y divide-border">
                    {section.members.map(renderRow)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
