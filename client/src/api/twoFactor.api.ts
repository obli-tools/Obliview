import apiClient from './client';
import type { ApiResponse, User } from '@obliview/shared';

export interface TwoFactorStatus {
  totpEnabled: boolean;
  emailOtpEnabled: boolean;
  /** The PROFILE address: e-mail codes are always sent there. */
  email: string | null;
}

export interface TotpSetupData {
  secret: string;
  qrDataUrl: string;
}

/**
 * Step-up proof required to add, replace or remove a second factor: a
 * current authenticator code when TOTP is enabled, else the current password.
 */
export interface StepUpProof {
  currentCode?: string;
  currentPassword?: string;
}

export const twoFactorApi = {
  async getStatus(): Promise<TwoFactorStatus> {
    const res = await apiClient.get<ApiResponse<TwoFactorStatus>>('/profile/2fa/status');
    return res.data.data!;
  },

  /** First enrolment needs no proof; replacing a live TOTP needs a current code. */
  async totpSetup(proof: StepUpProof = {}): Promise<TotpSetupData> {
    const res = await apiClient.post<ApiResponse<TotpSetupData>>('/profile/2fa/totp/setup', proof);
    return res.data.data!;
  },

  async totpEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/totp/enable', { code });
  },

  async totpDisable(proof: StepUpProof): Promise<void> {
    await apiClient.delete('/profile/2fa/totp', { data: proof });
  },

  /** Sends a code to the profile e-mail address (never another one). */
  async emailSetup(proof: StepUpProof): Promise<void> {
    await apiClient.post('/profile/2fa/email/setup', proof);
  },

  async emailEnable(code: string): Promise<void> {
    await apiClient.post('/profile/2fa/email/enable', { code });
  },

  async emailDisable(proof: StepUpProof): Promise<void> {
    await apiClient.delete('/profile/2fa/email', { data: proof });
  },

  async verify(code: string, method: 'totp' | 'email'): Promise<{ user: User }> {
    const res = await apiClient.post<ApiResponse<{ user: User }>>('/profile/2fa/verify', { code, method });
    return res.data.data!;
  },

  async resendEmail(): Promise<void> {
    await apiClient.post('/profile/2fa/resend-email');
  },
};
