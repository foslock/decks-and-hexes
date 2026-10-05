/**
 * Background music: a march heard from far off. Field drums keep a gentle
 * cadence over a bass drum on the strong beats, tenor drums join when it
 * swells, and rolls lead into new phrases. It is generated bar by bar, so it
 * never repeats the same way twice. (The bugle sounds with the phase banners,
 * not here.)
 *
 * Distance is the sound: everything runs into a long dark hall with only a
 * little dry signal, through a low-pass whose cutoff wanders with the level
 * (the wind bringing the band nearer, then taking it away) and a slow drift
 * across the stereo field.
 *
 *   voices ─> session dry ─> dry ──────────────────────────────┐
 *   voices ─> session wet ─> HPF ─> hall ─> LPF ─> return ─────┴> mix ─> HPF ─> distance LPF ─> drift pan ─> wind ─> comp ─> duck ─> volume ─> out
 *
 * Each start() opens a new session (its own dry/wet faders), so notes
 * already scheduled by a stopped session never sound when music restarts.
 */
import { createImpulseResponse, createNoiseBank, dbToGain, grainCurve, mulberry32, rand, setRandomSource, Voice, type Bus, type Ctx, type NoiseBank } from './synth';
import { drum } from './instruments';

const BPM = 92;
const BEAT = 60 / BPM;
const STEP = BEAT / 4;
const BAR = BEAT * 4;

/** Overall trim. Calibrated with offline renders: at volume 1 the march
 *  averages ≈ -30 LUFS (≈ -23 at its loudest moments), under the sound
 *  effects' ≈ -20 per hit. */
const MUSIC_TRIM_DB = 3;
/** Per-instrument levels (dB), mutable for audition and calibration. */
export const LEVELS = { bass: -21, snare: -14, roll: -8, tenor: -22 };

// ── Graph ──────────────────────────────────────────────────────────

export interface MusicGraph {
  ctx: Ctx;
  noise: NoiseBank;
  /** Session faders feed these. */
  dry: GainNode;
  send: GainNode;
  distance: BiquadFilterNode;
  drift: StereoPannerNode;
  wind: GainNode;
  duck: GainNode;
  volume: GainNode;
}

export function createMusicGraph(ctx: Ctx, destination: AudioNode = ctx.destination, noise: NoiseBank = createNoiseBank(ctx)): MusicGraph {
  const dry = ctx.createGain();
  dry.gain.value = 0.34;
  const send = ctx.createGain();
  const revHp = ctx.createBiquadFilter();
  revHp.type = 'highpass';
  revHp.frequency.value = 70;
  const hall = ctx.createConvolver();
  hall.normalize = false;
  hall.buffer = createImpulseResponse(ctx, { duration: 3.4, rt60: 2.5, predelay: 0.04 });
  const revLp = ctx.createBiquadFilter();
  revLp.type = 'lowpass';
  revLp.frequency.value = 3200;
  revLp.Q.value = 0.5;
  const ret = ctx.createGain();
  ret.gain.value = 0.9;
  const mix = ctx.createGain();
  mix.gain.value = dbToGain(MUSIC_TRIM_DB);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 40;
  hp.Q.value = 0.7;
  const distance = ctx.createBiquadFilter();
  distance.type = 'lowpass';
  distance.frequency.value = 1800;
  distance.Q.value = 0.4;
  const drift = ctx.createStereoPanner();
  const wind = ctx.createGain();
  wind.gain.value = 0.8;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24;
  comp.knee.value = 12;
  comp.ratio.value = 2.5;
  comp.attack.value = 0.02;
  comp.release.value = 0.4;
  const duck = ctx.createGain();
  const volume = ctx.createGain();

  dry.connect(mix);
  send.connect(revHp).connect(hall).connect(revLp).connect(ret).connect(mix);
  mix.connect(hp).connect(distance).connect(drift).connect(wind).connect(comp).connect(duck).connect(volume).connect(destination);
  return { ctx, noise, dry, send, distance, drift, wind, duck, volume };
}

// ── Instruments ────────────────────────────────────────────────────

/** Some of the hall, but enough of the direct sound to keep the beat crisp. */
const DRUM_REVERB = 0.6;

function hitVoice(bus: Bus, when: number, db: number, pan: number): Voice {
  return new Voice(bus, { when, gain: dbToGain(db), pan, reverb: DRUM_REVERB });
}

/** Field (snare) drum: a short skin body under a longer rattle of wires. */
function snare(bus: Bus, when: number, vel: number, pan: number) {
  const v = hitVoice(bus, when, LEVELS.snare, pan);
  v.tone({ f: 205 * rand(0.98, 1.02), f2: 178, glide: 0.03, gain: vel * 0.55, env: { a: 0.001, d: 0.09 } });
  v.noise({
    color: 'white', gain: vel,
    env: { a: 0.0012, d: 0.17 * rand(0.9, 1.1) },
    filters: [{ type: 'highpass', f: 850, q: 0.7 }, { type: 'peaking', f: 2400, q: 0.8, gain: 4 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  v.done();
}

/** Grace note just ahead of the stroke. */
function flam(bus: Bus, when: number, vel: number, pan: number) {
  snare(bus, when - 0.028, vel * 0.38, pan);
  snare(bus, when, vel, pan);
}

/** A press roll: dozens of strokes through one noise source, swelling from v0 to v1. */
function roll(bus: Bus, when: number, dur: number, v0: number, v1: number, pan: number) {
  const v = hitVoice(bus, when, LEVELS.roll, pan);
  const grains: { t: number; amp: number; dur: number }[] = [];
  const rate = 26;
  for (let t = 0; t < dur; t += 1 / rate) {
    const u = t / dur;
    grains.push({ t: t + rand(-0.004, 0.004), amp: (v0 + (v1 - v0) * u) * rand(0.75, 1), dur: rand(0.02, 0.03) });
  }
  const curve = grainCurve(grains, dur + 0.05);
  v.noise({
    color: 'white', curve, curveDur: dur + 0.05,
    filters: [{ type: 'highpass', f: 900, q: 0.7 }, { type: 'peaking', f: 2300, q: 0.8, gain: 4 }, { type: 'lowpass', f: 5500, q: 0.5 }],
  });
  v.noise({
    color: 'pink', curve, curveDur: dur + 0.05, gain: 0.5,
    filters: [{ type: 'bandpass', f: 220, q: 1.2 }],
  });
  v.done();
}

function bassDrum(bus: Bus, when: number, vel: number) {
  const v = hitVoice(bus, when, LEVELS.bass, 0);
  drum(v, { f: 56 * rand(0.98, 1.02), gain: vel, decay: 0.62, skin: 0.3, drive: 1.4 });
  v.done();
}

function tenor(bus: Bus, when: number, vel: number, f: number, pan: number) {
  const v = hitVoice(bus, when, LEVELS.tenor, pan);
  drum(v, { f, gain: vel, decay: 0.3, skin: 0.25, drive: 1.2 });
  v.done();
}

// ── Patterns ───────────────────────────────────────────────────────

/** 16 steps a bar. Snare: S accent, s stroke, g ghost, f flam, R roll from here to the bar's end. */
const SNARE: string[][] = [
  ['....s.......s...', '....s.......s.g.', '....g...s.......'],
  ['f...s.g.s...s.s.', 's.g.s.g.f.g.s...', 'f.s.s.s.f...s.s.', 'f...s.s.f...s.g.'],
  ['f.gss.g.f.gss.g.', 's.ssf.g.s.ssf...', 'f.s.sss.f.s.sss.'],
];
/** Bass drum: B strong, b soft. */
const BASS: string[][] = [
  ['B.......b.......', 'B...............'],
  ['B.......B.......', 'B.......b.......'],
  ['B.......B...b...', 'B.....b.B.......'],
];
/** Tenor drums at full swell: h high, m middle, l low. */
const TENOR = ['..........h.m...', '....h...m...l...', '..h.m.......h.l.'];
const TENOR_F: Record<string, number> = { h: 168, m: 138, l: 112 };
const FILLS = ['f.s.s.s.R.......', 's.g.s.g.f...R...', 'f...s...R.......'];

const pickOf = <T,>(arr: readonly T[]): T => arr[Math.floor(rand(0, arr.length)) % arr.length];
const human = () => rand(-0.006, 0.006);

export interface MarchState {
  bar: number;
  /** 0 sparse, 1 cadence, 2 full. */
  intensity: number;
  /** Whether the next bar's downbeat ends a roll (lands accented). */
  afterRoll: boolean;
}

export function newMarchState(): MarchState {
  return { bar: 0, intensity: 0, afterRoll: false };
}

/** Schedule one bar starting at `t0` (absolute) and advance the state. */
export function scheduleBar(bus: Bus, t0: number, st: MarchState): void {
  const phraseBar = st.bar % 4;
  if (phraseBar === 0 && st.bar > 0) {
    // New phrase: the band swells or settles a little.
    const r = rand();
    if (r < 0.3) st.intensity = Math.min(2, st.intensity + 1);
    else if (r < 0.55) st.intensity = Math.max(0, st.intensity - 1);
  }
  const lvl = st.intensity;
  const lastOfPhrase = phraseBar === 3;
  // An occasional bar with only the bass drum, when it's quiet.
  const hush = lvl === 0 && !lastOfPhrase && rand() < 0.15;
  const snarePat = lastOfPhrase && lvl >= 1 && rand() < 0.55 ? pickOf(FILLS) : pickOf(SNARE[lvl]);
  const bassPat = pickOf(BASS[lvl]);
  const tenorPat = lvl === 2 && rand() < 0.7 ? pickOf(TENOR) : null;
  const snarePan = -0.18;
  const tenorPan = 0.22;

  for (let i = 0; i < 16; i++) {
    const t = t0 + i * STEP;
    const b = bassPat[i];
    if (b === 'B') bassDrum(bus, t + human(), rand(0.85, 1));
    else if (b === 'b') bassDrum(bus, t + human(), rand(0.5, 0.65));
    if (tenorPat && TENOR_F[tenorPat[i]]) tenor(bus, t + human(), rand(0.5, 0.75), TENOR_F[tenorPat[i]], tenorPan);
    if (hush) continue;
    const s = snarePat[i];
    if (s === 'R') {
      roll(bus, t, (16 - i) * STEP, 0.3, 0.95, snarePan);
      break;
    }
    const accent = (i === 0 && st.afterRoll) ? 1 : 0;
    if (s === 'S' || accent) snare(bus, t + human(), rand(0.85, 1), snarePan);
    else if (s === 'f') flam(bus, t + human(), rand(0.8, 0.95), snarePan);
    else if (s === 's') snare(bus, t + human(), rand(0.5, 0.65), snarePan);
    else if (s === 'g') snare(bus, t + human(), rand(0.22, 0.32), snarePan);
  }
  st.afterRoll = snarePat.includes('R');
  st.bar++;
}

/** The wind: level, darkness and position drift together, bar by bar. */
export function scheduleWind(g: MusicGraph, t0: number): void {
  const near = rand(0.5, 1);
  g.wind.gain.setTargetAtTime(near, t0, BAR * 1.2);
  g.distance.frequency.setTargetAtTime(1100 + near * 1500, t0, BAR * 1.2);
  if (rand() < 0.35) g.drift.pan.setTargetAtTime(rand(-0.35, 0.35), t0, BAR * 2.5);
}

// ── Live player ────────────────────────────────────────────────────

interface Session { dry: GainNode; wet: GainNode; bus: Bus }

export class DistantMarch {
  private session: Session | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBar = 0;
  private state = newMarchState();

  constructor(private g: MusicGraph) {}

  get playing(): boolean { return this.session !== null; }

  setVolume(v: number) {
    const p = this.g.volume.gain;
    const now = this.g.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setTargetAtTime(Math.max(0, Math.min(1, v)), now, 0.015);
  }

  start(fadeIn = 4) {
    if (this.session) return;
    const ctx = this.g.ctx;
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.connect(this.g.dry);
    wet.connect(this.g.send);
    const now = ctx.currentTime;
    for (const f of [dry, wet]) {
      f.gain.setValueAtTime(0, now);
      f.gain.linearRampToValueAtTime(1, now + fadeIn);
    }
    this.session = { dry, wet, bus: { ctx, noise: this.g.noise, input: dry, send: wet } };
    this.state = newMarchState();
    this.nextBar = now + 0.1;
    this.pump();
    this.timer = setInterval(() => this.pump(), 250);
  }

  stop(fadeOut = 1.2) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = this.g.ctx.currentTime;
    for (const f of [s.dry, s.wet]) {
      f.gain.cancelScheduledValues(now);
      f.gain.setValueAtTime(f.gain.value, now);
      f.gain.linearRampToValueAtTime(0, now + fadeOut);
    }
    // Notes scheduled ahead play into a closed fader; cut them loose after.
    setTimeout(() => { s.dry.disconnect(); s.wet.disconnect(); }, (fadeOut + 0.2) * 1000);
  }

  /** Dip under a jingle for `seconds`, then come back. */
  duck(seconds: number, db = -14) {
    const p = this.g.duck.gain;
    const now = this.g.ctx.currentTime;
    p.cancelScheduledValues(now);
    p.setTargetAtTime(dbToGain(db), now, 0.08);
    p.setTargetAtTime(1, now + seconds, 0.6);
  }

  /** Keep about two seconds of bars scheduled ahead. */
  private pump() {
    const s = this.session;
    if (!s) return;
    const now = this.g.ctx.currentTime;
    // Fell behind (a suspended context, a stalled tab): pick up from now.
    if (this.nextBar < now) this.nextBar = now + 0.05;
    while (this.nextBar < now + 2) {
      try {
        scheduleBar(s.bus, this.nextBar, this.state);
        scheduleWind(this.g, this.nextBar);
      } catch (e) {
        console.warn('[music] failed to schedule a bar', e);
      }
      this.nextBar += BAR;
    }
  }
}

// ── Offline render (level calibration / audition) ──────────────────

export async function renderMarch(seconds: number, o: { seed?: number; sampleRate?: number; intensity?: number } = {}): Promise<AudioBuffer> {
  const sr = o.sampleRate ?? 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sr), sr);
  const g = createMusicGraph(ctx);
  const bus: Bus = { ctx, noise: g.noise, input: g.dry, send: g.send };
  const st = newMarchState();
  if (o.intensity !== undefined) st.intensity = o.intensity;
  if (o.seed !== undefined) setRandomSource(mulberry32(o.seed));
  try {
    for (let t = 0.05; t < seconds - 0.5; t += BAR) {
      if (o.intensity !== undefined) st.intensity = o.intensity;
      scheduleBar(bus, t, st);
      scheduleWind(g, t);
    }
  } finally {
    if (o.seed !== undefined) setRandomSource(null);
  }
  return ctx.startRendering();
}
