/**
 * Reusable "instruments" built on the synth toolkit. Each schedules layers on
 * a Voice at a voice-relative time and returns the time its last layer ends.
 *
 * Palette: paper/felt (cards), wood (markers, rams), skin (war drums,
 * timpani), metal (coins, shields, blades), brass + strings (heraldic jingles).
 */
import { applyEnv, grainCurve, rand, type NoiseColor, type Voice } from './synth';

// ── Paper / felt ───────────────────────────────────────────────────

/** Band-passed noise sweep — paper slide, toss, weapon swing. */
export function swish(v: Voice, o: {
  at?: number; gain?: number; from: number; to: number; dur: number;
  q?: number; attack?: number; hp?: number; lp?: number; color?: NoiseColor; attackCurve?: 'lin' | 'exp';
}): number {
  const attack = o.attack ?? 0.02;
  return v.noise({
    color: o.color ?? 'pink',
    at: o.at,
    gain: o.gain ?? 1,
    env: { a: attack, d: o.dur, attackCurve: o.attackCurve },
    filters: [
      { type: 'highpass', f: o.hp ?? 300, q: 0.7 },
      { type: 'bandpass', f: o.from, f2: o.to, sweep: attack + o.dur * 0.6, q: o.q ?? 0.9 },
      { type: 'lowpass', f: o.lp ?? 6000, q: 0.5 },
    ],
  });
}

/** Soft card-on-felt landing: dull noise puff plus a tiny low body. */
export function feltTap(v: Voice, o: { at?: number; gain?: number; f?: number; body?: number; bodyF?: number; decay?: number } = {}): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const bodyF = o.bodyF ?? 150;
  let end = v.tap({ at, gain: gain * 0.4, rate: rand(0.9, 1.1) * (0.05 / (o.decay ?? 0.05)), filters: [{ type: 'lowpass', f: o.f ?? 1100, q: 0.7 }] });
  const body = o.body ?? 0.35;
  if (body > 0) {
    end = Math.max(end, v.tone({ f: bodyF * 1.3, f2: bodyF * 0.8, glide: 0.05, at, gain: body * gain, env: { a: 0.0015, d: 0.07 } }));
  }
  return end;
}

/** Build a list of grains for grainCurve(). `shape(u)` gives the amplitude envelope over 0..1. */
export function scatter(count: number, total: number, o: {
  shape?: (u: number) => number; warp?: (u: number) => number; durMin?: number; durMax?: number; ampMin?: number;
} = {}): { t: number; amp: number; dur: number }[] {
  const out: { t: number; amp: number; dur: number }[] = [];
  for (let k = 0; k < count; k++) {
    const u = count === 1 ? 0 : k / (count - 1);
    const jittered = Math.min(1, Math.max(0, u + rand(-0.4, 0.4) / count));
    const t = (o.warp ? o.warp(jittered) : jittered) * total;
    out.push({
      t,
      amp: (o.shape ? o.shape(u) : 1) * rand(o.ampMin ?? 0.5, 1),
      dur: rand(o.durMin ?? 0.002, o.durMax ?? 0.005),
    });
  }
  return out;
}

/** Crackle layer: dozens of noise grains through one source + one gain. */
export function crackle(v: Voice, o: {
  at?: number; gain?: number; grains: { t: number; amp: number; dur: number }[]; total: number;
  color?: NoiseColor; filters: { type: BiquadFilterType; f: number; f2?: number; q?: number }[];
}): number {
  const curve = grainCurve(o.grains, o.total);
  return v.noise({ color: o.color ?? 'white', at: o.at, curve, curveDur: o.total, gain: o.gain ?? 1, filters: o.filters });
}

// ── Wood / skin ────────────────────────────────────────────────────

/** Modal wood knock (plank / marker / woodblock). */
export function woodKnock(v: Voice, o: { f: number; at?: number; gain?: number; decay?: number; click?: number; bright?: number }): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const d = o.decay ?? 0.08;
  const b = o.bright ?? 1;
  let end = v.partials({
    f: o.f, at, gain,
    ratios: [1, 2.32, 4.25],
    amps: [1, 0.42 * b, 0.16 * b],
    decays: [d, d * 0.55, d * 0.3],
    spread: 0.012,
  });
  const click = o.click ?? 0.3;
  if (click > 0) {
    end = Math.max(end, v.noise({
      color: 'pink', at, gain: gain * click,
      env: { a: 0.0005, d: 0.01 },
      filters: [{ type: 'highpass', f: 1600, q: 0.7 }, { type: 'lowpass', f: 6000, q: 0.5 }],
    }));
  }
  return end;
}

/** War drum: pitched membrane thump (saturated so it reads on laptop speakers) + skin noise. */
export function drum(v: Voice, o: { f?: number; at?: number; gain?: number; decay?: number; skin?: number; drive?: number; snap?: number }): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const f = o.f ?? 90;
  const d = o.decay ?? 0.35;
  let end = v.tone({ f: f * 1.7, f2: f, glide: 0.035, at, gain, env: { a: 0.001, d }, drive: o.drive ?? 2 });
  end = Math.max(end, v.tone({ f: f * 1.59 * 1.3, f2: f * 1.59, glide: 0.03, at, gain: gain * 0.3, env: { a: 0.001, d: d * 0.4 } }));
  end = Math.max(end, v.noise({
    color: 'brown', at, gain: gain * (o.skin ?? 0.4),
    env: { a: 0.001, d: 0.06 },
    filters: [{ type: 'lowpass', f: 850, q: 0.7 }, { type: 'highpass', f: 90, q: 0.7 }],
  }));
  if (o.snap) {
    end = Math.max(end, v.noise({
      color: 'pink', at, gain: gain * o.snap,
      env: { a: 0.0005, d: 0.016 },
      filters: [{ type: 'highpass', f: 1400, q: 0.7 }, { type: 'lowpass', f: 5000, q: 0.5 }],
    }));
  }
  return end;
}

/** Orchestral timpani: near-harmonic membrane modes with a slight pitch settle. */
export function timpani(v: Voice, o: { f: number; at?: number; gain?: number; decay?: number }): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const d = o.decay ?? 1.2;
  let end = v.tone({ f: o.f * 1.035, f2: o.f, glide: 0.09, at, gain, env: { a: 0.002, d }, drive: 1.3 });
  end = Math.max(end, v.partials({
    f: o.f, at, gain,
    ratios: [1.504, 1.742, 2.0, 2.245],
    amps: [0.45, 0.18, 0.28, 0.12],
    decays: [d * 0.7, d * 0.45, d * 0.5, d * 0.35],
    attack: 0.002,
  }));
  end = Math.max(end, v.noise({
    color: 'brown', at, gain: gain * 0.5,
    env: { a: 0.001, d: 0.07 },
    filters: [{ type: 'lowpass', f: 1000, q: 0.7 }],
  }));
  return end;
}

/** Sub "thump" with pitch drop + saturation — the low layer of every impact. */
export function thump(v: Voice, o: { f: number; f2: number; drop?: number; at?: number; gain?: number; decay?: number; drive?: number }): number {
  return v.tone({ f: o.f, f2: o.f2, glide: o.drop ?? 0.06, at: o.at, gain: o.gain ?? 1, env: { a: 0.001, d: o.decay ?? 0.3 }, drive: o.drive ?? 2.2 });
}

// ── Metal ──────────────────────────────────────────────────────────

/** Resonant shield/plate clang: inharmonic modes, beating twins on the low modes, strike noise. */
export function clang(v: Voice, o: { f: number; at?: number; gain?: number; decay?: number; bright?: number; strike?: number; dest?: AudioNode }): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const d = o.decay ?? 0.6;
  const b = o.bright ?? 1;
  let end = v.partials({
    f: o.f, at, gain, dest: o.dest,
    ratios: [1, 1.47, 2.09, 2.56, 3.24, 4.17],
    amps: [1, 0.72, 0.5, 0.36, 0.24 * b, 0.15 * b],
    decays: [d, d * 0.85, d * 0.68, d * 0.52, d * 0.4, d * 0.3],
    spread: 0.006,
  });
  // Detuned twins give the slow shimmer/beating of real metal.
  end = Math.max(end, v.partials({
    f: o.f * 1.0045, at, gain: gain * 0.5, dest: o.dest,
    ratios: [1, 1.47],
    amps: [1, 0.6],
    decays: [d * 1.1, d * 0.9],
  }));
  const strike = o.strike ?? 0.5;
  if (strike > 0) {
    end = Math.max(end, v.noise({
      color: 'white', at, gain: gain * strike * 0.35, dest: o.dest,
      env: { a: 0.0005, d: 0.014 },
      filters: [{ type: 'bandpass', f: Math.min(6000, o.f * 6), q: 0.8 }, { type: 'lowpass', f: 7500, q: 0.5 }],
    }));
    end = Math.max(end, v.noise({
      color: 'brown', at, gain: gain * strike, dest: o.dest,
      env: { a: 0.001, d: 0.05 },
      filters: [{ type: 'lowpass', f: 900, q: 0.7 }],
    }));
  }
  return end;
}

/** A single small gold coin: bright inharmonic partials with fast decay and a tiny tick. */
export function coin(v: Voice, o: { f: number; at?: number; gain?: number; decay?: number; dest?: AudioNode }): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const k = o.decay ?? 1;
  let end = v.partials({
    f: o.f, at, gain, dest: o.dest,
    ratios: [1, 1.53, 2.27, 2.94, 3.62],
    amps: [0.8, 0.62, 0.48, 0.3, 0.18],
    decays: [0.18 * k, 0.14 * k, 0.1 * k, 0.065 * k, 0.045 * k],
    spread: 0.015,
    attack: 0.0006,
  });
  end = Math.max(end, v.noise({
    color: 'white', at, gain: gain * 0.28, dest: o.dest,
    env: { a: 0.0004, d: 0.004 },
    filters: [{ type: 'highpass', f: 4500, q: 0.7 }, { type: 'lowpass', f: 11000, q: 0.5 }],
  }));
  return end;
}

/** Glassy FM bell with a pure sine body underneath. */
export function bell(v: Voice, o: { f: number; at?: number; gain?: number; decay?: number; ratio?: number; index?: number; dest?: AudioNode }): number {
  const at = o.at ?? 0;
  const gain = o.gain ?? 1;
  const d = o.decay ?? 1;
  let end = v.fm({
    f: o.f, ratio: o.ratio ?? 3.5, index: o.index ?? 1.4, index2: 0.08, indexTime: d * 0.5,
    at, gain: gain * 0.6, env: { a: 0.0015, d: d * 0.8 }, dest: o.dest,
  });
  end = Math.max(end, v.tone({ f: o.f, at, gain: gain * 0.5, env: { a: 0.002, d }, dest: o.dest }));
  return end;
}

// ── Brass & strings (heraldic jingles) ─────────────────────────────

/**
 * Brass-section note: detuned saw stack through a low-pass whose cutoff
 * blooms on the attack (the "blat"), a small pitch scoop, and delayed vibrato.
 */
export function brass(v: Voice, o: {
  f: number; at?: number; dur: number; gain?: number; bright?: number; voices?: number; cents?: number;
  attack?: number; release?: number; vibrato?: boolean; dest?: AudioNode;
}): number {
  const ctx = v.ctx;
  const at = o.at ?? 0;
  const t = v.at(at);
  const n = o.voices ?? 3;
  const cents = o.cents ?? 7;
  const attack = o.attack ?? 0.04;
  const release = o.release ?? 0.25;
  const bright = o.bright ?? 6;
  const hold = Math.max(0, o.dur - attack - 0.12);

  const lp = v.reg(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.Q.value = 1.0;
  const fPeak = Math.min(12000, o.f * bright);
  const fBody = Math.min(9000, o.f * bright * 0.62);
  lp.frequency.setValueAtTime(o.f * 1.2, t);
  lp.frequency.linearRampToValueAtTime(fPeak, t + attack * 1.3);
  lp.frequency.exponentialRampToValueAtTime(fBody, t + attack + 0.25);
  lp.frequency.setValueAtTime(fBody, t + attack + 0.12 + hold);
  lp.frequency.exponentialRampToValueAtTime(Math.max(80, o.f * 1.1), t + attack + 0.12 + hold + release);

  const amp = v.gain(0);
  const len = applyEnv(amp.gain, t, { a: attack, d: 0.12, s: 0.78, hold, r: release, peak: (o.gain ?? 1) / Math.sqrt(n) });
  lp.connect(amp).connect(o.dest ?? v.out);

  let vib: GainNode | null = null;
  if (o.vibrato !== false) {
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rand(5.0, 5.6);
    vib = v.gain(0);
    vib.gain.setValueAtTime(0, t);
    vib.gain.linearRampToValueAtTime(0, t + 0.18);
    vib.gain.linearRampToValueAtTime(7, t + 0.45);
    lfo.connect(vib);
    v.run(lfo, at, at + len);
  }
  for (let i = 0; i < n; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = o.f;
    const base = n === 1 ? 0 : (i / (n - 1) * 2 - 1) * cents;
    osc.detune.setValueAtTime(base - 28, t);
    osc.detune.linearRampToValueAtTime(base, t + 0.05);
    osc.connect(lp);
    if (vib) vib.connect(osc.detune);
    v.run(osc, at + rand(0, 0.006), at + len);
  }
  return at + len;
}

/** String-section pad: pairs of detuned saws per pitch, soft low-pass, slow swell. */
export function strings(v: Voice, o: {
  freqs: readonly number[]; at?: number; dur: number; gain?: number; attack?: number; release?: number; cutoff?: number; dest?: AudioNode;
}): number {
  const ctx = v.ctx;
  const at = o.at ?? 0;
  const t = v.at(at);
  const attack = o.attack ?? 0.3;
  const release = o.release ?? 0.7;
  const lp = v.reg(ctx.createBiquadFilter());
  lp.type = 'lowpass';
  lp.frequency.value = o.cutoff ?? 2000;
  lp.Q.value = 0.5;
  const amp = v.gain(0);
  const len = applyEnv(amp.gain, t, {
    a: attack, d: 0.05, s: 0.95, hold: Math.max(0, o.dur - attack - 0.05), r: release,
    peak: (o.gain ?? 1) / Math.sqrt(o.freqs.length * 2),
  });
  lp.connect(amp).connect(o.dest ?? v.out);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 4.6;
  const vib = v.gain(5);
  lfo.connect(vib);
  v.run(lfo, at, at + len);
  for (const f of o.freqs) {
    for (const c of [-8, 8]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      osc.detune.value = c + rand(-2, 2);
      osc.connect(lp);
      vib.connect(osc.detune);
      v.run(osc, at, at + len);
    }
  }
  return at + len;
}

/** Soft cymbal-like swell (high noise only, never harsh): used under jingle finales. */
export function shimmerSwell(v: Voice, o: { at?: number; gain?: number; rise: number; decay: number }): number {
  return v.noise({
    color: 'pink', at: o.at, gain: o.gain ?? 1,
    env: { a: o.rise, d: o.decay, attackCurve: 'exp' },
    filters: [{ type: 'highpass', f: 5200, q: 0.6 }, { type: 'lowpass', f: 11000, q: 0.5 }],
  });
}

/** Note-name helper for jingles (A4 = 440). */
export function note(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const base: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const n = base[m[1]] + acc + (parseInt(m[3], 10) - 4) * 12;
  return 440 * Math.pow(2, n / 12);
}
