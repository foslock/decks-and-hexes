/**
 * Offline rendering + level measurement for the sound recipes.
 * Used by the audition page's level meter and by automated audio analysis.
 */
import { createAudioGraph } from './graph';
import { SOUNDS, type SoundName } from './sounds';
import { mulberry32, setRandomSource } from './synth';

export interface RenderOptions {
  sampleRate?: number;
  /** Master volume (0..1). Default 1. */
  volume?: number;
  /** Seed the per-play randomization for reproducible renders. */
  seed?: number;
  /** Extra seconds rendered after the sound's nominal length (reverb tail). Default 1.5. */
  tail?: number;
  /** Set false to mute the dry path (reverb only). */
  dry?: boolean;
  /** Set false to mute the reverb return. */
  wet?: boolean;
}

/** Silence before the first event, so renders match a warmed-up live context. */
const PREROLL = 0.05;

/** Render a timeline of sounds (e.g. a rapid-fire burst or an overlap stress test). */
export async function renderEvents(events: { name: SoundName; at: number }[], length: number, o: RenderOptions = {}): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(length * sr), sr);
  const g = createAudioGraph(ctx);
  g.volume.gain.value = o.volume ?? 1;
  if (o.dry === false) g.dryTap.gain.value = 0;
  if (o.wet === false) g.wetTap.gain.value = 0;
  if (o.seed !== undefined) setRandomSource(mulberry32(o.seed));
  try {
    for (const e of events) SOUNDS[e.name].play(g, PREROLL + e.at);
  } finally {
    if (o.seed !== undefined) setRandomSource(null);
  }
  return ctx.startRendering();
}

export function renderSound(name: SoundName, o: RenderOptions = {}): Promise<AudioBuffer> {
  return renderEvents([{ name, at: 0 }], PREROLL + SOUNDS[name].length + (o.tail ?? 1.5), o);
}

export interface Levels {
  /** Sample peak, dBFS. */
  peakDb: number;
  /** Max K-weighted 100 ms loudness (LUFS-style, short window). */
  loudness: number;
  /** Seconds until the signal falls 60 dB below its peak for good. */
  duration: number;
}

// ITU-R BS.1770 K-weighting (48 kHz coefficients).
const K1 = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const K2 = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };

function biquad(x: Float32Array, c: { b: number[]; a: number[] }): Float32Array {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b[0] * x[i] + c.b[1] * x1 + c.b[2] * x2 - c.a[0] * y1 - c.a[1] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

export function measure(buf: AudioBuffer): Levels {
  const sr = buf.sampleRate;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  let peak = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  const weighted = chans.map((ch) => (sr === 48000 ? biquad(biquad(ch, K1), K2) : ch));
  const n = buf.length;
  const win = Math.max(1, Math.round(sr * 0.1));
  let acc = 0;
  let best = 0;
  const ms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const w of weighted) s += w[i] * w[i];
    ms[i] = s;
    acc += s;
    if (i >= win) acc -= ms[i - win];
    if (i >= win - 1) best = Math.max(best, acc / win);
  }
  const thr = peak * 1e-3;
  let last = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (chans.some((ch) => Math.abs(ch[i]) > thr)) { last = i; break; }
  }
  return {
    peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
    loudness: -0.691 + 10 * Math.log10(Math.max(best, 1e-12)),
    duration: last / sr,
  };
}
