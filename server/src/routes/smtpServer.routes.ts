import { Router } from 'express';
import { smtpServerController } from '../controllers/smtpServer.controller';
import { requireAuth } from '../middleware/auth';
import { requireAnyTenantCapability, requireTenantCapability } from '../middleware/rbac';

const router = Router();

// The list is also the SMTP picker of the notification-channel form:
// 'settings' OR 'notifications' (the controller trims the rows for callers
// without 'settings'). Registered before the blanket 'settings' gate.
router.get('/', requireAuth, requireAnyTenantCapability('settings', 'notifications'), smtpServerController.list);

// Everything else: SMTP servers are workspace settings (tenant capability 'settings')
router.use(requireAuth, requireTenantCapability('settings'));

router.post('/', smtpServerController.create);
router.put('/:id', smtpServerController.update);
router.delete('/:id', smtpServerController.delete);
router.post('/:id/test', smtpServerController.test);

export default router;
