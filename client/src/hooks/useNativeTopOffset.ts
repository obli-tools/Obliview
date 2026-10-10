import { useState, useEffect } from 'react';

/**
 * Returns the top offset (in px) injected by the ObliTools native desktop
 * launcher. ObliTools injects a `#root { margin-top: 40+AH px }` style to push
 * flow content below its fixed tab-bar (obli.tools/main.go injectBar).
 * Fixed-position overlays (toasts, top-center live alerts) need this value so
 * they don't render behind the bar.
 *
 * Returns 0 when not running inside ObliTools.
 */
export function useNativeTopOffset(): number {
  const [offset, setOffset] = useState(() => readOffset());

  useEffect(() => {
    let raf = 0;
    // Coalesce bursts of mutations into one measurement per frame.
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setOffset(readOffset()));
    };
    // Re-measure on resize (the bar might not exist on first paint).
    window.addEventListener('resize', measure);
    // Watch only what can move #root: the injected <style> in <head>, inline
    // styles / classes on <html>, <body> and #root, and the bar being appended
    // to <body>. The app's own subtree is NOT observed (heartbeat churn).
    const mo = new MutationObserver(measure);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    mo.observe(document.body, { childList: true, attributes: true, attributeFilter: ['style', 'class'] });
    const root = document.getElementById('root');
    if (root) mo.observe(root, { attributes: true, attributeFilter: ['style', 'class'] });
    // Initial re-measure after a tick (bar might be injected async).
    const t = setTimeout(measure, 100);
    return () => {
      window.removeEventListener('resize', measure);
      mo.disconnect();
      clearTimeout(t);
      cancelAnimationFrame(raf);
    };
  }, []);

  return offset;
}

function readOffset(): number {
  if (typeof document === 'undefined') return 0;
  const root = document.getElementById('root');
  if (!root) return 0;
  return parseInt(getComputedStyle(root).marginTop, 10) || 0;
}
