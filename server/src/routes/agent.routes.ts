import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin, requireTenantCapability } from '../middleware/rbac';
import { requireAgentDeviceRead, requireAgentDeviceWrite } from '../middleware/agentRbac';
import { agentAuth } from '../middleware/agentAuth';
import { requireTenant } from '../middleware/tenant';
import { asyncHandler } from '../utils/asyncHandler';
import {
  agentPush,
  notifyingUpdate,
  agentVersion,
  desktopVersion,
  agentDownload,
  agentInstallerLinux,
  agentInstallerWindowsMsi,
  agentInstallerWindowsMsiNt6,
  agentInstallerMacos,
  agentInstallerFreebsd,
  agentInstallerWizard,
  listKeys,
  createKey,
  updateKey,
  deleteKey,
  getDevice,
  getDeviceResolvedThresholds,
  listDevices,
  updateDevice,
  deleteDevice,
  getDeviceMetrics,
  sendDeviceCommand,
  bulkDeleteDevices,
  bulkUpdateDevices,
  bulkDeviceCommand,
  uninstallDevice,
  bulkUninstallDevices,
  cancelUninstallDevice,
  updateDeviceAgent,
  bulkUpdateAgents,
  updateAllAgents,
  cancelAgentUpdates,
  transferDevices,
  listProxyCandidates,
} from '../controllers/agent.controller';

// Every controller is wrapped with asyncHandler: Express 4 does not catch
// rejected async handlers, and on Node 24 an unhandled rejection exits the
// process. The wrapper forwards the error to the global errorHandler instead.

const router = Router();

// ── Public routes (no session auth required) ──────────────────────────────────

// Safety net for misconfigured reverse proxies.
// The real /ws endpoint is a WebSocket upgrade handled by the 'upgrade' event
// listener in index.ts — it never reaches Express.  If a proxy (e.g. Nginx
// Proxy Manager) does NOT have WebSocket Support enabled it strips the Upgrade
// header, Node.js emits 'request' instead of 'upgrade', and Express processes
// it as a plain GET.  Without this route it would fall through to the
// tenant-scoped router (requireAuth) and return a confusing 401.
// With this route the agent gets a clear 400 + explanation instead.
router.get('/ws', (_req, res) => {
  res.status(400).json({
    error: 'WebSocket upgrade required — enable WebSocket Support on the reverse-proxy host for this service',
  });
});

// Agent push — authenticated via X-API-Key header
router.post('/push', agentAuth, asyncHandler(agentPush));

// Pre-update notification — agent calls this before self-updating
router.post('/notifying-update', agentAuth, asyncHandler(notifyingUpdate));

// Agent auto-update endpoints
router.get('/version', asyncHandler(agentVersion));
router.get('/download/:filename', asyncHandler(agentDownload));

// Desktop app version (used by the React app to show update banner)
router.get('/desktop-version', asyncHandler(desktopVersion));

// Installer scripts (with API key injected — the key must exist, otherwise 404)
router.get('/installer/linux', asyncHandler(agentInstallerLinux));
router.get('/installer/macos', asyncHandler(agentInstallerMacos));
router.get('/installer/freebsd', asyncHandler(agentInstallerFreebsd));

// Pre-built Windows MSI (static, SERVERURL + APIKEY passed via msiexec properties)
router.get('/installer/windows.msi', asyncHandler(agentInstallerWindowsMsi));
// Windows 7 SP1 / 8.1 / Server 2008 R2 / 2012 / 2012 R2: the nt6 MSI (Go 1.20 build)
router.get('/installer/windows-nt6.msi', asyncHandler(agentInstallerWindowsMsiNt6));

// ── Session routes (session auth + tenant required) ─────────────────────────
// Agents live inside the team model (see middleware/agentRbac.ts):
//   - read  = RO on the device's agent monitor (requireAgentDeviceRead);
//   - write = RW on it, for notes / display config / sensor names / thresholds
//             (requireAgentDeviceWrite; lifecycle fields of PATCH are checked
//             against agents.manage in the controller);
//   - fleet / lifecycle operations = the 'agents.manage' tenant capability;
//   - API key creation / edition / deletion and tenant transfer = platform admins only.

router.get('/keys', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(listKeys));
router.post('/keys', requireAuth, requirePlatformAdmin(), requireTenant, asyncHandler(createKey));
// Rename / default group (validated against the key's workspace).
router.put('/keys/:id', requireAuth, requirePlatformAdmin(), requireTenant, asyncHandler(updateKey));
router.delete('/keys/:id', requireAuth, requirePlatformAdmin(), requireTenant, asyncHandler(deleteKey));

// Manual-install Wizard download (tenant-scoped key lookup, embeds
// {serverUrl, apiKey} as a tail blob on the wizard binary).
router.get('/installer/wizard.exe', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(agentInstallerWizard));

// Devices the caller may pick as a monitor proxy (MonitorEditPage).
router.get('/proxy-candidates', requireAuth, requireTenant, asyncHandler(listProxyCandidates));

// ⚠️ Bulk routes MUST be declared before /:id routes — otherwise Express matches
//    "bulk" as a device ID and the wrong handler fires.
router.delete('/devices/bulk',        requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(bulkDeleteDevices));
router.patch('/devices/bulk',         requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(bulkUpdateDevices));
router.post('/devices/bulk-uninstall', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(bulkUninstallDevices));
router.post('/devices/bulk-update',  requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(bulkUpdateAgents));
// Compatibility: whitelisted 'uninstall' / 'update' only (no free-form commands).
router.post('/devices/bulk-command',  requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(bulkDeviceCommand));
// Tenant transfer: platform admins only (devices from the current scope, key of the target workspace).
router.post('/devices/batch/transfer', requireAuth, requirePlatformAdmin(), requireTenant, asyncHandler(transferDevices));

// Admin-paced agent updates (agents no longer self-update on every deploy).
// {preview:true} answers the rollout state without queuing anything.
router.post('/update-all',        requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(updateAllAgents));
router.post('/update-all/cancel', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(cancelAgentUpdates));

// Listing: everything for agents.manage, otherwise the devices whose agent
// monitor the user can see (filtered in the controller).
router.get('/devices', requireAuth, requireTenant, asyncHandler(listDevices));
router.get('/devices/:id', requireAuth, requireTenant, requireAgentDeviceRead(), asyncHandler(getDevice));
router.get('/devices/:id/metrics', requireAuth, requireTenant, requireAgentDeviceRead(), asyncHandler(getDeviceMetrics));
router.get('/devices/:id/thresholds-resolved', requireAuth, requireTenant, requireAgentDeviceRead(), asyncHandler(getDeviceResolvedThresholds));
router.patch('/devices/:id', requireAuth, requireTenant, requireAgentDeviceWrite(), asyncHandler(updateDevice));
router.delete('/devices/:id', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(deleteDevice));
router.post('/devices/:id/uninstall', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(uninstallDevice));
router.post('/devices/:id/cancel-uninstall', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(cancelUninstallDevice));
router.post('/devices/:id/update', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(updateDeviceAgent));
// Compatibility: whitelisted 'uninstall' / 'update' only (no free-form commands).
router.post('/devices/:id/command', requireAuth, requireTenant, requireTenantCapability('agents.manage'), asyncHandler(sendDeviceCommand));

export default router;
