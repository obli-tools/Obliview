import { useState, useEffect, useRef, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { User, Save, KeyRound, Bell, CheckCircle2, AlertTriangle, QrCode, Mail, ArrowLeftRight, Palette, Camera, Trash2 } from 'lucide-react';
import { profileApi } from '@/api/profile.api';
import { ThemePicker } from '@/components/ThemePicker';
import { applyTheme, loadSavedTheme, type AppTheme } from '@/utils/theme';
import { appConfigApi } from '@/api/appConfig.api';
import { twoFactorApi, type TwoFactorStatus, type StepUpProof } from '@/api/twoFactor.api';
import { useAuthStore } from '@/store/authStore';
import { anonymizeUsername } from '@/utils/anonymize';
import { useLiveAlertsStore } from '@/store/liveAlertsStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { SUPPORTED_LANGUAGES, setLanguage } from '@/i18n';
import toast from 'react-hot-toast';

// Profile picture: center-cropped and resized in the browser before upload
// (the server validates the data URL and caps it at 512 KB).
const AVATAR_SIZE = 256;
const AVATAR_MAX_BYTES = 512 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

async function resizeAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Unreadable image'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('Empty image');
    const size = Math.min(AVATAR_SIZE, side);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    // WebP where the browser can encode it, else PNG (keeps transparency).
    const webp = canvas.toDataURL('image/webp', 0.9);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decoded size of a base64 data URL. */
function dataUrlBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
}

export function ProfilePage() {
  const { t } = useTranslation();
  const { user: sessionUser, requires2faSetup } = useAuthStore();
  // /profile?setup2fa=1: sent here by ProtectedRoute ("Force 2FA").
  const [searchParams, setSearchParams] = useSearchParams();
  const setup2faRequested = searchParams.get('setup2fa') === '1';
  const securityRef = useRef<HTMLDivElement>(null);

  const [avatar, setAvatar] = useState<string | null>(sessionUser?.avatar ?? null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [obligateUrl, setObligateUrl] = useState<string | null>(null);

  useEffect(() => {
    if (sessionUser?.foreignSource === 'obligate') {
      appConfigApi.getConfig().then(cfg => {
        const url = (cfg as any).obligate_url ?? (cfg as any).obligateUrl ?? null;
        setObligateUrl(url);
      }).catch(() => {});
    }
  }, [sessionUser]);
  const { localEnabled: alertEnabled, position: alertPosition, setEnabled, setPosition } = useLiveAlertsStore();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  // Address as last loaded/saved: changing it (the password-reset channel)
  // requires the current password.
  const [originalEmail, setOriginalEmail] = useState('');
  const [emailChangePassword, setEmailChangePassword] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState('');
  const [savingProfile, setSavingProfile] = useState(false);
  const isObligateUser = sessionUser?.foreignSource === 'obligate';
  const emailChanged = email.trim().toLowerCase() !== originalEmail.trim().toLowerCase();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);

  const [savingPrefs, setSavingPrefs] = useState(false);

  // Theme state — initialise from localStorage so the picker shows the active theme immediately
  const [preferredTheme, setPreferredTheme] = useState<AppTheme>(loadSavedTheme);
  const [savingTheme, setSavingTheme] = useState(false);

  // 2FA state
  const [allow2fa, setAllow2fa] = useState(false);
  const [tfaStatus, setTfaStatus] = useState<TwoFactorStatus | null>(null);

  // TOTP setup flow
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [totpSaving, setTotpSaving] = useState(false);

  // Email OTP setup flow
  const [emailSetupStep, setEmailSetupStep] = useState<'idle' | 'entering' | 'sent'>('idle');
  const [emailCode, setEmailCode] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);

  // Step-up proof for removing / adding a factor: a current authenticator
  // code when TOTP is on, else the current password (server: checkFactorManagement).
  const [stepUpAction, setStepUpAction] = useState<'totpSetup' | 'totpDisable' | 'emailDisable' | null>(null);
  const [stepUpValue, setStepUpValue] = useState('');
  const [stepUpSaving, setStepUpSaving] = useState(false);
  const proofIsCode = !!tfaStatus?.totpEnabled;
  const buildProof = (value: string): StepUpProof =>
    proofIsCode ? { currentCode: value } : { currentPassword: value };
  const stepUpReady = proofIsCode ? stepUpValue.length === 6 : stepUpValue.length > 0;
  const resetStepUp = () => { setStepUpAction(null); setStepUpValue(''); };

  /** Translated message for a step-up / factor-management error (server `code`). */
  const securityError = (err: unknown, fallback: string): string => {
    const e = err as { response?: { status?: number; data?: { code?: string } } };
    switch (e?.response?.data?.code) {
      case 'CURRENT_CODE_REQUIRED': return t('profile.security.stepUp.codeRequired', 'Enter a current code from your authenticator app.');
      case 'INVALID_CURRENT_CODE': return t('profile.security.stepUp.invalidCode', 'Invalid authenticator code.');
      case 'CODE_ALREADY_USED': return t('profile.security.stepUp.codeUsed', 'This code was already used. Wait for the next code.');
      case 'CURRENT_PASSWORD_REQUIRED': return t('profile.security.stepUp.passwordRequired', 'Enter your current password.');
      case 'INVALID_CURRENT_PASSWORD': return t('profile.security.stepUp.invalidPassword', 'Current password is incorrect.');
      case 'NO_LOCAL_PASSWORD': return t('profile.security.stepUp.noLocalPassword', 'This account has no local password; ask an administrator.');
      case 'PROFILE_EMAIL_REQUIRED': return t('profile.security.profileEmailRequired', 'Set an e-mail address in your profile first.');
      case 'SSO_EMAIL_MANAGED': return t('profile.emailManagedBySso', 'The e-mail address of an SSO account is managed in Obligate.');
      case 'EMAIL_CHANGED': return t('profile.security.emailChangedDuringSetup', 'Your e-mail address changed during the setup. Start again.');
      case 'TOTP_SETUP_EXPIRED': return t('profile.security.totpSetupExpired', 'The setup expired. Start again.');
      case 'TOTP_ALREADY_ENABLED': return t('profile.security.totpAlreadyEnabled', 'Two-factor authentication was enabled in the meantime. Start the setup again.');
    }
    if (e?.response?.status === 429) return t('profile.security.stepUp.tooMany', 'Too many attempts, please try again later.');
    return fallback;
  };

  useEffect(() => {
    profileApi.get().then((profile) => {
      setAvatar(profile.avatar ?? null);
      setDisplayName(profile.displayName || '');
      setEmail((profile as any).email || '');
      setOriginalEmail((profile as any).email || '');
      setPreferredLanguage((profile as any).preferredLanguage || '');
      if (profile.preferences?.preferredTheme) {
        setPreferredTheme(profile.preferences.preferredTheme);
      }
    });
    appConfigApi.getConfig().then((cfg) => {
      setAllow2fa(cfg.allow_2fa);
    }).catch(() => {});
    twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
  }, []);

  // Opened from the "Force 2FA" redirect: bring the 2FA section into view.
  const showSecurity = allow2fa || requires2faSetup || setup2faRequested;
  useEffect(() => {
    if (!setup2faRequested || !showSecurity) return;
    const id = window.setTimeout(() => {
      securityRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => window.clearTimeout(id);
  }, [setup2faRequested, showSecurity]);

  // A factor is now enabled while the session still says "setup required"
  // (just enabled here, or in the enrollment wizard): reload the session so
  // the redirect stops and the data refused until now is fetched again.
  const hasFactor = !!(tfaStatus?.totpEnabled || tfaStatus?.emailOtpEnabled);
  useEffect(() => {
    if (!hasFactor || !requires2faSetup) return;
    void useAuthStore.getState().checkSession();
    if (setup2faRequested) setSearchParams({}, { replace: true });
  }, [hasFactor, requires2faSetup, setup2faRequested, setSearchParams]);

  /** Avatar in the page and in the session user (sidebar / header). */
  const applyAvatar = (value: string | null) => {
    setAvatar(value);
    useAuthStore.setState((s) => (s.user ? { user: { ...s.user, avatar: value } } : {}));
  };

  const handleAvatarFile = async (file: File) => {
    if (!AVATAR_TYPES.includes(file.type)) {
      toast.error(t('profile.avatar.invalidType', 'Choose a PNG, JPEG or WebP image.'));
      return;
    }
    setAvatarUploading(true);
    try {
      let dataUrl: string;
      try {
        dataUrl = await resizeAvatar(file);
      } catch {
        toast.error(t('profile.avatar.invalidType', 'Choose a PNG, JPEG or WebP image.'));
        return;
      }
      if (dataUrlBytes(dataUrl) > AVATAR_MAX_BYTES) {
        toast.error(t('profile.avatar.tooLarge', 'Image too large (512 KB max).'));
        return;
      }
      const saved = await profileApi.uploadAvatar(dataUrl);
      applyAvatar(saved ?? dataUrl);
      toast.success(t('profile.avatar.updated', 'Profile picture updated'));
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      toast.error(code === 'AVATAR_TOO_LARGE'
        ? t('profile.avatar.tooLarge', 'Image too large (512 KB max).')
        : t('profile.avatar.failed', 'Could not update the profile picture'));
    } finally {
      setAvatarUploading(false);
    }
  };

  const handleAvatarRemove = async () => {
    try {
      await profileApi.deleteAvatar();
      applyAvatar(null);
      toast.success(t('profile.avatar.removed', 'Profile picture removed'));
    } catch {
      toast.error(t('profile.avatar.failed', 'Could not update the profile picture'));
    }
  };

  const handleProfileSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (emailChanged && !isObligateUser && !emailChangePassword) {
      toast.error(t('profile.emailChangePasswordRequired', 'Enter your current password to change your e-mail address.'));
      return;
    }
    setSavingProfile(true);
    try {
      const updated = await profileApi.update({
        displayName: displayName || null,
        email: email || null,
        preferredLanguage: preferredLanguage || undefined,
        ...(emailChanged && !isObligateUser ? { currentPassword: emailChangePassword } : {}),
      });
      const savedEmail = (updated as any)?.email ?? (email || '');
      setEmail(savedEmail);
      setOriginalEmail(savedEmail);
      setEmailChangePassword('');
      // Changing the address switches e-mail codes off server-side.
      if (emailChanged) twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
      toast.success(t('profile.profileUpdated'));
    } catch (err) {
      toast.error(securityError(err, t('profile.failedProfile')));
    } finally {
      setSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      toast.error(t('profile.password.mismatch'));
      return;
    }

    if (newPassword.length < 6) {
      toast.error(t('profile.password.tooShort'));
      return;
    }

    setSavingPassword(true);
    try {
      await profileApi.changePassword(currentPassword, newPassword);
      toast.success(t('profile.password.changed'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      const msg = err?.response?.data?.error || t('profile.password.failed');
      toast.error(msg);
    } finally {
      setSavingPassword(false);
    }
  };

  const handleSavePreferences = async () => {
    setSavingPrefs(true);
    try {
      await profileApi.update({
        preferences: {
          toastEnabled: alertEnabled,
          toastPosition: alertPosition,
        },
      });
      toast.success(t('profile.alerts.preferencesSaved'));
    } catch {
      toast.error(t('profile.alerts.failedPreferences'));
    } finally {
      setSavingPrefs(false);
    }
  };

  const handleThemeChange = async (theme: AppTheme) => {
    setPreferredTheme(theme);
    applyTheme(theme); // apply immediately for live preview
    setSavingTheme(true);
    try {
      await profileApi.update({
        preferences: {
          toastEnabled: alertEnabled,
          toastPosition: alertPosition,
          preferredTheme: theme,
        },
      });
      toast.success(t('profile.appearance.saved'));
    } catch {
      toast.error(t('profile.appearance.failed'));
    } finally {
      setSavingTheme(false);
    }
  };

  const handleLanguageChange = async (code: string) => {
    setPreferredLanguage(code);
    setLanguage(code);
    try {
      await profileApi.update({ preferredLanguage: code });
    } catch {
      // non-critical, ignore
    }
  };

  /**
   * Inline step-up prompt (one visible at a time): a current authenticator
   * code when TOTP is enabled, else the current password.
   */
  const renderStepUp = (
    onConfirm: () => void | Promise<void>,
    confirmLabel: string,
    saving: boolean,
    onCancel: () => void,
  ) => (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Input
            id="profile-2fa-step-up"
            label={proofIsCode
              ? t('profile.security.stepUp.codeLabel', 'Current authenticator code')
              : t('profile.security.stepUp.passwordLabel', 'Current password')}
            type={proofIsCode ? 'text' : 'password'}
            inputMode={proofIsCode ? 'numeric' : undefined}
            autoComplete={proofIsCode ? 'one-time-code' : 'current-password'}
            value={stepUpValue}
            onChange={(e) => setStepUpValue(proofIsCode ? e.target.value.replace(/\D/g, '').slice(0, 6) : e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && stepUpReady && !saving) { e.preventDefault(); void onConfirm(); } }}
            placeholder={proofIsCode ? '000000' : t('profile.password.currentPlaceholder')}
            autoFocus
          />
        </div>
        <Button disabled={!stepUpReady || saving} loading={saving} onClick={() => { void onConfirm(); }}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
      <p className="text-xs text-text-muted">
        {proofIsCode
          ? t('profile.security.stepUp.codeHint', 'To change your two-factor settings, enter a current code from your authenticator app.')
          : t('profile.security.stepUp.passwordHint', 'To change your two-factor settings, confirm with your current password.')}
      </p>
    </div>
  );

  if (sessionUser?.foreignSource === 'obligate' && obligateUrl) {
    return (
      <div className="p-6 max-w-2xl mx-auto">
        <div className="bg-bg-secondary border border-border rounded-lg p-6 text-center">
          <h2 className="text-lg font-medium text-text-primary mb-2">{t('profile.managedByObligate')}</h2>
          <p className="text-sm text-text-secondary mb-4">
            {t('profile.managedByObligateDesc')}
          </p>
          <a
            href={`${obligateUrl}/account`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-md font-medium text-sm transition-colors"
          >
            {t('profile.openObligateProfile')}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 min-w-0">
      <h1 className="text-2xl font-semibold text-text-primary mb-6">{t('profile.title')}</h1>

      {/* Avatar section — local accounts (Obligate syncs SSO users' pictures) */}
      {!isObligateUser && (
        <div className="mb-8 rounded-lg border border-border bg-bg-secondary p-5">
          <div className="flex items-center gap-4 sm:gap-6">
            <div className="relative group shrink-0">
              {avatar ? (
                <img src={avatar} alt="" className="w-20 h-20 rounded-full object-cover" />
              ) : (
                <div className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center">
                  <User size={32} className="text-accent" />
                </div>
              )}
              {/* Hover overlay: mouse only. Touch gets the visible button next to it. */}
              <label
                htmlFor="profile-avatar-input"
                title={t('profile.avatar.change', 'Change photo')}
                className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 hidden can-hover:flex items-center justify-center cursor-pointer transition-opacity"
              >
                <Camera size={20} className="text-white" />
              </label>
              <input
                id="profile-avatar-input"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                disabled={avatarUploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) void handleAvatarFile(file);
                }}
              />
              {avatarUploading && (
                <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                </div>
              )}
            </div>
            <div className="space-y-1 min-w-0">
              <p className="text-sm font-medium text-text-primary">{t('profile.avatar.title', 'Profile picture')}</p>
              <p className="text-xs text-text-muted">{t('profile.avatar.hint', 'PNG, JPEG or WebP. Cropped to a square and resized to 256 px.')}</p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <label
                  htmlFor="profile-avatar-input"
                  className="can-hover:hidden inline-flex items-center gap-1.5 rounded-md bg-bg-tertiary px-3 py-2 text-xs font-medium text-text-primary cursor-pointer"
                >
                  <Camera size={14} /> {t('profile.avatar.change', 'Change photo')}
                </label>
                {avatar && (
                  <button
                    type="button"
                    onClick={() => { void handleAvatarRemove(); }}
                    disabled={avatarUploading}
                    className="inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300 coarse:py-2 disabled:opacity-50"
                  >
                    <Trash2 size={12} /> {t('profile.avatar.remove', 'Remove')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Profile section */}
      <form onSubmit={handleProfileSubmit} className="mb-8">
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <User size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.sectionProfile')}
            </h2>
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">{t('profile.usernameLabel')}</label>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-primary font-mono bg-bg-tertiary rounded-md px-3 py-2 flex-1">
                {anonymizeUsername(sessionUser?.username)}
              </p>
              {sessionUser?.foreignSource && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[#1e1b4b]/60 border border-[#4338ca]/40 px-2 py-1 text-[10px] font-medium text-[#a5b4fc] shrink-0">
                  <ArrowLeftRight size={9} />{t('profile.ssoLabel', { foreignSource: sessionUser.foreignSource })}
                </span>
              )}
            </div>
          </div>

          <Input
            label={t('profile.displayNameLabel')}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={t('profile.displayNamePlaceholder')}
          />

          <div>
            <Input
              label={t('profile.emailLabel')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('profile.emailPlaceholder')}
              readOnly={isObligateUser}
            />
            <p className="mt-1 text-xs text-text-muted">
              {isObligateUser
                ? t('profile.emailManagedBySso', 'The e-mail address of an SSO account is managed in Obligate.')
                : t('profile.emailHint')}
            </p>
          </div>

          {emailChanged && !isObligateUser && (
            <div>
              <Input
                id="profile-email-current-password"
                label={t('profile.emailChangePasswordLabel', 'Current password')}
                type="password"
                autoComplete="current-password"
                value={emailChangePassword}
                onChange={(e) => setEmailChangePassword(e.target.value)}
                placeholder={t('profile.password.currentPlaceholder')}
              />
              <p className="mt-1 text-xs text-text-muted">
                {t('profile.emailChangePasswordHint', 'Your e-mail address is used to reset your password: confirm the change with your current password.')}
              </p>
            </div>
          )}

          <div className="space-y-1">
            <label className="block text-sm font-medium text-text-secondary">{t('profile.preferredLanguage')}</label>
            <select
              value={preferredLanguage}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeName} ({lang.name})
                </option>
              ))}
            </select>
          </div>

          <Button type="submit" loading={savingProfile}>
            <Save size={16} className="mr-1.5" />
            {t('profile.saveProfile')}
          </Button>
        </div>
      </form>

      {/* Password section */}
      {sessionUser?.foreignSource !== 'obligate' && (
        <form onSubmit={handlePasswordSubmit} className="mb-8">
          <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <KeyRound size={18} className="text-accent" />
              <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
                {t('profile.password.title')}
              </h2>
            </div>

            <Input
              label={t('profile.password.current')}
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder={t('profile.password.currentPlaceholder')}
              required
            />

            <Input
              label={t('profile.password.new')}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder={t('profile.password.newPlaceholder')}
              required
            />

            <Input
              label={t('profile.password.confirm')}
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t('profile.password.confirmPlaceholder')}
              required
            />

            <Button type="submit" loading={savingPassword}>
              <KeyRound size={16} className="mr-1.5" />
              {t('profile.password.change')}
            </Button>
          </div>
        </form>
      )}

      {/* Appearance section */}
      <div className="mb-8">
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Palette size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.appearance.title')}
            </h2>
            {savingTheme && (
              <span className="ml-auto text-xs text-text-muted">{t('common.saving')}</span>
            )}
          </div>
          <p className="text-xs text-text-muted -mt-2">{t('profile.appearance.subtitle')}</p>
          <ThemePicker value={preferredTheme} onChange={handleThemeChange} />
        </div>
      </div>

      {/* Live Alert Notifications section */}
      <div className="mb-8">
        <div className="rounded-lg border border-border bg-bg-secondary p-5 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Bell size={18} className="text-accent" />
            <h2 className="text-sm font-semibold text-text-secondary uppercase tracking-wide">
              {t('profile.alerts.title')}
            </h2>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{t('profile.alerts.enableLabel')}</p>
              <p className="text-xs text-text-muted mt-0.5">
                {t('profile.alerts.enableDesc')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEnabled(!alertEnabled)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${
                alertEnabled ? 'bg-accent' : 'bg-bg-tertiary'
              }`}
              aria-pressed={alertEnabled}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                  alertEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {/* Position selector */}
          <div>
            <p className="text-sm font-medium text-text-primary mb-2">{t('profile.alerts.positionLabel')}</p>
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="alertPosition"
                  value="bottom-right"
                  checked={alertPosition === 'bottom-right'}
                  onChange={() => setPosition('bottom-right')}
                  className="accent-accent mt-0.5"
                />
                <div>
                  <span className="text-sm text-text-primary">{t('profile.alerts.bottomRight')}</span>
                  <p className="text-xs text-text-muted">
                    {t('profile.alerts.bottomRightDesc')}
                  </p>
                </div>
              </label>
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="alertPosition"
                  value="top-center"
                  checked={alertPosition === 'top-center'}
                  onChange={() => setPosition('top-center')}
                  className="accent-accent mt-0.5"
                />
                <div>
                  <span className="text-sm text-text-primary">{t('profile.alerts.topCenter')}</span>
                  <p className="text-xs text-text-muted">
                    {t('profile.alerts.topCenterDesc')}
                  </p>
                </div>
              </label>
            </div>
          </div>

          <Button type="button" onClick={handleSavePreferences} loading={savingPrefs}>
            <Save size={16} className="mr-1.5" />
            {t('profile.alerts.savePreferences')}
          </Button>
        </div>
      </div>

      {/* Security / 2FA section */}
      {showSecurity && (
        <div
          id="profile-security"
          ref={securityRef}
          className={`scroll-mt-4${setup2faRequested && requires2faSetup ? ' rounded-lg ring-2 ring-amber-500/40 ring-offset-4 ring-offset-bg-primary' : ''}`}
        >
          <h2 className="text-lg font-semibold text-text-primary mb-4">{t('profile.security.title')}</h2>

          {requires2faSetup && (
            <div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
              <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-300">
                {t('profile.security.force2faWarning')}
              </p>
            </div>
          )}

          <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
            {/* TOTP */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <QrCode size={16} className="text-text-muted" />
                  <p className="text-sm font-medium text-text-primary">{t('profile.security.totp')}</p>
                  {tfaStatus?.totpEnabled && <CheckCircle2 size={14} className="text-green-400" />}
                </div>
                {tfaStatus?.totpEnabled ? (
                  stepUpAction !== 'totpDisable' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEmailSetupStep('idle');
                        setEmailCode('');
                        setStepUpValue('');
                        setStepUpAction('totpDisable');
                      }}
                    >
                      {t('common.disable')}
                    </Button>
                  )
                ) : !totpSetupData && stepUpAction !== 'totpSetup' ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      // A first enrolment is confirmed with the current password
                      setEmailSetupStep('idle');
                      setEmailCode('');
                      setStepUpValue('');
                      setStepUpAction('totpSetup');
                    }}
                  >
                    {t('common.enable')}
                  </Button>
                ) : null}
              </div>

              {!tfaStatus?.totpEnabled && !totpSetupData && stepUpAction === 'totpSetup' && renderStepUp(
                async () => {
                  setStepUpSaving(true);
                  try {
                    const data = await twoFactorApi.totpSetup(buildProof(stepUpValue));
                    resetStepUp();
                    setTotpSetupData(data);
                    setTotpCode('');
                  } catch (err) { toast.error(securityError(err, t('profile.security.failedStartTotp'))); }
                  finally { setStepUpSaving(false); }
                },
                t('common.enable'),
                stepUpSaving,
                resetStepUp,
              )}

              {tfaStatus?.totpEnabled && stepUpAction === 'totpDisable' && renderStepUp(
                async () => {
                  setStepUpSaving(true);
                  try {
                    await twoFactorApi.totpDisable(buildProof(stepUpValue));
                    setTfaStatus((s) => s ? { ...s, totpEnabled: false } : s);
                    resetStepUp();
                    toast.success(t('profile.security.totpDisabled'));
                  } catch (err) { toast.error(securityError(err, t('profile.security.failedDisableTotp'))); }
                  finally { setStepUpSaving(false); }
                },
                t('common.disable'),
                stepUpSaving,
                resetStepUp,
              )}

              {!tfaStatus?.totpEnabled && totpSetupData && (
                <div className="space-y-3">
                  <p className="text-xs text-text-muted">{t('profile.security.totpScanDesc')}</p>
                  <img src={totpSetupData.qrDataUrl} alt="TOTP QR Code" className="w-40 h-40 rounded-lg border border-border" />
                  <p className="text-xs text-text-muted font-mono break-all">{t('profile.security.totpSecret', { secret: totpSetupData.secret })}</p>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        label={t('profile.security.verificationCode')}
                        type="text"
                        inputMode="numeric"
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                      />
                    </div>
                    <Button
                      disabled={totpCode.length !== 6 || totpSaving}
                      loading={totpSaving}
                      onClick={async () => {
                        setTotpSaving(true);
                        try {
                          await twoFactorApi.totpEnable(totpCode);
                          setTfaStatus((s) => s ? { ...s, totpEnabled: true } : s);
                          setTotpSetupData(null);
                          setTotpCode('');
                          toast.success(t('profile.security.totpEnabled'));
                        } catch (err) {
                          const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
                          // Expired or superseded setup: the QR code is dead, start over.
                          if (code === 'TOTP_SETUP_EXPIRED' || code === 'TOTP_ALREADY_ENABLED') {
                            setTotpSetupData(null);
                            setTotpCode('');
                            twoFactorApi.getStatus().then(setTfaStatus).catch(() => {});
                          }
                          toast.error(securityError(err, t('profile.security.invalidCode')));
                        }
                        finally { setTotpSaving(false); }
                      }}
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setTotpSetupData(null); setTotpCode(''); }}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
            </div>

            {/* Email OTP */}
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mail size={16} className="text-text-muted" />
                  <p className="text-sm font-medium text-text-primary">{t('profile.security.emailOtp')}</p>
                  {tfaStatus?.emailOtpEnabled && (
                    <>
                      <CheckCircle2 size={14} className="text-green-400" />
                      <span className="text-xs text-text-muted">{tfaStatus.email}</span>
                    </>
                  )}
                </div>
                {tfaStatus?.emailOtpEnabled ? (
                  stepUpAction !== 'emailDisable' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setStepUpValue('');
                        setStepUpAction('emailDisable');
                      }}
                    >
                      {t('common.disable')}
                    </Button>
                  )
                ) : emailSetupStep === 'idle' ? (
                  <Button
                    size="sm"
                    onClick={() => {
                      resetStepUp();
                      setEmailSetupStep('entering');
                    }}
                  >
                    {t('common.enable')}
                  </Button>
                ) : null}
              </div>

              {tfaStatus?.emailOtpEnabled && stepUpAction === 'emailDisable' && renderStepUp(
                async () => {
                  setStepUpSaving(true);
                  try {
                    await twoFactorApi.emailDisable(buildProof(stepUpValue));
                    setTfaStatus((s) => s ? { ...s, emailOtpEnabled: false } : s);
                    resetStepUp();
                    toast.success(t('profile.security.emailOtpDisabled'));
                  } catch (err) { toast.error(securityError(err, t('profile.security.failedDisableEmailOtp'))); }
                  finally { setStepUpSaving(false); }
                },
                t('common.disable'),
                stepUpSaving,
                resetStepUp,
              )}

              {!tfaStatus?.emailOtpEnabled && emailSetupStep === 'entering' && (
                <div className="space-y-3">
                  {/* Codes always go to the PROFILE address (changed in the
                      profile section above, with the current password). */}
                  {tfaStatus?.email ? (
                    <p className="text-xs text-text-muted">
                      {t('profile.security.emailCodesSentTo', 'Codes will be sent to {{email}}, the e-mail address of your profile.', { email: tfaStatus.email })}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-300">
                      {t('profile.security.profileEmailRequired', 'Set an e-mail address in your profile first.')}
                    </p>
                  )}
                  {tfaStatus?.email
                    ? renderStepUp(
                      async () => {
                        setEmailSaving(true);
                        try {
                          await twoFactorApi.emailSetup(buildProof(stepUpValue));
                          setStepUpValue('');
                          setEmailSetupStep('sent');
                          toast.success(t('profile.security.codeSent'));
                        } catch (err) { toast.error(securityError(err, t('profile.security.failedSendCode'))); }
                        finally { setEmailSaving(false); }
                      },
                      t('profile.security.sendCode'),
                      emailSaving,
                      () => { setEmailSetupStep('idle'); setEmailCode(''); resetStepUp(); },
                    )
                    : (
                      <Button variant="ghost" onClick={() => { setEmailSetupStep('idle'); setEmailCode(''); resetStepUp(); }}>{t('common.cancel')}</Button>
                    )}
                </div>
              )}

              {!tfaStatus?.emailOtpEnabled && emailSetupStep === 'sent' && (
                <div className="space-y-3">
                  <p className="text-xs text-text-muted">{t('profile.security.enterCode', { email: tfaStatus?.email ?? '' })}</p>
                  <div className="flex items-end gap-2">
                    <div className="flex-1">
                      <Input
                        label={t('profile.security.verificationCode')}
                        type="text"
                        inputMode="numeric"
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                        autoFocus
                      />
                    </div>
                    <Button
                      disabled={emailCode.length !== 6 || emailSaving}
                      loading={emailSaving}
                      onClick={async () => {
                        setEmailSaving(true);
                        try {
                          await twoFactorApi.emailEnable(emailCode);
                          const status = await twoFactorApi.getStatus();
                          setTfaStatus(status);
                          setEmailSetupStep('idle');
                          setEmailCode('');
                          toast.success(t('profile.security.emailOtpEnabled'));
                        } catch (err) { toast.error(securityError(err, t('profile.security.invalidCode'))); }
                        finally { setEmailSaving(false); }
                      }}
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button variant="ghost" onClick={() => { setEmailSetupStep('idle'); setEmailCode(''); }}>{t('common.cancel')}</Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
