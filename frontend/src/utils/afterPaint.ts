/**
 * Run `fn` once the page has painted what's on it now — two animation
 * frames on — so heavy work after it (building a 3D board) can't keep the
 * last screen up. A hidden tab paints nothing and may run no animation
 * frames, so there a timer stands in after `fallbackMs`; a visible one waits
 * for its frames (up to `safetyMs`). Returns a cancel function.
 */
export function afterPaint(fn: () => void, fallbackMs = 250, safetyMs = 2000): () => void {
  let done = false;
  const stop = () => {
    done = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(hidden);
    window.clearTimeout(safety);
  };
  const run = () => {
    if (done) return;
    stop();
    fn();
  };
  let raf = requestAnimationFrame(() => { raf = requestAnimationFrame(run); });
  const hidden = window.setTimeout(() => { if (document.visibilityState === 'hidden') run(); }, fallbackMs);
  const safety = window.setTimeout(run, safetyMs);
  return stop;
}
