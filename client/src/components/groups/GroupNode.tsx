import { createContext, useContext, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, GroupTreeNode, Monitor, MonitorStatus, PermissionLevel } from '@obliview/shared';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { DraggableMonitor, AgentMonitorRow, splitAgentMonitors } from './GroupTree';
import { DraggableDevice } from './DraggableDevice';
import {
  useGroupDevices,
  fallbackAgentMonitors,
  agentsInMaintenance,
  monitorMatchesSearch,
  deviceMatchesSearch,
} from './DevicesContext';

// ── Tree helpers ─────────────────────────────────────────────────────────────

/** Collect all group IDs in a subtree (including self) */
function collectGroupIds(node: GroupTreeNode): number[] {
  const ids = [node.id];
  for (const child of node.children) {
    ids.push(...collectGroupIds(child));
  }
  return ids;
}

/** Find a group anywhere in `nodes`. */
export function findTreeGroup(nodes: GroupTreeNode[], id: number): GroupTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findTreeGroup(n.children, id);
    if (found) return found;
  }
  return null;
}

/** True when `id` is one of `nodes` or one of their descendants. */
export function treeContainsGroup(nodes: GroupTreeNode[], id: number): boolean {
  return findTreeGroup(nodes, id) !== null;
}

/**
 * Groups the viewer may write, as the server sees it: a team 'rw' grant on a
 * group covers its whole subtree (closure table). `null` = every group (admin).
 * The store's canWriteGroup() only reads direct grants, hence this walk.
 */
export function computeWritableGroupIds(
  tree: GroupTreeNode[],
  isAdmin: boolean,
  permissions: Record<string, PermissionLevel> | undefined,
): Set<number> | null {
  if (isAdmin) return null;
  const ids = new Set<number>();
  const walk = (nodes: GroupTreeNode[], inherited: boolean) => {
    for (const n of nodes) {
      const writable = inherited || permissions?.[`group:${n.id}`] === 'rw';
      if (writable) ids.add(n.id);
      walk(n.children, writable);
    }
  };
  walk(tree, false);
  return ids;
}

export function canWriteTreeGroup(writable: Set<number> | null, id: number): boolean {
  return writable === null || writable.has(id);
}

// ── Drag-and-drop contract of the sidebar tree ──────────────────────────────

/** Drag payloads (`active.data.current`). */
export type TreeDragData =
  | { type: 'monitor'; monitor: Monitor }
  | { type: 'agent-device'; device: AgentDevice }
  | { type: 'group'; node: GroupTreeNode };

/**
 * Drop payloads (`over.data.current`). `tenantId: null` = no tenant
 * constraint (single-tenant view); in god view every target carries the
 * tenant it belongs to, since nothing may move across tenants.
 */
export type TreeDropData =
  /** Into a group (monitor / device: set its group; group: reparent). */
  | { type: 'group'; groupId: number; tenantId: number }
  /** An "Ungrouped" section (monitor / device: ungroup; group: move to root). */
  | { type: 'ungrouped'; groupId: null; tenantId: number | null }
  /** The tree header or a tenant header (groups only: move to root). */
  | { type: 'root'; tenantId: number | null }
  /** Between two sibling groups (groups only, admins: reorder and/or reparent). */
  | { type: 'between'; parentId: number | null; insertBeforeId: number | null; tenantId: number | null };

export interface TreeDndState {
  /** Item being dragged, null when idle. */
  active: TreeDragData | null;
  /** Groups the viewer may write (see computeWritableGroupIds); null = all. */
  writableGroupIds: Set<number> | null;
  /** Drop between siblings — POST /groups/reorder is admin-only. */
  canReorder: boolean;
  /** Group reparenting — POST /groups/:id/move needs 'groups.manage'. */
  canMoveGroups: boolean;
  /** Agent device moves — PATCH /agent/devices/:id { groupId } needs 'agents.manage'. */
  canMoveDevices: boolean;
  /** Whether `drop` accepts the item being dragged (drives the drop highlight). */
  accepts: (drop: TreeDropData) => boolean;
}

export const TreeDndContext = createContext<TreeDndState>({
  active: null,
  writableGroupIds: new Set(),
  canReorder: false,
  canMoveGroups: false,
  canMoveDevices: false,
  accepts: () => false,
});

/**
 * Drop zone between two sibling groups (or after the last one, with
 * `insertBeforeId = null`). Zero layout height: the hit area is an absolute,
 * pointer-transparent strip over the boundary (dnd-kit collides on measured
 * rects, not on pointer events), so it never steals clicks and the rows never
 * shift. Only active while a group is dragged.
 */
export function DropBetween({
  parentId,
  insertBeforeId,
  tenantId,
  depth,
}: {
  parentId: number | null;
  insertBeforeId: number | null;
  tenantId: number | null;
  depth: number;
}) {
  const { active, accepts } = useContext(TreeDndContext);
  const data: TreeDropData = { type: 'between', parentId, insertBeforeId, tenantId };
  const { setNodeRef, isOver } = useDroppable({
    id: `group-between-${parentId ?? `root-${tenantId ?? 'all'}`}-${insertBeforeId ?? 'tail'}`,
    data,
    disabled: active?.type !== 'group',
  });

  return (
    <div className="relative h-0" aria-hidden>
      <div ref={setNodeRef} className="pointer-events-none absolute inset-x-0 -top-1 h-2" />
      {isOver && accepts(data) && (
        <div
          className="pointer-events-none absolute right-2 top-0 z-20 h-0.5 -translate-y-1/2 rounded-full bg-accent"
          style={{ left: `${depth * 16 + 8}px` }}
        />
      )}
    </div>
  );
}

// ── Group node ───────────────────────────────────────────────────────────────

const PROBLEM_STATUSES = new Set<MonitorStatus>(['down', 'alert', 'ssl_expired', 'ssl_warning']);

/**
 * During a maintenance window the worker keeps the real status ('down') with
 * inMaintenance = true: such a monitor is not a problem.
 */
function isProblem(m: Monitor): boolean {
  return !m.inMaintenance && PROBLEM_STATUSES.has(m.status);
}

interface GroupNodeProps {
  node: GroupTreeNode;
  depth?: number;
  selectedGroupId?: number | null;
  onSelectGroup?: (groupId: number | null) => void;
  /** Monitors and devices can be dragged (canCreate). Groups follow write access. */
  dndEnabled?: boolean;
  /** Trimmed search query ('' = no search). */
  searchQuery?: string;
  /** While searching: groups whose subtree holds a match (null = show every child). */
  matchingGroupIds?: Set<number> | null;
}

export function GroupNode({
  node,
  depth = 0,
  selectedGroupId,
  onSelectGroup,
  dndEnabled = false,
  searchQuery = '',
  matchingGroupIds = null,
}: GroupNodeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { monitors: monitorMap, getMonitorsByGroup, getMonitorSummary, getRecentHeartbeats } = useMonitorStore();
  const { getGroupStats, isGroupExpanded, toggleGroupExpanded } = useGroupStore();
  const treeDnd = useContext(TreeDndContext);
  const expanded = isGroupExpanded(node.id);

  const allMonitors = getMonitorsByGroup(node.id);
  const { list: groupDevices, enabled: devicesEnabled, statuses: deviceStatuses, deviceIds } = useGroupDevices(node.id);

  // When a search is active, filter monitors, devices and child groups to matching ones only
  const isSearching = searchQuery.length > 0;

  const monitors = isSearching
    ? allMonitors.filter((m) => monitorMatchesSearch(m, searchQuery))
    : allMonitors;

  const visibleChildren = isSearching && matchingGroupIds
    ? node.children.filter((c) => matchingGroupIds.has(c.id))
    : node.children;

  const visibleDevices = isSearching
    ? groupDevices.filter((d) => deviceMatchesSearch(d, searchQuery))
    : groupDevices;

  // One row per agent: with the devices list (served to everyone, filtered by
  // the server to the agents the user can see) the device row is the agent's
  // identity and its backing 'agent' monitor is skipped; without it the agent
  // monitor is shown as a device-style row instead.
  const { regular: regularMonitors, agents: agentMonitors } = splitAgentMonitors(monitors);
  // An agent whose device is not in the list (loading, failed, race) keeps
  // its monitor row so it never disappears from the tree.
  const agentMonitorRows = fallbackAgentMonitors(agentMonitors, devicesEnabled, deviceIds);
  // Devices whose backing agent monitor is in a maintenance window.
  const maintenanceDeviceIds = agentsInMaintenance(allMonitors);

  // Force-expand when searching so matched monitors are visible
  const effectiveExpanded = isSearching ? true : expanded;

  const hasContent = node.children.length > 0 || allMonitors.length > 0 || groupDevices.length > 0;
  const isSelected = selectedGroupId === node.id;
  const stats = getGroupStats(node.id);

  // Every monitor of the subtree (incl. descendants). The id set only changes
  // with the tree; the monitor list is re-read when the monitors map changes
  // (status / maintenance frames), so the flags below stay live.
  const subtreeGroupIds = useMemo(() => new Set(collectGroupIds(node)), [node]);
  const allMonitorsInTree = useMemo<Monitor[]>(() => {
    const out: Monitor[] = [];
    for (const m of monitorMap.values()) {
      if (m.groupId != null && subtreeGroupIds.has(m.groupId)) out.push(m);
    }
    return out;
  }, [monitorMap, subtreeGroupIds]);

  // Check if this group (incl. descendants) contains ONLY value_watcher monitors.
  const isValueWatcherOnly = allMonitorsInTree.length > 0
    && allMonitorsInTree.every((m) => m.type === 'value_watcher');
  // Some monitor or agent of the subtree is in a maintenance window.
  const hasMaintenance = allMonitorsInTree.some((m) => m.inMaintenance);

  // If value_watcher only, compute total from latest heartbeat values.
  // Kept outside the useMemo above because it depends on socket-frame data
  // (getRecentHeartbeats) — recomputing here on every render is intentional.
  let valueTotal: number | null = null;
  if (isValueWatcherOnly) {
    let sum = 0;
    let hasAny = false;
    for (const m of allMonitorsInTree) {
      const hbs = getRecentHeartbeats(m.id);
      const latest = hbs.length > 0 ? hbs[hbs.length - 1] : null;
      if (latest?.value != null) {
        const n = Number(latest.value);
        if (!isNaN(n)) {
          sum += n;
          hasAny = true;
        }
      }
    }
    if (hasAny) valueTotal = sum;
  }

  const upCount = monitors.filter((m) => m.status === 'up').length;
  const downCount = monitors.filter(isProblem).length;
  const totalCount = monitors.length;

  // Drag the group header to reparent it (any group the viewer can write) or,
  // for admins, to reorder it among its siblings. Needs 'groups.manage' (server).
  const canDragGroup = treeDnd.canMoveGroups && canWriteTreeGroup(treeDnd.writableGroupIds, node.id);
  const dragData: TreeDragData = { type: 'group', node };
  const {
    listeners: dragListeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({
    id: `group-${node.id}`,
    data: dragData,
    disabled: !canDragGroup,
  });

  // The whole node (header + expanded content) is a drop target
  const dropData: TreeDropData = { type: 'group', groupId: node.id, tenantId: node.tenantId };
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-group-${node.id}`,
    data: dropData,
  });
  const showDropHighlight = isOver && treeDnd.accepts(dropData);

  return (
    <div
      ref={setDropRef}
      className={cn(
        'transition-colors rounded-md',
        showDropHighlight && 'bg-accent/10 ring-1 ring-accent/30',
      )}
    >
      {/* Reorder slot right above this group (admins, while a group is dragged) */}
      {treeDnd.canReorder && (
        <DropBetween
          parentId={node.parentId ?? null}
          insertBeforeId={node.id}
          tenantId={node.tenantId}
          depth={depth}
        />
      )}

      {/* Group header — split click zones; the whole row is the drag handle */}
      {(() => {
        const isActive = location.pathname === `/group/${node.id}`;
        return (
          <div
            ref={setDragRef}
            {...(canDragGroup ? dragListeners ?? {} : {})}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md text-sm transition-colors',
              isActive
                ? 'bg-bg-active text-text-primary'
                : isSelected
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              isDragging && 'opacity-40',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {/* Left zone: chevron + folder icon — toggles expand/collapse */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hasContent) toggleGroupExpanded(node.id);
                onSelectGroup?.(isSelected ? null : node.id);
              }}
              className="flex items-center gap-1 shrink-0 py-1.5 pr-0.5"
            >
              {hasContent ? (
                <ChevronRight
                  size={14}
                  className={cn('shrink-0 transition-transform', effectiveExpanded && 'rotate-90')}
                />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}

              {effectiveExpanded && hasContent ? (
                <FolderOpen size={14} className="shrink-0 text-accent" />
              ) : (
                <Folder size={14} className="shrink-0 text-accent" />
              )}
            </button>

            {/* Right zone: name + badges — navigates to group detail page */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/group/${node.id}`);
              }}
              className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 pr-2"
            >
              <span className="truncate flex-1 text-left">{anonymize(node.name)}</span>

              {hasMaintenance && (
                <span
                  role="img"
                  aria-label={t('groupTree.inMaintenance', 'In maintenance')}
                  title={t('groupTree.inMaintenance', 'In maintenance')}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-maintenance"
                />
              )}

              {/* Value total for value_watcher-only groups, otherwise uptime % */}
              {isValueWatcherOnly && valueTotal !== null ? (
                <span className="shrink-0 inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                  {valueTotal.toLocaleString()}
                </span>
              ) : (
                stats && stats.total > 0 && (
                  <span
                    className={cn(
                      'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                      stats.uptimePct >= 99
                        ? 'bg-status-up-bg text-status-up'
                        : stats.uptimePct >= 95
                          ? 'bg-yellow-500/10 text-yellow-500'
                          : 'bg-status-down-bg text-status-down',
                    )}
                  >
                    {stats.uptimePct}%
                  </span>
                )
              )}

              {totalCount > 0 && (
                <span className="shrink-0 text-xs text-text-muted">
                  {downCount > 0 ? (
                    <span className="text-status-down">{downCount}</span>
                  ) : (
                    <span className="text-status-up">{upCount}</span>
                  )}
                  /{totalCount}
                </span>
              )}
            </button>
          </div>
        );
      })()}

      {/* Children and monitors */}
      {effectiveExpanded && (
        <div>
          {/* Child groups */}
          {visibleChildren.map((child) => (
            <GroupNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedGroupId={selectedGroupId}
              onSelectGroup={onSelectGroup}
              dndEnabled={dndEnabled}
              searchQuery={searchQuery}
              matchingGroupIds={matchingGroupIds}
            />
          ))}

          {/* Reorder slot after the last child group */}
          {treeDnd.canReorder && node.children.length > 0 && (
            <DropBetween
              parentId={node.id}
              insertBeforeId={null}
              tenantId={node.tenantId}
              depth={depth + 1}
            />
          )}

          {/* Monitors in this group (agent monitors excluded, see above) */}
          {regularMonitors.map((monitor) => (
            <DraggableMonitor
              key={monitor.id}
              monitor={monitor}
              depth={depth + 1}
              dndEnabled={dndEnabled}
              navigate={navigate}
              location={location}
              getMonitorSummary={getMonitorSummary}
            />
          ))}

          {/* Agents seen through their monitor (no devices list, or device
              not in the list yet). Not draggable. */}
          {agentMonitorRows.map((monitor) => (
            <AgentMonitorRow
              key={`agent-mon-${monitor.id}`}
              monitor={monitor}
              depth={depth + 1}
            />
          ))}

          {/* Agent devices in this group (when the tree is rendered inside a
              <DevicesProvider> — i.e. the sidebar). Distinct Cpu icon signals
              this is a device, not a monitor. */}
          {devicesEnabled && visibleDevices.map((device) => (
            <DraggableDevice
              key={`dev-${device.id}`}
              device={device}
              status={deviceStatuses.get(device.id)}
              depth={depth + 1}
              dndEnabled={dndEnabled && treeDnd.canMoveDevices}
              inMaintenance={maintenanceDeviceIds.has(device.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
