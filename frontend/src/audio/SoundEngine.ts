import { createAudioGraph, type AudioGraph } from './graph';
import { createMusicGraph, DistantMarch } from './music';
import { SOUNDS, smashSoundName, type SoundName } from './sounds';

/** A sound that can be cut short (a charge-up while a button is held). */
export interface HeldSound {
  /** Fade it out now (default 120 ms). */
  stop: (fadeMs?: number) => void;
}

const SILENT: HeldSound = { stop: () => {} };

/**
 * Whether the browser will hold a new audio context back until the page has
 * had a gesture: Firefox says so outright; Chromium always does before the
 * first gesture. (Safari can't tell us — prepare() waits and sees.)
 */
function autoplayBlocked(): boolean {
  if (typeof navigator === 'undefined') return true;
  const nav = navigator as Navigator & {
    getAutoplayPolicy?: (type: string) => string;
    userActivation?: { hasBeenActive: boolean };
    userAgentData?: unknown;
  };
  if (typeof nav.getAutoplayPolicy === 'function') return nav.getAutoplayPolicy('audiocontext') === 'disallowed';
  return !!nav.userAgentData && !!nav.userActivation && !nav.userActivation.hasBeenActive;
}

/** Fanfares the background music dips under. */
const DUCK_UNDER = new Set<SoundName>(['victoryJingle', 'defeatJingle', 'beginJingle']);

/**
 * Owns the (lazily created) AudioContext and master graph, and exposes one
 * method per sound. Recipes live in sounds.ts; the master bus in graph.ts.
 * Background music (music.ts) has its own bus, volume and on/off, and pauses
 * while the tab is hidden.
 */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private enabled = true;
  private volume = 1;
  private musicEnabled = true;
  private musicVolume = 0.5;
  private musicHeld = false;
  private music: DistantMarch | null = null;
  private unavailable = false;
  private unlockBound = false;

  constructor() {
    this.bindUnlock();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => this.syncMusic());
    }
  }

  /**
   * Create/resume the context on the first user gesture. Browsers (iOS Safari
   * especially) only let audio start from inside a gesture handler; doing it
   * here means sounds triggered later from timers or network messages (e.g.
   * the lobby countdown) still play, and the master bus is warmed up before
   * the first real sound.
   */
  private bindUnlock() {
    if (this.unlockBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    this.unlockBound = true;
    const events = ['pointerdown', 'keydown', 'touchend'] as const;
    const unlock = () => {
      if (!this.enabled && !this.musicEnabled) return;
      const graph = this.ensureContext();
      this.syncMusic();
      if (!graph || this.ctx?.state === 'running') {
        events.forEach((e) => window.removeEventListener(e, unlock, true));
      }
    };
    events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }));
  }

  private ensureContext(): AudioGraph | null {
    if (this.unavailable) return null;
    if (!this.graph) {
      const AC: typeof AudioContext | undefined = typeof window !== 'undefined'
        ? window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
      if (!AC) {
        this.unavailable = true;
        return null;
      }
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.graph = createAudioGraph(this.ctx);
        this.graph.volume.gain.value = this.volume;
        const musicGraph = createMusicGraph(this.ctx, this.ctx.destination, this.graph.noise);
        musicGraph.volume.gain.value = this.musicVolume;
        this.music = new DistantMarch(musicGraph);
        // Safari may start a context on its own (or only at the first click).
        this.ctx.addEventListener?.('statechange', () => this.syncMusic());
      } catch (e) {
        console.warn('[SoundEngine] audio unavailable', e);
        this.unavailable = true;
        return null;
      }
    }
    // Resume if suspended (browser autoplay policy)
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => { /* needs a user gesture; next play retries */ });
    }
    return this.graph;
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.graph && this.ctx) {
      // Smooth the change so dragging the slider never zippers or clicks.
      const p = this.graph.volume.gain;
      const now = this.ctx.currentTime;
      p.cancelScheduledValues(now);
      p.setTargetAtTime(this.volume, now, 0.015);
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  setMusicVolume(v: number) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    this.music?.setVolume(this.musicVolume);
  }

  setMusicEnabled(on: boolean) {
    this.musicEnabled = on;
    // Switched on after the page has had a gesture: start the context now
    // rather than waiting for the next click.
    const nav = typeof navigator !== 'undefined' ? navigator as Navigator & { userActivation?: { hasBeenActive: boolean } } : null;
    if (on && !this.graph && nav?.userActivation?.hasBeenActive) this.ensureContext();
    this.syncMusic();
  }

  /** Hold the music silent (the lobby countdown), or let it play again. */
  holdMusic(on: boolean) {
    this.musicHeld = on;
    this.syncMusic();
  }

  /** Start the music over from the top (a new game). */
  restartMusic() {
    this.musicHeld = false;
    this.music?.stop(0.4);
    this.syncMusic();
  }

  /** Music plays while it's on (and not held), the context exists and the tab is visible. */
  private syncMusic() {
    const music = this.music;
    if (!music) return;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (this.musicEnabled && !hidden && !this.musicHeld) {
      if (!music.playing) {
        this.ensureContext();
        music.start();
      }
    } else if (music.playing) {
      music.stop();
    }
  }

  /** Play any sound by name. Audio failures never propagate into game code. */
  play(name: SoundName) {
    if (!this.enabled) return;
    const graph = this.ensureContext();
    if (!graph) return;
    if (DUCK_UNDER.has(name)) this.music?.duck(SOUNDS[name].length + 0.3);
    try {
      SOUNDS[name].play(graph);
    } catch (e) {
      console.warn(`[SoundEngine] failed to play ${name}`, e);
    }
  }

  /** Play a sound `delay` seconds from now, on the audio clock. */
  playIn(name: SoundName, delay: number) {
    if (!this.enabled) return;
    const graph = this.ensureContext();
    if (!graph) return;
    try {
      SOUNDS[name].play(graph, graph.ctx.currentTime + Math.max(0, delay));
    } catch (e) {
      console.warn(`[SoundEngine] failed to play ${name}`, e);
    }
  }

  /**
   * Whether sound can be heard right now: the context runs and its clock has
   * started. A sound with no click behind it (the title animation) only plays
   * then — otherwise a held-back context would let it all out late, at the
   * first click or whenever the audio device wakes.
   */
  private get audible(): boolean {
    return this.ctx?.state === 'running' && this.ctx.currentTime > 0.02;
  }

  /**
   * Get audio going before the title animation: start the context and resolve
   * true once it can be heard, or false when the browser holds audio back
   * until a gesture (known up front where the browser says so) or it hasn't
   * started within `timeoutMs`.
   */
  prepare(timeoutMs = 2500): Promise<boolean> {
    if (!this.enabled && !this.musicEnabled) return Promise.resolve(false);
    if (autoplayBlocked()) return Promise.resolve(false);
    if (!this.ensureContext()) return Promise.resolve(false);
    const t0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.audible) { this.syncMusic(); resolve(true); return; }
        if (performance.now() - t0 >= timeoutMs) { resolve(false); return; }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /**
   * Play a sound through its own fader so it can be stopped early: its dry
   * and reverb sends ramp down (whatever already reached the reverb rings
   * out naturally).
   */
  playHeld(name: SoundName): HeldSound {
    if (!this.enabled) return SILENT;
    const graph = this.ensureContext();
    if (!graph) return SILENT;
    const ctx = graph.ctx;
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    dry.connect(graph.input);
    wet.connect(graph.send);
    try {
      SOUNDS[name].play({ ctx, noise: graph.noise, input: dry, send: wet });
    } catch (e) {
      console.warn(`[SoundEngine] failed to play ${name}`, e);
    }
    let stopped = false;
    const release = () => { dry.disconnect(); wet.disconnect(); };
    const natural = setTimeout(release, (SOUNDS[name].length + 0.5) * 1000);
    return {
      stop: (fadeMs = 120) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(natural);
        const t = ctx.currentTime;
        for (const g of [dry, wet]) {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0, t + fadeMs / 1000);
        }
        setTimeout(release, fadeMs + 60);
      },
    };
  }

  cardDraw() { this.play('cardDraw'); }
  cardPlay() { this.play('cardPlay'); }
  cardDiscard() { this.play('cardDiscard'); }
  cardTrash() { this.play('cardTrash'); }
  cardPurchase() { this.play('cardPurchase'); }
  tileSelect() { this.play('tileSelect'); }
  countdownTick() { this.play('countdownTick'); }
  countdownGo() { this.play('countdownGo'); }
  buttonClick() { this.play('buttonClick'); }
  deckShuffle() { this.play('deckShuffle'); }
  victoryJingle() { this.play('victoryJingle'); }
  defeatJingle() { this.play('defeatJingle'); }
  resolveDefenseFortify() { this.play('resolveDefenseFortify'); }
  resolveTileOccupied() { this.play('resolveTileOccupied'); }
  resolveContested() { this.play('resolveContested'); }
  resolveBaseRaidFortify() { this.play('resolveBaseRaidFortify'); }
  resolveBaseRaidRam() { this.play('resolveBaseRaidRam'); }
  resolveBaseRaidShatter() { this.play('resolveBaseRaidShatter'); }
  resolveBaseRaidHold() { this.play('resolveBaseRaidHold'); }
  upgradeCard() { this.play('upgradeCard'); }
  /** Power gathering while the upgrade badge is held; stop it on release. */
  upgradeCharge(): HeldSound { return this.playHeld('upgradeCharge'); }
  beginJingle() { this.play('beginJingle'); }
  /** The title cards rushing in (they collide 1 s later). */
  heroWhoosh() { if (this.audible) this.play('heroWhoosh'); }
  /** The title cards colliding. */
  swordClash() { if (this.audible) this.play('swordClash'); }
  /** A phase banner's bugle call: 1 → 3, 4 or 5. */
  phaseCall(step: 3 | 4 | 5) { this.play(`phaseCall${step}`); }
  /** A ring of tiles popping up as the board builds, `delay` s from now. */
  tilePop(delay = 0) { this.playIn('tilePop', delay); }

  /** A claim smashing into a defense: heavier with its power (0 … 8+). */
  claimSmash(power: number) { this.play(smashSoundName(power)); }

  // Optional extras — available but not yet wired into components.
  hoverTick() { this.play('hoverTick'); }
  coinSpend() { this.play('coinSpend'); }
  vpGain() { this.play('vpGain'); }
  phaseChange() { this.play('phaseChange'); }
  invalidAction() { this.play('invalidAction'); }
}

export const soundEngine = new SoundEngine();
