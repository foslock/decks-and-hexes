/**
 * Keeping sounds in time with what's on screen.
 *
 * A sound starts the moment the game asks for it but is heard only once the
 * audio output gets to it: normally a few tens of ms later, but Bluetooth
 * headphones and speakers add a fixed 150–250 ms (AirPods ≈ 170 ms), and
 * AirPlay far more. The browser reports that delay, so a sound that belongs
 * to something about to happen on screen — a claim about to smash into a
 * tile, the next card of a deal — can start that much early and be heard
 * right on it (see SoundEngine.cue).
 */

/** The delay every output has (ms): nobody hears it, so it isn't made up. */
export const USUAL_DELAY_MS = 30;
/** Never start a sound more than this far ahead (ms). */
export const MAX_LEAD_MS = 600;

/**
 * How long (ms) a sound started now takes to be heard; null when it can't
 * tell. The larger of what the output is playing right now (its timestamp)
 * and the latency the browser reports (Safari 18.4+, Chrome, Firefox).
 */
export function measureOutputDelay(ctx: AudioContext, now = performance.now()): number | null {
  if (ctx.state !== 'running') return null;
  const reported = ((ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0)) * 1000;
  let measured = 0;
  try {
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime && ts.performanceTime && ts.contextTime > 0 && ts.performanceTime > 0) {
      // The frame at contextTime is heard at performanceTime; one started now
      // (at currentTime) is heard that much later.
      const d = ts.performanceTime + (ctx.currentTime - ts.contextTime) * 1000 - now;
      if (Number.isFinite(d) && d >= 0 && d < 10000) measured = d;
    }
  } catch { /* not supported */ }
  const best = Math.max(reported, measured);
  return best > 0 ? best : null;
}

/** How far ahead (ms) to start a sound so it's heard on time, given the
 *  output's delay: whatever it adds beyond the usual. */
export function soundLead(delayMs: number | null): number {
  if (delayMs == null || !Number.isFinite(delayMs)) return 0;
  return Math.max(0, Math.min(MAX_LEAD_MS, delayMs - USUAL_DELAY_MS));
}
