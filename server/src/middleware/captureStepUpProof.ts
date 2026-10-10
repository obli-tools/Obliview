import type { Request, Response, NextFunction } from 'express';

// Step-up proofs (body.currentPassword, body.currentCode) are COPIED out of
// the JSON body into req.stepUpProof before any router runs.
//
// validate(schema) replaces req.body with the parsed data, and Zod strips
// unknown keys: a route whose schema does not list the proof (e.g.
// PUT /api/profile and updateProfileSchema) would never see it. Controllers
// that require a step-up read req.stepUpProof, whatever the route's schema.
// The body itself is left untouched (PUT /api/profile/password validates its
// own currentPassword field).
//
// Same idea as Obliance's middleware/captureStepUpProof.ts.

declare global {
  namespace Express {
    interface Request {
      /** Step-up proof fields of the JSON body, captured before validation. */
      stepUpProof?: { currentPassword?: string; currentCode?: string };
    }
  }
}

/** Longest password accepted as a proof (bcrypt reads 72 bytes anyway). */
const MAX_PASSWORD_LENGTH = 1024;
/** A TOTP code is 6 digits; anything longer is junk. */
const MAX_CODE_LENGTH = 16;

export function captureStepUpProof(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as unknown;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { currentPassword, currentCode } = body as { currentPassword?: unknown; currentCode?: unknown };
    const proof: { currentPassword?: string; currentCode?: string } = {};
    if (typeof currentPassword === 'string' && currentPassword.length > 0 && currentPassword.length <= MAX_PASSWORD_LENGTH) {
      proof.currentPassword = currentPassword;
    }
    if (typeof currentCode === 'string' || typeof currentCode === 'number') {
      const code = String(currentCode).trim();
      if (code.length > 0 && code.length <= MAX_CODE_LENGTH) proof.currentCode = code;
    }
    if (proof.currentPassword !== undefined || proof.currentCode !== undefined) req.stepUpProof = proof;
  }
  next();
}
