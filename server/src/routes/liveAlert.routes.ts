import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenant } from '../middleware/tenant';
import { asyncHandler } from '../utils/asyncHandler';
import * as ctrl from '../controllers/liveAlert.controller';

export const liveAlertRouter = Router();

// Read / dismiss state is per user (live_alert_user_state). Non-admins only
// see and act on alerts of monitors they can read. Hard deletes
// (`?scope=all`) are reserved to platform admins (checked in the controller).

// All tenants accessible by this user (no requireTenant — cross-tenant; every
// tenant for a platform admin in the god view)
liveAlertRouter.get('/all', requireAuth, asyncHandler(ctrl.getAllTenantAlerts));

// Current-tenant endpoints
liveAlertRouter.get('/', requireAuth, requireTenant, asyncHandler(ctrl.getAlerts));
liveAlertRouter.post('/read-all', requireAuth, requireTenant, asyncHandler(ctrl.markAllRead));
liveAlertRouter.delete('/', requireAuth, requireTenant, asyncHandler(ctrl.clearAll));

// Cross-tenant by alert id (tenant access + monitor visibility verified inside controller)
liveAlertRouter.patch('/:id/read', requireAuth, asyncHandler(ctrl.markRead));
liveAlertRouter.delete('/:id', requireAuth, asyncHandler(ctrl.deleteAlert));
