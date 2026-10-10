/**
 * Clipboard helper that survives plain-http self-hosted origins.
 *
 * `navigator.clipboard` only exists in secure contexts (https / localhost), so
 * on an instance reached as http://<LAN-IP> a bare `navigator.clipboard.writeText`
 * throws a TypeError and nothing is copied.
 *
 * copyText order: async Clipboard API → hidden textarea + execCommand('copy').
 * Resolves true/false and never rejects: the CALLER shows the success / failure
 * toast, e.g.
 *
 *   copyText(key).then((ok) => ok ? toast.success(t('common.copied')) : toast.error(t('common.copyFailed')));
 *
 * Ported from Obliance (client/src/utils/clipboard.ts) without the native
 * bridge branch, which Obliview does not have.
 */

function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement as HTMLElement | null;
  const selection = document.getSelection();
  const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  // 12pt avoids the iOS zoom-on-focus; off-screen but still "visible" for selection.
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;font-size:12pt;pointer-events:none;';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    ta.remove();
    if (savedRange && selection) {
      try {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      } catch { /* ignore */ }
    }
    if (active && typeof active.focus === 'function') {
      try { active.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }
  return ok;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* permission denied / document not focused — try the fallback */
      }
    }
    return execCommandCopy(text);
  } catch {
    return false;
  }
}
