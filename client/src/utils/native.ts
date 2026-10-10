/**
 * ObliTools (native desktop launcher) detection — one place for the checks
 * that are currently repeated inline in
 * Header.tsx, TenantSwitcher.tsx, hooks/useSocket.ts, DesktopUpdateBanner.tsx
 * and DownloadPage.tsx. Call sites adopt these helpers progressively.
 *
 * Two different questions, kept apart on purpose:
 *
 * - isObliToolsContext(): "are we hosted by ObliTools in any way?" — either
 *   in a frame (legacy ObliTools shells; the server now only allows
 *   same-origin framing) or in a WebView2 window where the Go overlay set
 *   `window.__obliview_is_native_app`. UI decisions only.
 *
 * - isObliToolsNativeApp(): only the explicit flag injected by the Go overlay
 *   (UI decisions: hide the download banner, app pills, tenant switcher
 *   behaviour…).
 */

/** Globals injected into `window` by the ObliTools Go overlay (obli.tools/main.go). */
export type ObliToolsWindow = Window & {
  /** Set by the overlay JS in every hosted app. */
  __obliview_is_native_app?: boolean;
  /** Version of the ObliTools build (absent on old builds). */
  __obliview_app_version?: string;
};

function obliToolsWindow(): ObliToolsWindow | null {
  return typeof window !== 'undefined' ? (window as ObliToolsWindow) : null;
}

/** True when the Go overlay flagged this window as the ObliTools native app. */
export function isObliToolsNativeApp(): boolean {
  return !!obliToolsWindow()?.__obliview_is_native_app;
}

/** True when the page runs inside any frame (cross-origin access counts as framed). */
export function isInIframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window !== window.top;
  } catch {
    return true; // cross-origin frame access blocked → definitely in an iframe
  }
}

/**
 * True inside ObliTools: flagged by its overlay, or framed (legacy shells).
 */
export function isObliToolsContext(): boolean {
  return isInIframe() || isObliToolsNativeApp();
}

/** ObliTools build version injected by the overlay, or null (browser / old build). */
export function obliToolsAppVersion(): string | null {
  return obliToolsWindow()?.__obliview_app_version ?? null;
}
