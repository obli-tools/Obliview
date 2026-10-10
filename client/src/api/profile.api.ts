import apiClient from './client';
import type { User, UserPreferences } from '@obliview/shared';

export const profileApi = {
  async get(): Promise<User> {
    const res = await apiClient.get('/profile');
    return res.data.data;
  },

  /**
   * Changing the e-mail address (the password-reset channel) requires
   * currentPassword; other fields do not.
   */
  async update(data: {
    displayName?: string | null;
    email?: string | null;
    preferredLanguage?: string;
    preferences?: UserPreferences | null;
    currentPassword?: string;
  }): Promise<User> {
    const res = await apiClient.put('/profile', data);
    return res.data.data;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await apiClient.put('/profile/password', { currentPassword, newPassword });
  },

  /** Profile picture: a PNG / JPEG / WebP data URL (512 KB max). Local accounts only. */
  async uploadAvatar(avatar: string): Promise<string> {
    const res = await apiClient.put('/profile/avatar', { avatar });
    return res.data.data.avatar;
  },

  async deleteAvatar(): Promise<void> {
    await apiClient.delete('/profile/avatar');
  },
};
