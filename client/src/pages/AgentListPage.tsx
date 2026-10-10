import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Trash2,
  Cpu,
  CheckCircle,
  RefreshCw,
  ExternalLink,
  Pencil,
  PowerOff,
  X,
  Settings2,
  Undo2,
  ArrowRightLeft,
  DownloadCloud,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { SOCKET_EVENTS, MASTER_TENANT_ID } from '@obliview/shared';
import type { MonitorGroup } from '@obliview/shared';
import { anonymize, anonymizeIp } from '@/utils/anonymize';
import { agentApi, type AgentApiKeyWithDefault, type AgentFleetDevice, type AgentRuntimeStatus } from '@/api/agent.api';
import { groupsApi } from '@/api/groups.api';
import { getSocket } from '@/socket/socketClient';
import { Button } from '@/components/common/Button';
import { IconButton } from '@/components/common/IconButton';
import { Checkbox } from '@/components/common/Checkbox';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { TenantBucketHeader } from '@/components/common/TenantBucketHeader';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { ActionMenu, type ActionMenuItem } from '@/components/common/ActionMenu';
import {
  AGENT_RUNTIME_STATUSES,
  AgentDeviceStatusBadge,
  deviceApprovalStatus,
  deviceRuntimeStatus,
  isPendingUninstall,
} from '@/components/agent/DeviceStatusBadge';
import { TransferTenantModal } from '@/components/agent/TransferTenantModal';
import { ApproveAgentModal } from '@/components/agent/ApproveAgentModal';
import { EditAgentModal, type EditAgentData } from '@/components/agent/EditAgentModal';
import { BulkEditAgentModal, type BulkEditAgentData } from '@/components/agent/BulkEditAgentModal';
import { ResolvedUpdatePolicyBadge, agentUpdateErrorMessage, frozenUpdateHint } from '@/components/agent/UpdatePolicyField';
import { useUiStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsGodView } from '@/hooks/useIsGodView';
import { useTenantCollapse } from '@/hooks/useTenantCollapse';
import { MEDIA, useMediaQuery } from '@/hooks/useMediaQuery';
import { apiErrorMessage } from '@/utils/apiError';
import { cn } from '@/utils/cn';

type AgentDevice = AgentFleetDevice;
type DeviceStatusFilter = 'all' | AgentDevice['status'];
const STATUS_FILTERS: readonly DeviceStatusFilter[] = ['all', 'approved', 'refused', 'suspended', 'pending'];
type RuntimeFilter = 'all' | AgentRuntimeStatus;
const RUNTIME_FILTERS: readonly RuntimeFilter[] = ['all', ...AGENT_RUNTIME_STATUSES];
/** Number of columns of the devices table (tenant bucket rows span all of them). */
const COLUMN_COUNT = 7;

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Page ──────────────────────────────────────────────────────────────────────

/**
 * /agents — the agent (device) list: approval filters, bulk actions and, in
 * God View, one collapsible bucket per tenant. Moved out of the old devices
 * tab of /manage/agents, which is now the agent configuration hub (API keys).
 *
 * `?status=pending|approved|refused|suspended` preselects the approval filter
 * (the sidebar pending badge links to /agents?status=pending) and
 * `?runtime=online|offline|alert|…` the runtime status filter.
 *
 * Open to every user: GET /agent/devices returns every device of the
 * workspace to agents.manage holders and, to everyone else, the devices whose
 * agent monitor they can see. Selection, bulk actions, approval and the other
 * lifecycle actions are only offered with agents.manage.
 */
export function AgentListPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isWide = useMediaQuery(MEDIA.lg);

  // ── Approval filter, synced to ?status= ──────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get('status');
  const deviceFilter: DeviceStatusFilter = (STATUS_FILTERS as readonly string[]).includes(rawStatus ?? '')
    ? (rawStatus as DeviceStatusFilter)
    : 'all';
  const setDeviceFilter = useCallback((f: DeviceStatusFilter) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (f === 'all') params.delete('status');
      else params.set('status', f);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  // ── Runtime status filter, synced to ?runtime= ──────────────────────────────
  const rawRuntime = searchParams.get('runtime');
  const runtimeFilter: RuntimeFilter = (RUNTIME_FILTERS as readonly string[]).includes(rawRuntime ?? '')
    ? (rawRuntime as RuntimeFilter)
    : 'all';
  const setRuntimeFilter = useCallback((f: RuntimeFilter) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (f === 'all') params.delete('runtime');
      else params.set('runtime', f);
      return params;
    }, { replace: true });
  }, [setSearchParams]);

  const [devices, setDevices] = useState<AgentDevice[]>([]);
  // API keys (default group preselection in the approve / edit modals).
  const [keys, setKeys] = useState<AgentApiKeyWithDefault[]>([]);
  const [groups, setGroups] = useState<MonitorGroup[]>([]);
  const [loaded, setLoaded] = useState(false);

  // God View = platform admin connected to the master tenant. The backend
  // already fans devices out cross-tenant in that case; we bucket them per
  // tenant and show a banner so the operator knows the listing is global.
  const isGodView = useIsGodView();
  const storeTenants = useTenantStore((s) => s.tenants);
  const tenantNameById = new Map(storeTenants.map((tn) => [tn.id, tn.name]));
  const { isCollapsed: tenantCollapsed, toggle: toggleTenantCollapsed } = useTenantCollapse();
  const [tenantFilter, setTenantFilter] = useState<Set<number>>(new Set());

  const { openAddAgentModal } = useUiStore();
  // Subscribes to the store so the page re-renders when capabilities load.
  const { hasCapability } = useAuthStore();
  const canManage = hasCapability('agents.manage');
  // Tenant transfer is platform-admin only (POST /agent/devices/batch/transfer).
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [approvingDevice, setApprovingDevice] = useState<AgentDevice | null>(null);
  const [editingDevice, setEditingDevice] = useState<AgentDevice | null>(null);
  const [transferDevices, setTransferDevices] = useState<AgentDevice[] | null>(null);

  // ── Live operational status (socket) ─────────────────────────────────────────
  const [liveAgentStatus, setLiveAgentStatus] = useState<Map<number, string>>(new Map());

  // ── Bulk select state ────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBulkEditModal, setShowBulkEditModal] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await agentApi.listDevices());
    } catch {
      toast.error(t('agents.failedLoad'));
    } finally {
      setLoaded(true);
    }
  }, [t]);

  const loadGroups = useCallback(async () => {
    try {
      const tree = await groupsApi.tree();
      const flat: MonitorGroup[] = [];
      const flatten = (nodes: typeof tree) => {
        for (const n of nodes) {
          flat.push(n);
          flatten(n.children);
        }
      };
      flatten(tree);
      setGroups(flat);
    } catch {
      // ignore — the modals then simply offer "No group"
    }
  }, []);

  const loadKeys = useCallback(async () => {
    try {
      setKeys(await agentApi.listKeys());
    } catch {
      // ignore — the modals then preselect no default group
    }
  }, []);

  useEffect(() => {
    void loadDevices();
    void loadGroups();
  }, [loadDevices, loadGroups]);

  useEffect(() => {
    if (canManage) void loadKeys();
  }, [canManage, loadKeys]);

  // Mirror of `devices` for socket handlers (they are registered once and
  // must not run side effects inside a setState updater).
  const devicesRef = useRef<AgentDevice[]>(devices);
  devicesRef.current = devices;

  // Debounced full reload: an AGENT_DEVICE_UPDATED for a device we do not
  // track yet (typically a NEW pending registration) needs the list from the
  // server. Bursts (bulk approve, several agents registering) collapse into
  // a single refetch.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimerRef.current) return;
    reloadTimerRef.current = setTimeout(() => {
      reloadTimerRef.current = null;
      void loadDevices();
    }, 400);
  }, [loadDevices]);
  useEffect(() => () => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
  }, []);

  // Live updates via Socket.io
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onPush = (data: { deviceId: number; agentVersion?: string }) => {
      if (!data.agentVersion) return;
      setDevices(prev => prev.map(d =>
        d.id === data.deviceId && d.agentVersion !== data.agentVersion
          ? { ...d, agentVersion: data.agentVersion! }
          : d,
      ));
    };

    // The server emits the full device (rowToDevice, keyed by `id`). Older
    // servers sent a partial `{ deviceId, name, hostname, status, groupId }`,
    // which is still accepted: whatever fields arrive are merged in.
    const onDeviceUpdated = (data: Partial<AgentDevice> & { deviceId?: number }) => {
      const { deviceId: legacyId, ...patch } = data;
      const deviceId = patch.id ?? legacyId;
      if (deviceId == null) { scheduleReload(); return; }
      if (!devicesRef.current.some(d => d.id === deviceId)) {
        // Untracked (new pending device, or one moved into our scope): refetch.
        scheduleReload();
        return;
      }
      setDevices(prev => prev.map(d => (d.id === deviceId ? { ...d, ...patch, id: deviceId } : d)));
      // A fresh server runtime state replaces an older live value.
      if (patch.runtimeStatus !== undefined) {
        setLiveAgentStatus(prev => {
          if (!prev.has(deviceId)) return prev;
          const next = new Map(prev);
          next.delete(deviceId);
          return next;
        });
      }
    };

    // Auto-delete after uninstall: remove device from list & selection
    const onDeviceDeleted = (data: { deviceId: number }) => {
      setDevices(prev => prev.filter(d => d.id !== data.deviceId));
      setSelectedIds(prev => {
        if (!prev.has(data.deviceId)) return prev;
        const next = new Set(prev);
        next.delete(data.deviceId);
        return next;
      });
    };

    // Track live operational status per device (e.g. 'updating')
    const onAgentStatusChanged = (data: { deviceId: number; status: string }) => {
      setLiveAgentStatus(prev => {
        const next = new Map(prev);
        next.set(data.deviceId, data.status);
        return next;
      });
    };

    socket.on('agentPush', onPush);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatusChanged);
    return () => {
      socket.off('agentPush', onPush);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_DELETED, onDeviceDeleted);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onAgentStatusChanged);
    };
  }, [scheduleReload]);

  // ── Derived lists ────────────────────────────────────────────────────────────

  // Tenant chips only exist in God View; outside it the filter is a no-op.
  const tenantScoped = isGodView && tenantFilter.size > 0
    ? devices.filter(d => tenantFilter.has(d.tenantId))
    : devices;
  const runtimeOf = (d: AgentDevice) => deviceRuntimeStatus(d, liveAgentStatus.get(d.id));
  const approvalScoped = deviceFilter === 'all'
    ? tenantScoped
    : tenantScoped.filter(d => deviceApprovalStatus(d) === deviceFilter);
  // A pending or refused device has no runtime state: runtime filters only
  // ever match approved / suspended devices.
  const filteredDevices = runtimeFilter === 'all'
    ? approvalScoped
    : approvalScoped.filter(d => runtimeOf(d) === runtimeFilter);
  const pendingCount = devices.filter(d => deviceApprovalStatus(d) === 'pending').length;
  const presentTenantIds = Array.from(new Set(devices.map(d => d.tenantId)));

  // Bulk actions only ever act on rows the operator can see (a device that
  // left the current filter through a live update is not acted upon).
  const selectedDevices = filteredDevices.filter(d => selectedIds.has(d.id));
  const selectedCount = selectedDevices.length;

  // A filter change starts a fresh selection.
  const tenantFilterKey = [...tenantFilter].sort((a, b) => a - b).join(',');
  useEffect(() => {
    setSelectedIds(new Set());
  }, [deviceFilter, runtimeFilter, tenantFilterKey]);

  // The bulk dialog closes for good when its selection vanishes (live
  // deletions), instead of popping up again on the next selection.
  useEffect(() => {
    if (selectedCount === 0) setShowBulkEditModal(false);
  }, [selectedCount]);

  // ── Select-all checkbox indeterminate state ──────────────────────────────────
  const allSelected = filteredDevices.length > 0 && filteredDevices.every(d => selectedIds.has(d.id));
  const someSelected = !allSelected && filteredDevices.some(d => selectedIds.has(d.id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredDevices.map(d => d.id)));
  };

  const toggleSelect = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const dropFromSelection = (id: number) => {
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const filterLabel = (f: DeviceStatusFilter): string => {
    switch (f) {
      case 'all': return t('agents.filter.all', 'All');
      case 'approved': return t('agents.filter.approved', 'Approved');
      case 'refused': return t('agents.filter.refused', 'Refused');
      case 'suspended': return t('agents.filter.suspended', 'Suspended');
      case 'pending': return t('agents.filter.pending', 'Pending');
    }
  };

  const runtimeLabel = (f: RuntimeFilter): string => {
    switch (f) {
      case 'all': return t('agents.runtimeFilter.all', 'Any state');
      case 'online': return t('agents.runtime.online', 'Online');
      case 'offline': return t('agents.runtime.offline', 'Offline');
      case 'alert': return t('agents.runtime.alert', 'Alert');
      case 'maintenance': return t('agents.runtime.maintenance', 'Maintenance');
      case 'updating': return t('agents.runtime.updating', 'Updating');
      case 'update_error': return t('agents.runtime.updateError', 'Update failed');
      case 'pending_uninstall': return t('agents.runtime.pendingUninstall', 'Pending uninstall');
      case 'suspended': return t('agents.runtime.suspended', 'Suspended');
    }
  };

  const emptyLabel = (f: DeviceStatusFilter): string => {
    if (runtimeFilter !== 'all') return t('agents.empty.runtime', 'No agents in this state');
    switch (f) {
      case 'all': return t('agents.empty.all', 'No agents yet');
      case 'approved': return t('agents.empty.approved', 'No approved devices');
      case 'refused': return t('agents.empty.refused', 'No refused devices');
      case 'suspended': return t('agents.empty.suspended', 'No suspended devices');
      case 'pending': return t('agents.empty.pending', 'No devices waiting for approval');
    }
  };

  // ── Device actions ───────────────────────────────────────────────────────────

  /** Apply a device returned by a lifecycle call (null = refetch the list). */
  const mergeDevice = (updated: AgentDevice | null) => {
    if (updated) setDevices(prev => prev.map(d => (d.id === updated.id ? { ...d, ...updated } : d)));
    else void loadDevices();
  };

  const handleApprove = async (groupId: number | null) => {
    if (!approvingDevice) return;
    try {
      await agentApi.updateDevice(approvingDevice.id, { status: 'approved', groupId });
      toast.success(t('agents.deviceApproved', { hostname: anonymize(approvingDevice.hostname) }));
      setApprovingDevice(null);
      void loadDevices();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedApprove')));
    }
  };

  const handleRefuse = async (device: AgentDevice) => {
    const ok = await confirm({
      message: t('agents.confirmRefuse', { hostname: anonymize(device.hostname) }),
      danger: true,
      confirmLabel: t('agents.refuse', 'Refuse'),
    });
    if (!ok) return;
    try {
      await agentApi.updateDevice(device.id, { status: 'refused' });
      toast.success(t('agents.deviceRefused'));
      void loadDevices();
    } catch {
      toast.error(t('agents.failedRefuse'));
    }
  };

  /** Refused → back to pending (it must be approved again). */
  const handleReinstate = async (device: AgentDevice) => {
    try {
      await agentApi.updateDevice(device.id, { status: 'pending' });
      toast.success(t('agents.deviceReinstated'));
      void loadDevices();
    } catch {
      toast.error(t('agents.failedReinstate'));
    }
  };

  /** Suspended → approved again (monitor resumed). */
  const handleResume = async (device: AgentDevice) => {
    try {
      await agentApi.updateDevice(device.id, { status: 'approved' });
      toast.success(t('agents.deviceResumed', 'Agent reactivated'));
      void loadDevices();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedReinstate')));
    }
  };

  const handleDeleteDevice = async (device: AgentDevice) => {
    const ok = await confirm({
      message: t('agents.confirmDeleteDevice', { hostname: anonymize(device.name ?? device.hostname) }),
      danger: true,
    });
    if (!ok) return;
    try {
      await agentApi.deleteDevice(device.id);
      toast.success(t('agents.deviceDeleted'));
      dropFromSelection(device.id);
      void loadDevices();
    } catch {
      toast.error(t('agents.failedDeleteDevice'));
    }
  };

  /** Send an uninstall command to a single device. */
  const handleUninstallDevice = async (device: AgentDevice) => {
    const ok = await confirm({
      message: t('agents.confirmUninstall', { hostname: anonymize(device.name ?? device.hostname) }),
      danger: true,
      confirmLabel: t('agents.uninstall', 'Uninstall'),
    });
    if (!ok) return;
    try {
      const updated = await agentApi.uninstallDevice(device.id);
      toast.success(t('agents.uninstallQueued'));
      mergeDevice(updated);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedUninstall')));
    }
  };

  /** Withdraw an uninstall the agent did not receive yet. */
  const handleCancelUninstall = async (device: AgentDevice) => {
    try {
      const updated = await agentApi.cancelUninstall(device.id);
      toast.success(t('agents.uninstallCancelled', 'Uninstall cancelled'));
      mergeDevice(updated);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedCancelUninstall', 'Failed to cancel the uninstall')));
    }
  };

  /** Queue a paced update to the latest agent version. */
  const handleUpdateNow = async (device: AgentDevice) => {
    try {
      const { result, device: updated } = await agentApi.requestUpdate(device.id);
      mergeDevice(updated);
      if (result.queued > 0) {
        toast.success(t('agents.updateQueued', 'Update queued: the agent updates when the rollout reaches it'));
      } else if (result.alreadyQueued > 0) {
        toast(t('agents.updateAlreadyQueued', 'An update is already queued for this agent'));
      } else if (result.upToDate > 0) {
        toast(t('agents.alreadyUpToDate', 'This agent already runs the latest version'));
      }
    } catch (err) {
      toast.error(agentUpdateErrorMessage(err, t, t('agents.failedUpdateQueue', 'Failed to queue the update')));
    }
  };

  const handleEditSave = async (data: EditAgentData) => {
    if (!editingDevice) return;
    try {
      const newStatus = data.suspended ? 'suspended'
        : editingDevice.status === 'suspended' ? 'approved'
        : undefined;
      await agentApi.updateDevice(editingDevice.id, {
        name: data.name,
        ...(data.groupId !== undefined ? { groupId: data.groupId } : {}),
        heartbeatMonitoring: data.heartbeatMonitoring,
        overrideGroupSettings: data.overrideGroupSettings,
        ...(newStatus ? { status: newStatus } : {}),
      });
      toast.success(t('agents.agentUpdated'));
      setEditingDevice(null);
      void loadDevices();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedUpdateAgent')));
    }
  };

  // ── Bulk actions ─────────────────────────────────────────────────────────────

  const handleBulkDelete = async () => {
    const ids = selectedDevices.map(d => d.id);
    const count = ids.length;
    if (count === 0) return;
    const ok = await confirm({
      message: t('agents.confirmBulkDelete', { count }),
      danger: true,
      requireText: String(count),
    });
    if (!ok) return;
    try {
      await agentApi.bulkDeleteDevices(ids);
      toast.success(t('agents.bulkDeleted', { count }));
      setSelectedIds(new Set());
      void loadDevices();
    } catch {
      toast.error(t('agents.failedBulkDelete'));
    }
  };

  const handleBulkUninstall = async () => {
    // Proxies ignore 'uninstall' (the server skips them too).
    const ids = selectedDevices.filter(d => d.deviceType !== 'proxy').map(d => d.id);
    const count = ids.length;
    if (count === 0) {
      if (selectedDevices.length > 0) {
        toast.error(t('agents.bulkUninstallNoAgent', 'Proxies cannot be uninstalled remotely: stop the proxy, then delete the device'));
      }
      return;
    }
    const ok = await confirm({
      message: t('agents.confirmBulkUninstall', { count }),
      danger: true,
      requireText: String(count),
      confirmLabel: t('agents.uninstall', 'Uninstall'),
    });
    if (!ok) return;
    try {
      await agentApi.bulkUninstall(ids);
      toast.success(t('agents.bulkUninstallQueued', { count }));
      setSelectedIds(new Set());
      void loadDevices();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedBulkUninstall')));
    }
  };

  /** Paced update of the selected approved agents (pending ones are never updated). */
  const handleBulkUpdate = async () => {
    const ids = selectedDevices.filter(d => deviceApprovalStatus(d) === 'approved').map(d => d.id);
    const count = ids.length;
    if (count === 0) {
      toast.error(t('agents.bulkUpdateNone', 'No approved agent in the selection'));
      return;
    }
    const ok = await confirm({
      message: t('agents.confirmBulkUpdateAgents', 'Update the agent on {{count}} device(s)? Updates are handed out at the rollout pace.', { count }),
      confirmLabel: t('agents.updateNow', 'Update now'),
    });
    if (!ok) return;
    try {
      const result = await agentApi.bulkRequestUpdate(ids);
      toast.success(t('agents.bulkUpdateQueued', 'Update queued for {{count}} agent(s)', { count: result ? result.queued : count }));
      if (result && result.frozen > 0) {
        toast(t('agentUpdatePolicy.bulkFrozenSkipped', {
          defaultValue: '{{count}} frozen agent(s) skipped (update policy: frozen)',
          count: result.frozen,
        }));
      }
      setSelectedIds(new Set());
      void loadDevices();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedUpdateQueue', 'Failed to queue the update')));
    }
  };

  const handleBulkEditSave = async (data: BulkEditAgentData) => {
    const ids = selectedDevices.map(d => d.id);
    const count = ids.length;
    try {
      await agentApi.bulkUpdateDevices(ids, data);
      toast.success(t('agents.bulkUpdated', { count }));
      setShowBulkEditModal(false);
      setSelectedIds(new Set());
      void loadDevices();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.failedBulkUpdate')));
    }
  };

  // ── Rows ─────────────────────────────────────────────────────────────────────

  const thCls = 'px-4 py-2.5 text-left text-xs font-medium text-text-muted uppercase tracking-wide whitespace-nowrap';

  const renderDeviceRow = (device: AgentDevice) => {
    const selected = selectedIds.has(device.id);
    const displayName = anonymize(device.name ?? device.hostname);
    const approval = deviceApprovalStatus(device);
    const pendingUninstall = isPendingUninstall(device);
    const menuItems: ActionMenuItem[] = [
      {
        key: 'update',
        icon: <DownloadCloud size={14} />,
        label: t('agents.updateNow', 'Update now'),
        // Update policy 'off' at some level: manual updates are refused too.
        description: frozenUpdateHint(t, device.resolvedUpdatePolicy),
        disabled: device.resolvedUpdatePolicy?.policy === 'off',
        onClick: () => void handleUpdateNow(device),
        hidden: approval !== 'approved' || pendingUninstall,
      },
      {
        key: 'cancel-uninstall',
        icon: <Undo2 size={14} />,
        label: t('agents.cancelUninstall', 'Cancel uninstall'),
        onClick: () => void handleCancelUninstall(device),
        hidden: !pendingUninstall,
      },
      {
        key: 'uninstall',
        icon: <PowerOff size={14} />,
        label: t('agents.uninstallAgent', 'Uninstall agent'),
        onClick: () => void handleUninstallDevice(device),
        // A proxy ignores 'uninstall': it is stopped by hand, then deleted.
        hidden: pendingUninstall || approval === 'pending' || device.deviceType === 'proxy',
      },
      {
        key: 'transfer',
        icon: <ArrowRightLeft size={14} />,
        label: t('agents.transfer.action', 'Transfer to another workspace'),
        onClick: () => setTransferDevices([device]),
        hidden: !isPlatformAdmin,
      },
      {
        key: 'delete',
        icon: <Trash2 size={14} />,
        label: t('common.delete'),
        onClick: () => void handleDeleteDevice(device),
        danger: true,
        separator: true,
      },
    ];
    return (
      <tr
        key={device.id}
        // The pinned first cell (narrow screens) follows the row hover colour.
        className={cn(
          'hover:bg-bg-hover hover:[--table-sticky-bg:rgb(var(--c-bg-hover))] transition-colors',
          selected && 'bg-accent/5',
        )}
      >
        {/* Sticky first column on narrow screens: selection + name stay visible. */}
        <td className="px-3 py-3 align-top">
          <div className="flex items-start gap-3">
            {canManage && (
              <Checkbox
                checked={selected}
                onCheckedChange={() => toggleSelect(device.id)}
                aria-label={t('agents.selectDevice', 'Select {{name}}', { name: displayName })}
                wrapperClassName="mt-0.5"
              />
            )}
            <div className="min-w-0 max-w-[14rem] sm:max-w-none">
              <Link
                to={`/agents/${device.id}`}
                className="font-medium text-text-primary hover:text-accent transition-colors break-words"
              >
                {displayName}
              </Link>
              {device.deviceType === 'proxy' && (
                <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-blue-500/15 text-blue-400">
                  {t('agents.proxyBadge', 'Proxy')}
                </span>
              )}
              {device.name && (
                <div className="text-[10px] text-text-muted mt-0.5">{anonymize(device.hostname)}</div>
              )}
              <div className="text-[10px] text-text-muted font-mono mt-0.5">{device.uuid.slice(0, 12)}…</div>
            </div>
          </div>
        </td>
        <td className="px-4 py-3 text-text-muted whitespace-nowrap">{anonymizeIp(device.ip) || '—'}</td>
        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
          {device.osInfo
            ? `${device.osInfo.distro ?? device.osInfo.platform} ${device.osInfo.release ?? ''}`
            : '—'}
        </td>
        <td className="px-4 py-3 text-text-muted whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            <span>{device.agentVersion ?? '—'}</span>
            {/* Effective update policy (auto / manual / frozen) of approved agents. */}
            {approval === 'approved' && device.deviceType !== 'proxy' && (
              <ResolvedUpdatePolicyBadge resolved={device.resolvedUpdatePolicy} />
            )}
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <AgentDeviceStatusBadge device={device} liveStatus={liveAgentStatus.get(device.id)} />
          </div>
        </td>
        <td className="px-4 py-3 text-text-muted text-xs whitespace-nowrap">{formatDate(device.createdAt)}</td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1">
            {canManage && approval === 'pending' && (
              <>
                <Button size="sm" onClick={() => setApprovingDevice(device)}>
                  <CheckCircle size={12} className="mr-1" />{t('agents.approve')}
                </Button>
                <Button size="sm" variant="danger" onClick={() => handleRefuse(device)}>
                  {t('agents.refuse', 'Refuse')}
                </Button>
              </>
            )}
            {/* Every device can be inspected, whatever its approval state. */}
            <Link
              to={`/agents/${device.id}`}
              className="inline-flex items-center gap-1 whitespace-nowrap px-2 py-1 rounded text-xs font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors coarse:min-h-10"
            >
              <ExternalLink size={12} />
              {t('agents.view', 'View')}
            </Link>
            {canManage && approval === 'refused' && (
              <Button size="sm" variant="secondary" onClick={() => handleReinstate(device)}>
                {t('agents.reinstate', 'Reinstate')}
              </Button>
            )}
            {canManage && approval === 'suspended' && (
              <Button size="sm" variant="secondary" onClick={() => handleResume(device)}>
                {t('agents.reinstate', 'Reinstate')}
              </Button>
            )}
            {canManage && (approval === 'approved' || approval === 'suspended') && (
              <IconButton
                label={t('common.edit')}
                icon={<Pencil size={13} />}
                onClick={() => setEditingDevice(device)}
              />
            )}
            {canManage && <ActionMenu items={menuItems} triggerSize="sm" />}
          </div>
        </td>
      </tr>
    );
  };

  const renderRows = (): ReactNode[] => {
    // Flat list outside God View.
    if (!isGodView) return filteredDevices.map(renderDeviceRow);

    // God View: bucket by tenant, master first then alpha, with a collapsible
    // full-width header per tenant.
    const byTenant = new Map<number, AgentDevice[]>();
    for (const d of filteredDevices) {
      if (!byTenant.has(d.tenantId)) byTenant.set(d.tenantId, []);
      byTenant.get(d.tenantId)!.push(d);
    }
    const ordered = Array.from(byTenant.entries()).sort(([a], [b]) => {
      if (a === MASTER_TENANT_ID) return -1;
      if (b === MASTER_TENANT_ID) return 1;
      return (tenantNameById.get(a) ?? '').localeCompare(tenantNameById.get(b) ?? '');
    });
    const rows: ReactNode[] = [];
    for (const [tid, devs] of ordered) {
      const collapsed = tenantCollapsed(tid);
      rows.push(
        <tr key={`hdr-${tid}`} className="bg-accent/5">
          <td colSpan={COLUMN_COUNT} className="px-3 py-0">
            <TenantBucketHeader
              tenantId={tid}
              variant="row"
              collapsed={collapsed}
              onToggle={() => toggleTenantCollapsed(tid)}
              countLabel={t('agents.deviceCount', '{{count}} device(s)', { count: devs.length })}
            />
          </td>
        </tr>,
      );
      if (!collapsed) {
        for (const d of devs) rows.push(renderDeviceRow(d));
      }
    }
    return rows;
  };

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <h1 className="text-2xl font-semibold text-text-primary">{t('nav.agents', 'Agents')}</h1>
          {pendingCount > 0 && (
            <button
              type="button"
              onClick={() => setDeviceFilter('pending')}
              className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-400 hover:bg-yellow-500/30 transition-colors"
            >
              {t('agents.pendingCount', '{{count}} pending', { count: pendingCount })}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <IconButton
            label={t('common.refresh')}
            icon={<RefreshCw size={14} />}
            size="lg"
            onClick={() => void loadDevices()}
          />
          {canManage && (
            <Button onClick={openAddAgentModal}>
              <Plus size={14} className="mr-1.5" />{t('agents.addAgent')}
            </Button>
          )}
        </div>
      </div>

      {/* God View banner — visible only to platform admins on the master tenant */}
      {isGodView && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-accent/30 bg-accent/10 px-3 py-2 sm:items-center">
          <span className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-accent text-bg-primary">
            {t('agents.godView.badge', 'God View')}
          </span>
          <p className="text-xs text-text-secondary">
            {t('agents.godView.devices', 'Showing devices across every tenant. Switch tenant via the topbar to scope to a single workspace.')}
          </p>
        </div>
      )}

      {/* Approval status filter */}
      <div
        role="group"
        aria-label={t('agents.filter.label', 'Approval status')}
        className="flex gap-1 mb-3 overflow-x-auto overscroll-x-contain scrollbar-none"
      >
        {STATUS_FILTERS.map(f => (
          <button
            key={f}
            type="button"
            aria-pressed={deviceFilter === f}
            onClick={() => setDeviceFilter(f)}
            className={cn(
              'shrink-0 whitespace-nowrap px-3 py-1.5 text-sm rounded-md transition-colors coarse:min-h-10',
              deviceFilter === f
                ? 'bg-bg-tertiary text-text-primary font-medium'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
            )}
          >
            {filterLabel(f)}
            {f !== 'all' && (
              <span className="ml-1.5 text-xs text-text-muted">
                ({tenantScoped.filter(d => deviceApprovalStatus(d) === f).length})
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Runtime status filter (states with no device are hidden unless selected) */}
      <div
        role="group"
        aria-label={t('agents.runtimeFilter.label', 'Agent state')}
        className="flex gap-1 mb-3 overflow-x-auto overscroll-x-contain scrollbar-none"
      >
        {RUNTIME_FILTERS.map(f => {
          const count = f === 'all' ? 0 : approvalScoped.filter(d => runtimeOf(d) === f).length;
          if (f !== 'all' && count === 0 && runtimeFilter !== f) return null;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={runtimeFilter === f}
              onClick={() => setRuntimeFilter(f)}
              className={cn(
                'shrink-0 whitespace-nowrap px-3 py-1 text-xs rounded-md transition-colors coarse:min-h-10',
                runtimeFilter === f
                  ? 'bg-bg-tertiary text-text-primary font-medium'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
              )}
            >
              {runtimeLabel(f)}
              {f !== 'all' && <span className="ml-1.5 text-text-muted">({count})</span>}
            </button>
          );
        })}
      </div>

      {/* God View: narrow the cross-tenant list (renders nothing elsewhere). */}
      <TenantFilterChips
        value={tenantFilter}
        onChange={setTenantFilter}
        availableTenantIds={presentTenantIds}
        className="mb-4"
      />

      {/* Bulk action bar */}
      {canManage && selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-3 px-4 py-2.5 rounded-lg bg-accent/10 border border-accent/20">
          <span className="text-sm font-medium text-accent">
            {t('agents.selectedCount', '{{count}} selected', { count: selectedCount })}
          </span>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            <Button size="sm" variant="secondary" onClick={() => setShowBulkEditModal(true)}>
              <Settings2 size={12} className="mr-1.5" />{t('common.edit')}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleBulkUpdate}>
              <DownloadCloud size={12} className="mr-1.5" />{t('agents.updateNow', 'Update now')}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleBulkUninstall}>
              <PowerOff size={12} className="mr-1.5" />{t('agents.uninstall', 'Uninstall')}
            </Button>
            {isPlatformAdmin && (
              <Button size="sm" variant="secondary" onClick={() => setTransferDevices(selectedDevices)}>
                <ArrowRightLeft size={12} className="mr-1.5" />{t('agents.transfer.short', 'Transfer')}
              </Button>
            )}
            <Button size="sm" variant="danger" onClick={handleBulkDelete}>
              <Trash2 size={12} className="mr-1.5" />{t('common.delete')}
            </Button>
            <IconButton
              label={t('agents.clearSelection', 'Clear selection')}
              icon={<X size={14} />}
              onClick={() => setSelectedIds(new Set())}
            />
          </div>
        </div>
      )}

      {/* Devices table */}
      {filteredDevices.length === 0 ? (
        <div className="rounded-lg bg-bg-secondary py-12 text-center px-4">
          <Cpu size={32} className="mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">
            {loaded ? emptyLabel(deviceFilter) : t('common.loading')}
          </p>
          {loaded && canManage && runtimeFilter === 'all' && (deviceFilter === 'pending' || deviceFilter === 'all') && (
            <p className="text-xs text-text-muted mt-1">
              {t('agents.addAgentEmpty')}
            </p>
          )}
        </div>
      ) : (
        <TableScroll className="rounded-lg bg-bg-secondary" stickyFirstCol={!isWide}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-bg-tertiary">
                <th className={cn(thCls, 'px-3')}>
                  <div className="flex items-center gap-3">
                    {canManage && (
                      <Checkbox
                        ref={selectAllRef}
                        checked={allSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label={allSelected ? t('agents.deselectAll', 'Deselect all') : t('agents.selectAll', 'Select all')}
                        title={allSelected ? t('agents.deselectAll', 'Deselect all') : t('agents.selectAll', 'Select all')}
                      />
                    )}
                    <span>{t('agents.col.hostname', 'Hostname')}</span>
                  </div>
                </th>
                <th className={thCls}>{t('agents.col.ip', 'IP')}</th>
                <th className={thCls}>{t('agents.col.os', 'OS')}</th>
                <th className={thCls}>{t('common.agent')}</th>
                <th className={thCls}>{t('common.status')}</th>
                <th className={thCls}>{t('agents.col.registered', 'Registered')}</th>
                <th className={cn(thCls, 'text-right')}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {renderRows()}
            </tbody>
          </table>
        </TableScroll>
      )}

      {/* Modals */}
      {canManage && approvingDevice && (
        <ApproveAgentModal
          device={approvingDevice}
          groups={groups}
          keys={keys}
          onApprove={handleApprove}
          onCancel={() => setApprovingDevice(null)}
        />
      )}

      {canManage && editingDevice && (
        <EditAgentModal
          device={editingDevice}
          groups={groups}
          keys={keys}
          onSave={handleEditSave}
          onCancel={() => setEditingDevice(null)}
        />
      )}

      {canManage && showBulkEditModal && selectedDevices.length > 0 && (
        <BulkEditAgentModal
          devices={selectedDevices}
          groups={groups}
          keys={keys}
          onSave={handleBulkEditSave}
          onCancel={() => setShowBulkEditModal(false)}
        />
      )}

      {isPlatformAdmin && transferDevices && transferDevices.length > 0 && (
        <TransferTenantModal
          devices={transferDevices.map(d => ({ id: d.id, tenantId: d.tenantId, name: anonymize(d.name ?? d.hostname) }))}
          onClose={() => setTransferDevices(null)}
          onTransferred={() => {
            setSelectedIds(new Set());
            void loadDevices();
          }}
        />
      )}
    </PageContainer>
  );
}

export default AgentListPage;
