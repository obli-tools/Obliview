import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { importExportController } from '../controllers/importExport.controller';

const router = Router();

// All import/export routes are platform-admin only. The gate is applied per route (not via a
// path-less router.use) because this router is mounted on '/admin': a blanket gate would also
// shadow every other '/admin/*' mount (e.g. '/admin/smtp-servers').
router.get('/export', requireAuth, requirePlatformAdmin(), importExportController.exportData);
router.post('/import', requireAuth, requirePlatformAdmin(), importExportController.importData);

export default router;
