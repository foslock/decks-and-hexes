/**
 * Procedural synthesis toolkit for Card Clash.
 *
 * Everything here works on a `BaseAudioContext`, so the exact same recipes can
 * render live (AudioContext) or offline (OfflineAudioContext, for the audition
 * page's level meter and for automated analysis).
 *
 * Conventions
 *  - All `at` times passed to Voice helpers are seconds RELATIVE to the voice start.
 *  - Envelopes always start from gain 0 and decay exponentially to ~-80 dB before
 *    the source is stopped, so nothing ever starts or stops at non-zero gain.
 *  - A Voice owns every node it creates and disconnects them all once its last
 *    source has ended (fire-and-forget, nothing leaks).
 */

export type Ctx = BaseAudioContext;
export type NoiseColor = 'white' | 'pink' | 'brown';

// ── Randomness ──────────────────────────────────────────────────────

let rng: () => number = Math.random;

/** Swap the random source (e.g. a seeded PRNG for reproducible offline renders). */
export function setRandomSource(fn: (() => number) | null): void {
  rng = fn ?? Math.random;
}

/** Small, fast seeded PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const rand = (lo = 0, hi = 1): number => lo + (hi - lo) * rng();
export const randInt = (lo: number, hi: number): number => Math.floor(rand(lo, hi + 1));
export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
/** Multiply `v` by a random factor in [1-pct, 1+pct]. */
export const jitter = (v: number, pct: number): number => v * (1 + rand(-pct, pct));
/** Frequency ratio for `n` semitones. */
export const semi = (n: number): number => Math.pow(2, n / 12);
export const dbToGain = (db: number): number => Math.pow(10, db / 20);

const lastVariant = new Map<string, number>();
/** Pick one of `n` variants at random, never repeating the previous pick for `key`. */
export function variant(key: string, n: number): number {
  if (n <= 1) return 0;
  const prev = lastVariant.get(key);
  let i = Math.floor(rng() * (prev === undefined ? n : n - 1));
  if (prev !== undefined && i >= prev) i++;
  lastVariant.set(key, i);
  return i;
}

// ── Buffers ─────────────────────────────────────────────────────────

export interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /**
   * Short pre-shaped, energy-normalized noise transients (thuds/taps). Unlike
   * slicing a random window of the long buffers, these give near-identical
   * loudness on every play, which matters for sounds repeated many times.
   */
  taps: AudioBuffer[];
}

function normalizeRms(data: Float32Array, target: number): void {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  const k = target / Math.sqrt(sum / data.length || 1);
  for (let i = 0; i < data.length; i++) data[i] = Math.max(-1, Math.min(1, data[i] * k));
}

/** White, pink (Paul Kellet) and brown noise buffers, all RMS-matched so layers mix predictably. */
export function createNoiseBank(ctx: Ctx, seconds = 2): NoiseBank {
  const sr = ctx.sampleRate;
  // Fixed seed: identical buffers every session (per-play variety comes from random read offsets).
  const random = mulberry32(0x5eed);
  const len = Math.floor(sr * seconds);
  const make = () => ctx.createBuffer(1, len, sr);
  const white = make();
  const pink = make();
  const brown = make();
  const w = white.getChannelData(0);
  const p = pink.getChannelData(0);
  const b = brown.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let br = 0, dc = 0;
  for (let i = 0; i < len; i++) {
    const x = random() * 2 - 1;
    w[i] = x;
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    p[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
    // Leaky integrator: -6 dB/oct above ~150 Hz, flat below. A gentler leak would
    // add huge random sub-bass swings, making short bursts wildly uneven in level.
    br = 0.98 * br + x * 0.2;
    dc = 0.999 * dc + 0.001 * br;
    b[i] = br - dc;
  }
  // Fade the loop seam so looping sources never click.
  for (const d of [w, p, b]) {
    normalizeRms(d, 0.3);
    const f = Math.floor(sr * 0.005);
    for (let i = 0; i < f; i++) {
      const g = i / f;
      d[i] *= g;
      d[len - 1 - i] *= g;
    }
  }
  const taps: AudioBuffer[] = [];
  const tapLen = Math.floor(sr * 0.09);
  for (let k = 0; k < 4; k++) {
    const buf = ctx.createBuffer(1, tapLen, sr);
    const d = buf.getChannelData(0);
    let lp = 0;
    let energy = 0;
    for (let i = 0; i < tapLen; i++) {
      const t = i / sr;
      lp = 0.95 * lp + 0.05 * (random() * 2 - 1); // reddish: most energy below ~400 Hz
      const env = (1 - Math.exp(-t / 0.0004)) * Math.exp(-t / 0.012);
      d[i] = lp * env;
      energy += d[i] * d[i];
    }
    const g = 0.05 / Math.sqrt(energy / sr); // fixed energy per tap
    for (let i = 0; i < tapLen; i++) d[i] *= g;
    d[tapLen - 1] = 0;
    taps.push(buf);
  }
  return { white, pink, brown, taps };
}

/**
 * Warm, short room/hall impulse response: a few early reflections, then a
 * decorrelated stereo tail whose high frequencies die faster than the lows.
 * Energy-normalized so the reverb return level is predictable.
 */
export function createImpulseResponse(ctx: Ctx, opts: { duration?: number; rt60?: number; predelay?: number } = {}): AudioBuffer {
  const { duration = 1.4, rt60 = 1.05, predelay = 0.011 } = opts;
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * duration);
  const ir = ctx.createBuffer(2, len, sr);
  const seeded = mulberry32(0xc1a5);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    // Early reflections (different per channel for width).
    for (let k = 0; k < 9; k++) {
      const t = 0.004 + seeded() * 0.045;
      const i = Math.floor((predelay * 0.4 + t) * sr);
      if (i < len) d[i] += (seeded() < 0.5 ? -1 : 1) * (0.35 + seeded() * 0.4) * Math.exp(-t / 0.04);
    }
    // Diffuse tail with time-varying one-pole low-pass (8 kHz → ~1.4 kHz).
    let y = 0;
    const start = Math.floor(predelay * sr);
    for (let i = start; i < len; i++) {
      const t = (i - start) / sr;
      const fc = 8000 * Math.pow(1400 / 8000, Math.min(1, t / 0.9));
      const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      y += a * ((seeded() * 2 - 1) - y);
      const fadeIn = Math.min(1, t / 0.018);
      const decay = Math.pow(10, (-3 * t) / rt60);
      d[i] += y * decay * fadeIn * 1.6;
    }
    // Fade the very end to zero.
    const f = Math.floor(sr * 0.05);
    for (let i = 0; i < f; i++) d[len - 1 - i] *= i / f;
  }
  // Energy-normalize (sum of squares per channel = 1).
  let e = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) e += d[i] * d[i];
  }
  const k = 1 / Math.sqrt(e / 2);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= k;
  }
  return ir;
}

const shaperCurves = new Map<number, Float32Array>();
/** tanh soft-clip curve (normalized so ±1 maps to ±1). Adds harmonics so subs read on small speakers. */
function saturationCurve(drive: number): Float32Array {
  const key = Math.round(drive * 100);
  let c = shaperCurves.get(key);
  if (!c) {
    const n = 1024;
    c = new Float32Array(n);
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(drive * x) / norm;
    }
    shaperCurves.set(key, c);
  }
  return c;
}

/**
 * Build a gain curve made of many tiny grains (paper crackle, riffle flaps,
 * debris). One noise source + one gain node can then carry dozens of transients.
 * Each grain: ~0.3 ms attack, exponential decay over `dur`.
 */
export function grainCurve(grains: { t: number; amp: number; dur: number }[], total: number, res = 4000): Float32Array {
  const n = Math.max(4, Math.ceil(total * res));
  const c = new Float32Array(n);
  for (const g of grains) {
    const i0 = Math.floor(g.t * res);
    const tau = Math.max(g.dur / 5, 0.0004);
    const iEnd = Math.min(n - 1, i0 + Math.ceil(g.dur * 1.6 * res));
    for (let i = Math.max(0, i0); i < iEnd; i++) {
      const x = (i - i0) / res;
      c[i] += g.amp * (1 - Math.exp(-x / 0.0003)) * Math.exp(-x / tau);
    }
  }
  for (let i = 0; i < n; i++) c[i] = Math.min(1, c[i]);
  c[0] = 0;
  c[n - 1] = 0;
  return c;
}

// ── Graph contract ─────────────────────────────────────────────────

/** What a recipe needs from the master graph. */
export interface Bus {
  ctx: Ctx;
  /** Dry input of the master bus. */
  input: AudioNode;
  /** Input of the shared reverb. */
  send: AudioNode;
  noise: NoiseBank;
}

// ── Envelopes ──────────────────────────────────────────────────────

export interface Env {
  /** Attack time (s), linear rise from 0. Default 2 ms. */
  a?: number;
  /** Peak gain. Default 1. */
  peak?: number;
  /**
   * Percussive (no `s`): time to decay 60 dB after the attack.
   * Sustained (with `s`): time to fall to the sustain level.
   */
  d?: number;
  /** Sustain level as a fraction of peak (0..1). Omit for a percussive envelope. */
  s?: number;
  /** Time held at sustain before release. */
  hold?: number;
  /** Release time (to -80 dB). */
  r?: number;
  /** 'exp' attack = swell that blooms at the end (reverse-whoosh feel). */
  attackCurve?: 'lin' | 'exp';
}

const FLOOR = 1e-4;

/** Schedule an envelope on `param` starting at absolute time `t`. Returns its length in seconds. */
export function applyEnv(param: AudioParam, t: number, e: Env): number {
  const a = Math.max(0.0008, e.a ?? 0.002);
  const peak = e.peak ?? 1;
  param.cancelScheduledValues(t);
  if (e.attackCurve === 'exp') {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak * FLOOR * 10, t + 0.002);
    param.exponentialRampToValueAtTime(peak, t + a);
  } else {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
  }
  if (e.s === undefined) {
    const d = e.d ?? 0.2;
    const end = a + d * 1.34; // -80 dB
    param.exponentialRampToValueAtTime(peak * FLOOR, t + end);
    param.setValueAtTime(0, t + end + 0.001);
    return end + 0.002;
  }
  const d = e.d ?? 0.1;
  const s = Math.max(FLOOR * 10, e.s) * peak;
  const hold = e.hold ?? 0;
  const r = e.r ?? 0.2;
  param.exponentialRampToValueAtTime(s, t + a + d);
  const relStart = t + a + d + hold;
  param.setValueAtTime(s, relStart);
  param.exponentialRampToValueAtTime(peak * FLOOR, relStart + r);
  param.setValueAtTime(0, relStart + r + 0.001);
  return a + d + hold + r + 0.002;
}

// ── Voice ──────────────────────────────────────────────────────────

export interface FilterSpec {
  type: BiquadFilterType;
  f: number;
  /** Optional target frequency; swept exponentially over `sweep` seconds. */
  f2?: number;
  sweep?: number;
  q?: number;
  gain?: number;
}

export interface VoiceOptions {
  /** Absolute start time; default ctx.currentTime + 5 ms. */
  when?: number;
  gain?: number;
  pan?: number;
  /** Reverb send amount (0..1). */
  reverb?: number;
}

/**
 * One fire-and-forget sound event. Layers created through it share a gain,
 * a stereo position and a reverb send, and are torn down together.
 */
export class Voice {
  readonly ctx: Ctx;
  readonly t0: number;
  readonly noiseBank: NoiseBank;
  readonly out: GainNode;
  readonly panner: StereoPannerNode;
  private nodes: AudioNode[] = [];
  private lastSource: AudioScheduledSourceNode | null = null;
  private lastEnd = -1;

  constructor(bus: Bus, o: VoiceOptions = {}) {
    this.ctx = bus.ctx;
    this.noiseBank = bus.noise;
    this.t0 = o.when ?? bus.ctx.currentTime + 0.005;
    this.out = this.reg(bus.ctx.createGain());
    this.out.gain.value = o.gain ?? 1;
    this.panner = this.reg(bus.ctx.createStereoPanner());
    this.panner.pan.value = Math.max(-1, Math.min(1, o.pan ?? 0));
    this.out.connect(this.panner);
    this.panner.connect(bus.input);
    if (o.reverb && o.reverb > 0) {
      const send = this.reg(bus.ctx.createGain());
      send.gain.value = o.reverb;
      this.panner.connect(send);
      send.connect(bus.send);
    }
  }

  /** Register a node for teardown. */
  reg<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Absolute time for a voice-relative offset. */
  at(rel = 0): number {
    return this.t0 + rel;
  }

  gain(v = 1): GainNode {
    const g = this.reg(this.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  /** A sub-bus with its own pan (for spreading layers inside one voice). */
  bus(gain = 1, pan = 0): GainNode {
    const g = this.gain(gain);
    if (pan !== 0) {
      const p = this.reg(this.ctx.createStereoPanner());
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p).connect(this.out);
    } else {
      g.connect(this.out);
    }
    return g;
  }

  filter(spec: FilterSpec, at = 0, defaultSweep = 0.1): BiquadFilterNode {
    const f = this.reg(this.ctx.createBiquadFilter());
    f.type = spec.type;
    const t = this.at(at);
    f.frequency.setValueAtTime(spec.f, t);
    if (spec.f2 !== undefined) f.frequency.exponentialRampToValueAtTime(spec.f2, t + (spec.sweep ?? defaultSweep));
    if (spec.q !== undefined) f.Q.value = spec.q;
    if (spec.gain !== undefined) f.gain.value = spec.gain;
    return f;
  }

  shaper(drive: number): WaveShaperNode {
    const s = this.reg(this.ctx.createWaveShaper());
    s.curve = saturationCurve(drive);
    s.oversample = '2x';
    return s;
  }

  /** Connect nodes in series; returns the last. */
  chain(...nodes: AudioNode[]): AudioNode {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /** Start/stop a source at voice-relative times and track it for teardown. */
  run(src: AudioScheduledSourceNode, start: number, stop: number, offset?: number): void {
    this.reg(src);
    const t = this.at(start);
    if (offset !== undefined && src instanceof AudioBufferSourceNode) src.start(t, offset);
    else src.start(t);
    src.stop(this.at(stop));
    if (stop > this.lastEnd) {
      this.lastEnd = stop;
      this.lastSource = src;
    }
  }

  // ── Layers ──

  /** Oscillator layer with optional pitch glide, filter chain, vibrato and saturation. */
  tone(o: {
    f: number;
    type?: OscillatorType;
    wave?: PeriodicWave;
    f2?: number;
    glide?: number;
    detune?: number;
    at?: number;
    env: Env;
    gain?: number;
    filters?: FilterSpec[];
    drive?: number;
    vibrato?: { rate: number; cents: number; delay?: number };
    dest?: AudioNode;
  }): number {
    const at = o.at ?? 0;
    const osc = this.ctx.createOscillator();
    if (o.wave) osc.setPeriodicWave(o.wave);
    else osc.type = o.type ?? 'sine';
    const t = this.at(at);
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2 !== undefined) osc.frequency.exponentialRampToValueAtTime(o.f2, t + (o.glide ?? 0.1));
    if (o.detune) osc.detune.value = o.detune;
    const g = this.gain(0);
    const len = applyEnv(g.gain, t, { ...o.env, peak: (o.env.peak ?? 1) * (o.gain ?? 1) });
    let head: AudioNode = osc;
    if (o.drive) head = this.chain(head, this.shaper(o.drive));
    for (const fs of o.filters ?? []) head = this.chain(head, this.filter(fs, at, len));
    head.connect(g);
    g.connect(o.dest ?? this.out);
    if (o.vibrato) {
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = o.vibrato.rate;
      const depth = this.gain(0);
      const vd = o.vibrato.delay ?? 0;
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(0, t + vd);
      depth.gain.linearRampToValueAtTime(o.vibrato.cents, t + vd + 0.25);
      lfo.connect(depth).connect(osc.detune);
      this.run(lfo, at, at + len);
    }
    this.run(osc, at, at + len);
    return at + len;
  }

  /** One of the bank's consistent noise transients, filtered. Returns its end time. */
  tap(o: { at?: number; gain?: number; filters?: FilterSpec[]; rate?: number; dest?: AudioNode }): number {
    const at = o.at ?? 0;
    const taps = this.noiseBank.taps;
    const src = this.ctx.createBufferSource();
    src.buffer = taps[Math.floor(rand(0, taps.length)) % taps.length];
    const rate = o.rate ?? rand(0.92, 1.08);
    src.playbackRate.value = rate;
    const g = this.gain(o.gain ?? 1);
    let head: AudioNode = src;
    for (const fs of o.filters ?? []) head = this.chain(head, this.filter(fs, at));
    head.connect(g);
    g.connect(o.dest ?? this.out);
    const len = src.buffer.duration / rate + 0.005;
    this.run(src, at, at + len);
    return at + len;
  }

  /** Filtered noise layer. `curve` (a grainCurve) replaces the envelope when given. */
  noise(o: {
    color?: NoiseColor;
    at?: number;
    env?: Env;
    curve?: Float32Array;
    curveDur?: number;
    gain?: number;
    filters?: FilterSpec[];
    rate?: number;
    dest?: AudioNode;
  }): number {
    const at = o.at ?? 0;
    const buf = this.noiseBank[o.color ?? 'pink'];
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (o.rate) src.playbackRate.value = o.rate;
    const g = this.gain(0);
    const t = this.at(at);
    let len: number;
    if (o.curve) {
      len = o.curveDur ?? 0.5;
      const k = o.gain ?? 1;
      const c = k === 1 ? o.curve : o.curve.map((v) => v * k);
      g.gain.setValueCurveAtTime(c, t, len);
      len += 0.002;
    } else {
      const env = o.env ?? { d: 0.1 };
      len = applyEnv(g.gain, t, { ...env, peak: (env.peak ?? 1) * (o.gain ?? 1) });
    }
    let head: AudioNode = src;
    for (const fs of o.filters ?? []) head = this.chain(head, this.filter(fs, at, len));
    head.connect(g);
    g.connect(o.dest ?? this.out);
    this.run(src, at, at + len, rand(0, buf.duration - 0.05));
    return at + len;
  }

  /**
   * Modal (additive) bank: sine partials at `f * ratio[i]` with independent
   * exponential decays — the backbone of coins, bells, wood and metal.
   */
  partials(o: {
    f: number;
    ratios: readonly number[];
    amps: readonly number[];
    decays: readonly number[];
    at?: number;
    gain?: number;
    attack?: number;
    /** Random per-partial ratio spread (fraction), keeps repeats from sounding identical. */
    spread?: number;
    dest?: AudioNode;
  }): number {
    const at = o.at ?? 0;
    let end = at;
    for (let i = 0; i < o.ratios.length; i++) {
      const fr = o.f * o.ratios[i] * (o.spread ? 1 + rand(-o.spread, o.spread) : 1);
      if (fr >= this.ctx.sampleRate * 0.45) continue;
      end = Math.max(end, this.tone({
        f: fr,
        at,
        gain: (o.gain ?? 1) * o.amps[i],
        env: { a: o.attack ?? 0.001, d: o.decays[i] },
        dest: o.dest,
      }));
    }
    return end;
  }

  /** Two-operator FM (sine carrier + sine modulator) with a decaying index for a bright-then-mellow strike. */
  fm(o: {
    f: number;
    ratio: number;
    index: number;
    index2?: number;
    indexTime?: number;
    at?: number;
    env: Env;
    gain?: number;
    dest?: AudioNode;
  }): number {
    const at = o.at ?? 0;
    const t = this.at(at);
    const car = this.ctx.createOscillator();
    car.frequency.value = o.f;
    const mod = this.ctx.createOscillator();
    mod.frequency.value = o.f * o.ratio;
    const idx = this.gain(0);
    const dev = o.index * o.f * o.ratio;
    idx.gain.setValueAtTime(dev, t);
    idx.gain.exponentialRampToValueAtTime(Math.max(1, (o.index2 ?? o.index * 0.1) * o.f * o.ratio), t + (o.indexTime ?? 0.3));
    mod.connect(idx).connect(car.frequency);
    const g = this.gain(0);
    const len = applyEnv(g.gain, t, { ...o.env, peak: (o.env.peak ?? 1) * (o.gain ?? 1) });
    car.connect(g).connect(o.dest ?? this.out);
    this.run(mod, at, at + len);
    this.run(car, at, at + len);
    return at + len;
  }

  /** Disconnect everything once the last source has finished. Call after scheduling all layers. */
  done(): void {
    const src = this.lastSource;
    const nodes = this.nodes;
    if (!src) {
      nodes.forEach((n) => n.disconnect());
      return;
    }
    src.onended = () => {
      for (const n of nodes) {
        try { n.disconnect(); } catch { /* already disconnected */ }
      }
      nodes.length = 0;
    };
  }
}
