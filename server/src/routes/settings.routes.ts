import { Router } from 'express';
import { z } from 'zod';
import { SETTINGS_KEYS } from '@obliview/shared';
import { settingsController } from '../controllers/settings.controller';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability, requireMonitorWrite, requireGroupWrite } from '../middleware/rbac';
import { validate } from '../middleware/validate';
import { setSettingSchema, setSettingsBulkSchema } from '../validators/settings.schema';

const settingsKeyValues = Object.values(SETTINGS_KEYS) as [string, ...string[]];

/** PUT /settings/monitors/bulk — monitor-scope overrides for a selection. */
const monitorsBulkSchema = z.object({
  monitorIds: z.array(z.number().int().positive()).min(1).max(10_000),
  overrides: z.array(z.object({ key: z.enum(settingsKeyValues), value: z.number() })).default([]),
  remove: z.array(z.enum(settingsKeyValues)).default([]),
}).refine((b) => b.overrides.length + b.remove.length > 0, { message: 'Nothing to change' });

const router = Router();

router.use(requireAuth);

// ── Workspace (global) scope — tenant capability 'settings' ──────────────
// The client addresses it as /global/null (scope id placeholder, ignored).
router.get('/global/resolved', requireTenantCapability('settings'), settingsController.getGlobalResolved);
router.put('/global/:id', requireTenantCapability('settings'), validate(setSettingSchema), settingsController.set('global'));
router.put('/global/:id/bulk', requireTenantCapability('settings'), validate(setSettingsBulkSchema), settingsController.setBulk('global'));
router.delete('/global/:id/:key', requireTenantCapability('settings'), settingsController.remove('global'));

// ── Monitor scope (bulk) — RW on every listed monitor, checked in the controller ──
// Declared before /monitor/:id so the paths can never be confused.
router.put('/monitors/bulk', validate(monitorsBulkSchema), settingsController.setMonitorsBulk);

// ── Group scope — RW holders of the group (admins always) ───────────────────
// The resolved view needs read access (checked in the controller, after the
// tenant ownership check so a foreign group stays a 404).
router.get('/group/:id/resolved', settingsController.getGroupResolved);
router.put('/group/:id', requireGroupWrite(), validate(setSettingSchema), settingsController.set('group'));
router.put('/group/:id/bulk', requireGroupWrite(), validate(setSettingsBulkSchema), settingsController.setBulk('group'));
router.delete('/group/:id/:key', requireGroupWrite(), settingsController.remove('group'));

// ── Monitor scope — RW holders of the monitor (admins always) ───────────────
router.get('/monitor/:id/resolved', settingsController.getMonitorResolved);
router.put('/monitor/:id', requireMonitorWrite(), validate(setSettingSchema), settingsController.set('monitor'));
router.put('/monitor/:id/bulk', requireMonitorWrite(), validate(setSettingsBulkSchema), settingsController.setBulk('monitor'));
router.delete('/monitor/:id/:key', requireMonitorWrite(), settingsController.remove('monitor'));

export default router;
