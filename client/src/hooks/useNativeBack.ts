import { useEffect, useRef } from 'react';

/**
 * Back / Escape stack shared by the overlay primitives (Modal, Drawer,
 * ConfirmDialog, ActionMenu, Tip, MasterDetail) — port of Obliance's
 * hooks/useNativeBack.ts + the back-stack half of native/bridge.ts.
 *
 * Self-contained on purpose: it does NOT depend on the Android bridge module.
 * The global Escape dispatcher (and the `window.__obliHandleBack` hook the
 * Obli Android shell calls on the system back button) are installed lazily
 * the first time a handler registers, so it works in a plain browser, in
 * ObliTools and in the Android shell alike, with no boot-time wiring.
 */

/**
 * A back handler. `source` tells whether the Android back button or the
 * Escape key triggered it. Return `false` to let the event fall through to
 * the next handler (and, for back, ultimately to the shell's
 * webView.goBack()); anything else consumes it.
 */
export type BackHandler = (source: 'back' | 'escape') => boolean | void;

export interface BackHandlerOptions {
  /**
   * Also receive the Escape key. Escape walks the stack from the top but only
   * visits Escape-enabled entries (others are transparent to it), so stacked
   * overlays close one at a time. Default false.
   */
  escape?: boolean;
}

interface BackEntry {
  handler: BackHandler;
  escape: boolean;
}

type BackWindow = Window & { __obliHandleBack?: () => boolean };

const backStack: BackEntry[] = [];

function runStack(source: 'back' | 'escape'): boolean {
  // Snapshot: a handler may unregister itself (closing a modal) while we iterate.
  const entries = backStack.slice().reverse();
  for (const entry of entries) {
    if (source === 'escape' && !entry.escape) continue;
    let result: boolean | void;
    try {
      result = entry.handler(source);
    } catch (err) {
      console.error(`[obli-back] ${source} handler failed`, err);
      result = true;
    }
    if (result !== false) return true;
  }
  return false;
}

/**
 * Run the back stack from the most recent handler down. Returns true when one
 * consumed the press. This is what `window.__obliHandleBack` calls.
 */
export function handleNativeBack(): boolean {
  return runStack('back');
}

/** Number of registered back handlers (0 = the shell will navigate back / exit). */
export function backStackDepth(): number {
  return backStack.length;
}

function onEscapeKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  if (runStack('escape')) e.preventDefault();
}

let installed = false;

/**
 * Install the global Escape dispatcher and `window.__obliHandleBack`.
 * Idempotent; called automatically by registerBackHandler().
 */
export function installBackHandler(): void {
  if (typeof window === 'undefined' || installed) return;
  installed = true;
  const w = window as BackWindow;
  // Do not override a handler someone else already installed.
  if (typeof w.__obliHandleBack !== 'function') w.__obliHandleBack = handleNativeBack;
  // Bubble phase on window: React handlers (and inputs/comboboxes that call
  // preventDefault on Escape) run first.
  window.addEventListener('keydown', onEscapeKey);
}

/**
 * Push a back handler on the stack (most recent wins). Returns the unregister
 * function. Prefer the `useNativeBack()` hook in components.
 */
export function registerBackHandler(handler: BackHandler, options?: BackHandlerOptions): () => void {
  installBackHandler();
  const entry: BackEntry = { handler, escape: !!options?.escape };
  backStack.push(entry);
  return () => {
    const i = backStack.indexOf(entry);
    if (i >= 0) backStack.splice(i, 1);
  };
}

export interface UseNativeBackOptions {
  /**
   * Also receive the Escape key (handler gets `source === 'escape'`). Escape
   * only visits Escape-enabled entries, top-most first, so stacked overlays
   * close one at a time. Modal, Drawer, ConfirmDialog, ActionMenu and Tip use
   * it; default false (page-level handlers should not react to Escape).
   */
  escape?: boolean;
}

/**
 * Register `handler` for the Android back button (and optionally Escape)
 * while `active` is true. The most recently activated handler runs first;
 * return `false` from it to let the press fall through to the previous one
 * (and ultimately to the shell's webView.goBack()).
 *
 * The handler may change on every render — only `active` toggles the
 * registration, so the stack order is the activation order.
 *
 *   useNativeBack(() => setOpen(false), open);
 *   useNativeBack(() => setOpen(false), open, { escape: true });
 */
export function useNativeBack(handler: BackHandler, active = true, options?: UseNativeBackOptions): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const escape = !!options?.escape;

  useEffect(() => {
    if (!active) return;
    return registerBackHandler((source) => handlerRef.current(source), { escape });
  }, [active, escape]);
}
