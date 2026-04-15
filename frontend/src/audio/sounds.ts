/**
 * Procedural sound synthesis recipes using the Web Audio API.
 * Each function creates short-lived audio nodes that self-cleanup.
 */

type Ctx = AudioContext;
type Dest = AudioNode;

/** Create a white noise AudioBuffer (1 second, mono) */
export function createNoiseBuffer(ctx: Ctx): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, sr, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < sr; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buf;
}

// ── Helpers ──────────────────────────────────────────────────────────

function noise(ctx: Ctx, buffer: AudioBuffer, dest: Dest, gain: number, duration: number, filterType: BiquadFilterType, freqStart: number, freqEnd: number, attackMs = 20) {
  const now = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(freqStart, now);
  filter.frequency.linearRampToValueAtTime(freqEnd, now + duration);
  filter.Q.value = 1.5;

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + attackMs / 1000);
  g.gain.linearRampToValueAtTime(0, now + duration);

  src.connect(filter).connect(g).connect(dest);
  src.start(now);
  src.stop(now + duration + 0.01);
}

function osc(ctx: Ctx, dest: Dest, type: OscillatorType, freq: number, gain: number, duration: number, attackMs = 5, freqEnd?: number) {
  const now = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, now);
  if (freqEnd !== undefined) {
    o.frequency.linearRampToValueAtTime(freqEnd, now + duration);
  }

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + attackMs / 1000);
  g.gain.exponentialRampToValueAtTime(0.001, now + duration);

  o.connect(g).connect(dest);
  o.start(now);
  o.stop(now + duration + 0.01);
}

function oscAt(ctx: Ctx, dest: Dest, type: OscillatorType, freq: number, gain: number, startOffset: number, duration: number, attackMs = 5) {
  const now = ctx.currentTime + startOffset;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, now);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(gain, now + attackMs / 1000);
  g.gain.exponentialRampToValueAtTime(0.001, now + duration);

  o.connect(g).connect(dest);
  o.start(now);
  o.stop(now + duration + 0.01);
}

// ── Sound Recipes ───────────────────────────────────────────────────

/** Soft whoosh — bandpass noise sweep down */
export function cardDraw(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  noise(ctx, noiseBuf, dest, 0.08, 0.2, 'bandpass', 2000, 800, 20);
}

/** Satisfying thud — low sine + noise burst */
export function cardPlay(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  osc(ctx, dest, 'sine', 80, 0.12, 0.15, 5);
  noise(ctx, noiseBuf, dest, 0.06, 0.05, 'lowpass', 400, 200, 5);
}

/** Light swoosh upward */
export function cardDiscard(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  noise(ctx, noiseBuf, dest, 0.06, 0.18, 'bandpass', 800, 3000, 15);
}

/** Paper rip — sharp highpass noise burst with downward sweep */
export function cardTrash(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  noise(ctx, noiseBuf, dest, 0.10, 0.15, 'highpass', 4000, 1200, 3);
  noise(ctx, noiseBuf, dest, 0.05, 0.10, 'bandpass', 2500, 600, 2);
}

/** Two quick tones + shimmer */
export function cardPurchase(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  oscAt(ctx, dest, 'square', 1200, 0.04, 0, 0.08, 5);
  oscAt(ctx, dest, 'square', 1600, 0.05, 0.12, 0.1, 5);
  // Shimmer
  const now = ctx.currentTime + 0.15;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 4000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.03, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
  src.connect(hp).connect(g).connect(dest);
  src.start(now);
  src.stop(now + 0.21);
}

/** Short soft click */
export function tileSelect(ctx: Ctx, dest: Dest) {
  osc(ctx, dest, 'sine', 600, 0.06, 0.05, 5);
}

/** Clean beep */
export function countdownTick(ctx: Ctx, dest: Dest) {
  osc(ctx, dest, 'sine', 880, 0.08, 0.1, 10);
}

/** Bright chime — perfect fifth */
export function countdownGo(ctx: Ctx, dest: Dest) {
  osc(ctx, dest, 'sine', 880, 0.1, 0.3, 10);
  osc(ctx, dest, 'sine', 1320, 0.08, 0.3, 10);
}

/** Subtle UI click */
export function buttonClick(ctx: Ctx, dest: Dest) {
  osc(ctx, dest, 'triangle', 440, 0.04, 0.04, 3);
}

/** Rapid card riffle — series of short noise bursts */
export function deckShuffle(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  const burstCount = 9;
  const totalDuration = 0.6;
  const burstSpacing = totalDuration / burstCount;

  for (let i = 0; i < burstCount; i++) {
    const offset = i * burstSpacing;
    const now = ctx.currentTime + offset;
    // Crescendo-decrescendo envelope
    const progress = i / (burstCount - 1);
    const envGain = 0.06 * (1 - Math.abs(progress - 0.5) * 1.6);
    const freq = 1500 + Math.random() * 1500;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = 2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(envGain, now + 0.005);
    g.gain.linearRampToValueAtTime(0, now + 0.025);
    src.connect(bp).connect(g).connect(dest);
    src.start(now);
    src.stop(now + 0.03);
  }
}

/** Ascending triumphant arpeggio + sustained chord */
export function victoryJingle(ctx: Ctx, dest: Dest) {
  const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
  const noteDur = 0.4;
  const gap = 0.3;

  // Arpeggio
  for (let i = 0; i < notes.length; i++) {
    const offset = i * gap;
    oscAt(ctx, dest, 'sine', notes[i], 0.1, offset, noteDur, 10);
    // Detuned double for richness
    oscAt(ctx, dest, 'triangle', notes[i] * 1.002, 0.04, offset + 0.03, noteDur - 0.03, 10);
  }

  // Final sustained chord (C5 + E5 + G5)
  const chordStart = notes.length * gap + 0.1;
  const chordDur = 1.5;
  const chordNotes = [523.25, 659.25, 783.99];
  for (const freq of chordNotes) {
    const startTime = ctx.currentTime + chordStart;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.08, startTime);
    g.gain.linearRampToValueAtTime(0, startTime + chordDur);
    o.connect(g).connect(dest);
    o.start(startTime);
    o.stop(startTime + chordDur + 0.01);
  }
}

/** Descending melancholy tune */
export function defeatJingle(ctx: Ctx, dest: Dest) {
  const notes = [523.25, 466.16, 415.30, 392.00]; // C5, Bb4, Ab4, G4
  const noteDur = 0.35;
  const gap = 0.32;

  for (let i = 0; i < notes.length; i++) {
    const offset = i * gap;
    oscAt(ctx, dest, 'sine', notes[i], 0.08, offset, noteDur, 15);
  }

  // Final note with vibrato
  const vibratoStart = ctx.currentTime + notes.length * gap + 0.05;
  const vibratoFreq = 392.00; // G4
  const vibratoDur = 1.5;

  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = vibratoFreq;

  // LFO for vibrato
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 5;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 3; // +/- 3Hz
  lfo.connect(lfoGain).connect(o.frequency);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.08, vibratoStart);
  g.gain.linearRampToValueAtTime(0, vibratoStart + vibratoDur);

  o.connect(g).connect(dest);
  o.start(vibratoStart);
  o.stop(vibratoStart + vibratoDur + 0.01);
  lfo.start(vibratoStart);
  lfo.stop(vibratoStart + vibratoDur + 0.01);
}

/** Short fanfare — game begin */
export function beginJingle(ctx: Ctx, dest: Dest) {
  // Quick ascending triad: C5 → E5 → G5, bright and short
  oscAt(ctx, dest, 'sine', 523.25, 0.09, 0, 0.18, 8);
  oscAt(ctx, dest, 'triangle', 523.25, 0.04, 0, 0.18, 8);
  oscAt(ctx, dest, 'sine', 659.25, 0.10, 0.12, 0.18, 8);
  oscAt(ctx, dest, 'triangle', 659.25, 0.04, 0.12, 0.18, 8);
  oscAt(ctx, dest, 'sine', 783.99, 0.11, 0.24, 0.3, 8);
  oscAt(ctx, dest, 'triangle', 783.99, 0.05, 0.24, 0.3, 8);
  // Final bright octave accent
  oscAt(ctx, dest, 'sine', 1046.50, 0.08, 0.36, 0.4, 10);
}

/** Bright ascending sparkle — card upgraded */
export function upgradeCard(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  // Quick ascending tones
  oscAt(ctx, dest, 'sine', 800, 0.06, 0, 0.12, 5);
  oscAt(ctx, dest, 'sine', 1200, 0.07, 0.08, 0.12, 5);
  oscAt(ctx, dest, 'sine', 1600, 0.08, 0.16, 0.2, 5);
  // High shimmer
  const now = ctx.currentTime + 0.2;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.04, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  src.connect(hp).connect(g).connect(dest);
  src.start(now);
  src.stop(now + 0.31);
}

/** Rising harden — defense fortified */
export function resolveDefenseFortify(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  // Low rumbling foundation that rises
  osc(ctx, dest, 'sine', 150, 0.07, 0.25, 10, 250);
  // Metallic clang layered on top
  osc(ctx, dest, 'triangle', 400, 0.05, 0.15, 5, 600);
  // Short noise burst for "stone/metal" texture
  noise(ctx, noiseBuf, dest, 0.04, 0.1, 'bandpass', 1200, 2400, 5);
}

/** Low-mid tone with pitch drop — tile claimed */
export function resolveTileOccupied(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  osc(ctx, dest, 'sine', 300, 0.08, 0.2, 10, 220);
  noise(ctx, noiseBuf, dest, 0.03, 0.08, 'lowpass', 500, 300, 5);
}

/** Higher impact tone — contested tile */
export function resolveContested(ctx: Ctx, dest: Dest) {
  osc(ctx, dest, 'sine', 500, 0.09, 0.25, 8, 600);
}

/** Base raid — fortification rising. Deep sub-bass swell + stone-grind + metallic clang.
 *  Meant to feel ominous and weighty. Longer than normal resolveDefenseFortify. */
export function resolveBaseRaidFortify(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  // Deep sub-bass foundation rising
  osc(ctx, dest, 'sine', 55, 0.12, 0.65, 40, 90);
  osc(ctx, dest, 'triangle', 110, 0.06, 0.55, 40, 180);
  // Stone-grind — filtered noise sweeping up
  noise(ctx, noiseBuf, dest, 0.08, 0.55, 'bandpass', 200, 800, 30);
  // Metallic clang near the end (like a portcullis slamming down)
  oscAt(ctx, dest, 'triangle', 320, 0.08, 0.4, 0.25, 5);
  oscAt(ctx, dest, 'sine', 640, 0.05, 0.4, 0.25, 5);
  // High glint
  oscAt(ctx, dest, 'sine', 1200, 0.04, 0.45, 0.3, 8);
}

/** Base raid — a single battering-ram impact. Low thud + mid crack + splinter noise.
 *  Called once per ram hit (typically 3 times). */
export function resolveBaseRaidRam(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  // Massive low thud
  osc(ctx, dest, 'sine', 60, 0.14, 0.2, 2, 30);
  // Mid-register crack
  osc(ctx, dest, 'triangle', 220, 0.08, 0.12, 2, 110);
  // Wood-splinter noise burst
  noise(ctx, noiseBuf, dest, 0.12, 0.15, 'bandpass', 1400, 500, 2);
  // Sharp high transient
  noise(ctx, noiseBuf, dest, 0.05, 0.06, 'highpass', 3500, 2500, 1);
}

/** Base raid — wall shatters / raid succeeds. Big crack, glass-like shatter, low boom aftermath. */
export function resolveBaseRaidShatter(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  // Initial crack transient
  noise(ctx, noiseBuf, dest, 0.18, 0.08, 'bandpass', 3000, 1000, 1);
  // Glassy shatter — high noise cascade
  noise(ctx, noiseBuf, dest, 0.10, 0.5, 'highpass', 4000, 2000, 2);
  noise(ctx, noiseBuf, dest, 0.07, 0.4, 'bandpass', 6000, 3000, 3);
  // Low boom aftermath
  oscAt(ctx, dest, 'sine', 45, 0.16, 0.05, 0.8, 3);
  oscAt(ctx, dest, 'sine', 90, 0.08, 0.05, 0.7, 3);
  // Metallic shimmer tail
  oscAt(ctx, dest, 'triangle', 1800, 0.04, 0.1, 0.4, 5);
  oscAt(ctx, dest, 'sine', 2400, 0.03, 0.15, 0.35, 5);
}

/** Base raid — defender holds. Triumphant deep boom + resonant bell + rising shimmer. */
export function resolveBaseRaidHold(ctx: Ctx, dest: Dest, noiseBuf: AudioBuffer) {
  // Heavy impact — the attack bouncing off
  osc(ctx, dest, 'sine', 70, 0.14, 0.35, 3, 40);
  noise(ctx, noiseBuf, dest, 0.08, 0.12, 'lowpass', 600, 300, 2);
  // Resonant bell tones — defender "holding firm"
  oscAt(ctx, dest, 'sine', 440, 0.08, 0.1, 0.6, 8);
  oscAt(ctx, dest, 'triangle', 660, 0.05, 0.1, 0.55, 8);
  oscAt(ctx, dest, 'sine', 880, 0.04, 0.15, 0.5, 10);
  // Rising victory shimmer
  oscAt(ctx, dest, 'sine', 1320, 0.04, 0.25, 0.4, 12);
}
