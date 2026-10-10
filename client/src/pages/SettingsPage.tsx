import { useState, useEffect, useId, type FormEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Shield, Server, Plus, Pencil, Trash2, Wifi, Eye, EyeOff, ArrowLeftRight, Info, Cpu, HardDrive,
  Database, Clock, Globe, Building2, Lock, PackageOpen, Mail,
} from 'lucide-react';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import { NotificationTypesPanel } from '@/components/agent/NotificationTypesPanel';
import { UpdatePolicyField } from '@/components/agent/UpdatePolicyField';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useIsMasterTenant } from '@/hooks/useIsGodView';
import apiClient from '@/api/client';
import { smtpServerApi, type CreateSmtpServerRequest } from '@/api/smtpServer.api';
import { appConfigApi, type ObligateConfigView, type ObligateConfigPatch } from '@/api/appConfig.api';
import { systemApi, type SystemInfo } from '@/api/system.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Checkbox } from '@/components/ui/Checkbox';
import { ImportExportPage } from '@/pages/ImportExportPage';
import type { SmtpServer, AppConfig, AgentGlobalConfig, NotificationTypeConfig, ApiResponse } from '@obliview/shared';
import { MASTER_TENANT_ID, DEFAULT_AGENT_UPDATE_POLICY } from '@obliview/shared';
import type { AgentUpdatePolicy } from '@obliview/shared';
import toast from 'react-hot-toast';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';
import { apiErrorCode, apiErrorMessage } from '@/utils/apiError';
import { useTranslation } from 'react-i18next';

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="font-mono text-xs text-text-primary">{value}</span>
    </div>
  );
}

/** Top-level block of the page: "Platform (all workspaces)" / "This workspace". */
function SectionHeader({
  id, icon, title, description, extra,
}: {
  id: string;
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-3 border-b border-border pb-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <h2 id={id} className="text-lg font-semibold text-text-primary">{title}</h2>
        <p className="text-sm text-text-muted">{description}</p>
      </div>
      {extra}
    </div>
  );
}

/** Sub-section heading inside a block. */
function SubHeading({ icon, children, extra }: { icon?: ReactNode; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-base font-semibold text-text-primary">
        {icon}
        {children}
      </h3>
      {extra}
    </div>
  );
}

/** Minimum length of the Obligate inbound secret (enforced by the server too). */
const OBLIGATE_INBOUND_SECRET_MIN = 16;

/** GET /admin/smtp-servers?scope=otp: candidates for the 2FA / password-reset server. */
type OtpSmtpServer = SmtpServer & { tenantId: number | null };

/** Server code of a refused delete (the server sends the 2FA / password-reset emails). */
const SMTP_IN_USE_OTP = 'SMTP_SERVER_IN_USE_OTP';

type SmtpFormMode = 'create' | 'edit' | null;

interface SmtpForm {
  name: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
}

const emptySmtpForm = (): SmtpForm => ({
  name: '',
  host: '',
  port: '587',
  secure: false,
  username: '',
  password: '',
  fromAddress: '',
});

export function SettingsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const location = useLocation();
  const smtpFormId = useId();
  const { isAdmin, hasCapability } = useAuthStore();
  const admin = isAdmin();
  // Workspace SMTP servers are gated on the 'settings' tenant capability
  // (smtpServer.routes); Import / Export and the platform block stay
  // platform-admin only.
  useTenantStore((s) => s.tenants);
  useAuthStore((s) => s.tenantCapabilities);
  const canSettings = hasCapability('settings');
  const isMaster = useIsMasterTenant();
  const { tenants, currentTenantId, setCurrentTenant } = useTenantStore();
  // Platform settings (app_config) apply to every workspace: only a platform
  // admin connected to the master workspace may change them.
  const canEditPlatform = admin && isMaster;

  const tenantName = (id: number | null | undefined) =>
    id == null
      ? ''
      : tenants.find((tn) => tn.id === id)?.name ?? t('ui.tenant.fallback', 'Tenant {{id}}', { id });
  const masterInList = tenants.some((tn) => tn.id === MASTER_TENANT_ID);

  // ── SMTP Servers (this workspace) ──
  const [servers, setServers] = useState<SmtpServer[]>([]);
  const [smtpMode, setSmtpMode] = useState<SmtpFormMode>(null);
  const [editingServer, setEditingServer] = useState<SmtpServer | null>(null);
  const [smtpForm, setSmtpForm] = useState<SmtpForm>(emptySmtpForm());
  const [showPassword, setShowPassword] = useState(false);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  // ── OTP / password-reset SMTP candidates (platform-level + master workspace) ──
  const [otpServers, setOtpServers] = useState<OtpSmtpServer[]>([]);

  // ── App Config (2FA) ──
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [configSaving, setConfigSaving] = useState(false);

  // ── Agent Global Config (only the notification types layer is used) ──
  const [agentGlobal, setAgentGlobal] = useState<AgentGlobalConfig | null>(null);

  // ── Obligate SSO Integration ──
  const [obligateCfg,     setObligateCfg]     = useState<ObligateConfigView | null>(null);
  const [obligateUrl,     setObligateUrl]     = useState('');
  const [obligateApiKey,  setObligateApiKey]  = useState('');
  const [showObligateKey, setShowObligateKey] = useState(false);
  const [obligateInboundSecret, setObligateInboundSecret] = useState('');
  const [showInboundSecret,     setShowInboundSecret]     = useState(false);

  // ── System info (About section) ──
  const [systemInfo, setSystemInfo]           = useState<SystemInfo | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);

  const loadOtpServers = () => {
    // ?scope=otp is platform-admin only.
    if (!admin) return;
    apiClient
      .get<ApiResponse<OtpSmtpServer[]>>('/admin/smtp-servers', { params: { scope: 'otp' } })
      .then((res) => setOtpServers(res.data.data ?? []))
      .catch(() => setOtpServers([]));
  };

  useEffect(() => {
    if (!admin) return;
    setSystemInfoLoading(true);
    systemApi.getInfo().then(setSystemInfo).catch(() => {}).finally(() => setSystemInfoLoading(false));
    loadOtpServers();
    appConfigApi.getConfig().then(setAppConfig).catch(() => {});
    appConfigApi.getAgentGlobal().then(setAgentGlobal).catch(() => {});
    appConfigApi.getObligateConfig().then((cfg) => {
      setObligateCfg(cfg);
      setObligateUrl(cfg.url ?? '');
    }).catch(() => {});
  }, [admin]);

  useEffect(() => {
    if (!canSettings) return;
    smtpServerApi.list().then(setServers).catch(() => {});
  }, [canSettings, currentTenantId]);

  // /settings#import-export (legacy /manage/import-export redirect): bring the
  // embedded Import / Export section into view. The sections above it load
  // asynchronously and grow, so the scroll is repeated a few times, until the
  // user scrolls or types.
  useEffect(() => {
    if (!admin || !location.hash) return;
    const id = decodeURIComponent(location.hash.slice(1));
    const scrollToAnchor = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    const frame = requestAnimationFrame(scrollToAnchor);
    const timers = [300, 900].map((ms) => window.setTimeout(scrollToAnchor, ms));
    const stop = () => timers.forEach((tm) => window.clearTimeout(tm));
    const opts: AddEventListenerOptions = { once: true, passive: true };
    window.addEventListener('wheel', stop, opts);
    window.addEventListener('touchstart', stop, opts);
    window.addEventListener('keydown', stop, opts);
    return () => {
      cancelAnimationFrame(frame);
      stop();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [admin, location.hash]);

  async function saveObligateConfig() {
    if (!canEditPlatform) return;
    try {
      const trimmedUrl = obligateUrl.trim().replace(/\/$/, '');
      if (trimmedUrl && trimmedUrl === window.location.origin.replace(/\/$/, '')) {
        toast.error(t('settings.obligate.selfUrlError'));
        return;
      }
      const patch: ObligateConfigPatch = { url: trimmedUrl || null };
      if (obligateApiKey.trim()) patch.apiKey = obligateApiKey.trim();
      const updated = await appConfigApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      setObligateApiKey('');
      toast.success(t('settings.obligate.saved'));
    } catch {
      toast.error(t('settings.obligate.failedSave'));
    }
  }

  // Inbound secret: saved on its own, never with the URL or the key (a failed
  // save must not touch the other fields). Write-only: never read back.
  async function patchObligateInboundSecret(inboundSecret: string | null) {
    try {
      const updated = await appConfigApi.patchObligateConfig({ inboundSecret });
      setObligateCfg(updated);
      setObligateInboundSecret('');
      setShowInboundSecret(false);
      toast.success(t('settings.obligate.saved'));
    } catch (err: unknown) {
      const serverError = String((err as { response?: { data?: { error?: unknown } } })?.response?.data?.error ?? '');
      toast.error(/at least 16 characters/i.test(serverError)
        ? t('settings.obligate.inboundSecret.tooShort', 'The inbound secret must be at least 16 characters long.')
        : t('settings.obligate.failedSave'));
    }
  }

  // Only saved on an explicit action, after a warning: once it is set, every
  // Obligate call to this server that still presents the API key is refused
  // (user deactivations and deletions included).
  async function saveInboundSecret() {
    const value = obligateInboundSecret.trim();
    if (!value || !canEditPlatform) return;
    if (value.length < OBLIGATE_INBOUND_SECRET_MIN) {
      toast.error(t('settings.obligate.inboundSecret.tooShort', 'The inbound secret must be at least 16 characters long.'));
      return;
    }
    if (!(await confirm({
      title: t('settings.obligate.inboundSecret.label', 'Inbound secret (optional)'),
      message: t('settings.obligate.inboundSecret.confirm', 'Set this inbound secret? From now on, Obligate must present it instead of the API key when it calls this server. Use the secret generated for this app in Obligate (Connected Apps), then activate it there: until Obligate presents it, all of its calls are refused, including the deactivations and deletions of SSO users.'),
      danger: true,
      confirmLabel: t('common.save'),
    }))) return;
    await patchObligateInboundSecret(value);
  }

  async function clearInboundSecret() {
    if (!canEditPlatform) return;
    if (!(await confirm({
      title: t('settings.obligate.inboundSecret.label', 'Inbound secret (optional)'),
      message: t('settings.obligate.inboundSecret.confirmClear', 'Clear the inbound secret? Obligate calls to this server will be authenticated with the API key again. Clear it in Obligate too.'),
      danger: true,
      confirmLabel: t('settings.obligate.inboundSecret.clear', 'Clear'),
    }))) return;
    await patchObligateInboundSecret(null);
  }

  function openCreate() {
    setEditingServer(null);
    setSmtpForm(emptySmtpForm());
    setShowPassword(false);
    setSmtpMode('create');
  }

  function openEdit(server: SmtpServer) {
    setEditingServer(server);
    setSmtpForm({
      name: server.name,
      host: server.host,
      port: String(server.port),
      secure: server.secure,
      username: server.username,
      password: '',
      fromAddress: server.fromAddress,
    });
    setShowPassword(false);
    setSmtpMode('edit');
  }

  function closeSmtpModal() {
    setSmtpMode(null);
    setEditingServer(null);
  }

  async function handleSmtpSubmit(e: FormEvent) {
    e.preventDefault();
    setSmtpSaving(true);
    try {
      const data: CreateSmtpServerRequest = {
        name: smtpForm.name,
        host: smtpForm.host,
        port: parseInt(smtpForm.port, 10),
        secure: smtpForm.secure,
        username: smtpForm.username,
        password: smtpForm.password,
        fromAddress: smtpForm.fromAddress,
      };
      if (smtpMode === 'create') {
        const created = await smtpServerApi.create(data);
        setServers((prev) => [...prev, created]);
        toast.success(t('settings.smtp.created'));
      } else if (editingServer) {
        const payload = smtpForm.password ? data : { ...data, password: undefined };
        const updated = await smtpServerApi.update(editingServer.id, payload);
        setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        toast.success(t('settings.smtp.updated'));
      }
      closeSmtpModal();
      loadOtpServers();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('settings.smtp.failedSave')));
    } finally {
      setSmtpSaving(false);
    }
  }

  async function handleDelete(server: SmtpServer) {
    if (!(await confirm({ message: t('settings.confirmDeleteSmtp', { name: server.name }), danger: true }))) return;
    try {
      await smtpServerApi.delete(server.id);
      setServers((prev) => prev.filter((s) => s.id !== server.id));
      toast.success(t('settings.smtp.deleted'));
      loadOtpServers();
    } catch (err) {
      toast.error(apiErrorCode(err) === SMTP_IN_USE_OTP
        ? t('settings.smtp.inUseOtp', 'This server sends the two-factor codes and the password-reset emails. Choose another server under Platform → Security first.')
        : apiErrorMessage(err, t('settings.smtp.failedDelete')));
    }
  }

  async function handleTest(server: SmtpServer) {
    setTestingId(server.id);
    try {
      await smtpServerApi.test(server.id);
      toast.success(t('settings.smtp.testOk', { name: server.name }));
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, t('settings.smtp.testFailed')));
    } finally {
      setTestingId(null);
    }
  }

  async function setConfigKey(key: keyof AppConfig, value: boolean | number | null) {
    if (!appConfig || !canEditPlatform) return;
    setConfigSaving(true);
    try {
      await appConfigApi.setConfig(key, value);
      setAppConfig((prev) => prev ? { ...prev, [key]: value } : prev);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('settings.failedUpdate')));
    } finally {
      setConfigSaving(false);
    }
  }

  // Global layer of the agent notification types (device → group chain → this → defaults).
  async function saveAgentNotifTypes(notifTypes: NotificationTypeConfig | null) {
    try {
      const updated = await appConfigApi.patchAgentGlobal({ notificationTypes: notifTypes });
      setAgentGlobal(updated);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('settings.failedUpdate')));
      throw err;
    }
  }

  // Global level of the agent update policy (null = built-in default 'manual').
  async function saveAgentUpdatePolicy(updatePolicy: AgentUpdatePolicy | null) {
    const updated = await appConfigApi.patchAgentGlobal({ updatePolicy });
    setAgentGlobal(updated);
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
  }

  // OTP select options, grouped by origin.
  const otpPlatform = otpServers.filter((s) => s.tenantId === null);
  const otpMaster = otpServers.filter((s) => s.tenantId === MASTER_TENANT_ID);
  const otpOther = otpServers.filter((s) => s.tenantId !== null && s.tenantId !== MASTER_TENANT_ID);
  const otpServerId = appConfig?.otp_smtp_server_id ?? null;

  const readOnlyNote = !canEditPlatform && (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-status-pending/30 bg-status-pending-bg px-4 py-3 text-sm text-status-pending">
      <Lock size={15} className="shrink-0" />
      <p className="min-w-0 flex-1">
        {t(
          'settings.platform.readOnly',
          'Read-only here: these settings apply to every workspace and can only be changed from the master workspace ({{name}}).',
          { name: tenantName(MASTER_TENANT_ID) },
        )}
      </p>
      {admin && masterInList && (
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => void setCurrentTenant(MASTER_TENANT_ID, '/settings')}
        >
          {t('settings.platform.openMaster', 'Open in {{name}}', { name: tenantName(MASTER_TENANT_ID) })}
        </Button>
      )}
    </div>
  );

  return (
    <PageContainer className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary">{t('nav.settings', 'Settings')}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {t('settings.pageDesc', 'Platform settings shared by every workspace, then the settings of the current workspace.')}
        </p>
      </div>

      {/* ═══════════════════ Platform (all workspaces) ═══════════════════ */}
      {admin && (
        <section aria-labelledby="settings-platform" className="space-y-6">
          <SectionHeader
            id="settings-platform"
            icon={<Globe size={18} />}
            title={t('settings.platform.title', 'Platform (all workspaces)')}
            description={t('settings.platform.desc', 'Instance-wide configuration: it applies to every workspace and every user.')}
          />

          {readOnlyNote}

          {/* Disabled fieldset = every control read-only outside the master workspace */}
          <fieldset disabled={!canEditPlatform} className="min-w-0 space-y-8">
            {/* ── Security / 2FA ── */}
            <div>
              <SubHeading icon={<Shield size={16} className="text-text-muted" />}>
                {t('settings.security.title')}
              </SubHeading>
              <div className="rounded-lg border border-border bg-bg-secondary divide-y divide-border">
                <div className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.allow2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">{t('settings.security.allow2faDesc')}</p>
                  </div>
                  <ToggleSwitch
                    checked={appConfig?.allow_2fa ?? false}
                    disabled={!canEditPlatform || configSaving || !appConfig}
                    onChange={(v) => void setConfigKey('allow_2fa', v)}
                    ariaLabel={t('settings.security.allow2fa')}
                  />
                </div>

                <div className={cn('flex items-start justify-between gap-4 p-4', !appConfig?.allow_2fa && 'opacity-50')}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.force2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {t('settings.security.force2faDesc').split('\n')[0]}
                      {' '}
                      {t('settings.security.force2faBypass', 'Emergency bypass:')}{' '}
                      <code className="text-xs font-mono">DISABLE_2FA_FORCE=true</code> (.env)
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={appConfig?.force_2fa ?? false}
                    disabled={!canEditPlatform || configSaving || !appConfig || !appConfig.allow_2fa}
                    onChange={(v) => void setConfigKey('force_2fa', v)}
                    ariaLabel={t('settings.security.force2fa')}
                  />
                </div>

                {/* Not tied to allow_2fa: the password-reset emails use this server too */}
                <div className="flex items-start gap-4 p-4">
                  <Mail size={16} className="text-text-muted mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <label htmlFor="otp-smtp-server" className="text-sm font-medium text-text-primary">
                      {t('settings.security.otpSmtpTitle', 'SMTP server for 2FA codes and password reset')}
                    </label>
                    <p className="text-xs text-text-muted mt-0.5">
                      {t(
                        'settings.security.otpSmtpFullDesc',
                        'Sends the email one-time codes (when Email OTP is enabled) and the password-reset emails, for every workspace.',
                      )}
                    </p>
                    <select
                      id="otp-smtp-server"
                      className="mt-2 w-full max-w-sm rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 coarse:min-h-10"
                      value={otpServerId ?? ''}
                      disabled={!canEditPlatform || configSaving || !appConfig}
                      onChange={(e) => void setConfigKey('otp_smtp_server_id', e.target.value ? parseInt(e.target.value, 10) : null)}
                    >
                      <option value="">{t('settings.security.noneOption')}</option>
                      {otpPlatform.length > 0 && (
                        <optgroup label={t('settings.security.otpPlatformServers', 'Platform-level servers')}>
                          {otpPlatform.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </optgroup>
                      )}
                      {otpMaster.length > 0 && (
                        <optgroup label={t('settings.security.otpMasterServers', 'Master workspace ({{name}})', { name: tenantName(MASTER_TENANT_ID) })}>
                          {otpMaster.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </optgroup>
                      )}
                      {otpOther.length > 0 && (
                        <optgroup label={t('settings.security.otpOtherServers', 'Other workspace (not recommended)')}>
                          {otpOther.map((s) => (
                            <option key={s.id} value={s.id}>{s.name} · {tenantName(s.tenantId)}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                    <p className="mt-1.5 text-xs text-text-muted">
                      {t(
                        'settings.security.otpSmtpHint',
                        'Lists the platform-level servers and the SMTP servers of the master workspace ({{name}}). To use a new server, add it to the master workspace. The selected server cannot be deleted.',
                        { name: tenantName(MASTER_TENANT_ID) },
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* ── Obligate SSO Gateway ── */}
            <div>
              <SubHeading icon={<ArrowLeftRight size={16} className="text-text-muted" />}>
                {t('settings.obligate.title')}
              </SubHeading>
              <div className="rounded-lg border border-border bg-bg-secondary p-4 sm:p-5 space-y-4">
                <p className="text-sm text-text-muted">
                  {t('settings.obligate.description', 'Connect this app to your Obligate SSO gateway for centralized authentication and cross-app navigation. Register this app in Obligate first, then paste the API key here.')}
                </p>
                <div className="bg-status-pending-bg border border-status-pending/30 rounded-md p-3 text-sm text-status-pending">
                  {t('settings.obligate.warning', 'When enabled, local authentication is disabled. Users must sign in through the Obligate gateway. If the gateway becomes unreachable, local authentication is automatically restored as a fallback.')}
                </div>

                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <label htmlFor="obligate-url" className="text-sm font-medium text-text-secondary">{t('settings.obligate.urlLabel')}</label>
                    {obligateCfg?.url && (
                      <a href={obligateCfg.url} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">
                        {t('settings.obligate.open', 'Open')} ↗
                      </a>
                    )}
                  </div>
                  <input
                    id="obligate-url"
                    type="url"
                    placeholder={t('settings.obligate.urlPlaceholder')}
                    value={obligateUrl}
                    onChange={(e) => setObligateUrl(e.target.value)}
                    onBlur={() => void saveObligateConfig()}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label htmlFor="obligate-api-key" className="block text-sm font-medium text-text-secondary mb-1">
                    {t('settings.obligate.apiKeyLabel')}
                    {obligateCfg?.apiKeySet && (
                      <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20">{t('settings.obligate.setBadge', 'SET')}</span>
                    )}
                  </label>
                  <div className="relative">
                    <input
                      id="obligate-api-key"
                      type={showObligateKey ? 'text' : 'password'}
                      placeholder={obligateCfg?.apiKeySet ? '••••••••••••••••••••••••••••••••••••' : t('settings.obligate.apiKeyPlaceholder')}
                      value={obligateApiKey}
                      onChange={(e) => setObligateApiKey(e.target.value)}
                      onBlur={() => { if (obligateApiKey.trim()) void saveObligateConfig(); }}
                      autoComplete="off"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60"
                    />
                    <button
                      type="button"
                      onClick={() => setShowObligateKey((v) => !v)}
                      aria-label={t('settings.obligate.inboundSecret.toggleVisibility', 'Show / hide')}
                      aria-pressed={showObligateKey}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    >
                      {showObligateKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-text-muted">
                    {t('settings.obligate.apiKeyHint', 'Generate this key in Obligate → Connected Apps → Add App.')}
                  </p>
                </div>

                {/* Optional distinct secret Obligate must present on its calls to this server */}
                {obligateCfg?.apiKeySet && (
                  <div>
                    <label htmlFor="obligate-inbound-secret" className="block text-sm font-medium text-text-secondary mb-1">
                      {t('settings.obligate.inboundSecret.label', 'Inbound secret (optional)')}
                      {obligateCfg.inboundSecretSet && (
                        <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20">{t('settings.obligate.setBadge', 'SET')}</span>
                      )}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <div className="relative min-w-[12rem] flex-1">
                        <input
                          id="obligate-inbound-secret"
                          type={showInboundSecret ? 'text' : 'password'}
                          placeholder={obligateCfg.inboundSecretSet ? '••••••••••••••••••••••••••••••••••••' : t('settings.obligate.inboundSecret.placeholder', 'Empty: the API key is expected')}
                          value={obligateInboundSecret}
                          disabled={obligateCfg.inboundSecretFromEnv}
                          onChange={(e) => setObligateInboundSecret(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveInboundSecret(); } }}
                          autoComplete="off"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                        />
                        <button
                          type="button"
                          onClick={() => setShowInboundSecret((v) => !v)}
                          aria-label={t('settings.obligate.inboundSecret.toggleVisibility', 'Show / hide')}
                          aria-pressed={showInboundSecret}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                        >
                          {showInboundSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      {obligateInboundSecret.trim() && !obligateCfg.inboundSecretFromEnv && (
                        <Button type="button" size="sm" className="shrink-0" onClick={() => void saveInboundSecret()}>
                          {t('common.save')}
                        </Button>
                      )}
                      {obligateCfg.inboundSecretSet && !obligateCfg.inboundSecretFromEnv && (
                        <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => void clearInboundSecret()}>
                          {t('settings.obligate.inboundSecret.clear', 'Clear')}
                        </Button>
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-text-muted">
                      {obligateCfg.inboundSecretFromEnv
                        ? t('settings.obligate.inboundSecret.fromEnv', 'Set by the OBLIGATE_INBOUND_SECRET environment variable.')
                        : t('settings.obligate.inboundSecret.hint', 'Secret that Obligate must present when it calls this server (user sync, app info, dashboard stats), at least 16 characters. Leave empty to keep expecting the API key. Generate it in Obligate (Connected Apps), paste it here, then activate it in Obligate.')}
                    </p>
                  </div>
                )}

                {obligateCfg?.url && obligateCfg.apiKeySet && (
                  <div className="pt-4 border-t border-border mt-4">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">{t('settings.obligate.enableSso')}</p>
                        <p className="text-xs text-text-muted mt-0.5">
                          {t('settings.obligate.enableSsoDesc')}
                        </p>
                      </div>
                      <ToggleSwitch
                        checked={appConfig?.obligate_enabled ?? false}
                        disabled={!canEditPlatform || configSaving || !appConfig}
                        onChange={(v) => void setConfigKey('obligate_enabled', v)}
                        ariaLabel={t('settings.obligate.enableSso')}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── Agent notification defaults (global layer of the agent notification types) ── */}
            <div>
              <SubHeading icon={<Server size={16} className="text-text-muted" />}>
                {t('settings.agentNotifDefaults', 'Agent notification defaults')}
              </SubHeading>
              <p className="mb-3 text-xs text-text-muted">
                {t(
                  'settings.agentNotifDefaultsDesc',
                  'Which agent events send notifications, for every workspace, unless a group or a device overrides it.',
                )}
              </p>
              <NotificationTypesPanel
                config={agentGlobal?.notificationTypes ?? {
                  global: null, down: null, up: null, alert: null, update: null,
                }}
                scope="global"
                onSave={saveAgentNotifTypes}
              />
            </div>

            {/* ── Agent updates (global level of the update policy cascade) ── */}
            <div>
              <SubHeading icon={<Server size={16} className="text-text-muted" />}>
                {t('agentUpdatePolicy.globalTitle', 'Agent updates')}
              </SubHeading>
              <div className="rounded-lg border border-border bg-bg-secondary p-4 sm:p-5">
                {agentGlobal && (
                  <UpdatePolicyField
                    level="global"
                    label={t('agentUpdatePolicy.policyLabel', 'Update policy')}
                    description={t(
                      'agentUpdatePolicy.globalDesc',
                      'Applies to every workspace unless a workspace, a group or an agent overrides it. Frozen here is the fleet-wide kill-switch: no agent is updated, even manually, and waiting updates are cancelled. Workspaces are set on the Workspace page, groups on their settings page.',
                    )}
                    ownPolicy={agentGlobal.updatePolicy ?? null}
                    inherited={{ policy: DEFAULT_AGENT_UPDATE_POLICY, source: 'default', sourceGroupId: null }}
                    effective={agentGlobal.updatePolicy
                      ? { policy: agentGlobal.updatePolicy, source: 'global', sourceGroupId: null }
                      : { policy: DEFAULT_AGENT_UPDATE_POLICY, source: 'default', sourceGroupId: null }}
                    canEdit={canEditPlatform}
                    onChange={saveAgentUpdatePolicy}
                  />
                )}
              </div>
            </div>
          </fieldset>

          {/* ── About (read-only information) ── */}
          <div>
            <SubHeading icon={<Info size={16} className="text-text-muted" />}>
              {t('about.title', 'About')}
            </SubHeading>
            <div className="rounded-lg border border-border bg-bg-secondary p-4 sm:p-5">
              {systemInfoLoading ? (
                <p className="text-sm text-text-muted animate-pulse">{t('about.loading', 'Loading system information…')}</p>
              ) : systemInfo ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
                  {/* Versions */}
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                      <Server size={12} /> {t('about.versions', 'Versions')}
                    </p>
                    <AboutRow label={t('about.server', 'Server')} value={`v${systemInfo.appVersion}`} />
                    <AboutRow label={t('about.client', 'Client')} value={`v${__APP_VERSION__}`} />
                    <AboutRow label={t('about.agent', 'Agent')} value={`v${systemInfo.agentVersion}`} />
                    <AboutRow label="Node.js" value={systemInfo.nodeVersion} />
                  </div>
                  {/* Instance */}
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                      <Clock size={12} /> {t('about.instance', 'Instance')}
                    </p>
                    <AboutRow label={t('about.uptime', 'Uptime')} value={formatUptime(systemInfo.uptimeSeconds)} />
                    <AboutRow
                      label={t('about.environment', 'Environment')}
                      value={systemInfo.environment.isDocker ? 'Docker' : t('about.native', 'Native')}
                    />
                    <AboutRow label={t('about.platform', 'Platform')} value={systemInfo.environment.platform} />
                    <AboutRow label={t('about.cpuCores', 'CPU cores')} value={String(systemInfo.cpu.cores)} />
                  </div>
                  {/* Memory */}
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                      <HardDrive size={12} /> {t('about.memory', 'Memory')}
                    </p>
                    <AboutRow label={t('about.processRss', 'Process (RSS)')} value={`${systemInfo.memory.processRssMb} MB`} />
                    <AboutRow label={t('about.heapUsed', 'Heap used')} value={`${systemInfo.memory.processHeapMb} MB`} />
                    <AboutRow label={t('about.systemFree', 'System free')} value={`${systemInfo.memory.systemFreeMb} / ${systemInfo.memory.systemTotalMb} MB`} />
                  </div>
                  {/* CPU load */}
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                      <Cpu size={12} /> {t('about.cpuLoad', 'CPU load avg')}
                    </p>
                    <AboutRow label="1 min"  value={String(systemInfo.cpu.loadAvg1)} />
                    <AboutRow label="5 min"  value={String(systemInfo.cpu.loadAvg5)} />
                    <AboutRow label="15 min" value={String(systemInfo.cpu.loadAvg15)} />
                  </div>
                  {/* Database */}
                  <div className="space-y-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
                      <Database size={12} /> {t('about.database', 'Database')}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-text-muted">PostgreSQL</span>
                      <span className={cn(
                        'flex items-center gap-1.5 text-xs font-medium',
                        systemInfo.environment.dbStatus === 'ok' ? 'text-status-up' : 'text-status-down',
                      )}>
                        <span className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          systemInfo.environment.dbStatus === 'ok' ? 'bg-status-up' : 'bg-status-down',
                        )} />
                        {systemInfo.environment.dbStatus === 'ok' ? t('about.connected', 'Connected') : t('about.error', 'Error')}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-text-muted">{t('about.loadFailed', 'Could not load system information.')}</p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ═══════════════════ This workspace ═══════════════════ */}
      <section aria-labelledby="settings-workspace" className="space-y-6">
        <SectionHeader
          id="settings-workspace"
          icon={<Building2 size={18} />}
          title={t('settings.workspace.title', 'This workspace')}
          description={t('settings.workspace.desc', 'Applies only to the current workspace.')}
          extra={currentTenantId != null && tenantName(currentTenantId) ? (
            <span className="inline-flex items-center gap-1 self-center rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">
              <Building2 size={12} />
              {anonymize(tenantName(currentTenantId))}
            </span>
          ) : undefined}
        />

        {/* ── Workspace monitor defaults (settings, tenant-scoped) ── */}
        <SettingsPanel scope="global" scopeId={null} title={t('settings.defaultMonitorSettings')} />

        {canSettings && (
          <>
            {/* ── SMTP Servers (notification channels of this workspace) ── */}
            <div>
              <SubHeading
                icon={<Mail size={16} className="text-text-muted" />}
                extra={(
                  <Button size="sm" onClick={openCreate}>
                    <Plus size={14} className="mr-1" /> {t('settings.smtp.addServer')}
                  </Button>
                )}
              >
                {t('settings.smtp.title')}
              </SubHeading>
              <p className="mb-3 text-xs text-text-muted">
                {t('settings.smtp.workspaceDesc', 'Used by the Email notification channels of this workspace.')}
              </p>
              {servers.length === 0 ? (
                <div className="rounded-lg border border-border bg-bg-secondary p-5 text-sm text-text-muted flex items-center gap-3">
                  <Server size={16} className="shrink-0" />
                  {t('settings.smtp.noServers')}
                </div>
              ) : (
                <TableScroll className="rounded-lg border border-border bg-bg-secondary">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colName')}</th>
                        <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colHost')}</th>
                        <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colFrom')}</th>
                        <th className="px-4 py-2.5 font-medium text-text-secondary text-right">{t('settings.smtp.colActions')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {servers.map((server) => (
                        <tr key={server.id} className="border-b border-border last:border-0 hover:bg-bg-hover transition-colors">
                          <td className="px-4 py-3 text-text-primary font-medium">
                            {server.name}
                            {otpServerId === server.id && (
                              <span
                                className="ml-1.5 whitespace-nowrap rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                                title={t('settings.smtp.otpBadgeTitle', 'Sends the two-factor codes and the password-reset emails of every workspace')}
                              >
                                {t('settings.smtp.otpBadge', '2FA / password reset')}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-text-secondary whitespace-nowrap">
                            {server.host}:{server.port}
                            {server.secure && <span className="ml-1.5 text-xs bg-green-500/10 text-green-400 rounded px-1">{t('settings.smtp.tlsBadge')}</span>}
                          </td>
                          <td className="px-4 py-3 text-text-muted">{server.fromAddress}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              <IconButton
                                label={t('settings.smtp.testConnection')}
                                icon={<Wifi size={14} />}
                                variant="accent"
                                onClick={() => void handleTest(server)}
                                disabled={testingId === server.id}
                                className="disabled:opacity-50"
                              />
                              <IconButton
                                label={t('common.edit')}
                                icon={<Pencil size={14} />}
                                onClick={() => openEdit(server)}
                              />
                              <IconButton
                                label={t('common.delete')}
                                icon={<Trash2 size={14} />}
                                variant="danger"
                                onClick={() => void handleDelete(server)}
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </div>
          </>
        )}

        {admin && (
          <>
            {/* ── Import / Export (this workspace's configuration) ── */}
            <div id="import-export" className="scroll-mt-4">
              <SubHeading icon={<PackageOpen size={16} className="text-text-muted" />}>
                {t('importExport.title')}
              </SubHeading>
              {/* Embedded: no padding, no h1 — its export / import cards sit directly here */}
              <ImportExportPage embedded />
            </div>
          </>
        )}
      </section>

      {/* ── SMTP server dialog ── */}
      <Modal
        open={smtpMode !== null}
        onClose={closeSmtpModal}
        title={smtpMode === 'create' ? t('settings.smtp.addTitle') : t('settings.smtp.editTitle')}
        icon={<Mail size={16} className="text-accent" />}
        size="sm"
        closeOnBackdrop={false}
        footer={(
          <>
            <Button type="button" variant="ghost" onClick={closeSmtpModal}>{t('common.cancel')}</Button>
            <Button type="submit" form={smtpFormId} disabled={smtpSaving}>
              {smtpSaving ? t('common.saving') : smtpMode === 'create' ? t('common.create') : t('common.save')}
            </Button>
          </>
        )}
      >
        <form id={smtpFormId} onSubmit={handleSmtpSubmit} className="space-y-3">
          <Input
            label={t('settings.smtp.nameLabel')}
            value={smtpForm.name}
            onChange={(e) => setSmtpForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={t('settings.smtp.namePlaceholder')}
            required
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input
                label={t('settings.smtp.hostLabel')}
                value={smtpForm.host}
                onChange={(e) => setSmtpForm((f) => ({ ...f, host: e.target.value }))}
                placeholder={t('settings.smtp.hostPlaceholder')}
                required
              />
            </div>
            <Input
              label={t('settings.smtp.portLabel')}
              type="number"
              value={smtpForm.port}
              onChange={(e) => setSmtpForm((f) => ({ ...f, port: e.target.value }))}
              placeholder={t('settings.smtp.portPlaceholder')}
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
            <Checkbox
              checked={smtpForm.secure}
              onCheckedChange={(v) => setSmtpForm((f) => ({ ...f, secure: v }))}
            />
            {t('settings.smtp.tlsLabel')}
          </label>
          <Input
            label={t('settings.smtp.usernameLabel')}
            value={smtpForm.username}
            onChange={(e) => setSmtpForm((f) => ({ ...f, username: e.target.value }))}
            required
          />
          <div className="relative">
            <Input
              label={smtpMode === 'edit' ? t('settings.smtp.passwordEditLabel') : t('settings.smtp.passwordLabel')}
              type={showPassword ? 'text' : 'password'}
              value={smtpForm.password}
              onChange={(e) => setSmtpForm((f) => ({ ...f, password: e.target.value }))}
              required={smtpMode === 'create'}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={t('settings.obligate.inboundSecret.toggleVisibility', 'Show / hide')}
              aria-pressed={showPassword}
              className="absolute right-2.5 bottom-2 text-text-muted hover:text-text-primary"
            >
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <Input
            label={t('settings.smtp.fromLabel')}
            type="email"
            value={smtpForm.fromAddress}
            onChange={(e) => setSmtpForm((f) => ({ ...f, fromAddress: e.target.value }))}
            placeholder={t('settings.smtp.fromPlaceholder')}
            required
          />
        </form>
      </Modal>
    </PageContainer>
  );
}
