import { Router } from 'express';
import { appConfigController } from '../controllers/appConfig.controller';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';

const router = Router();

// GET is available to all authenticated users (needed for profile page to check allow_2fa)
router.get('/', requireAuth, appConfigController.getAll);

// Specific named routes MUST come before /:key (otherwise /:key captures them first)

// Agent global defaults — platform admin only
router.get('/agent-global', requireAuth, requirePlatformAdmin(), appConfigController.getAgentGlobal);
router.patch('/agent-global', requireAuth, requirePlatformAdmin(), appConfigController.patchAgentGlobal);

// Obligate SSO gateway config — platform admin only
router.get('/obligate', requireAuth, requirePlatformAdmin(), appConfigController.getObligateConfig);
router.put('/obligate', requireAuth, requirePlatformAdmin(), appConfigController.setObligateConfig);

// Generic key setter — must be LAST among PUT routes
router.put('/:key', requireAuth, requirePlatformAdmin(), appConfigController.set);

export default router;
