import { Router } from 'express';
import { groupsController } from '../controllers/groups.controller';
import { requireAuth } from '../middleware/auth';
import { requireRole, requireGroupWrite, requireCanCreate, requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import {
  createGroupSchema,
  updateGroupSchema,
  moveGroupSchema,
} from '../validators/group.schema';

const router = Router();

// All routes require authentication
router.use(requireAuth);

// Read routes (visibility filtering in controller)
router.get('/', groupsController.list);
router.get('/tree', groupsController.tree);
router.get('/stats', groupsController.stats);
router.get('/:id', groupsController.getById);
router.get('/:id/monitors', groupsController.getMonitors);
router.get('/:id/heartbeats', groupsController.heartbeats);
router.get('/:id/detail-stats', groupsController.groupDetailStats);

// Write routes (permission-based: admin OR team RW).
// Create / delete / move also need the tenant capability 'groups.manage':
// teams decide WHERE, the tenant role decides WHAT.
router.post('/', requireCanCreate('groups.manage'), validate(createGroupSchema), groupsController.create);
router.put('/:id', requireGroupWrite(), validate(updateGroupSchema), groupsController.update);
router.post('/reorder', requireRole('admin'), groupsController.reorder);
router.post('/:id/move', requireTenantCapability('groups.manage'), requireGroupWrite(), validate(moveGroupSchema), groupsController.move);
router.delete('/:id', requireTenantCapability('groups.manage'), requireGroupWrite(), groupsController.delete);
router.delete('/:id/heartbeats', requireGroupWrite(), groupsController.clearHeartbeats);
router.patch('/:id/agent-config', requireRole('admin'), groupsController.updateAgentGroupConfig);
// Agent update policy of the group (inherited by its sub-groups): agent managers
// of the group's workspace (the group must belong to the active tenant).
router.get('/:id/agent-update-policy', requireTenantCapability('agents.manage'), groupsController.getAgentUpdatePolicy);
router.put('/:id/agent-update-policy', requireTenantCapability('agents.manage'), groupsController.setAgentUpdatePolicy);

export default router;
