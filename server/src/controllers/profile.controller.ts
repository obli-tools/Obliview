import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { comparePassword, hashPassword } from '../utils/crypto';
import { AppError } from '../middleware/errorHandler';
import type { UpdateProfileInput, ChangePasswordInput } from '../validators/profile.schema';

function buildUserResponse(row: Record<string, unknown>) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preferences: row.preferences ?? null,
    email: row.email ?? null,
    preferredLanguage: row.preferred_language ?? 'en',
    enrollmentVersion: row.enrollment_version ?? 0,
    hasPassword: !!row.password_hash,
    avatar: row.avatar ?? null,
  };
}

// Profile picture: a base64 data URL of a PNG, JPEG or WebP image, 512 KB
// max once decoded (no image library is a server dependency: the client
// resizes to 256 px before uploading; the server only validates and caps).
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

function hasImageSignature(type: string, buf: Buffer): boolean {
  switch (type) {
    case 'png':
      return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpeg':
      return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'webp':
      return buf.length > 12
        && buf.subarray(0, 4).toString('ascii') === 'RIFF'
        && buf.subarray(8, 12).toString('ascii') === 'WEBP';
    default:
      return false;
  }
}

/** Validated avatar data URL, or an AppError (400 / 413). */
function parseAvatar(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError(400, 'Invalid image: a PNG, JPEG or WebP data URL is expected', 'AVATAR_INVALID');
  }
  // Base64 is 4/3 of the binary size: refuse oversized strings before decoding.
  if (value.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 64) {
    throw new AppError(413, 'Image too large (512 KB max)', 'AVATAR_TOO_LARGE');
  }
  const m = AVATAR_DATA_URL.exec(value);
  if (!m) {
    throw new AppError(400, 'Invalid image: a PNG, JPEG or WebP data URL is expected', 'AVATAR_INVALID');
  }
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new AppError(413, 'Image too large (512 KB max)', 'AVATAR_TOO_LARGE');
  }
  if (!hasImageSignature(m[1], bytes)) {
    throw new AppError(400, 'Invalid image: the content does not match its type', 'AVATAR_INVALID');
  }
  return value;
}

/** Obligate SSO users: the avatar is synced from Obligate at each sign-in. */
async function assertLocalAccount(userId: number | undefined): Promise<void> {
  const row = await db('users').where({ id: userId }).first('foreign_source') as
    { foreign_source: string | null } | undefined;
  if (!row) throw new AppError(404, 'User not found');
  if (row.foreign_source === 'obligate') {
    throw new AppError(403, 'The profile picture of an SSO account is managed in Obligate.', 'SSO_AVATAR_MANAGED');
  }
}

export const profileController = {
  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const row = await db('users')
        .select('id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'password_hash', 'avatar')
        .where({ id: req.session.userId })
        .first();

      if (!row) throw new AppError(404, 'User not found');

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as UpdateProfileInput;

      const updatePayload: Record<string, unknown> = { updated_at: new Date() };

      if ('displayName' in data) updatePayload.display_name = data.displayName;
      if ('preferences' in data) {
        updatePayload.preferences = data.preferences !== undefined ? JSON.stringify(data.preferences) : null;
      }
      if ('preferredLanguage' in data) updatePayload.preferred_language = data.preferredLanguage;

      if ('email' in data) {
        const current = await db('users')
          .select('email', 'email_otp_enabled', 'password_hash', 'foreign_source')
          .where({ id: req.session.userId })
          .first() as {
            email: string | null; email_otp_enabled: boolean | null;
            password_hash: string | null; foreign_source: string | null;
          } | undefined;
        if (!current) throw new AppError(404, 'User not found');

        const newEmail = data.email || null;
        const normalize = (v: string | null | undefined) => String(v ?? '').trim().toLowerCase();
        if (normalize(newEmail) === normalize(current.email)) {
          // A profile form re-saved with the same address (or a case /
          // spacing fix) is not a change of channel: no proof needed.
          if (current.foreign_source !== 'obligate') updatePayload.email = newEmail;
        } else {
          // users.email is the password-reset channel: a stolen session alone
          // must not be able to move it.
          if (current.foreign_source === 'obligate') {
            // Synced from Obligate at each SSO sign-in; managed there.
            throw new AppError(403, 'The e-mail address of an SSO account is managed in Obligate.', 'SSO_EMAIL_MANAGED');
          }
          // Read from req.stepUpProof: updateProfileSchema strips unknown keys
          // from the body (middleware/captureStepUpProof.ts).
          const currentPassword = req.stepUpProof?.currentPassword;
          if (!currentPassword) {
            throw new AppError(400, 'Enter your current password to change your e-mail address.', 'CURRENT_PASSWORD_REQUIRED');
          }
          if (!current.password_hash || !(await comparePassword(currentPassword, current.password_hash))) {
            throw new AppError(403, 'Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
          }
          updatePayload.email = newEmail;
          // E-mail codes went to the old address: switch them off.
          if (current.email_otp_enabled) updatePayload.email_otp_enabled = false;
        }
      }

      const [row] = await db('users')
        .where({ id: req.session.userId })
        .update(updatePayload)
        .returning(['id', 'username', 'display_name', 'role', 'is_active', 'created_at', 'updated_at', 'preferences', 'email', 'preferred_language', 'enrollment_version', 'password_hash', 'avatar']);

      if (!row) throw new AppError(404, 'User not found');

      res.json({ success: true, data: buildUserResponse(row) });
    } catch (err) {
      next(err);
    }
  },

  async changePassword(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { currentPassword, newPassword } = req.body as ChangePasswordInput;

      const user = await db('users').select('password_hash').where({ id: req.session.userId }).first();
      if (!user) throw new AppError(404, 'User not found');

      const valid = await comparePassword(currentPassword, user.password_hash);
      if (!valid) throw new AppError(400, 'Current password is incorrect');

      const newHash = await hashPassword(newPassword);
      await db('users').where({ id: req.session.userId }).update({ password_hash: newHash, updated_at: new Date() });

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/profile/avatar  { avatar: 'data:image/<png|jpeg|webp>;base64,...' }
  async uploadAvatar(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await assertLocalAccount(req.session.userId);
      const avatar = parseAvatar((req.body as { avatar?: unknown } | undefined)?.avatar);
      const n = await db('users').where({ id: req.session.userId }).update({ avatar, updated_at: new Date() });
      if (!n) throw new AppError(404, 'User not found');
      res.json({ success: true, data: { avatar } });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/profile/avatar
  async deleteAvatar(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      await assertLocalAccount(req.session.userId);
      await db('users').where({ id: req.session.userId }).update({ avatar: null, updated_at: new Date() });
      res.json({ success: true, data: { avatar: null } });
    } catch (err) {
      next(err);
    }
  },
};
