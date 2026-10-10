import { Router } from 'express';
import { twoFactorController } from '../controllers/twoFactor.controller';
import { requireAuth } from '../middleware/auth';
import { mfaLimiter, mfaAccountLimiter, mfaResendLimiter, stepUpLimiter } from '../middleware/rateLimiter';

const router = Router();

// Profile 2FA routes (requires auth). Adding, replacing or removing a factor
// needs a step-up proof in the body (currentCode, else currentPassword — see
// checkFactorManagement in the controller); wrong proofs and wrong enable
// codes are capped per user by stepUpLimiter.
router.get('/status', requireAuth, twoFactorController.status);
router.post('/totp/setup', requireAuth, stepUpLimiter, twoFactorController.totpSetup);
router.post('/totp/enable', requireAuth, stepUpLimiter, twoFactorController.totpEnable);
router.delete('/totp', requireAuth, stepUpLimiter, twoFactorController.totpDisable);
router.post('/email/setup', requireAuth, stepUpLimiter, twoFactorController.emailSetup);
router.post('/email/enable', requireAuth, stepUpLimiter, twoFactorController.emailEnable);
router.delete('/email', requireAuth, stepUpLimiter, twoFactorController.emailDisable);

// Auth 2FA routes (rate-limited, no requireAuth — session has pendingMfaUserId):
// per IP (mfaLimiter) AND per pending account (mfaAccountLimiter).
router.post('/verify', mfaLimiter, mfaAccountLimiter, twoFactorController.verify);
router.post('/resend-email', mfaLimiter, mfaAccountLimiter, mfaResendLimiter, twoFactorController.resendEmail);

export default router;
