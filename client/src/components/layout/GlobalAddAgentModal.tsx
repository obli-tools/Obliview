import { useState, useEffect, useMemo } from 'react';
import { Key, Monitor, Terminal, Apple, Download, ChevronDown, ShieldAlert, Container } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { AgentApiKey } from '@obliview/shared';
import { agentApi } from '@/api/agent.api';
import { Button } from '@/components/common/Button';
import { CopyButton } from '@/components/common/CopyButton';
import { useUiStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';

type OsTab = 'windows' | 'linux' | 'macos' | 'freebsd' | 'docker';
// The modern agent is built with Go >= 1.22, which needs Windows 10 / Server
// 2016 or newer (its MSI refuses older systems). Windows 7 SP1 / 8.1 / Server
// 2008 R2 / 2012 / 2012 R2 get the same agent built with Go 1.20: the "nt6"
// MSI (agent/go120.mod, agent/build_flavor.go).
type WindowsVariant = 'modern' | 'oldtls' | 'nt6' | 'manual';
type LoadError = 'forbidden' | 'failed' | null;

function CommandBlock({ command }: { command: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
      <code className="flex-1 text-xs font-mono text-text-primary break-all leading-relaxed whitespace-pre-wrap">{command}</code>
      <CopyButton text={command} />
    </div>
  );
}

export function GlobalAddAgentModal() {
  const { t } = useTranslation();
  // POST /agent/keys is platform-admin only (AdminAgentPage canEditKeys).
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { addAgentModalOpen, closeAddAgentModal } = useUiStore();
  const [keys, setKeys] = useState<AgentApiKey[]>([]);
  const [agentVersion, setAgentVersion] = useState('1.0.0');
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [osTab, setOsTab] = useState<OsTab>('windows');
  const [winVariant, setWinVariant] = useState<WindowsVariant>('modern');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [loadError, setLoadError] = useState<LoadError>(null);
  // null = still checking. The wizard .exe is only produced by a separate
  // build step, so the option is hidden when the server does not have it.
  const [wizardAvailable, setWizardAvailable] = useState<boolean | null>(null);
  // null = still checking. The nt6 MSI is produced by its own build step
  // (Go 1.20): the option stays visible but says so when it is missing.
  const [nt6Available, setNt6Available] = useState<boolean | null>(null);

  useEffect(() => {
    if (!addAgentModalOpen) return;
    let cancelled = false;
    setLoadError(null);
    Promise.all([
      agentApi.listKeys(),
      agentApi.getVersion().catch(() => ({ version: '1.0.0', downloadUrl: '' })),
    ])
      .then(([k, v]) => {
        if (cancelled) return;
        setKeys(k);
        setAgentVersion(v.version);
        if (k.length > 0 && selectedKeyId === null) setSelectedKeyId(k[0].id);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        setKeys([]);
        setLoadError(status === 403 ? 'forbidden' : 'failed');
      });
    agentApi.isWizardAvailable().then((ok) => {
      if (!cancelled) setWizardAvailable(ok);
    });
    agentApi.isNt6MsiAvailable().then((ok) => {
      if (!cancelled) setNt6Available(ok);
    });
    return () => { cancelled = true; };
  }, [addAgentModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedKey = useMemo(
    () => keys.find((k) => k.id === selectedKeyId) ?? null,
    [keys, selectedKeyId],
  );

  if (!addAgentModalOpen) return null;

  // Fall back to the default variant if the wizard turned out to be missing.
  const effectiveWinVariant: WindowsVariant =
    winVariant === 'manual' && wizardAvailable !== true ? 'modern' : winVariant;

  const origin = window.location.origin;
  const msiUrl = `${origin}/api/agent/installer/windows.msi`;
  const apiKey = selectedKey?.key ?? '';
  const encKey = encodeURIComponent(apiKey);

  // ── Command templates ──
  const linuxCmd = `curl -fsSL "${origin}/api/agent/installer/linux?key=${encKey}" | bash`;
  const macosCmd = `sudo bash -c "$(curl -fsSL '${origin}/api/agent/installer/macos?key=${encKey}')"`;
  const freebsdCmd = `fetch -qo - "${origin}/api/agent/installer/freebsd?key=${encKey}" | sh`;
  // Docker proxy stub (proxy/, image meejay/obliview-proxy): a full checker
  // that registers as a 'proxy' device. The /data volume keeps its device
  // identity across container re-creation.
  const dockerProxyCmd = `docker run -d -e OBLIVIEW_SERVER=${origin} -e OBLIVIEW_API_KEY=${apiKey} -v obliview-proxy:/data meejay/obliview-proxy`;

  const winModernCmd = `$m="$env:TEMP\\obliview-agent.msi"; Invoke-WebRequest "${msiUrl}" -OutFile $m -UseBasicParsing; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${apiKey}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m`;

  const winOldTlsCmd = `$m="$env:TEMP\\obliview-agent.msi"; Import-Module BitsTransfer; Start-BitsTransfer -Source "${msiUrl}" -Destination $m; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${apiKey}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m`;

  // Windows NT 6.x (7 SP1 / 8.1 / Server 2008 R2 / 2012 / 2012 R2): the nt6
  // MSI. PowerShell 2.0 compatible (no Invoke-WebRequest before 3.0): TLS 1.2
  // enabled first (3072 = Tls12, unnamed before .NET 4.5), BITS download with
  // a WebClient fallback, then the same msiexec properties as the modern command.
  const nt6MsiUrl = `${origin}/api/agent/installer/windows-nt6.msi`;
  const winNt6Cmd = `try { [Net.ServicePointManager]::SecurityProtocol = 3072 } catch {}; $m="$env:TEMP\\obliview-agent-nt6.msi"; try { Import-Module BitsTransfer; Start-BitsTransfer -Source "${nt6MsiUrl}" -Destination $m -ErrorAction Stop } catch { (New-Object Net.WebClient).DownloadFile("${nt6MsiUrl}", $m) }; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${origin}\`" APIKEY=\`"${apiKey}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m`;

  const wizardUrl = selectedKey
    ? `${origin}/api/agent/installer/wizard.exe?keyId=${selectedKey.id}`
    : '';

  const noKeys = keys.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-bg-primary shadow-2xl overflow-y-auto max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-primary">{t('agents.addAgent', 'Add Agent')}</h2>
            <p className="text-xs text-text-muted mt-0.5">
              {t('agents.deploy.agentVersion', 'Agent version: {{version}}', { version: agentVersion })}
            </p>
          </div>
          <button
            onClick={closeAddAgentModal}
            aria-label={t('common.close', 'Close')}
            className="text-text-muted hover:text-text-primary text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {loadError ? (
            <div className="text-center py-8">
              <ShieldAlert size={28} className="mx-auto mb-2 text-text-muted" />
              <p className="text-sm text-text-muted">
                {loadError === 'forbidden'
                  ? t('agents.noKeyPermission', 'You need admin rights to add agents')
                  : t('agents.failedLoad', 'Failed to load agent data')}
              </p>
            </div>
          ) : noKeys ? (
            <div className="text-center py-8">
              <Key size={28} className="mx-auto mb-2 text-text-muted" />
              {isPlatformAdmin ? (
                <>
                  <p className="text-sm text-text-muted">{t('agents.noKeysCreateFirst', 'Create an API key first in Agent config')}</p>
                  <Link to="/manage/agents?tab=keys" onClick={closeAddAgentModal} className="inline-block mt-2 text-sm text-accent hover:underline">
                    {t('agents.deploy.createKeyLink', 'Create an API key')}
                  </Link>
                </>
              ) : (
                <p className="text-sm text-text-muted">
                  {t('agents.noKeysAskAdmin', 'No API key exists for this workspace yet. Ask a platform administrator to create one.')}
                </p>
              )}
            </div>
          ) : (
            <>
              {/* API key picker */}
              <div>
                <label className="block text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">
                  {t('agents.apiKeyLabel', 'API key')}
                </label>
                <div className="relative">
                  <button
                    onClick={() => setDropdownOpen((v) => !v)}
                    className="w-full flex items-center justify-between gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-left hover:border-border-light transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Key size={14} className="text-accent shrink-0" />
                      <span className="text-sm text-text-primary truncate">
                        {selectedKey?.name ?? t('agents.chooseKey', 'Choose a key')}
                      </span>
                      {selectedKey && (
                        <span className="text-xs font-mono text-text-muted shrink-0">
                          {selectedKey.key.slice(0, 8)}…{selectedKey.key.slice(-4)}
                        </span>
                      )}
                    </div>
                    <ChevronDown size={14} className="text-text-muted shrink-0" />
                  </button>
                  {dropdownOpen && (
                    <div className="absolute z-10 mt-1 w-full rounded-md border border-border bg-bg-secondary shadow-lg max-h-60 overflow-y-auto">
                      {keys.map((k) => (
                        <button
                          key={k.id}
                          onClick={() => { setSelectedKeyId(k.id); setDropdownOpen(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover transition-colors"
                        >
                          <Key size={14} className="text-accent shrink-0" />
                          <span className="text-sm text-text-primary flex-1 truncate">{k.name}</span>
                          <span className="text-xs font-mono text-text-muted shrink-0">
                            {k.key.slice(0, 8)}…{k.key.slice(-4)}
                          </span>
                          {k.deviceCount !== undefined && (
                            <span className="text-xs text-text-muted shrink-0">
                              {t('agents.deviceCount', '{{count}} device(s)', { count: k.deviceCount })}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* OS tabs */}
              <div className="flex items-center gap-1 rounded-md bg-bg-secondary p-1 border border-border overflow-x-auto scrollbar-none">
                {([
                  { id: 'windows', label: 'Windows', icon: Monitor },
                  { id: 'linux', label: 'Linux', icon: Terminal },
                  { id: 'macos', label: 'macOS', icon: Apple },
                  { id: 'freebsd', label: 'FreeBSD', icon: Terminal },
                  { id: 'docker', label: t('agents.deploy.dockerProxyTab', 'Docker proxy'), icon: Container },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setOsTab(tab.id)}
                    className={
                      'flex-1 shrink-0 whitespace-nowrap flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ' +
                      (osTab === tab.id
                        ? 'bg-accent/15 text-accent border border-accent/30'
                        : 'text-text-muted hover:text-text-primary')
                    }
                  >
                    <tab.icon size={13} />
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Per-OS body */}
              <div className="space-y-3">
                {osTab === 'windows' && (
                  <>
                    {/* Windows variant pills */}
                    <div className="flex items-center gap-1 flex-wrap">
                      {([
                        { id: 'modern',  label: t('agents.deploy.winModernOption', 'Windows 10+') },
                        { id: 'oldtls',  label: t('agents.winOldTls', 'Windows Server 2016 (legacy TLS)') },
                        { id: 'nt6',     label: t('agents.deploy.nt6Option', 'Windows 7 / 8.1 / Server 2008 R2 / 2012 (legacy build)') },
                        ...(wizardAvailable ? [{ id: 'manual', label: t('agents.deploy.wizardOption', 'Manual / Wizard') }] : []),
                      ] as Array<{ id: WindowsVariant; label: string }>).map((v) => (
                        <button
                          key={v.id}
                          onClick={() => setWinVariant(v.id)}
                          className={
                            'px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors border ' +
                            (effectiveWinVariant === v.id
                              ? 'bg-accent/15 text-accent border-accent/30'
                              : 'bg-bg-tertiary text-text-muted border-border hover:border-border-light')
                          }
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>

                    {effectiveWinVariant === 'modern' && (
                      <>
                        <p className="text-xs text-text-muted">
                          {t('agents.deploy.winModernHint', 'PowerShell as Administrator on Windows 10, 11, Server 2019 and newer.')}
                        </p>
                        <CommandBlock command={winModernCmd} />
                      </>
                    )}
                    {effectiveWinVariant === 'oldtls' && (
                      <>
                        <p className="text-xs text-text-muted">
                          {t('agents.deploy.winOldTlsHint', 'Uses BitsTransfer for hosts without modern TLS in Invoke-WebRequest.')}
                        </p>
                        <CommandBlock command={winOldTlsCmd} />
                      </>
                    )}
                    {effectiveWinVariant === 'nt6' && (
                      nt6Available === false ? (
                        <p className="text-xs text-text-muted">
                          {t('agents.deploy.nt6NotBuilt', 'The Windows 7 / 8.1 / Server 2008 R2 / 2012 installer has not been built on this server yet.')}
                        </p>
                      ) : (
                        <>
                          <p className="text-xs text-text-muted">
                            {t('agents.deploy.nt6Hint', 'PowerShell as Administrator on Windows 7 SP1, 8.1, Server 2008 R2 SP1, 2012 and 2012 R2 (64-bit). Same agent, built for older Windows. PowerShell 2.0 compatible.')}
                          </p>
                          <CommandBlock command={winNt6Cmd} />
                          <p className="text-[11px] text-text-muted">
                            {t('agents.deploy.nt6TlsNote', 'If the download fails on Windows 7 / Server 2008 R2, install the TLS 1.2 updates (KB3140245, KB3154518) or copy the MSI to the machine and run the msiexec part.')}{' '}
                            <a href={nt6MsiUrl} download="obliview-agent-nt6.msi" className="text-accent hover:underline">
                              {t('agents.deploy.nt6DownloadMsi', 'Download the MSI')}
                            </a>
                          </p>
                        </>
                      )
                    )}
                    {effectiveWinVariant === 'manual' && (
                      <div className="rounded-md border border-border bg-bg-secondary p-4">
                        <div className="flex items-start gap-3">
                          <Download size={20} className="text-accent shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary">
                              {t('agents.deploy.wizardTitle', 'Obliview Install Wizard')}
                            </p>
                            <p className="text-xs text-text-muted mt-1">
                              {t('agents.deploy.wizardHint', 'Self-contained .exe bundling the MSI, pre-filled with this key and server URL. Run it on the target host: no PowerShell required.')}
                            </p>
                            <a
                              href={wizardUrl || '#'}
                              download={wizardUrl ? 'obliview-install-wizard.exe' : undefined}
                              className={
                                'inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ' +
                                (wizardUrl
                                  ? 'bg-accent text-bg-primary hover:bg-accent-hover'
                                  : 'bg-bg-tertiary text-text-muted cursor-not-allowed')
                              }
                              onClick={(e) => { if (!wizardUrl) e.preventDefault(); }}
                            >
                              <Download size={13} />
                              {t('agents.deploy.downloadWizard', 'Download wizard')}
                            </a>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {osTab === 'linux' && (
                  <>
                    <p className="text-xs text-text-muted">
                      {t('agents.deploy.linuxHint', 'Requires curl, systemd and root.')}
                    </p>
                    <CommandBlock command={linuxCmd} />
                  </>
                )}

                {osTab === 'macos' && (
                  <>
                    <p className="text-xs text-text-muted">
                      {t('agents.deploy.macosHint', 'Installs the launchd service. Works on Intel and Apple Silicon.')}
                    </p>
                    <CommandBlock command={macosCmd} />
                  </>
                )}

                {osTab === 'freebsd' && (
                  <>
                    <p className="text-xs text-text-muted">
                      {t('agents.deploy.freebsdHint', 'Installs as an rc.d service. Requires root.')}
                    </p>
                    <CommandBlock command={freebsdCmd} />
                  </>
                )}

                {osTab === 'docker' && (
                  <>
                    <p className="text-xs text-text-muted">
                      {t('agents.deploy.dockerProxyHint', 'Runs the Obliview proxy in a container: a full remote checker (HTTP, ping, DNS, Docker, scripts, browser…) that registers as a proxy device. Approve it like an agent, then pick it as the proxy of a monitor.')}
                    </p>
                    <CommandBlock command={dockerProxyCmd} />
                    <p className="text-[11px] text-text-muted">
                      {t('agents.deploy.dockerProxyVolume', 'Keep the /data volume: it holds the device identity, so re-creating the container does not register a new device.')}
                    </p>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        <div className="px-6 pb-6">
          <Button variant="secondary" onClick={closeAddAgentModal} className="w-full">{t('common.close', 'Close')}</Button>
        </div>
      </div>
    </div>
  );
}
