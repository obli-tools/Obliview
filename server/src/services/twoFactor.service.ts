import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import { randomInt } from 'crypto';
import { smtpServerService } from './smtpServer.service';
import { config } from '../config';
import { db } from '../db';
import { logger } from '../utils/logger';

/** TOTP period (seconds). */
const TOTP_PERIOD_S = 30;
/** Accepted drift: ±1 step (±30 s). Was ±2 (5 valid codes per attempt). */
export const TOTP_WINDOW = 1;

export const twoFactorService = {
  // ── TOTP ──────────────────────────────────────────────────────────────────

  generateTotpSecret(username: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = new OTPAuth.TOTP({
      issuer: config.appName,
      label: username,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });
    return {
      secret: secret.base32,
      uri: totp.toString(),
    };
  },

  async generateTotpQr(uri: string): Promise<string> {
    return QRCode.toDataURL(uri);
  },

  /**
   * Checks a TOTP code against [secret] (±TOTP_WINDOW steps). Returns the
   * absolute time step the code belongs to (floor(unix / 30)), or null when
   * the code is wrong. A valid code is NOT accepted yet: the caller passes the
   * step to acceptTotpStep(), which refuses a replay.
   */
  verifyTotpStep(secret: string, code: string, nowMs: number = Date.now()): number | null {
    const token = String(code ?? '').trim();
    if (!/^\d{6}$/.test(token)) return null;
    try {
      const totp = new OTPAuth.TOTP({
        issuer: config.appName,
        algorithm: 'SHA1',
        digits: 6,
        period: TOTP_PERIOD_S,
        secret: OTPAuth.Secret.fromBase32(secret.trim()),
      });
      const delta = totp.validate({ token, timestamp: nowMs, window: TOTP_WINDOW });
      if (delta === null) return null;
      return Math.floor(nowMs / 1000 / TOTP_PERIOD_S) + delta;
    } catch (err) {
      logger.warn({ err }, 'TOTP verification threw an exception (secret may be malformed)');
      return null;
    }
  },

  /**
   * TOTP anti-replay: records [step] as the last accepted step of the user,
   * in one atomic UPDATE that only matches when the step is NEWER than the
   * stored one (users.totp_last_step, migration 055). Returns false for a
   * replayed code (same or older step), including a code already used to
   * sign in, and for two parallel requests with the same code (one wins).
   */
  async acceptTotpStep(userId: number, step: number): Promise<boolean> {
    if (!Number.isSafeInteger(step) || step <= 0) return false;
    const r = await db.raw(
      `UPDATE users SET totp_last_step = ?
        WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)
        RETURNING id`,
      [step, userId, step],
    ) as { rows: unknown[] };
    return r.rows.length > 0;
  },

  /**
   * @deprecated Boolean check WITHOUT anti-replay. Use verifyTotpStep() +
   * acceptTotpStep() for anything that grants access or changes a factor.
   */
  verifyTotp(secret: string, code: string): boolean {
    return twoFactorService.verifyTotpStep(secret, code) !== null;
  },

  // ── Email OTP ──────────────────────────────────────────────────────────────

  /** 6-digit code from a CSPRNG (was Math.random). */
  generateEmailOtp(): string {
    return String(randomInt(100000, 1000000));
  },

  async sendEmailOtp(smtpServerId: number, toEmail: string, code: string): Promise<void> {
    const server = await smtpServerService.getById(smtpServerId);
    if (!server) throw new Error('SMTP server not configured for OTP');

    const transport = nodemailer.createTransport({
      host: server.host,
      port: server.port,
      secure: server.secure,
      auth: { user: server.username, pass: server.password },
    });

    await transport.sendMail({
      from: server.from_address,
      to: toEmail,
      subject: `${config.appName} — Your login code`,
      text: `Your login verification code is: ${code}\n\nThis code expires in 10 minutes.`,
      html: `
        <h2>${config.appName} — Login verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing:8px;font-family:monospace">${code}</h1>
        <p style="color:#888;font-size:12px">This code expires in 10 minutes. If you did not request this, ignore this email.</p>
      `,
    });

    logger.info(`Email OTP sent to ${toEmail}`);
  },
};
