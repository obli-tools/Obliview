import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import authRoutes from './auth.routes';
import tenantRoutes from './tenant.routes';
import monitorsRoutes from './monitors.routes';
import groupsRoutes from './groups.routes';
import settingsRoutes from './settings.routes';
import notificationsRoutes from './notifications.routes';
import heartbeatRoutes from './heartbeat.routes';
import usersRoutes from './users.routes';
import profileRoutes from './profile.routes';
import teamsRoutes from './teams.routes';
import agentRoutes from './agent.routes';
import importExportRoutes from './importExport.routes';
import remediationRoutes from './remediation.routes';
import smtpServerRoutes from './smtpServer.routes';
import appConfigRoutes from './appConfig.routes';
import twoFactorRoutes from './twoFactor.routes';
import maintenanceRoutes from './maintenance.routes';
import { liveAlertRouter } from './liveAlert.routes';
import oblitoolsRoutes from './oblitools.routes';
import obligateCallbackRoutes from './obligateCallback.routes';
import permissionSetsRoutes from './permissionSets.routes';
import systemRoutes from './system.routes';
import auditRoutes from './audit.routes';
import mobileAppRoutes from './mobileApp.routes';
import { startAuditRetentionJob } from '../services/audit.service';

const router = Router();

// ── Global (no tenant required) ────────────────────────────────────────────
router.use('/auth', authRoutes);
router.use('/heartbeat', heartbeatRoutes); // push monitors (no session)
router.use('/agent', agentRoutes);          // agent push (authenticated via API key)
router.use('/admin/config', appConfigRoutes);
router.use('/system', systemRoutes);         // system info / about (admin only, no tenant required)
router.use('/oblitools', oblitoolsRoutes);  // ObliTools desktop manifest (auth required)
router.use('/auth', obligateCallbackRoutes); // Obligate sso-config + connected-apps (callback is mounted in app.ts at /auth)
router.use('/permission-sets', permissionSetsRoutes);
router.use('/profile/2fa', twoFactorRoutes); // must be before /profile
router.use('/mobile', mobileAppRoutes);      // PUBLIC: Android shell version + APK download (no session)

// ── Live alerts (mixed: /all is cross-tenant, rest is tenant-scoped — handled inside router) ──
router.use('/live-alerts', liveAlertRouter);

// ── Tenant management (requireAuth but NOT requireTenant) ──────────────────
// /api/tenants  (CRUD + member management)
// /api/tenant/switch
router.use('/tenants', tenantRoutes);
router.use('/tenant', tenantRoutes);

// ── Tenant-scoped routes (requireAuth + requireTenant) ─────────────────────
const tenantRouter = Router();
tenantRouter.use(requireAuth);
tenantRouter.use(requireTenant);

tenantRouter.use('/monitors', monitorsRoutes);
tenantRouter.use('/groups', groupsRoutes);
tenantRouter.use('/settings', settingsRoutes);
tenantRouter.use('/notifications', notificationsRoutes);
tenantRouter.use('/users', usersRoutes);
tenantRouter.use('/profile', profileRoutes);
tenantRouter.use('/teams', teamsRoutes);
tenantRouter.use('/admin', importExportRoutes);
tenantRouter.use('/remediation', remediationRoutes);
tenantRouter.use('/admin/smtp-servers', smtpServerRoutes);
tenantRouter.use('/maintenance', maintenanceRoutes);
tenantRouter.use('/audit-log', auditRoutes);

router.use('/', tenantRouter);

// Audit log retention (365 days): purge shortly after boot, then daily.
startAuditRetentionJob();

export { router as routes };
