import { useState, useEffect } from 'react';
import {
  Monitor, Apple, Download, FolderOpen, Loader2, CheckCircle, AlertCircle,
  Smartphone, RefreshCw, Copy,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { isAndroidApp, nativeInfo, canUseNative, native } from '../native/bridge';
import { downloadUrl as downloadServerFile } from '../utils/download';
import { copyText } from '../utils/clipboard';

// ── Native Obli.tools Go bindings ────────────────────────────────────────────
// These are injected by the Go overlay into window when running inside Obli.tools.
// (Unrelated to the Android shell, which goes through native/bridge.ts.)

type NativeWindow = Window & {
  __obliview_is_native_app?: boolean;
  /** Returns the currently saved download folder, or "" if not yet set. */
  __go_getDownloadDir?: () => Promise<string>;
  /** Opens a native OS folder-picker, saves the choice, returns the path. Rejects on cancel. */
  __go_chooseDownloadDir?: () => Promise<string>;
  /** Downloads relUrl from the Obliview server to the saved folder (opens picker if unset). Returns the full path. */
  __go_downloadFile?: (relUrl: string, filename: string) => Promise<string>;
};

const nw = typeof window !== 'undefined' ? (window as NativeWindow) : null;
const isNativeApp = !!nw?.__obliview_is_native_app;

// ── Static data ───────────────────────────────────────────────────────────────

interface DownloadEntry {
  label: string;      // format label, e.g. "Disk Image (.dmg)"
  sublabel: string;   // arch / OS note, e.g. "Apple Silicon (M1–M4)"
  filename: string;
  primary?: boolean;
}

interface Platform {
  name: string;
  icon: React.ReactNode;
  downloads: DownloadEntry[];
}


// ── Component ─────────────────────────────────────────────────────────────────

export function DownloadPage() {
  const { t } = useTranslation();
  // Inside the Obli Android shell the desktop launcher is irrelevant: the page
  // becomes the app's "about / updates" screen.
  const inAndroidApp = isAndroidApp();

  const PLATFORMS: Platform[] = [
    {
      name: t('download.windows'),
      icon: <Monitor size={24} />,
      downloads: [
        {
          label: t('download.installer'),
          sublabel: t('download.installerSub'),
          filename: 'ObliToolsSetup.msi',
          primary: true,
        },
        {
          label: t('download.portable'),
          sublabel: t('download.portableSub'),
          filename: 'ObliTools.exe',
        },
      ],
    },
    {
      name: t('download.macos'),
      icon: <Apple size={24} />,
      downloads: [
        {
          label: t('download.dmg'),
          sublabel: t('download.dmgSubArm'),
          filename: 'ObliTools-arm64.dmg',
          primary: true,
        },
        {
          label: t('download.dmg'),
          sublabel: t('download.dmgSubIntel'),
          filename: 'ObliTools-amd64.dmg',
          primary: true,
        },
        {
          label: t('download.zip'),
          sublabel: t('download.dmgSubArm'),
          filename: 'ObliTools-arm64.zip',
        },
        {
          label: t('download.zip'),
          sublabel: t('download.dmgSubIntel'),
          filename: 'ObliTools-amd64.zip',
        },
      ],
    },
  ];

  // Native-app download folder state
  const [downloadDir, setDownloadDir] = useState<string>('');

  // Per-filename loading / success / error state
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});
  const [downloaded, setDownloaded] = useState<Record<string, string>>({});  // filename → saved path
  const [dlErrors, setDlErrors] = useState<Record<string, string>>({});

  // On mount, read the saved download folder from Go config.
  useEffect(() => {
    if (!isNativeApp || !nw?.__go_getDownloadDir) return;
    nw.__go_getDownloadDir()
      .then(dir => setDownloadDir(dir))
      .catch(() => {/* silently ignore */});
  }, []);

  const handleChangeDir = async () => {
    const go = nw?.__go_chooseDownloadDir;
    if (!go) return;
    try {
      const dir = await go();
      setDownloadDir(dir);
    } catch {
      // cancelled — silently ignore
    }
  };

  const handleNativeDownload = async (relUrl: string, filename: string) => {
    const go = nw?.__go_downloadFile;
    if (!go) return;

    setDownloading(prev => ({ ...prev, [filename]: true }));
    setDlErrors(prev => { const n = { ...prev }; delete n[filename]; return n; });

    try {
      const dest = await go(relUrl, filename);
      setDownloaded(prev => ({ ...prev, [filename]: dest }));
      // After 6 s reset the "Saved" badge so the button is usable again.
      setTimeout(() => {
        setDownloaded(prev => { const n = { ...prev }; delete n[filename]; return n; });
      }, 6000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'cancelled') {
        setDlErrors(prev => ({ ...prev, [filename]: msg }));
      }
      // If the user opened the folder picker and chose a new folder, update the displayed dir.
      if (nw?.__go_getDownloadDir) {
        nw.__go_getDownloadDir().then(dir => setDownloadDir(dir)).catch(() => {});
      }
    } finally {
      setDownloading(prev => { const n = { ...prev }; delete n[filename]; return n; });
    }
  };

  if (inAndroidApp) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
        <AndroidAppSection inApp />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">

      {/* Header */}
      <div className="mb-10 text-center">
        <div className="mb-4 flex justify-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Download size={32} />
          </div>
        </div>
        <h1 className="mb-2 text-2xl font-bold text-text-primary sm:text-3xl">{t('download.title')}</h1>
        <p className="text-text-secondary">
          {t('download.description')}
        </p>
      </div>

      {/* Download folder row — shown only inside the native app */}
      {isNativeApp && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-border bg-bg-secondary px-4 py-3 text-sm">
          <FolderOpen size={15} className="text-text-muted shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-text-secondary">{t('download.downloadFolder')}</span>
            {downloadDir
              ? <span className="font-mono text-text-primary break-all">{downloadDir}</span>
              : <span className="text-text-muted italic">{t('download.downloadFolderPlaceholder')}</span>
            }
          </div>
          <button
            onClick={handleChangeDir}
            className="shrink-0 rounded-md border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('download.changeFolder')}
          </button>
        </div>
      )}

      {/* Feature pills */}
      <div className="mb-10 flex flex-wrap justify-center gap-2">
        {[
          t('download.features.soundAlerts'),
          t('download.features.agentAlerts'),
          t('download.features.noBrowserOverhead'),
          t('download.features.remembersUrl'),
          t('download.features.alwaysUpToDate'),
        ].map((f) => (
          <span
            key={f}
            className="rounded-full border border-border bg-bg-secondary px-3 py-1 text-xs text-text-secondary"
          >
            {f}
          </span>
        ))}
      </div>

      {/* Download cards */}
      <div className="flex flex-col gap-4">
        {PLATFORMS.map((p) => (
          <div
            key={p.name}
            className="rounded-xl border border-border bg-bg-secondary p-5"
          >
            {/* Platform header */}
            <div className="mb-3 flex items-center gap-2.5 text-text-primary">
              <span className="text-text-secondary">{p.icon}</span>
              <span className="font-semibold">{p.name}</span>
            </div>

            {/* Download buttons — 2-column grid, tall buttons */}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {p.downloads.map((d) => {
                const isLoading = !!downloading[d.filename];
                const isSaved   = !!downloaded[d.filename];
                const hasError  = !!dlErrors[d.filename];

                const base    = 'flex flex-col items-center justify-center gap-1 rounded-lg px-3 py-5 text-center transition-colors disabled:opacity-60 w-full';
                const primary = `${base} bg-accent font-semibold text-white hover:opacity-90`;
                const secondary = `${base} border border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary`;

                const inner = isLoading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    <span className="text-xs mt-0.5">{t('common.downloading')}</span>
                  </>
                ) : isSaved ? (
                  <>
                    <CheckCircle size={15} className={d.primary ? 'text-white/80' : 'text-green-400'} />
                    <span className="text-xs mt-0.5">{t('common.saved')}</span>
                  </>
                ) : (
                  <>
                    <Download size={15} />
                    <span className="text-xs font-semibold leading-tight mt-0.5">{d.label}</span>
                    <span className="text-xs leading-tight opacity-60">{d.sublabel}</span>
                  </>
                );

                return (
                  <div key={d.filename} className="flex flex-col">
                    {hasError && isNativeApp && (
                      <div className="mb-1 flex items-center gap-1 text-xs text-red-400">
                        <AlertCircle size={10} />
                        <span className="truncate">{dlErrors[d.filename]}</span>
                      </div>
                    )}
                    {isNativeApp ? (
                      <button
                        onClick={() => handleNativeDownload(`/downloads/${d.filename}`, d.filename)}
                        disabled={isLoading}
                        className={d.primary ? primary : secondary}
                      >
                        {inner}
                      </button>
                    ) : (
                      <a
                        href={`/downloads/${d.filename}`}
                        download={d.filename}
                        className={d.primary ? primary : secondary}
                      >
                        {inner}
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* How it works */}
      <div className="mt-6 rounded-xl border border-border bg-bg-secondary p-5">
        <div className="mb-3 text-sm font-semibold text-text-primary">{t('download.howItWorks')}</div>
        <ul className="space-y-2 text-sm text-text-secondary">
          <li className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-primary">1.</span>
            {t('download.step1')}
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-primary">2.</span>
            {t('download.step2')}
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-primary">3.</span>
            {t('download.step3')}
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-primary">4.</span>
            {t('download.step4')}
          </li>
          <li className="flex gap-2">
            <span className="mt-0.5 shrink-0 text-primary">5.</span>
            {t('download.step5')}
          </li>
        </ul>
      </div>

      {/* Android app — hidden when this server publishes none (404) */}
      <AndroidAppSection inApp={false} />
    </div>
  );
}

// ── Android app (Obli Android shell) ─────────────────────────────────────────
//
// GET /api/mobile/android/version, served by
// server/src/controllers/mobileApp.controller.ts. 404 = no Android app
// published on this server: the browser section is hidden entirely.
//
// Browser: version / size / notes + APK download (absolute URL, copyable so it
// can be sent to the phone) + install steps.
// Inside the Android shell: installed version + "Check for updates"
// (native.checkForUpdate — the shell's updater verifies SHA-256 + signer and
// runs the installer). Shells without the `update` capability fall back to a
// plain DownloadManager download of the newer APK.

interface AndroidVersionInfo {
  app: string;
  packageName: string | null;
  version: string;
  versionCode: number;
  minSupportedVersionCode: number;
  minSdk?: number | null;
  sha256: string | null;
  sizeBytes: number | null;
  signerSha256: string | null;
  builtAt: string | null;
  available: boolean;
  downloadUrl: string;
  releaseNotes: string | null;
}

const ANDROID_VERSION_URL = '/api/mobile/android/version';

// Android API level → marketing version, for the "Android X+" requirement.
const ANDROID_RELEASE_BY_SDK: Record<number, string> = {
  21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1',
  28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16',
};

type UpdateCheck =
  | { kind: 'available'; version: string }
  | { kind: 'upToDate' }
  | { kind: 'error' };

function toAbsoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

function AndroidAppSection({ inApp }: { inApp: boolean }) {
  const { t, i18n } = useTranslation();

  const [info, setInfo] = useState<AndroidVersionInfo | null>(null);
  const [infoError, setInfoError] = useState(false);
  /** The server publishes no Android app at all (404). */
  const [notPublished, setNotPublished] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(ANDROID_VERSION_URL, { cache: 'no-store' })
      .then((r) => {
        if (r.status === 404) return null;
        return r.ok ? (r.json() as Promise<AndroidVersionInfo>) : Promise.reject(r.status);
      })
      .then((data) => {
        if (cancelled) return;
        if (data) setInfo(data);
        else setNotPublished(true);
      })
      .catch(() => { if (!cancelled) setInfoError(true); });
    return () => { cancelled = true; };
  }, []);

  const available = !!info?.available;
  // Absolute so it can be copied / typed on the phone (the API returns a path).
  const absoluteUrl = info ? toAbsoluteUrl(info.downloadUrl) : '';
  const apkName = info ? `Obliview-${info.version}.apk` : 'Obliview.apk';
  const serverOrigin = window.location.origin;

  const sizeLabel = available && info?.sizeBytes
    ? t('download.android.sizeMb', {
        size: (info.sizeBytes / (1024 * 1024)).toLocaleString(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      })
    : null;
  const androidRelease = info?.minSdk ? ANDROID_RELEASE_BY_SDK[info.minSdk] : undefined;
  const requiresLabel = androidRelease ? t('download.android.requires', { version: androidRelease }) : null;
  const builtLabel = available && info?.builtAt && !Number.isNaN(Date.parse(info.builtAt))
    ? t('download.android.released', { date: new Date(info.builtAt).toLocaleDateString(i18n.language) })
    : null;

  const handleCopy = async () => {
    const ok = await copyText(absoluteUrl);
    if (ok) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  };

  // ── In-app ────────────────────────────────────────────────────────────────
  const app = inApp ? nativeInfo() : null;
  const canCheck = inApp && canUseNative('checkForUpdate');
  const newerOnServer = !!app && available && !!info && info.versionCode > app.versionCode;

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateCheck(null);
    try {
      const r = await native.checkForUpdate();
      setUpdateCheck(r.available ? { kind: 'available', version: r.versionName } : { kind: 'upToDate' });
    } catch {
      setUpdateCheck({ kind: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const handleDownloadUpdate = async () => {
    const ok = await downloadServerFile(absoluteUrl, apkName);
    if (ok) toast.success(t('download.android.downloadStarted'));
    else toast.error(t('common.error'));
  };

  const releaseNotesBlock = available && info?.releaseNotes ? (
    <div className="mt-5">
      <div className="mb-2 text-sm font-semibold text-text-primary">
        {t('download.android.releaseNotes', { version: info.version })}
      </div>
      <pre className="max-h-64 overflow-y-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-bg-tertiary p-3 text-xs text-text-secondary font-mono">
        {info.releaseNotes}
      </pre>
    </div>
  ) : null;

  if (inApp) {
    const unavailable = notPublished || infoError || (!!info && !available);
    return (
      <>
        <div className="mb-8 text-center">
          <div className="mb-4 flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Smartphone size={32} />
            </div>
          </div>
          <h1 className="mb-2 text-2xl font-bold text-text-primary sm:text-3xl">
            {t('download.android.appTitle')}
          </h1>
          {app && (
            <p className="text-text-secondary">
              {t('download.android.inAppVersion', { version: app.appVersion })}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-border bg-bg-secondary p-5">
          {!info && !infoError && !notPublished && (
            <p className="mb-4 flex items-center gap-1.5 text-sm text-text-muted">
              <Loader2 size={14} className="animate-spin" />
              {t('download.android.loading')}
            </p>
          )}
          {available && info && (
            <p className="mb-4 text-sm text-text-secondary">
              {newerOnServer
                ? t('download.android.newerOnServer', { version: info.version })
                : t('download.android.serverVersion', { version: info.version })}
            </p>
          )}
          {unavailable && !canCheck && (
            <p className="text-sm text-text-muted">{t('download.android.unavailable')}</p>
          )}

          {canCheck ? (
            <>
              <button
                type="button"
                onClick={handleCheckUpdate}
                disabled={checking}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 transition-colors"
              >
                {checking ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                {checking ? t('download.android.checking') : t('download.android.checkUpdates')}
              </button>
              {updateCheck && (
                <p
                  role="status"
                  className={`mt-3 flex items-start gap-1.5 text-sm ${updateCheck.kind === 'error' ? 'text-red-400' : 'text-text-secondary'}`}
                >
                  {updateCheck.kind === 'error'
                    ? <AlertCircle size={16} className="mt-0.5 shrink-0" />
                    : <CheckCircle size={16} className="mt-0.5 shrink-0 text-primary" />}
                  <span>
                    {updateCheck.kind === 'available'
                      ? t('download.android.updateAvailable', { version: updateCheck.version })
                      : updateCheck.kind === 'upToDate'
                        ? t('download.android.upToDate')
                        : t('download.android.checkFailed')}
                  </span>
                </p>
              )}
            </>
          ) : newerOnServer ? (
            <button
              type="button"
              onClick={handleDownloadUpdate}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white hover:opacity-90 transition-colors"
            >
              <Download size={16} />
              {t('download.android.downloadUpdate')}
            </button>
          ) : available ? (
            <p className="flex items-center gap-1.5 text-sm text-text-secondary">
              <CheckCircle size={16} className="shrink-0 text-primary" />
              {t('download.android.upToDate')}
            </p>
          ) : null}

          {releaseNotesBlock}
        </div>
      </>
    );
  }

  // ── Browser ───────────────────────────────────────────────────────────────
  // Nothing published on this server (404): no Android section at all.
  if (notPublished) return null;

  const meta = [
    info ? `v${info.version}` : null,
    builtLabel,
    sizeLabel,
    requiresLabel,
  ].filter(Boolean).join(' · ');

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-lg font-semibold text-text-primary">
        {t('download.android.sectionTitle')}
      </h2>
      <div className="rounded-xl border border-border bg-bg-secondary p-5">
        <div className="mb-3 flex items-center gap-2.5 text-text-primary">
          <Smartphone size={22} className="shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{t('download.android.title')}</div>
            <div className="mt-0.5 text-xs text-text-muted">
              {available ? meta
                : infoError || info ? t('download.android.unavailable')
                : t('download.android.loading')}
            </div>
          </div>
        </div>

        <p className="mb-4 text-sm text-text-secondary">{t('download.android.description')}</p>

        {available && info && (
          <>
            <a
              href={absoluteUrl}
              download={apkName}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 text-sm font-semibold text-white hover:opacity-90 transition-colors"
            >
              <Download size={16} />
              {t('download.android.button')}
            </a>

            {/* Direct link: to open or send to the phone from a desktop browser */}
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-bg-tertiary px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[11px] uppercase tracking-wide text-text-muted">
                  {t('download.android.directLink')}
                </div>
                <div className="select-all break-all font-mono text-xs text-text-primary">{absoluteUrl}</div>
              </div>
              <button
                type="button"
                onClick={handleCopy}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors coarse:min-h-10"
              >
                <Copy size={13} />
                {t('common.copy')}
              </button>
            </div>

            {/* Install instructions */}
            <div className="mt-5">
              <div className="mb-2 text-sm font-semibold text-text-primary">
                {t('download.android.installTitle')}
              </div>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-secondary">
                <li>{t('download.android.step1')}</li>
                <li>{t('download.android.step2')}</li>
                <li>
                  {t('download.android.step3')}{' '}
                  <code className="break-all rounded bg-bg-tertiary px-1 py-0.5 font-mono text-xs text-text-primary">{serverOrigin}</code>
                </li>
                <li>{t('download.android.step4')}</li>
              </ol>
            </div>

            {/* Fingerprints, for whoever wants to check the APK by hand */}
            {(info.sha256 || info.signerSha256 || info.packageName) && (
              <details className="mt-5 text-xs text-text-muted">
                <summary className="cursor-pointer select-none py-1 text-text-secondary">
                  {t('download.android.details')}
                </summary>
                <dl className="mt-2 space-y-2">
                  {info.packageName && (
                    <div>
                      <dt>{t('download.android.packageName')}</dt>
                      <dd className="break-all font-mono text-text-primary">{info.packageName}</dd>
                    </div>
                  )}
                  <div>
                    <dt>{t('download.android.versionCode')}</dt>
                    <dd className="font-mono text-text-primary">{info.versionCode}</dd>
                  </div>
                  {info.sha256 && (
                    <div>
                      <dt>{t('download.android.sha256')}</dt>
                      <dd className="select-all break-all font-mono text-text-primary">{info.sha256}</dd>
                    </div>
                  )}
                  {info.signerSha256 && (
                    <div>
                      <dt>{t('download.android.signerSha256')}</dt>
                      <dd className="select-all break-all font-mono text-text-primary">{info.signerSha256}</dd>
                    </div>
                  )}
                </dl>
              </details>
            )}
          </>
        )}

        {releaseNotesBlock}
      </div>
    </section>
  );
}
