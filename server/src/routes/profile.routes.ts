import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { stepUpLimiter } from '../middleware/rateLimiter';
import { profileController } from '../controllers/profile.controller';
import { updateProfileSchema, changePasswordSchema } from '../validators/profile.schema';

const router = Router();

// All routes require authentication (any role)
router.use(requireAuth);

router.get('/', profileController.get);
// Both check the current password (e-mail change / password change): failed
// attempts are capped per user (successful requests are not counted).
router.put('/', stepUpLimiter, validate(updateProfileSchema), profileController.update);
router.put('/password', stepUpLimiter, validate(changePasswordSchema), profileController.changePassword);
// Profile picture of a local account (Obligate SSO accounts: managed there)
router.put('/avatar', profileController.uploadAvatar);
router.delete('/avatar', profileController.deleteAvatar);

export default router;
