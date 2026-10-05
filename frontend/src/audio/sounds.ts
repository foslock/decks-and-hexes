/**
 * Sound recipes for Card Clash.
 *
 * Palette
 *  - Cards: paper and felt. Soft, tactile, short tails (they repeat a lot).
 *  - Economy: gold coins (inharmonic metal partials) dropping into a leather purse.
 *  - Magic: FM glass bells and rising air for upgrades.
 *  - Board / claims: martial. Banner snaps, war drums, shield clangs, blades.
 *  - Base raids: heavy wood (ram), stone and debris (shatter), resonant shields (hold).
 *  - Jingles: short heraldic brass + string motifs with timpani.
 *
 * Every recipe takes the master Bus and an optional absolute start time so
 * it can render live or offline. Levels are in dB and were calibrated with
 * offline renders to a common short-term loudness (see LEVELS).
 */
import { dbToGain, jitter, pick, rand, randInt, semi, variant, Voice, type Bus } from './synth';
import { bell, brass, bugle, clang, coin, crackle, drum, feltTap, note, scatter, shimmerSwell, strings, swish, thump, timpani, woodKnock } from './instruments';

export const CORE_SOUND_NAMES = [
  'cardDraw', 'cardPlay', 'cardDiscard', 'cardTrash', 'cardPurchase', 'tileSelect',
  'countdownTick', 'countdownGo', 'buttonClick', 'deckShuffle', 'victoryJingle', 'defeatJingle',
  'resolveDefenseFortify', 'resolveTileOccupied', 'resolveContested', 'resolveBaseRaidFortify',
  'resolveBaseRaidRam', 'resolveBaseRaidShatter', 'resolveBaseRaidHold', 'upgradeCharge', 'upgradeCard', 'beginJingle',
  'heroWhoosh', 'swordClash', 'tilePop', 'phaseCall3', 'phaseCall4', 'phaseCall5',
] as const;

/** Optional extras (available on the engine + hook, not yet wired into components). */
export const EXTRA_SOUND_NAMES = ['hoverTick', 'coinSpend', 'vpGain', 'phaseChange', 'invalidAction'] as const;

/** A claim smashing into a tile's defense, one per power level (0 … 8+). */
export const SMASH_SOUND_NAMES = [
  'claimSmash0', 'claimSmash1', 'claimSmash2', 'claimSmash3', 'claimSmash4',
  'claimSmash5', 'claimSmash6', 'claimSmash7', 'claimSmash8',
] as const;

export type CoreSoundName = typeof CORE_SOUND_NAMES[number];
export type ExtraSoundName = typeof EXTRA_SOUND_NAMES[number];
export type SmashSoundName = typeof SMASH_SOUND_NAMES[number];
export type SoundName = CoreSoundName | ExtraSoundName | SmashSoundName;

/** The smash for a claim of this power (8 and up share the biggest). */
export function smashSoundName(power: number): SmashSoundName {
  const i = Math.max(0, Math.min(SMASH_SOUND_NAMES.length - 1, Math.round(power)));
  return SMASH_SOUND_NAMES[i];
}

/**
 * Output level per sound (dB). Calibrated so that at volume 1.0 the K-weighted
 * 100 ms peak loudness is ≈ -20 LU for gameplay SFX, ≈ -27 for UI ticks and
 * ≈ -16 for jingles.
 */
const LEVELS: Record<SoundName, number> = {
  cardDraw: 4.8,
  cardPlay: -0.4,
  cardDiscard: 5.1,
  cardTrash: -4.3,
  cardPurchase: -12.4,
  tileSelect: -4.9,
  countdownTick: -6.3,
  countdownGo: -9.5,
  buttonClick: -7.1,
  deckShuffle: 9.0,
  victoryJingle: -13.9,
  defeatJingle: -11.5,
  resolveDefenseFortify: -11.7,
  resolveTileOccupied: -6.2,
  resolveContested: -12.6,
  resolveBaseRaidFortify: -13.0,
  resolveBaseRaidRam: -11.2,
  resolveBaseRaidShatter: -12.9,
  resolveBaseRaidHold: -14.7,
  upgradeCharge: -13,
  upgradeCard: -12.5,
  beginJingle: -9.7,
  heroWhoosh: -10,
  swordClash: -14,
  tilePop: -6,
  phaseCall3: -11.1,
  phaseCall4: -11.2,
  phaseCall5: -11.7,
  hoverTick: -9.9,
  coinSpend: -11.6,
  vpGain: -9.6,
  phaseChange: -3.2,
  invalidAction: -3.9,
  // The smashes climb on purpose: ≈ -27 LU for a 0 up to ≈ -16 LU at 8+.
  claimSmash0: -4.4,
  claimSmash1: -7.2,
  claimSmash2: -10.4,
  claimSmash3: -14.3,
  claimSmash4: -14.1,
  claimSmash5: -16.5,
  claimSmash6: -14.0,
  claimSmash7: -12.4,
  claimSmash8: -15.8,
};

type Recipe = (bus: Bus, when?: number) => void;

function voice(bus: Bus, when: number | undefined, name: SoundName, o: { vary?: number; pan?: number; reverb?: number } = {}): Voice {
  const vary = o.vary ?? 0;
  return new Voice(bus, {
    when,
    gain: dbToGain(LEVELS[name] + (vary ? rand(-vary, vary) : 0)),
    pan: o.pan ?? 0,
    reverb: o.reverb ?? 0,
  });
}

// ── Cards ──────────────────────────────────────────────────────────

/** Card slides off the deck ("fwip") and settles softly in hand. */
const cardDraw: Recipe = (bus, when) => {
  const k = variant('cardDraw', 4);
  const c = [1150, 1350, 1550, 1250][k] * jitter(1, 0.08);
  const v = voice(bus, when, 'cardDraw', { vary: 0.7, pan: rand(-0.25, 0.25), reverb: 0.1 });
  const dur = jitter(0.085, 0.12);
  swish(v, { from: c * 0.7, to: c * 1.3, dur, attack: jitter(0.022, 0.2), q: 0.8, hp: 450, lp: 4800 });
  feltTap(v, { at: 0.05 + dur * 0.35 + rand(0, 0.01), gain: 0.35, f: 1300, body: 0.1, bodyF: 210 });
  v.done();
};

/** Short air swish, then the card is laid flat on the felt with a soft wooden table knock. */
const cardPlay: Recipe = (bus, when) => {
  const v = voice(bus, when, 'cardPlay', { vary: 1, pan: rand(-0.15, 0.15), reverb: 0.14 });
  swish(v, { from: 1400, to: 800, dur: 0.035, attack: 0.022, q: 0.8, gain: 0.35, attackCurve: 'exp' });
  const hit = 0.026;
  v.noise({
    color: 'pink', at: hit, env: { a: 0.001, d: 0.07 },
    filters: [{ type: 'highpass', f: 150, q: 0.7 }, { type: 'lowpass', f: jitter(2600, 0.1), f2: 1100, sweep: 0.05, q: 0.6 }],
  });
  thump(v, { f: jitter(190, 0.05), f2: 110, drop: 0.05, at: hit, gain: 0.4, decay: 0.12, drive: 1.6 });
  woodKnock(v, { f: pick([230, 255, 280]), at: hit, gain: 0.35, decay: 0.09, click: 0 });
  v.done();
};

/** Card tossed onto the discard pile: airy flick down, soft landing. */
const cardDiscard: Recipe = (bus, when) => {
  const v = voice(bus, when, 'cardDiscard', { vary: 0.7, pan: rand(0, 0.3), reverb: 0.1 });
  swish(v, { from: jitter(2300, 0.1), to: 850, dur: jitter(0.11, 0.1), attack: 0.03, q: 1.0, hp: 400, lp: 5000, gain: 0.8 });
  feltTap(v, { at: 0.1 + rand(0, 0.015), gain: 0.5, f: 1000, body: 0.12, bodyF: 190 });
  v.done();
};

/** Paper rip (dense crackle grains) with a dark "poof" — the card is gone for good. */
const cardTrash: Recipe = (bus, when) => {
  const v = voice(bus, when, 'cardTrash', { vary: 0.8, pan: rand(-0.15, 0.15), reverb: 0.14 });
  const total = jitter(0.24, 0.1);
  const g = scatter(70, total, { shape: (u) => Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + u)), 0.6), durMin: 0.0015, durMax: 0.005, ampMin: 0.3 });
  crackle(v, {
    grains: g, total, color: 'white', gain: 0.75,
    filters: [{ type: 'highpass', f: 600, q: 0.7 }, { type: 'bandpass', f: 1500, f2: 2500, q: 0.7 }, { type: 'lowpass', f: 5000, q: 0.5 }],
  });
  swish(v, { from: 1300, to: 2400, dur: 0.17, attack: 0.03, q: 0.6, gain: 0.25, hp: 600, lp: 5000 });
  v.noise({ color: 'brown', at: 0.06, gain: 0.6, env: { a: 0.02, d: 0.35 }, filters: [{ type: 'lowpass', f: 650, f2: 220, sweep: 0.3, q: 0.7 }] });
  thump(v, { f: 170, f2: 60, drop: 0.25, at: 0.05, gain: 0.35, decay: 0.32, drive: 2 });
  v.done();
};

/** 3–4 gold coins cascade (each panned and pitched differently) into a leather purse. */
const cardPurchase: Recipe = (bus, when) => {
  const v = voice(bus, when, 'cardPurchase', { vary: 0.8, reverb: 0.12 });
  const n = randInt(3, 4);
  let t = 0;
  for (let i = 0; i < n; i++) {
    coin(v, {
      f: rand(1900, 2800), at: t,
      gain: (i === 0 ? 1 : rand(0.55, 0.85)) * Math.pow(0.88, i),
      decay: 1 - i * 0.15,
      dest: v.bus(1, rand(-0.35, 0.35)),
    });
    t += rand(0.035, 0.07) * (1 - i * 0.1);
  }
  const land = t + 0.01;
  v.noise({ color: 'brown', at: land, gain: 0.55, env: { a: 0.004, d: 0.12 }, filters: [{ type: 'lowpass', f: 750, f2: 350, sweep: 0.1, q: 0.7 }] });
  thump(v, { f: 140, f2: 85, drop: 0.06, at: land, gain: 0.25, decay: 0.1, drive: 1.5 });
  v.noise({ color: 'pink', at: land, gain: 0.18, env: { a: 0.002, d: 0.06 }, filters: [{ type: 'bandpass', f: 900, q: 0.7 }] });
  coin(v, { f: rand(1700, 2200), at: land + 0.015, gain: 0.25, decay: 0.35 });
  v.done();
};

/** Riffle (one noise source carrying ~44 card flaps), bridge cascade, two squaring taps on the felt. */
const deckShuffle: Recipe = (bus, when) => {
  const v = voice(bus, when, 'deckShuffle', { vary: 0.5, reverb: 0.1 });
  const p = v.panner.pan;
  p.setValueAtTime(-0.2, v.at(0));
  p.linearRampToValueAtTime(0.2, v.at(0.55));
  p.linearRampToValueAtTime(0, v.at(0.9));
  const T = 0.55;
  const flaps = scatter(44, T, {
    shape: (u) => Math.pow(Math.sin(Math.PI * (0.1 + 0.85 * u)), 0.6),
    warp: (u) => u + (0.5 / (2 * Math.PI)) * Math.sin(2 * Math.PI * u),
    durMin: 0.002, durMax: 0.0045, ampMin: 0.55,
  });
  crackle(v, {
    grains: flaps, total: T, color: 'pink', gain: 0.8,
    filters: [{ type: 'highpass', f: 900, q: 0.7 }, { type: 'bandpass', f: 2600, q: 0.6 }, { type: 'lowpass', f: 5500, q: 0.5 }],
  });
  crackle(v, { grains: flaps, total: T, color: 'brown', gain: 0.6, filters: [{ type: 'lowpass', f: 900, q: 0.7 }] });
  swish(v, { from: 1800, to: 2400, dur: 0.4, attack: 0.12, q: 0.5, gain: 0.12, hp: 700, lp: 5000 });
  const B0 = 0.6;
  const BT = 0.32;
  crackle(v, {
    at: B0, grains: scatter(26, BT, { shape: (u) => Math.pow(1 - u, 0.7), durMin: 0.0015, durMax: 0.003, ampMin: 0.3 }),
    total: BT, color: 'pink', gain: 0.45,
    filters: [{ type: 'highpass', f: 1200, q: 0.7 }, { type: 'lowpass', f: 5000, q: 0.5 }],
  });
  swish(v, { at: B0 - 0.04, from: 2200, to: 900, dur: 0.25, attack: 0.08, q: 0.6, gain: 0.35, hp: 400, lp: 5000 });
  feltTap(v, { at: 1.0, gain: 0.35, f: 1200, body: 0.3, bodyF: 170 });
  feltTap(v, { at: 1.12, gain: 0.25, f: 1100, body: 0.25, bodyF: 160 });
  v.done();
};

/** Rising air + ascending glass-bell arpeggio + shimmering bloom. */
/**
 * Holding the upgrade badge: power gathering for 1.5 s (the hold) — a tone
 * climbing two octaves as it swells, an airy rush opening up, and a run of
 * glassy plinks quickening upward. Played held (SoundEngine.playHeld), so
 * letting go early fades it out.
 */
const upgradeCharge: Recipe = (bus, when) => {
  const v = voice(bus, when, 'upgradeCharge', { vary: 0.3, reverb: 0.35 });
  const T = 1.5;
  const grow = { a: T - 0.05, d: 0.05, s: 1, hold: 0, r: 0.12, attackCurve: 'exp' as const };
  v.tone({ f: note('G3'), f2: note('G5'), glide: T, gain: 0.32, env: grow, vibrato: { rate: 5.5, cents: 16, delay: 0.5 } });
  v.tone({ type: 'triangle', f: note('D4'), f2: note('D6'), glide: T, gain: 0.1, env: grow, detune: 6 });
  v.noise({
    color: 'pink', gain: 0.3, env: grow,
    filters: [{ type: 'bandpass', f: 500, f2: 5200, sweep: T, q: 1.4 }, { type: 'lowpass', f: 9000, q: 0.5 }],
  });
  shimmerSwell(v, { gain: 0.22, rise: T - 0.1, decay: 0.2 });
  // Plinks climbing a G-major pentatonic, coming faster as the hold fills.
  const run = ['G5', 'A5', 'B5', 'D6', 'E6', 'G6', 'A6', 'B6', 'D7', 'E7'];
  run.forEach((n, i) => {
    const u = i / run.length;
    const at = T * (1 - Math.pow(1 - u, 1.7)) * 0.96;
    bell(v, { f: note(n), at, gain: 0.16 + 0.16 * u, decay: 0.28, ratio: 3, index: 0.8, dest: v.bus(1, -0.4 + 0.8 * u) });
  });
  v.done();
};

/**
 * The card is upgraded: a warm thump and crack, a G-major chord blooming in
 * glass bells over a short brass "ta-da", a shower of gold glints, and a
 * shimmering tail.
 */
const upgradeCard: Recipe = (bus, when) => {
  const v = voice(bus, when, 'upgradeCard', { vary: 0.4, reverb: 0.45 });
  thump(v, { f: 130, f2: 55, drop: 0.12, gain: 0.55, decay: 0.38, drive: 2 });
  v.noise({ color: 'white', gain: 0.35, env: { a: 0.0005, d: 0.05 }, filters: [{ type: 'highpass', f: 1800, q: 0.7 }, { type: 'lowpass', f: 10000, q: 0.5 }] });
  ['G5', 'B5', 'D6', 'G6', 'B6'].forEach((n, i) => {
    bell(v, { f: note(n), at: i * 0.018, gain: 0.5 - i * 0.05, decay: 1.4, ratio: 3, index: 1.1, dest: v.bus(1, -0.5 + i * 0.25) });
  });
  ['G3', 'D4', 'G4', 'B4'].forEach((n, i) => {
    brass(v, { f: note(n), at: 0.01 + i * 0.008, dur: 0.42, gain: 0.2, bright: 6, attack: 0.02, release: 0.45, voices: 2 });
  });
  // Gold glints scattered over the first second, thinning out.
  for (let i = 0; i < 14; i++) {
    const at = Math.pow(rand(0, 1), 1.8) * 0.9;
    coin(v, { f: rand(2400, 5200), at: 0.04 + at, gain: 0.22 * (1 - at), decay: 0.5, dest: v.bus(1, rand(-0.7, 0.7)) });
  }
  v.tone({ f: note('G6'), at: 0.08, gain: 0.12, env: { a: 0.08, d: 1.2 }, vibrato: { rate: 6.5, cents: 14 } });
  v.tone({ type: 'triangle', f: note('G3'), gain: 0.12, env: { a: 0.02, d: 1.3 } });
  shimmerSwell(v, { at: 0.02, gain: 0.3, rise: 0.04, decay: 1.4 });
  v.done();
};

// ── Board / UI ─────────────────────────────────────────────────────

/** Small wooden marker tapped onto the map. */
const tileSelect: Recipe = (bus, when) => {
  const k = variant('tileSelect', 3);
  const f = [540, 580, 620][k] * semi(rand(-0.25, 0.25));
  const v = voice(bus, when, 'tileSelect', { vary: 1, pan: rand(-0.1, 0.1), reverb: 0.08 });
  woodKnock(v, { f, decay: 0.06, click: 0.35, bright: 0.9 });
  v.tone({ f: 230, f2: 170, glide: 0.04, gain: 0.25, env: { a: 0.001, d: 0.04 } });
  v.done();
};

/** Subtle UI tick. */
const buttonClick: Recipe = (bus, when) => {
  const v = voice(bus, when, 'buttonClick', { vary: 0.8, reverb: 0.02 });
  v.partials({ f: 1500 * semi(rand(-0.3, 0.3)), ratios: [1, 2.1], amps: [1, 0.25], decays: [0.022, 0.012], attack: 0.0006 });
  v.noise({ color: 'pink', gain: 0.25, env: { a: 0.0004, d: 0.005 }, filters: [{ type: 'highpass', f: 2500, q: 0.7 }, { type: 'lowpass', f: 7000, q: 0.5 }] });
  v.tone({ f: 380, f2: 300, glide: 0.02, gain: 0.3, env: { a: 0.001, d: 0.02 } });
  v.done();
};

/** War-drum hit with a woodblock on top. */
const countdownTick: Recipe = (bus, when) => {
  const v = voice(bus, when, 'countdownTick', { vary: 0.3, reverb: 0.16 });
  drum(v, { f: 125, gain: 0.6, decay: 0.26, skin: 0.4, drive: 1.8, snap: 0.25 });
  woodKnock(v, { f: 880 * semi(rand(-0.1, 0.1)), gain: 0.7, decay: 0.07, click: 0.25 });
  v.done();
};

/** The bugle's G2 harmonics: × 3 = D4, × 4 = G4, × 6 = D5. */
const BUGLE_G = 98;

/** Countdown over, the game is on: a bugle's "ta-ta-taaa" (G4 G4 D5) over a bass drum. */
const countdownGo: Recipe = (bus, when) => {
  const v = voice(bus, (when ?? bus.ctx.currentTime) + 0.06, 'countdownGo', { reverb: 0.32 });
  bugle(v, { f: BUGLE_G * 4, dur: 0.11, gain: 0.8, vibrato: false });
  bugle(v, { f: BUGLE_G * 4, at: 0.14, dur: 0.11, gain: 0.8, vibrato: false, scoop: 20 });
  bugle(v, { f: BUGLE_G * 6, at: 0.28, dur: 0.75 });
  drum(v, { f: 60, at: 0.28, gain: 0.6, decay: 0.55, skin: 0.35, drive: 1.6 });
  v.done();
};

/**
 * A phase banner sweeping in: the bugle flicks up from a grace note on the 1
 * (G4) to a held 3, 4 or 5 — climbing through the round (Play → Resolve → Buy).
 */
function phaseCall(name: 'phaseCall3' | 'phaseCall4' | 'phaseCall5', target: number): Recipe {
  return (bus, when) => {
    const v = voice(bus, when, name, { reverb: 0.4 });
    const grace = 0.085;
    bugle(v, { f: BUGLE_G * 4, dur: grace, gain: 0.7, bright: 4.5, vibrato: false, scoop: 30 });
    bugle(v, { f: target, at: grace, dur: 0.6, gain: 0.9, bright: 4.5, scoop: 15 });
    v.done();
  };
}
/** G4 up to B4 (the 5th harmonic). */
const phaseCall3 = phaseCall('phaseCall3', BUGLE_G * 5);
/** G4 up to C5 (between the harmonics: the player lips it up). */
const phaseCall4 = phaseCall('phaseCall4', BUGLE_G * 4 * (4 / 3));
/** G4 up to D5 (the 6th harmonic). */
const phaseCall5 = phaseCall('phaseCall5', BUGLE_G * 6);

// ── Claim resolution ───────────────────────────────────────────────

/** Banner whips taut and is planted with a war-drum hit. */
const resolveTileOccupied: Recipe = (bus, when) => {
  const k = variant('resolveTileOccupied', 3);
  const v = voice(bus, when, 'resolveTileOccupied', { vary: 0.8, pan: rand(-0.15, 0.15), reverb: 0.22 });
  v.noise({
    color: 'pink', gain: 1, env: { a: 0.004, d: 0.08 },
    filters: [{ type: 'highpass', f: 300, q: 0.7 }, { type: 'bandpass', f: jitter(2600, 0.1), f2: 700, sweep: 0.05, q: 0.8 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  v.noise({
    color: 'pink', at: 0.05 + rand(0, 0.015), gain: 0.55, env: { a: 0.003, d: 0.06 },
    filters: [{ type: 'highpass', f: 300, q: 0.7 }, { type: 'bandpass', f: jitter(1700, 0.1), f2: 600, sweep: 0.05, q: 0.8 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  drum(v, { f: 92 * semi([0, -1, 1][k]), at: 0.012, gain: 0.65, decay: 0.25, skin: 0.45, drive: 2.2 });
  v.done();
};

/** Shield raised: resonant clang over a solid thunk and a little stone settle. */
const resolveDefenseFortify: Recipe = (bus, when) => {
  const v = voice(bus, when, 'resolveDefenseFortify', { vary: 0.8, pan: rand(-0.1, 0.1), reverb: 0.2 });
  clang(v, { f: pick([300, 318, 337]), gain: 0.5, decay: 0.55, bright: 0.8, strike: 0.6 });
  thump(v, { f: 150, f2: 80, drop: 0.05, gain: 0.6, decay: 0.2, drive: 2 });
  v.noise({ color: 'brown', at: 0.015, gain: 0.25, env: { a: 0.006, d: 0.15 }, filters: [{ type: 'bandpass', f: 420, q: 0.8 }] });
  v.done();
};

/** Tense clash: swing whoosh and "ba-DUM" drums into two crossing blades and a scrape. */
const resolveContested: Recipe = (bus, when) => {
  const v = voice(bus, when, 'resolveContested', { vary: 0.6, reverb: 0.22 });
  swish(v, { from: 600, to: 2000, dur: 0.05, attack: 0.17, q: 1, gain: 0.35, attackCurve: 'exp', hp: 300, lp: 5000 });
  drum(v, { f: 92, gain: 0.35, decay: 0.18, skin: 0.3 });
  const H = 0.19;
  drum(v, { f: 72, at: H, gain: 0.6, decay: 0.35, skin: 0.45, drive: 2.4 });
  const f = pick([830, 880, 935]);
  clang(v, { f, at: H, gain: 0.45, decay: 0.38, bright: 0.9, strike: 0.6, dest: v.bus(1, -0.2) });
  clang(v, { f: f * 1.19, at: H + 0.016, gain: 0.36, decay: 0.3, bright: 0.8, strike: 0.5, dest: v.bus(1, 0.2) });
  v.noise({
    color: 'white', at: H + 0.01, gain: 0.12, env: { a: 0.004, d: 0.22 },
    filters: [{ type: 'bandpass', f: 3000, f2: 1600, sweep: 0.2, q: 2 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  v.done();
};

// ── Title screen & board build ────────────────────────────────────

/**
 * The title cards rushing in from both sides: two air rushes swelling toward
 * the middle over a rising rumble, cut off at the collision (t = 1.0).
 */
const heroWhoosh: Recipe = (bus, when) => {
  const v = voice(bus, when, 'heroWhoosh', { reverb: 0.2 });
  const T = 1.0;
  const rush = { a: T - 0.02, d: 0.02, s: 1, hold: 0, r: 0.06, attackCurve: 'exp' as const };
  for (const side of [-1, 1]) {
    v.noise({
      color: 'pink', gain: 0.75, env: rush, dest: v.bus(1, side * 0.6),
      filters: [
        { type: 'highpass', f: 250, q: 0.7 },
        { type: 'bandpass', f: 350, f2: 2800, sweep: T, q: 1.1 },
        { type: 'lowpass', f: 7000, q: 0.5 },
      ],
    });
  }
  v.tone({ f: 70, f2: 190, glide: T, gain: 0.35, env: rush, drive: 1.6 });
  shimmerSwell(v, { gain: 0.18, rise: T - 0.05, decay: 0.12 });
  v.done();
};

/**
 * Steel on steel: a sharp strike, two blades ringing against each other, the
 * "shing" of the edges sliding apart, and a heavy thump under it all.
 */
const swordClash: Recipe = (bus, when) => {
  const v = voice(bus, when, 'swordClash', { vary: 0.3, reverb: 0.35 });
  v.noise({ color: 'white', gain: 0.5, env: { a: 0.0004, d: 0.025 }, filters: [{ type: 'highpass', f: 2200, q: 0.7 }, { type: 'lowpass', f: 12000, q: 0.5 }] });
  thump(v, { f: 140, f2: 48, drop: 0.09, gain: 0.6, decay: 0.42, drive: 2.2 });
  drum(v, { f: 66, gain: 0.35, decay: 0.4, skin: 0.4 });
  const f = pick([1580, 1660, 1740]);
  clang(v, { f, gain: 0.42, decay: 1.1, bright: 1.2, strike: 0.5, dest: v.bus(1, -0.25) });
  clang(v, { f: f * 1.34, at: 0.006, gain: 0.32, decay: 0.9, bright: 1.1, strike: 0.4, dest: v.bus(1, 0.25) });
  v.noise({
    color: 'white', at: 0.012, gain: 0.22, env: { a: 0.01, d: 0.32 },
    filters: [{ type: 'bandpass', f: 6500, f2: 3200, sweep: 0.3, q: 3 }, { type: 'lowpass', f: 9000, q: 0.5 }],
  });
  v.done();
};

/** A tile popping up out of the water as the board builds. */
const tilePop: Recipe = (bus, when) => {
  const v = voice(bus, when, 'tilePop', { vary: 1.2, pan: rand(-0.4, 0.4), reverb: 0.12 });
  const f = rand(620, 980);
  v.tone({ f, f2: f * 0.42, glide: 0.035, gain: 0.7, env: { a: 0.002, d: 0.06 } });
  v.tone({ type: 'triangle', f: f * 1.5, f2: f * 0.8, glide: 0.025, gain: 0.15, env: { a: 0.001, d: 0.035 } });
  v.noise({ color: 'pink', gain: 0.18, env: { a: 0.0005, d: 0.012 }, filters: [{ type: 'bandpass', f: 1800, q: 1 }] });
  v.done();
};

// ── Claim smash (power 0 → 8+) ─────────────────────────────────────
// A claim's number smashing into a tile's defense. Each power level is its own
// sound, a step heavier than the last: a feeble poke, a jab, a blade strike,
// crossing swords, a war-drum blow, a mace, a war hammer, a siege ram, and at
// 8+ a cataclysm. The hit lands at t = 0 (it plays on impact).

/** Power 0: a feeble wooden poke. */
const claimSmash0: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash0', { vary: 0.6, pan: rand(-0.1, 0.1), reverb: 0.1 });
  woodKnock(v, { f: pick([400, 430, 460]), gain: 0.55, decay: 0.07, click: 0.3 });
  thump(v, { f: 170, f2: 130, drop: 0.03, gain: 0.25, decay: 0.08, drive: 1.4 });
  feltTap(v, { at: 0.004, gain: 0.3, f: 1200, body: 0.08, bodyF: 220 });
  v.done();
};

/** Power 1: a light jab — a knock and a thin, short ring. */
const claimSmash1: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash1', { vary: 0.6, pan: rand(-0.1, 0.1), reverb: 0.12 });
  woodKnock(v, { f: pick([290, 310, 330]), gain: 0.5, decay: 0.08, click: 0.4 });
  thump(v, { f: 160, f2: 95, drop: 0.04, gain: 0.4, decay: 0.12, drive: 1.8 });
  clang(v, { f: pick([1240, 1300, 1360]), at: 0.002, gain: 0.2, decay: 0.16, bright: 0.6, strike: 0.4 });
  v.done();
};

/** Power 2: a blade strike over a small drum. */
const claimSmash2: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash2', { vary: 0.6, pan: rand(-0.08, 0.08), reverb: 0.15 });
  drum(v, { f: 112, gain: 0.45, decay: 0.18, skin: 0.35, drive: 2, snap: 0.25 });
  clang(v, { f: pick([960, 1000, 1045]), gain: 0.38, decay: 0.28, bright: 0.85, strike: 0.6 });
  v.noise({ color: 'white', at: 0.006, gain: 0.08, env: { a: 0.003, d: 0.12 }, filters: [{ type: 'bandpass', f: 3200, f2: 1900, sweep: 0.12, q: 2 }] });
  v.done();
};

/** Power 3: crossing swords — two blades and a scrape, a firm drum under them. */
const claimSmash3: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash3', { vary: 0.5, reverb: 0.17 });
  drum(v, { f: 94, gain: 0.55, decay: 0.26, skin: 0.4, drive: 2.2, snap: 0.3 });
  const f = pick([830, 880, 935]);
  clang(v, { f, gain: 0.42, decay: 0.36, bright: 0.9, strike: 0.6, dest: v.bus(1, -0.2) });
  clang(v, { f: f * 1.19, at: 0.014, gain: 0.34, decay: 0.3, bright: 0.8, strike: 0.5, dest: v.bus(1, 0.2) });
  v.noise({
    color: 'white', at: 0.01, gain: 0.12, env: { a: 0.004, d: 0.22 },
    filters: [{ type: 'bandpass', f: 3000, f2: 1600, sweep: 0.2, q: 2 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  v.done();
};

/** Power 4: a war-drum blow — a low thump through a shield clang. */
const claimSmash4: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash4', { vary: 0.5, reverb: 0.2 });
  drum(v, { f: 80, gain: 0.65, decay: 0.34, skin: 0.45, drive: 2.4, snap: 0.35 });
  thump(v, { f: 130, f2: 60, drop: 0.06, gain: 0.55, decay: 0.3, drive: 2.3 });
  clang(v, { f: pick([720, 760, 800]), gain: 0.42, decay: 0.45, bright: 0.85, strike: 0.7 });
  v.noise({ color: 'brown', gain: 0.4, env: { a: 0.001, d: 0.1 }, filters: [{ type: 'lowpass', f: 900, q: 0.7 }] });
  v.done();
};

/** Power 5: a mace — a crushing double clang, splinters flying. */
const claimSmash5: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash5', { vary: 0.5, reverb: 0.23 });
  thump(v, { f: 110, f2: 48, drop: 0.07, gain: 0.8, decay: 0.42, drive: 2.6 });
  drum(v, { f: 70, gain: 0.55, decay: 0.38, skin: 0.5, drive: 2.4, snap: 0.45 });
  const f = pick([590, 620, 650]);
  clang(v, { f, gain: 0.45, decay: 0.55, bright: 0.9, strike: 0.8, dest: v.bus(1, -0.15) });
  clang(v, { f: f * 1.33, at: 0.01, gain: 0.32, decay: 0.42, bright: 0.8, strike: 0.6, dest: v.bus(1, 0.15) });
  crackle(v, {
    at: 0.006, grains: scatter(16, 0.22, { shape: (u) => 1 - u, durMin: 0.002, durMax: 0.007, ampMin: 0.3 }),
    total: 0.22, color: 'pink', gain: 0.35, filters: [{ type: 'bandpass', f: 1800, q: 0.7 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  v.done();
};

/** Power 6: a war hammer — a crack, a timpani boom, the plate ringing, stone chips. */
const claimSmash6: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash6', { vary: 0.4, reverb: 0.27 });
  v.noise({ color: 'white', gain: 0.45, env: { a: 0.0005, d: 0.035 }, filters: [{ type: 'highpass', f: 800, q: 0.7 }, { type: 'lowpass', f: 8000, q: 0.5 }] });
  thump(v, { f: 95, f2: 40, drop: 0.09, gain: 0.95, decay: 0.55, drive: 2.8 });
  timpani(v, { f: note('D2'), gain: 0.55, decay: 0.9 });
  clang(v, { f: pick([470, 490, 510]), gain: 0.48, decay: 0.8, bright: 0.9, strike: 0.8 });
  v.noise({ color: 'brown', gain: 0.5, env: { a: 0.002, d: 0.25 }, filters: [{ type: 'lowpass', f: 700, f2: 250, sweep: 0.2, q: 0.7 }] });
  crackle(v, {
    at: 0.008, grains: scatter(30, 0.4, { shape: (u) => Math.exp(-u * 3), durMin: 0.003, durMax: 0.009, ampMin: 0.3 }),
    total: 0.4, color: 'pink', gain: 0.45, filters: [{ type: 'bandpass', f: 1300, q: 0.6 }, { type: 'lowpass', f: 5000, q: 0.5 }],
  });
  v.done();
};

/** Power 7: a siege ram — a sub boom, low brass, a great plate and tumbling stone. */
const claimSmash7: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash7', { vary: 0.4, reverb: 0.32 });
  v.noise({ color: 'white', gain: 0.6, env: { a: 0.0004, d: 0.04 }, filters: [{ type: 'highpass', f: 700, q: 0.7 }, { type: 'lowpass', f: 9000, q: 0.5 }] });
  thump(v, { f: 80, f2: 34, drop: 0.12, gain: 1, decay: 0.75, drive: 3 });
  timpani(v, { f: note('A1'), gain: 0.65, decay: 1.2 });
  const f = pick([370, 385, 400]);
  clang(v, { f, gain: 0.5, decay: 1.0, bright: 0.9, strike: 0.85 });
  clang(v, { f: f * 1.5, at: 0.012, gain: 0.26, decay: 0.7, bright: 0.8, strike: 0.5 });
  ['D2', 'A2'].forEach((n) => brass(v, { f: note(n), at: 0.015, dur: 0.28, gain: 0.3, bright: 5, attack: 0.012, release: 0.35, voices: 2 }));
  const T = 0.7;
  crackle(v, {
    at: 0.01, grains: scatter(45, T, { shape: (u) => Math.exp(-u * 3), warp: (u) => Math.pow(u, 1.6), durMin: 0.003, durMax: 0.01, ampMin: 0.3 }),
    total: T, color: 'pink', gain: 0.6, filters: [{ type: 'bandpass', f: 1100, q: 0.6 }, { type: 'lowpass', f: 5000, q: 0.5 }],
  });
  v.noise({ color: 'brown', at: 0.02, gain: 0.35, env: { a: 0.04, d: 0.8 }, filters: [{ type: 'lowpass', f: 240, q: 0.7 }] });
  v.done();
};

/** Power 8+: a cataclysm — a thunderclap, a sub drop and an aftershock, a
 *  brass chord, the plate howling, and stone raining down. */
const claimSmash8: Recipe = (bus, when) => {
  const v = voice(bus, when, 'claimSmash8', { vary: 0.3, reverb: 0.38 });
  v.noise({ color: 'white', gain: 0.8, env: { a: 0.0003, d: 0.05 }, filters: [{ type: 'highpass', f: 600, q: 0.7 }, { type: 'lowpass', f: 10000, q: 0.5 }] });
  thump(v, { f: 72, f2: 26, drop: 0.2, gain: 1, decay: 1.1, drive: 3.2 });
  timpani(v, { f: note('D2'), gain: 0.7, decay: 1.4 });
  timpani(v, { f: note('A1'), at: 0.16, gain: 0.55, decay: 1.2 });
  thump(v, { f: 60, f2: 30, drop: 0.1, at: 0.16, gain: 0.55, decay: 0.6, drive: 2.6 });
  const f = pick([290, 300, 312]);
  clang(v, { f, gain: 0.55, decay: 1.4, bright: 1, strike: 0.9, dest: v.bus(1, -0.15) });
  clang(v, { f: f * 1.41, at: 0.01, gain: 0.32, decay: 1.0, bright: 0.9, strike: 0.6, dest: v.bus(1, 0.15) });
  ['D2', 'A2', 'D3', 'F3'].forEach((n, i) => brass(v, { f: note(n), at: 0.02 + i * 0.006, dur: 0.5, gain: 0.3, bright: 6, attack: 0.015, release: 0.6, voices: 2 }));
  const T = 1.1;
  const tumble = { shape: (u: number) => Math.exp(-u * 2.6), warp: (u: number) => Math.pow(u, 1.7), durMin: 0.003, durMax: 0.011, ampMin: 0.3 };
  crackle(v, { at: 0.01, grains: scatter(80, T, tumble), total: T, color: 'pink', gain: 0.75, filters: [{ type: 'bandpass', f: 1100, q: 0.6 }, { type: 'lowpass', f: 5000, q: 0.5 }] });
  crackle(v, { at: 0.01, grains: scatter(50, T, tumble), total: T, color: 'brown', gain: 0.55, filters: [{ type: 'bandpass', f: 380, q: 0.8 }] });
  v.noise({ color: 'brown', at: 0.02, gain: 0.45, env: { a: 0.05, d: 1.3 }, filters: [{ type: 'lowpass', f: 200, q: 0.7 }] });
  v.done();
};

// ── Base raid ──────────────────────────────────────────────────────

/** Ominous build: sub swell, low tritone drone, grinding stone, then a portcullis slams down. */
const resolveBaseRaidFortify: Recipe = (bus, when) => {
  const v = voice(bus, when, 'resolveBaseRaidFortify', { vary: 0.5, reverb: 0.3 });
  v.tone({ f: 42, f2: 58, glide: 0.7, gain: 0.5, env: { a: 0.45, d: 0.05, s: 0.9, hold: 0.15, r: 0.35 }, drive: 1.6 });
  const drone = { a: 0.4, d: 0.05, s: 0.9, hold: 0.15, r: 0.4 };
  v.tone({ type: 'sawtooth', f: note('C2'), gain: 0.12, env: drone, filters: [{ type: 'lowpass', f: 320, q: 0.7 }] });
  v.tone({ type: 'sawtooth', f: note('F#2'), gain: 0.09, env: drone, filters: [{ type: 'lowpass', f: 320, q: 0.7 }] });
  crackle(v, {
    grains: scatter(45, 0.6, { shape: (u) => Math.min(1, u * 1.6), durMin: 0.004, durMax: 0.012, ampMin: 0.3 }),
    total: 0.6, color: 'brown', gain: 1, filters: [{ type: 'bandpass', f: 260, f2: 700, q: 0.9 }],
  });
  v.noise({ color: 'brown', gain: 0.4, env: { a: 0.4, d: 0.05, s: 0.8, hold: 0.1, r: 0.15 }, filters: [{ type: 'bandpass', f: 260, f2: 600, sweep: 0.6, q: 0.8 }] });
  const S = 0.62;
  thump(v, { f: 95, f2: 42, drop: 0.08, at: S, gain: 1, decay: 0.42, drive: 2.6 });
  clang(v, { f: 175, at: S, gain: 0.45, decay: 0.7, bright: 0.7, strike: 0.8 });
  v.noise({ color: 'brown', at: S, gain: 0.55, env: { a: 0.002, d: 0.15 }, filters: [{ type: 'lowpass', f: 1200, q: 0.7 }] });
  crackle(v, {
    at: S + 0.01, grains: scatter(10, 0.2, { shape: (u) => 1 - u, durMin: 0.003, durMax: 0.008, ampMin: 0.3 }),
    total: 0.2, color: 'pink', gain: 0.25, filters: [{ type: 'bandpass', f: 1500, q: 0.7 }],
  });
  v.done();
};

/** One battering-ram blow on a wooden gate (called 3× per raid; three pitch variants). */
const resolveBaseRaidRam: Recipe = (bus, when) => {
  const k = variant('resolveBaseRaidRam', 3);
  const p = semi([0, -1.2, 0.8][k]);
  const v = voice(bus, when, 'resolveBaseRaidRam', { vary: 0.6, pan: rand(-0.08, 0.08), reverb: 0.22 });
  thump(v, { f: 82 * p, f2: 40 * p, drop: 0.07, gain: 0.8, decay: 0.32, drive: 2.6 });
  v.partials({ f: 135 * p, ratios: [1, 1.93, 2.91, 4.37], amps: [1, 0.6, 0.4, 0.22], decays: [0.25, 0.17, 0.12, 0.07], gain: 0.9, spread: 0.01 });
  v.noise({ color: 'brown', gain: 0.7, env: { a: 0.001, d: 0.18 }, filters: [{ type: 'lowpass', f: 750, f2: 300, sweep: 0.15, q: 0.7 }] });
  v.noise({ color: 'white', gain: 0.35, env: { a: 0.0005, d: 0.03 }, filters: [{ type: 'bandpass', f: 1300, q: 0.8 }] });
  crackle(v, {
    at: 0.005, grains: scatter(12, 0.13, { shape: (u) => 1 - u, durMin: 0.002, durMax: 0.006, ampMin: 0.3 }),
    total: 0.13, color: 'pink', gain: 0.3, filters: [{ type: 'bandpass', f: 2200, q: 0.7 }, { type: 'lowpass', f: 6000, q: 0.5 }],
  });
  v.done();
};

/** The wall gives way: sharp crack, deep boom, tumbling stone debris and a rumbling tail. */
const resolveBaseRaidShatter: Recipe = (bus, when) => {
  const v = voice(bus, when, 'resolveBaseRaidShatter', { vary: 0.4, reverb: 0.35 });
  v.noise({ color: 'white', gain: 0.8, env: { a: 0.0004, d: 0.045 }, filters: [{ type: 'highpass', f: 700, q: 0.7 }, { type: 'lowpass', f: 9000, q: 0.5 }] });
  thump(v, { f: 75, f2: 32, drop: 0.15, gain: 0.8, decay: 0.9, drive: 3 });
  v.noise({ color: 'brown', gain: 0.8, env: { a: 0.002, d: 0.6 }, filters: [{ type: 'lowpass', f: 550, f2: 150, sweep: 0.5, q: 0.7 }] });
  const T = 1.0;
  const tumble = { shape: (u: number) => Math.exp(-u * 3.2), warp: (u: number) => Math.pow(u, 1.8), durMin: 0.003, durMax: 0.01, ampMin: 0.3 };
  crackle(v, { grains: scatter(70, T, tumble), total: T, color: 'pink', gain: 0.9, filters: [{ type: 'bandpass', f: 1100, q: 0.6 }, { type: 'lowpass', f: 5000, q: 0.5 }] });
  crackle(v, { grains: scatter(50, T, tumble), total: T, color: 'brown', gain: 0.6, filters: [{ type: 'bandpass', f: 380, q: 0.8 }] });
  for (let i = 0; i < 5; i++) {
    const at = Math.pow(rand(0.05, 1), 1.6) * 0.75;
    v.partials({ f: rand(260, 700), ratios: [1, 2.2, 3.7], amps: [1, 0.5, 0.25], decays: [0.06, 0.04, 0.025], at, gain: 0.5 * (1 - at), dest: v.bus(1, rand(-0.5, 0.5)) });
  }
  v.noise({ color: 'brown', at: 0.02, gain: 0.35, env: { a: 0.05, d: 1.1 }, filters: [{ type: 'lowpass', f: 220, q: 0.7 }] });
  v.done();
};

/** The defence holds: the blow rings off a great shield, answered by open-fifth horns. */
const resolveBaseRaidHold: Recipe = (bus, when) => {
  const v = voice(bus, when, 'resolveBaseRaidHold', { vary: 0.4, reverb: 0.32 });
  thump(v, { f: 90, f2: 45, drop: 0.07, gain: 0.9, decay: 0.4, drive: 2.3 });
  v.noise({ color: 'brown', gain: 0.5, env: { a: 0.001, d: 0.1 }, filters: [{ type: 'lowpass', f: 850, q: 0.7 }] });
  clang(v, { f: 220, gain: 0.6, decay: 1.3, bright: 0.85, strike: 0.7 });
  ['D3', 'A3', 'D4'].forEach((n, i) => {
    brass(v, { f: note(n), at: 0.12 + i * 0.01, dur: 0.55, gain: 0.32, bright: 4, attack: 0.08, release: 0.6, voices: 2 });
  });
  bell(v, { f: note('D5'), at: 0.14, gain: 0.12, decay: 1.0 });
  bell(v, { f: note('A5'), at: 0.2, gain: 0.09, decay: 0.9 });
  v.done();
};

// ── Jingles ────────────────────────────────────────────────────────

/** The first round begins: a bugle call (D4 G4 · D5, held) with a bass drum under the held note. */
const beginJingle: Recipe = (bus, when) => {
  const v = voice(bus, when, 'beginJingle', { reverb: 0.32 });
  bugle(v, { f: BUGLE_G * 3, dur: 0.13, gain: 0.8, vibrato: false });
  bugle(v, { f: BUGLE_G * 4, at: 0.16, dur: 0.13, gain: 0.85, vibrato: false, scoop: 25 });
  bugle(v, { f: BUGLE_G * 6, at: 0.36, dur: 0.95 });
  drum(v, { f: 60, at: 0.36, gain: 0.6, decay: 0.6, skin: 0.35, drive: 1.6 });
  v.done();
};

/** Triumphant C-major fanfare: triplet pickup, rising call, full brass + strings chord with timpani. */
const victoryJingle: Recipe = (bus, when) => {
  const v = voice(bus, when, 'victoryJingle', { reverb: 0.35 });
  const mel = v.bus(1, 0.1);
  const low = v.bus(0.8, -0.15);
  const str = v.bus(0.6, 0);
  const seq: readonly (readonly [string, number, number])[] = [
    ['G4', 0, 0.1], ['G4', 0.11, 0.1], ['G4', 0.22, 0.1], ['C5', 0.34, 0.4],
    ['G4', 0.78, 0.13], ['C5', 0.94, 0.13], ['E5', 1.1, 0.18],
  ];
  for (const [n, at, dur] of seq) {
    brass(v, { f: note(n), at, dur, gain: 0.55, bright: 6.5, attack: 0.025, release: 0.12, vibrato: dur > 0.3, dest: mel });
    brass(v, { f: note(n) / 2, at, dur, gain: 0.32, bright: 4.5, attack: 0.03, release: 0.12, voices: 2, vibrato: false, dest: low });
  }
  brass(v, { f: note('E4'), at: 0.34, dur: 0.4, gain: 0.28, bright: 5, release: 0.15, voices: 2, dest: low });
  brass(v, { f: note('G4'), at: 0.345, dur: 0.4, gain: 0.26, bright: 5, release: 0.15, voices: 2, dest: low });
  const F = 1.32;
  const FD = 1.45;
  ['C4', 'G4', 'C5', 'E5', 'G5'].forEach((n, i) => {
    brass(v, { f: note(n), at: F + i * 0.008, dur: FD, gain: [0.4, 0.36, 0.42, 0.38, 0.42][i], bright: 6, attack: 0.05, release: 0.7, dest: i < 2 ? low : mel });
  });
  strings(v, { freqs: ['C3', 'G3', 'C4', 'E4', 'G4'].map(note), at: F - 0.05, dur: FD + 0.1, gain: 0.5, attack: 0.25, release: 0.9, cutoff: 2200, dest: str });
  timpani(v, { f: note('C3'), at: 0.34, gain: 0.7, decay: 0.9 });
  timpani(v, { f: note('G2'), at: 1.1, gain: 0.5, decay: 0.6 });
  timpani(v, { f: note('C3'), at: F, gain: 0.9, decay: 1.4 });
  shimmerSwell(v, { at: F - 0.45, rise: 0.45, decay: 1.4, gain: 0.12 });
  bell(v, { f: note('C6'), at: F, gain: 0.15, decay: 1.4 });
  bell(v, { f: note('G6'), at: F + 0.06, gain: 0.1, decay: 1.2 });
  v.done();
};

/** Somber C-minor horn line over a dark Cm–Ab–G–Cm string progression. */
const defeatJingle: Recipe = (bus, when) => {
  const v = voice(bus, when, 'defeatJingle', { reverb: 0.4 });
  const mel = v.bus(1, 0.05);
  const str = v.bus(0.75, -0.05);
  const line: readonly (readonly [string, number, number])[] = [
    ['G4', 0, 0.5], ['Eb4', 0.55, 0.5], ['C4', 1.1, 0.5], ['B3', 1.65, 0.5], ['C4', 2.2, 1.3],
  ];
  line.forEach(([n, at, dur], i) => {
    const last = i === line.length - 1;
    brass(v, { f: note(n), at, dur, gain: 0.5, bright: 3.2, attack: 0.07, release: last ? 1.0 : 0.35, cents: 6, dest: mel });
  });
  const pads: readonly (readonly [string[], number, number])[] = [
    [['C3', 'G3', 'Eb4'], 0, 1.1], [['Ab2', 'Eb3', 'C4'], 1.1, 0.55], [['G2', 'D3', 'B3'], 1.65, 0.55], [['C3', 'G3', 'C4', 'Eb4'], 2.2, 1.3],
  ];
  pads.forEach(([ns, at, dur], i) => {
    const last = i === pads.length - 1;
    strings(v, { freqs: ns.map(note), at, dur, gain: 0.55, attack: i === 0 ? 0.35 : 0.2, release: last ? 1.2 : 0.4, cutoff: 1200, dest: str });
  });
  timpani(v, { f: note('C2'), at: 0, gain: 0.5, decay: 1.2 });
  timpani(v, { f: note('C2'), at: 2.2, gain: 0.7, decay: 1.6 });
  v.done();
};

// ── Optional extras ────────────────────────────────────────────────

/** Barely-there hover tick. */
const hoverTick: Recipe = (bus, when) => {
  const v = voice(bus, when, 'hoverTick', { vary: 1 });
  v.partials({ f: 2100 * semi(rand(-0.4, 0.4)), ratios: [1, 2.4], amps: [1, 0.2], decays: [0.012, 0.007], attack: 0.0008 });
  v.tone({ f: 600, f2: 480, glide: 0.015, gain: 0.3, env: { a: 0.001, d: 0.015 } });
  v.done();
};

/** One or two coins flicked from the purse (re-roll / retain / debt payment). */
const coinSpend: Recipe = (bus, when) => {
  const v = voice(bus, when, 'coinSpend', { vary: 0.8, reverb: 0.1 });
  coin(v, { f: rand(2100, 2800), gain: 1, decay: 0.9, dest: v.bus(1, rand(-0.2, 0.2)) });
  coin(v, { f: rand(1800, 2300), at: rand(0.045, 0.065), gain: 0.5, decay: 0.6 });
  feltTap(v, { at: 0.07, gain: 0.25, f: 900, body: 0.15 });
  v.done();
};

/** Warm two-bell chime (rising fourth→fifth) for gaining VP. */
const vpGain: Recipe = (bus, when) => {
  const v = voice(bus, when, 'vpGain', { vary: 0.4, reverb: 0.35 });
  bell(v, { f: note('A5'), gain: 0.6, decay: 1.0, ratio: 3, index: 1.0 });
  bell(v, { f: note('E6'), at: 0.09, gain: 0.55, decay: 1.2, ratio: 3, index: 1.0 });
  v.tone({ type: 'triangle', f: note('A4'), gain: 0.14, env: { a: 0.01, d: 0.9 } });
  v.tone({ f: note('A6'), at: 0.12, gain: 0.08, env: { a: 0.03, d: 0.7 }, vibrato: { rate: 7, cents: 10 } });
  v.done();
};

/** Soft rising whoosh landing on a low drum — phase transitions. */
const phaseChange: Recipe = (bus, when) => {
  const v = voice(bus, when, 'phaseChange', { vary: 0.5, reverb: 0.25 });
  swish(v, { from: 350, to: 1500, dur: 0.22, attack: 0.18, q: 0.7, gain: 0.6, hp: 150, lp: 4000 });
  drum(v, { f: 70, at: 0.17, gain: 0.45, decay: 0.35, skin: 0.3 });
  v.done();
};

/** Dull descending double knock — "can't do that". */
const invalidAction: Recipe = (bus, when) => {
  const v = voice(bus, when, 'invalidAction', { vary: 0.5, reverb: 0.06 });
  woodKnock(v, { f: 230, gain: 0.8, decay: 0.07, click: 0.15, bright: 0.5 });
  woodKnock(v, { f: 190, at: 0.09, gain: 0.7, decay: 0.08, click: 0.12, bright: 0.5 });
  v.tone({ f: 120, f2: 95, glide: 0.05, gain: 0.3, env: { a: 0.002, d: 0.08 } });
  v.tone({ f: 105, f2: 85, glide: 0.05, at: 0.09, gain: 0.3, env: { a: 0.002, d: 0.08 } });
  v.done();
};

export interface SoundDef {
  play: Recipe;
  /** Approximate dry length in seconds (offline renders add the reverb tail). */
  length: number;
}

export const SOUNDS: Record<SoundName, SoundDef> = {
  cardDraw: { play: cardDraw, length: 0.25 },
  cardPlay: { play: cardPlay, length: 0.25 },
  cardDiscard: { play: cardDiscard, length: 0.3 },
  cardTrash: { play: cardTrash, length: 0.55 },
  cardPurchase: { play: cardPurchase, length: 0.6 },
  tileSelect: { play: tileSelect, length: 0.15 },
  countdownTick: { play: countdownTick, length: 0.45 },
  countdownGo: { play: countdownGo, length: 1.3 },
  buttonClick: { play: buttonClick, length: 0.1 },
  deckShuffle: { play: deckShuffle, length: 1.3 },
  victoryJingle: { play: victoryJingle, length: 3.8 },
  defeatJingle: { play: defeatJingle, length: 4.8 },
  resolveDefenseFortify: { play: resolveDefenseFortify, length: 0.8 },
  resolveTileOccupied: { play: resolveTileOccupied, length: 0.5 },
  resolveContested: { play: resolveContested, length: 0.8 },
  resolveBaseRaidFortify: { play: resolveBaseRaidFortify, length: 1.6 },
  resolveBaseRaidRam: { play: resolveBaseRaidRam, length: 0.5 },
  resolveBaseRaidShatter: { play: resolveBaseRaidShatter, length: 1.6 },
  resolveBaseRaidHold: { play: resolveBaseRaidHold, length: 1.8 },
  upgradeCharge: { play: upgradeCharge, length: 1.55 },
  upgradeCard: { play: upgradeCard, length: 1.9 },
  beginJingle: { play: beginJingle, length: 1.6 },
  heroWhoosh: { play: heroWhoosh, length: 1.1 },
  swordClash: { play: swordClash, length: 1.6 },
  tilePop: { play: tilePop, length: 0.12 },
  phaseCall3: { play: phaseCall3, length: 0.9 },
  phaseCall4: { play: phaseCall4, length: 0.9 },
  phaseCall5: { play: phaseCall5, length: 0.9 },
  hoverTick: { play: hoverTick, length: 0.06 },
  coinSpend: { play: coinSpend, length: 0.35 },
  vpGain: { play: vpGain, length: 1.4 },
  phaseChange: { play: phaseChange, length: 0.7 },
  invalidAction: { play: invalidAction, length: 0.3 },
  claimSmash0: { play: claimSmash0, length: 0.2 },
  claimSmash1: { play: claimSmash1, length: 0.3 },
  claimSmash2: { play: claimSmash2, length: 0.4 },
  claimSmash3: { play: claimSmash3, length: 0.5 },
  claimSmash4: { play: claimSmash4, length: 0.6 },
  claimSmash5: { play: claimSmash5, length: 0.8 },
  claimSmash6: { play: claimSmash6, length: 1.0 },
  claimSmash7: { play: claimSmash7, length: 1.4 },
  claimSmash8: { play: claimSmash8, length: 1.8 },
};
