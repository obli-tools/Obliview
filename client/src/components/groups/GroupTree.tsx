import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Activity, Cpu, Folder, Plus } from 'lucide-react';
import { useGroupStore } from '@/store/groupStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useTenantCollapse } from '@/hooks/useTenantCollapse';
import { useIsGodView } from '@/hooks/useIsGodView';
import { isMasterTenant } from '@obliview/shared';
import {
  GroupNode,
  DropBetween,
  TreeDndContext,
  computeWritableGroupIds,
  canWriteTreeGroup,
  findTreeGroup,
  treeContainsGroup,
  type TreeDndState,
  type TreeDragData,
  type TreeDropData,
} from './GroupNode';
import { DraggableDevice } from './DraggableDevice';
import { CreateGroupModal } from './CreateGroupModal';
import {
  useGroupDevices,
  useAllDevices,
  fallbackAgentMonitors,
  agentsInMaintenance,
  monitorMatchesSearch,
  deviceMatchesSearch,
} from './DevicesContext';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { TenantBucketHeader } from '@/components/common/TenantBucketHeader';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';
import { apiErrorMessage } from '@/utils/apiError';
import { estimateMaxBars } from '@/components/monitors/HeartbeatBar';
import { monitorsApi } from '@/api/monitors.api';
import { groupsApi } from '@/api/groups.api';
import { agentApi } from '@/api/agent.api';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { AgentDevice, GroupTreeNode, Monitor, MonitorStatus } from '@obliview/shared';

/**
 * One row per agent. An approved agent has two records: the agent_devices row
 * and a backing monitor of type 'agent'. When the devices list is available
 * (admins: the sidebar wraps the tree in an enabled <DevicesProvider>), the
 * device row is the agent's only identity and agent monitors are skipped.
 * Without it (non-admins), agent monitors are rendered as device-style rows.
 */
export function splitAgentMonitors(monitors: Monitor[]): { regular: Monitor[]; agents: Monitor[] } {
  const regular: Monitor[] = [];
  const agents: Monitor[] = [];
  for (const m of monitors) (m.type === 'agent' ? agents : regular).push(m);
  return { regular, agents };
}

/**
 * Tenant of a monitor. The monitor payload does not carry tenantId yet
 * (server rowToMonitor omits it), so it is read defensively; an agent monitor
 * falls back to its device's tenant. null = unknown.
 */
function monitorTenantId(m: Monitor, deviceTenant: Map<number, number>): number | null {
  const own = (m as Monitor & { tenantId?: number | null }).tenantId;
  if (typeof own === 'number') return own;
  if (m.agentDeviceId != null) return deviceTenant.get(m.agentDeviceId) ?? null;
  return null;
}

/** Ids of the sibling groups under `parentId` (root level: roots of `tenantId`), in tree order. */
function siblingIds(tree: GroupTreeNode[], parentId: number | null, tenantId: number): number[] {
  if (parentId === null) return tree.filter((n) => n.tenantId === tenantId).map((n) => n.id);
  return findTreeGroup(tree, parentId)?.children.map((n) => n.id) ?? [];
}

interface DropRules {
  tree: GroupTreeNode[];
  writableGroupIds: Set<number> | null;
  canReorder: boolean;
  /** 'groups.manage' (POST /groups/:id/move). */
  canMoveGroups: boolean;
  /** 'agents.manage' (device groupId is a manage-only field). */
  canMoveDevices: boolean;
  deviceTenant: Map<number, number>;
}

function dragTenantId(drag: TreeDragData, deviceTenant: Map<number, number>): number | null {
  if (drag.type === 'group') return drag.node.tenantId;
  if (drag.type === 'agent-device') return drag.device.tenantId;
  return monitorTenantId(drag.monitor, deviceTenant);
}

/** A drop that would cross tenants (refused: closure edges and groups are per-tenant). */
function isCrossTenantDrop(drag: TreeDragData, drop: TreeDropData, deviceTenant: Map<number, number>): boolean {
  if (drag.type !== 'group' && drop.type !== 'group' && drop.type !== 'ungrouped') return false;
  const itemTenant = dragTenantId(drag, deviceTenant);
  return drop.tenantId !== null && itemTenant !== null && drop.tenantId !== itemTenant;
}

/** Whether `drop` is a real, permitted change for the dragged item. */
function isValidTreeDrop(drag: TreeDragData, drop: TreeDropData, rules: DropRules): boolean {
  if (isCrossTenantDrop(drag, drop, rules.deviceTenant)) return false;

  if (drag.type === 'group') {
    if (!rules.canMoveGroups) return false;
    const node = drag.node;
    const parentId = node.parentId ?? null;
    switch (drop.type) {
      case 'group':
        return drop.groupId !== node.id
          && drop.groupId !== parentId
          // Never into its own subtree (the server refuses it too).
          && !treeContainsGroup(node.children, drop.groupId)
          && canWriteTreeGroup(rules.writableGroupIds, drop.groupId);
      case 'ungrouped':
      case 'root':
        return parentId !== null;
      case 'between': {
        if (!rules.canReorder) return false;
        if (drop.parentId !== null && (
          drop.parentId === node.id
          || treeContainsGroup(node.children, drop.parentId)
          || !canWriteTreeGroup(rules.writableGroupIds, drop.parentId)
        )) return false;
        // Same parent: right before or right after itself changes nothing.
        if (drop.parentId === parentId) {
          const siblings = siblingIds(rules.tree, parentId, node.tenantId);
          const idx = siblings.indexOf(node.id);
          const next = idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : null;
          if (drop.insertBeforeId === node.id || drop.insertBeforeId === next) return false;
        }
        return true;
      }
    }
  }

  // Monitors and agent devices: into a group (the server requires write
  // access on it), or back to "Ungrouped".
  if (drag.type === 'agent-device' && !rules.canMoveDevices) return false;
  if (drop.type !== 'group' && drop.type !== 'ungrouped') return false;
  const currentGroupId = drag.type === 'monitor' ? drag.monitor.groupId : drag.device.groupId;
  const targetGroupId = drop.type === 'group' ? drop.groupId : null;
  if (currentGroupId === targetGroupId) return false;
  return targetGroupId === null || canWriteTreeGroup(rules.writableGroupIds, targetGroupId);
}

/**
 * Pointer-based collision: a between-siblings slot under the pointer wins,
 * otherwise the innermost (smallest) droppable under it — a child group
 * rather than the parent node that contains it.
 */
const treeCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return rectIntersection(args);
  const hits = pointerWithin(args);
  if (hits.length <= 1) return hits;
  const typeOf = (id: string | number) =>
    (args.droppableContainers.find((c) => c.id === id)?.data.current as TreeDropData | undefined)?.type;
  const between = hits.find((c) => typeOf(c.id) === 'between');
  if (between) return [between];
  const area = (id: string | number) => {
    const r = args.droppableRects.get(id);
    return r ? r.width * r.height : Number.POSITIVE_INFINITY;
  };
  return [...hits].sort((a, b) => area(a.id) - area(b.id));
};

/** One god-view tenant bucket (tenantId null = the single-tenant flat view). */
interface TreeBucket {
  tenantId: number | null;
  roots: GroupTreeNode[];
  /** Ungrouped non-agent monitors. */
  monitors: Monitor[];
  /** Ungrouped agents seen through their monitor (no device row for them). */
  agentMonitors: Monitor[];
  /** Ungrouped agent devices. */
  devices: AgentDevice[];
}

const ungroupedRowCount = (b: Pick<TreeBucket, 'monitors' | 'agentMonitors' | 'devices'>) =>
  b.monitors.length + b.agentMonitors.length + b.devices.length;

interface GroupTreeProps {
  selectedGroupId?: number | null;
  onSelectGroup?: (groupId: number | null) => void;
  searchQuery?: string;
  /**
   * Render the tree header: "Groups" label, '+' (new group, canCreateGroup users)
   * and the "move to root level" drop zone. Default true.
   */
  showHeader?: boolean;
}

export function GroupTree({ selectedGroupId, onSelectGroup, searchQuery = '', showHeader = true }: GroupTreeProps) {
  const { t } = useTranslation();
  const { tree, fetchTree, fetchGroupStats, expandAncestors, expandGroup, updateGroup } = useGroupStore();
  const {
    monitors: monitorMap,
    getMonitorsByGroup,
    fetchSummary,
    fetchAllHeartbeats,
    getMonitorSummary,
    updateMonitor,
  } = useMonitorStore();
  const {
    canCreate: canCreateCheck,
    canCreateGroup: canCreateGroupCheck,
    hasCapability,
    user: currentUser,
    permissions,
  } = useAuthStore();
  const storeTenants = useTenantStore((s) => s.tenants);
  const isGodView = useIsGodView();
  const navigate = useNavigate();
  const location = useLocation();
  const { isCollapsed: tenantCollapsed, toggle: toggleTenant } = useTenantCollapse();

  const query = searchQuery.trim();
  const isSearching = query.length > 0;
  const isAdmin = currentUser?.role === 'admin';
  // Monitors are draggable for canCreate users (as before); devices also need
  // 'agents.manage'; groups need 'groups.manage' plus write access on them;
  // reorder is admin-only (server route). New groups: canCreateGroup.
  const canMove = canCreateCheck();
  const canMoveDevices = canMove && hasCapability('agents.manage');
  const canMoveGroups = hasCapability('groups.manage');
  const canCreateGroup = canCreateGroupCheck();

  const [active, setActive] = useState<TreeDragData | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  useEffect(() => {
    fetchTree();
    fetchGroupStats();
    fetchSummary();
    fetchAllHeartbeats(estimateMaxBars());
    const interval = setInterval(() => {
      fetchGroupStats();
      fetchSummary();
    }, 60000);
    return () => clearInterval(interval);
  }, [fetchTree, fetchGroupStats, fetchSummary, fetchAllHeartbeats]);

  // Auto-expand ancestors when navigating to a group detail / settings page
  useEffect(() => {
    const match = location.pathname.match(/^\/group\/(\d+)(?:\/edit)?$/);
    if (match) {
      const groupId = Number(match[1]);
      expandAncestors(groupId);
    }
  }, [location.pathname, expandAncestors]);

  const ungroupedMonitors = getMonitorsByGroup(null);
  const {
    list: ungroupedDevices,
    enabled: devicesEnabled,
    statuses: deviceStatuses,
    deviceIds,
  } = useGroupDevices(null);
  const { devices: allDevices } = useAllDevices();

  const deviceTenant = useMemo(
    () => new Map(allDevices.map((d) => [d.id, d.tenantId] as const)),
    [allDevices],
  );
  const tenantNameById = useMemo(
    () => new Map(storeTenants.map((tn) => [tn.id, tn.name] as const)),
    [storeTenants],
  );
  const writableGroupIds = useMemo(
    () => computeWritableGroupIds(tree, isAdmin, permissions?.permissions),
    [tree, isAdmin, permissions],
  );

  // While searching: every group whose subtree holds a matching monitor or device.
  const matchingGroupIds = useMemo(() => {
    if (!isSearching) return null;
    const direct = new Set<number>();
    for (const m of monitorMap.values()) {
      if (m.groupId == null) continue;
      // With the devices list, an agent is matched through its device row.
      if (m.type === 'agent' && devicesEnabled && m.agentDeviceId != null && deviceIds.has(m.agentDeviceId)) continue;
      if (monitorMatchesSearch(m, query)) direct.add(m.groupId);
    }
    for (const d of allDevices) {
      if (d.groupId != null && deviceMatchesSearch(d, query)) direct.add(d.groupId);
    }
    const out = new Set<number>();
    const walk = (n: GroupTreeNode): boolean => {
      let hit = direct.has(n.id);
      for (const c of n.children) if (walk(c)) hit = true;
      if (hit) out.add(n.id);
      return hit;
    };
    tree.forEach(walk);
    return out;
  }, [isSearching, query, monitorMap, allDevices, devicesEnabled, deviceIds, tree]);

  // ── Drag and drop ──────────────────────────────────────────────────────────

  const dropRules: DropRules = {
    tree, writableGroupIds, canReorder: isAdmin, canMoveGroups, canMoveDevices, deviceTenant,
  };

  const accepts = useCallback(
    (drop: TreeDropData) => active !== null
      && isValidTreeDrop(active, drop, {
        tree, writableGroupIds, canReorder: isAdmin, canMoveGroups, canMoveDevices, deviceTenant,
      }),
    [active, tree, writableGroupIds, isAdmin, canMoveGroups, canMoveDevices, deviceTenant],
  );

  const dndState = useMemo<TreeDndState>(
    () => ({ active, writableGroupIds, canReorder: isAdmin, canMoveGroups, canMoveDevices, accepts }),
    [active, writableGroupIds, isAdmin, canMoveGroups, canMoveDevices, accepts],
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActive((event.active.data.current as TreeDragData | undefined) ?? null);
  };

  /** Reparent (drop on a group / root) or reorder (drop between siblings) a group. */
  const dropGroup = async (node: GroupTreeNode, drop: TreeDropData) => {
    const currentParent = node.parentId ?? null;
    let step: 'move' | 'reorder' = 'move';
    try {
      if (drop.type === 'between') {
        const newParent = drop.parentId;
        if (newParent !== currentParent) {
          const moved = await groupsApi.move(node.id, newParent);
          updateGroup(moved.id, moved);
        }
        // The server stores plain sort orders: send the whole target sibling list.
        step = 'reorder';
        const ordered = siblingIds(tree, newParent, node.tenantId).filter((id) => id !== node.id);
        const at = drop.insertBeforeId === null
          ? ordered.length
          : Math.max(0, ordered.indexOf(drop.insertBeforeId));
        ordered.splice(at, 0, node.id);
        await groupsApi.reorder(ordered.map((id, idx) => ({ id, sortOrder: idx })));
        if (newParent !== null) expandGroup(newParent);
        toast.success(newParent === currentParent ? t('groups.reordered') : t('groups.moved'));
      } else {
        const newParent = drop.type === 'group' ? drop.groupId : null;
        const moved = await groupsApi.move(node.id, newParent);
        updateGroup(moved.id, moved);
        if (newParent !== null) expandGroup(newParent);
        toast.success(t('groups.moved'));
      }
    } catch (err) {
      toast.error(apiErrorMessage(err, step === 'reorder' ? t('groups.failedReorder') : t('groups.failedMove')));
    } finally {
      // The group:* socket events only reach the admin room: re-read ourselves.
      fetchTree();
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    setActive(null);
    const drag = event.active.data.current as TreeDragData | undefined;
    const drop = event.over?.data.current as TreeDropData | undefined;
    if (!drag || !drop) return;

    if (!isValidTreeDrop(drag, drop, dropRules)) {
      // Explain the one refusal that is not obvious; other invalid drops
      // (onto itself, its current place, a descendant) are silent no-ops.
      if (isCrossTenantDrop(drag, drop, deviceTenant)) {
        toast.error(t('groupTree.crossTenant', 'Items cannot be moved to another workspace'));
      }
      return;
    }

    if (drag.type === 'group') {
      await dropGroup(drag.node, drop);
      return;
    }

    const targetGroupId = drop.type === 'group' ? drop.groupId : null;

    // Monitor drop. Agent monitors are never draggable: an agent is moved
    // through its device row (below), and the server mirrors the group onto
    // the agent monitor.
    if (drag.type === 'monitor') {
      const monitor = drag.monitor;
      if (monitor.type === 'agent') return;
      try {
        await monitorsApi.update(monitor.id, { groupId: targetGroupId });
        updateMonitor(monitor.id, { groupId: targetGroupId });
        fetchTree();
        toast.success(t('groupTree.monitorMoved'));
      } catch (err) {
        toast.error(apiErrorMessage(err, t('groupTree.failedMoveMonitor')));
      }
      return;
    }

    // Agent device drop — same tree, distinct API
    const device = drag.device;
    try {
      await agentApi.updateDevice(device.id, { groupId: targetGroupId });
      // The server mirrors the group onto the agent's backing monitor; keep
      // the local copy in step so group counts move with the device.
      for (const m of useMonitorStore.getState().getMonitorList()) {
        if (m.type === 'agent' && m.agentDeviceId === device.id) updateMonitor(m.id, { groupId: targetGroupId });
      }
      toast.success(t('groupTree.agentMoved'));
      // Sidebar polls devices; we let its 30s tick + socket frames refresh.
    } catch (err) {
      toast.error(apiErrorMessage(err, t('groupTree.failedMoveAgent')));
    }
  };

  // ── Rows ───────────────────────────────────────────────────────────────────

  // Hybrid model: every group can contain both monitors and agent devices.
  const visibleRoots = matchingGroupIds ? tree.filter((n) => matchingGroupIds.has(n.id)) : tree;

  const filteredUngrouped = isSearching
    ? ungroupedMonitors.filter((m) => monitorMatchesSearch(m, query))
    : ungroupedMonitors;

  const filteredUngroupedDevices = isSearching
    ? ungroupedDevices.filter((d) => deviceMatchesSearch(d, query))
    : ungroupedDevices;

  // Rows actually rendered in the "Ungrouped" sections (see splitAgentMonitors).
  const { regular: ungroupedRegular, agents: ungroupedAgentMonitors } = splitAgentMonitors(filteredUngrouped);
  const ungroupedFallbackAgents = fallbackAgentMonitors(ungroupedAgentMonitors, devicesEnabled, deviceIds);
  const visibleUngroupedDevices = devicesEnabled ? filteredUngroupedDevices : [];
  const ungroupedMaintenanceIds = agentsInMaintenance(ungroupedMonitors);

  // God View: one bucket per tenant holding its root groups AND its ungrouped
  // monitors / devices. Master tenant first, then alphabetical. Ungrouped
  // monitors whose tenant is unknown (see monitorTenantId) are listed after
  // the buckets rather than guessed into one.
  const orphans: Pick<TreeBucket, 'monitors' | 'agentMonitors' | 'devices'> = { monitors: [], agentMonitors: [], devices: [] };
  let buckets: TreeBucket[];
  if (isGodView) {
    const byTenant = new Map<number, TreeBucket>();
    const bucket = (tenantId: number) => {
      let b = byTenant.get(tenantId);
      if (!b) {
        b = { tenantId, roots: [], monitors: [], agentMonitors: [], devices: [] };
        byTenant.set(tenantId, b);
      }
      return b;
    };
    for (const n of visibleRoots) bucket(n.tenantId).roots.push(n);
    for (const m of ungroupedRegular) {
      const tid = monitorTenantId(m, deviceTenant);
      (tid === null ? orphans : bucket(tid)).monitors.push(m);
    }
    for (const m of ungroupedFallbackAgents) {
      const tid = monitorTenantId(m, deviceTenant);
      (tid === null ? orphans : bucket(tid)).agentMonitors.push(m);
    }
    for (const d of visibleUngroupedDevices) bucket(d.tenantId).devices.push(d);

    const nameOf = (id: number) => tenantNameById.get(id) ?? `Tenant ${id}`;
    buckets = [...byTenant.values()].sort((a, b) => {
      const ta = a.tenantId!;
      const tb = b.tenantId!;
      if (isMasterTenant(ta)) return -1;
      if (isMasterTenant(tb)) return 1;
      return nameOf(ta).localeCompare(nameOf(tb));
    });
  } else {
    buckets = [{
      tenantId: null,
      roots: visibleRoots,
      monitors: ungroupedRegular,
      agentMonitors: ungroupedFallbackAgents,
      devices: visibleUngroupedDevices,
    }];
  }

  const isEmpty = buckets.every((b) => b.roots.length === 0 && ungroupedRowCount(b) === 0)
    && ungroupedRowCount(orphans) === 0;

  const renderBucketBody = (b: TreeBucket) => (
    <>
      {b.roots.map((node) => (
        <GroupNode
          key={node.id}
          node={node}
          selectedGroupId={selectedGroupId}
          onSelectGroup={onSelectGroup}
          dndEnabled={canMove}
          searchQuery={query}
          matchingGroupIds={matchingGroupIds}
        />
      ))}
      {/* Reorder slot after the last root group of this tenant */}
      {isAdmin && b.roots.length > 0 && (
        <DropBetween parentId={null} insertBeforeId={null} tenantId={b.tenantId} depth={0} />
      )}
      {ungroupedRowCount(b) > 0 && (
        <UngroupedSection
          dropId={`drop-ungrouped-${b.tenantId ?? 'all'}`}
          tenantId={b.tenantId}
          label={t('nav.ungrouped', 'Ungrouped')}
          showDivider={b.tenantId === null && b.roots.length > 0}
          monitors={b.monitors}
          agentMonitors={b.agentMonitors}
          devices={b.devices}
          deviceStatuses={deviceStatuses}
          maintenanceDeviceIds={ungroupedMaintenanceIds}
          dndEnabled={canMove}
          navigate={navigate}
          location={location}
          getMonitorSummary={getMonitorSummary}
        />
      )}
    </>
  );

  // A group is being dragged and may go to the root level: say so in the header.
  const rootHint = active?.type === 'group' && accepts({ type: 'root', tenantId: null });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={treeCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActive(null)}
    >
      <TreeDndContext.Provider value={dndState}>
        <div className="space-y-0.5">
          {showHeader && (
            <RootDropZone id="drop-root" tenantId={null}>
              <div className="flex min-h-[28px] items-center gap-1 pl-2 pr-0.5">
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-[0.14em]',
                    rootHint ? 'text-accent' : 'text-text-muted',
                  )}
                >
                  {rootHint
                    ? t('groupTree.dropToRoot', 'Drop here to move to the root level')
                    : t('nav.groups', 'Groups')}
                </span>
                {canCreateGroup && (
                  <IconButton
                    label={t('groups.new', 'New group')}
                    icon={<Plus size={14} />}
                    size="sm"
                    variant="accent"
                    touchTarget="overlay"
                    onClick={() => setCreateOpen(true)}
                  />
                )}
              </div>
            </RootDropZone>
          )}

          {buckets.map((b) => {
            if (b.tenantId === null) {
              return <div key="flat" className="space-y-0.5">{renderBucketBody(b)}</div>;
            }
            const tenantId = b.tenantId;
            // While searching the per-tenant collapse is ignored, otherwise a
            // query would silently hide the matches of a folded tenant.
            const collapsed = tenantCollapsed(tenantId) && !isSearching;
            return (
              <div key={tenantId} className="space-y-0.5">
                <RootDropZone id={`drop-root-${tenantId}`} tenantId={tenantId}>
                  <TenantBucketHeader
                    tenantId={tenantId}
                    tenantName={tenantNameById.get(tenantId)}
                    collapsed={collapsed}
                    onToggle={() => toggleTenant(tenantId)}
                  />
                </RootDropZone>
                {!collapsed && renderBucketBody(b)}
              </div>
            );
          })}

          {/* God view: ungrouped monitors whose tenant is not known client-side */}
          {ungroupedRowCount(orphans) > 0 && (
            <UngroupedSection
              dropId="drop-ungrouped-unknown-tenant"
              tenantId={null}
              label={t('groupTree.ungroupedAllTenants', 'Ungrouped — all workspaces')}
              showDivider
              monitors={orphans.monitors}
              agentMonitors={orphans.agentMonitors}
              devices={orphans.devices}
              deviceStatuses={deviceStatuses}
              maintenanceDeviceIds={ungroupedMaintenanceIds}
              dndEnabled={canMove}
              navigate={navigate}
              location={location}
              getMonitorSummary={getMonitorSummary}
            />
          )}

          {/* Empty state */}
          {isEmpty && (
            <div className="py-4 text-center text-sm text-text-muted">
              {isSearching
                ? t('groupTree.noMatches', 'No matching monitors')
                : t('groupTree.empty', 'No monitors yet')}
            </div>
          )}
        </div>
      </TreeDndContext.Provider>

      <DragOverlay dropAnimation={null}>
        {active?.type === 'monitor' && (
          <div className="flex items-center gap-2 rounded-md bg-bg-secondary border border-accent px-3 py-1.5 text-sm shadow-lg">
            <MonitorStatusBadge status={active.monitor.status} size="sm" inMaintenance={active.monitor.inMaintenance} />
            <span className="text-text-primary">{anonymize(active.monitor.name)}</span>
          </div>
        )}
        {active?.type === 'agent-device' && (
          <div className="flex items-center gap-2 rounded-md bg-bg-secondary border border-accent px-3 py-1.5 text-sm shadow-lg">
            <Cpu size={12} className="shrink-0 text-text-muted" />
            <span className="text-text-primary">{anonymize(active.device.name ?? active.device.hostname)}</span>
          </div>
        )}
        {active?.type === 'group' && (
          <div className="flex items-center gap-2 rounded-md bg-bg-secondary border border-accent px-3 py-1.5 text-sm shadow-lg">
            <Folder size={14} className="shrink-0 text-accent" />
            <span className="text-text-primary">{anonymize(active.node.name)}</span>
          </div>
        )}
      </DragOverlay>

      <CreateGroupModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </DndContext>
  );
}

/** Drop target meaning "root level" for a dragged group (tree header, tenant headers). */
function RootDropZone({ id, tenantId, children }: { id: string; tenantId: number | null; children: ReactNode }) {
  const { accepts } = useContext(TreeDndContext);
  const data: TreeDropData = { type: 'root', tenantId };
  const { setNodeRef, isOver } = useDroppable({ id, data });
  return (
    <div
      ref={setNodeRef}
      className={cn('rounded-md transition-colors', isOver && accepts(data) && 'bg-accent/10 ring-1 ring-accent/30')}
    >
      {children}
    </div>
  );
}

/** Ungrouped section — acts as a drop target (groupId = null; groups: root level) */
function UngroupedSection({
  dropId,
  tenantId,
  label,
  showDivider,
  monitors,
  agentMonitors,
  devices,
  deviceStatuses,
  maintenanceDeviceIds,
  dndEnabled,
  navigate,
  location,
  getMonitorSummary,
}: {
  dropId: string;
  /** Tenant of the bucket (god view), null = no constraint. */
  tenantId: number | null;
  label: string;
  /** Separator above the section (flat view, after the groups). */
  showDivider: boolean;
  /** Non-agent monitors (draggable rows). */
  monitors: Monitor[];
  /** Agent monitors rendered as device-style rows (only when the devices list is disabled). */
  agentMonitors: Monitor[];
  /** Agent devices (only when the devices list is enabled). */
  devices: AgentDevice[];
  deviceStatuses: Map<number, MonitorStatus | 'suspended' | undefined>;
  /** Devices whose agent monitor is in a maintenance window. */
  maintenanceDeviceIds: Set<number>;
  dndEnabled: boolean;
  navigate: ReturnType<typeof import('react-router-dom').useNavigate>;
  location: ReturnType<typeof import('react-router-dom').useLocation>;
  getMonitorSummary: (id: number) => { uptimePct: number; avgResponseTime: number | null } | undefined;
}) {
  const { accepts, canMoveDevices } = useContext(TreeDndContext);
  const data: TreeDropData = { type: 'ungrouped', groupId: null, tenantId };
  const { setNodeRef, isOver } = useDroppable({ id: dropId, data });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'transition-colors rounded-md',
        isOver && accepts(data) && 'bg-accent/10 ring-1 ring-accent/30',
      )}
    >
      {showDivider && (
        <div className="my-2 border-t border-border" />
      )}
      <div className={cn('px-2 py-1 text-xs font-medium text-text-muted uppercase tracking-wider', !showDivider && 'mt-1')}>
        {label}
      </div>
      {monitors.map((monitor) => (
        <DraggableMonitor
          key={monitor.id}
          monitor={monitor}
          depth={0}
          dndEnabled={dndEnabled}
          navigate={navigate}
          location={location}
          getMonitorSummary={getMonitorSummary}
        />
      ))}
      {agentMonitors.map((monitor) => (
        <AgentMonitorRow key={`agent-mon-${monitor.id}`} monitor={monitor} depth={0} />
      ))}
      {devices.map((device) => (
        <DraggableDevice
          key={`dev-${device.id}`}
          device={device}
          status={deviceStatuses.get(device.id)}
          depth={0}
          dndEnabled={dndEnabled && canMoveDevices}
          inMaintenance={maintenanceDeviceIds.has(device.id)}
        />
      ))}
    </div>
  );
}

/**
 * Device-style row for an agent, built from its backing monitor. Used when the
 * viewer has no access to the devices list (non-admins): same Cpu icon and
 * layout as <DraggableDevice>, never draggable (an agent is moved through its
 * device). Links to the device page (/agents/:id is open to anyone who can
 * read the agent monitor), or to the monitor view for an orphan agent monitor.
 */
export function AgentMonitorRow({ monitor, depth }: { monitor: Monitor; depth: number }) {
  const location = useLocation();
  const to = monitor.agentDeviceId != null ? `/agents/${monitor.agentDeviceId}` : `/monitor/${monitor.id}`;
  const isActive = location.pathname === to;

  return (
    <div style={{ paddingLeft: `${depth * 16 + 8}px` }}>
      <Link
        to={to}
        className={cn(
          'flex items-center gap-2 rounded-md py-1 px-2 text-sm transition-colors',
          isActive
            ? 'bg-accent/10 text-accent-hover'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
      >
        <Cpu size={12} className="shrink-0 text-text-muted" />
        <MonitorStatusBadge status={monitor.status} size="sm" inMaintenance={monitor.inMaintenance} />
        <span className="truncate flex-1 text-xs">{anonymize(monitor.agentDeviceName ?? monitor.name)}</span>
      </Link>
    </div>
  );
}

/** Format a numeric-looking value with locale grouping.
 *  Very small numbers (< 0.001) use full decimal notation to avoid toLocaleString()
 *  collapsing them to "0" (which only allows 3 fraction digits by default).
 */
function formatVal(v: string): string {
  const n = Number(v);
  if (!isNaN(n) && isFinite(n)) {
    if (n !== 0 && Math.abs(n) < 0.001) {
      // How many decimal places needed to show at least 4 significant digits
      const places = Math.max(0, -Math.floor(Math.log10(Math.abs(n)))) + 4;
      return n.toFixed(Math.min(places, 15)).replace(/\.?0+$/, '') || '0';
    }
    return n.toLocaleString();
  }
  return v;
}

/** A single monitor item that is draggable (admin only) */
export function DraggableMonitor({
  monitor,
  depth,
  dndEnabled,
  navigate,
  location,
  getMonitorSummary,
}: {
  monitor: Monitor;
  depth: number;
  dndEnabled: boolean;
  navigate: ReturnType<typeof import('react-router-dom').useNavigate>;
  location: ReturnType<typeof import('react-router-dom').useLocation>;
  getMonitorSummary: (id: number) => { uptimePct: number; avgResponseTime: number | null } | undefined;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggableMonitor(
    monitor,
    dndEnabled,
  );
  const { getRecentHeartbeats } = useMonitorStore();

  const isActive = location.pathname === `/monitor/${monitor.id}`;
  const mSummary = getMonitorSummary(monitor.id);
  const isValueWatcher = monitor.type === 'value_watcher';

  // For value_watcher: get the current value from latest heartbeat, and previous from monitor field
  let currentValue: string | null = null;
  let previousValue: string | null = null;
  if (isValueWatcher) {
    const hbs = getRecentHeartbeats(monitor.id);
    const latest = hbs.length > 0 ? hbs[hbs.length - 1] : null;
    currentValue = latest?.value ?? null;
    previousValue = monitor.valueWatcherPreviousValue ?? null;
  }

  return (
    <button
      ref={dndEnabled ? setNodeRef : undefined}
      {...(dndEnabled ? { ...attributes, ...listeners } : {})}
      onClick={() => navigate(`/monitor/${monitor.id}`)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors',
        isActive
          ? 'bg-bg-active text-text-primary'
          : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        isDragging && 'opacity-40',
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <Activity size={12} className="shrink-0 text-text-muted" />
      <MonitorStatusBadge status={monitor.status} size="sm" inMaintenance={monitor.inMaintenance} />
      <span className="truncate flex-1 text-left">{anonymize(monitor.name)}</span>

      {isValueWatcher ? (
        <>
          {/* Previous value → Current value badges for value_watcher */}
          {previousValue != null && currentValue != null && previousValue !== currentValue && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-semibold text-text-muted line-through">
              {formatVal(previousValue)}
            </span>
          )}
          {currentValue != null && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              {formatVal(currentValue)}
            </span>
          )}
        </>
      ) : (
        <>
          {/* Default: uptime % + response time badges */}
          {mSummary && (
            <span
              className={cn(
                'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                mSummary.uptimePct >= 99
                  ? 'bg-status-up-bg text-status-up'
                  : mSummary.uptimePct >= 95
                    ? 'bg-yellow-500/10 text-yellow-500'
                    : 'bg-status-down-bg text-status-down',
              )}
            >
              {mSummary.uptimePct}%
            </span>
          )}
          {mSummary?.avgResponseTime != null && (
            <span className="shrink-0 inline-flex items-center rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-semibold text-text-muted">
              {Math.round(mSummary.avgResponseTime)}ms
            </span>
          )}
        </>
      )}
    </button>
  );
}

/** Hook wrapper for useDraggable to avoid conditional hook calls */
function useDraggableMonitor(monitor: Monitor, enabled: boolean) {
  const data: TreeDragData = { type: 'monitor', monitor };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `monitor-${monitor.id}`,
    data,
    disabled: !enabled,
  });
  return { attributes, listeners, setNodeRef, isDragging };
}
