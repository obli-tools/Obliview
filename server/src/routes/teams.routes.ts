import { Router } from 'express';
import { teamsController } from '../controllers/teams.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import {
  createTeamSchema,
  updateTeamSchema,
  setTeamMembersSchema,
  setTeamPermissionsSchema,
} from '../validators/team.schema';

const router = Router();

// Teams are managed per tenant: platform admins, tenant admins and any
// permission set carrying 'users.manage'. Teams are strictly mono-tenant;
// the controller gates every by-id route on the team's tenant.
router.use(requireAuth);
router.use(requireTenantCapability('users.manage'));

// Team CRUD
router.get('/', teamsController.list);
router.get('/:id', teamsController.getById);
router.post('/', validate(createTeamSchema), teamsController.create);
router.put('/:id', validate(updateTeamSchema), teamsController.update);
router.delete('/:id', teamsController.delete);

// Members
router.get('/:id/members', teamsController.getMembers);
router.put('/:id/members', validate(setTeamMembersSchema), teamsController.setMembers);

// Permissions
router.get('/:id/permissions', teamsController.getPermissions);
router.put('/:id/permissions', validate(setTeamPermissionsSchema), teamsController.setPermissions);
router.delete('/:id/permissions/:permId', teamsController.removePermission);

export default router;
