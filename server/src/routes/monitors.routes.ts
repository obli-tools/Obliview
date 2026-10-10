import { Router } from 'express';
import { monitorsController } from '../controllers/monitors.controller';
import { requireAuth } from '../middleware/auth';
import { requireMonitorWrite, requireCanCreate, requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import {
  createMonitorSchema,
  updateMonitorSchema,
  bulkUpdateSchema,
} from '../validators/monitor.schema';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Read routes (visibility check in controller)
router.get('/summary', monitorsController.summary);
router.get('/uptime-series', monitorsController.uptimeSeries);
router.get('/heartbeats/all', monitorsController.allHeartbeats);
router.get('/', monitorsController.list);
router.get('/:id', monitorsController.getById);
router.get('/:id/heartbeats', monitorsController.heartbeats);
router.get('/:id/stats', monitorsController.stats);

// Bulk operations MUST be defined before /:id routes (otherwise /bulk matches /:id first)
router.patch('/bulk', validate(bulkUpdateSchema), monitorsController.bulkUpdate);
router.delete('/bulk', requireTenantCapability('monitors.manage'), monitorsController.bulkDelete);
router.post('/bulk/pause', monitorsController.bulkPause);

// Write routes (permission-based: admin OR team RW).
// Create / delete also need the tenant capability 'monitors.manage':
// teams decide WHERE, the tenant role decides WHAT.
router.post('/', requireCanCreate('monitors.manage'), validate(createMonitorSchema), monitorsController.create);
router.put('/:id', requireMonitorWrite(), validate(updateMonitorSchema), monitorsController.update);
router.delete('/:id', requireTenantCapability('monitors.manage'), requireMonitorWrite(), monitorsController.delete);
router.post('/:id/pause', requireMonitorWrite(), monitorsController.pause);

export default router;
