import { createAudioGraph, type AudioGraph } from './graph';
import { createMusicGraph, DistantMarch } from './music';
import { measureOutputDelay, soundLead } from './outputDelay';
import { SOUNDS, smashSoundName, type SoundName } from './sounds';

/** A sound that can be cut short (a charge-up while a button is held). */
export interface HeldSound {
  /** Fade it out now (default 120 ms). */
  stop: (fadeMs?: number) => void;
}

const SILENT: HeldSound = { stop: () => {} };

/** Fanfares the background music dips under. */
const DUCK_UNDER = new Set<SoundName>(['victoryJingle', 'defeatJingle', 'beginJingle']);

/**
 * Owns the (lazily created) AudioContext and master graph, and exposes one
 * method per sound. Recipes live in sounds.ts; the master bus in graph.ts.
 * Nothing sounds until the page has had a gesture (a click, tap or key) —
 * browsers would only hold it back and let it out late. Background music
 * (music.ts) has its own bus, volume and on/off; it plays where a screen
 * turns it on (the lobby and the game) and pauses while the tab is hidden.
 */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private enabled = true;
  private volume = 1;
  /** Off until the player turns it on in the settings. */
  private musicEnabled = false;
  private musicVolume = 0.5;
  private musicHeld = false;
  /** Screens that want music turn it on (the lobby, the game). */
  private musicActive = false;
  /** The page has had a click, tap or key press. */
  private gestured = false;
  private music: DistantMarch | null = null;
  private unavailable = false;
  private unlockBound = false;
  /** The output's delay (ms), measured now and then (see outputDelay.ts). */
  private delay: number | null = null;
  private delayAt = -Infinity;

  constructor() {
    this.bindUnlock();
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => this.syncMusic());
    }
    // Headphones connected or unplugged: measure the output afresh.
    if (typeof navigator !== 'undefined') navigator.mediaDevices?.addEventListener?.('devicechange', () => { this.delayAt = -Infinity; });
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
      this.gestured = true;
      if (!this.enabled && !this.musicEnabled) return;
      const graph = this.ensureContext();
      this.syncMusic();
      if (!graph || this.ctx?.state === 'running') {
        events.forEach((e) => window.removeEventListener(e, unlock, true));
        this.unlockBound = false;
      }
    };
    events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }));
  }

  private ensureContext(): AudioGraph | null {
    if (this.unavailable) return null;
    if (!this.graph) {
      // Before a gesture the browser would only queue it all up.
      if (!this.gestured) return null;
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
        // Chrome: the output moved to another device.
        this.ctx.addEventListener?.('sinkchange', () => { this.delayAt = -Infinity; });
      } catch (e) {
        console.warn('[SoundEngine] audio unavailable', e);
        this.unavailable = true;
        return null;
      }
    }
    // Resume if suspended (browser autoplay policy) or interrupted (Safari).
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') {
      this.ctx.resume().catch(() => { /* needs a user gesture; next play retries */ });
    }
    return this.graph;
  }

  // ── Keeping sounds in time with the screen ─────────────────────────

  /** How long (ms) a sound started now takes to be heard; null if unknown. */
  outputDelay(): number | null {
    return this.ctx ? measureOutputDelay(this.ctx) : null;
  }

  /**
   * How far ahead (ms) sounds start so they're heard with what they belong
   * to: the output's delay beyond the usual (Bluetooth headphones ≈ 150–250
   * ms). Re-measured every couple of seconds — it changes when headphones
   * connect or disconnect.
   */
  get leadMs(): number {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    if (now - this.delayAt > 2000) {
      const d = this.outputDelay();
      if (d != null) { this.delay = d; this.delayAt = now; }
    }
    return soundLead(this.delay);
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
    this.syncMusic();
  }

  /** A screen that has music (the lobby, the game) turns it on; the home screen turns it off. */
  setMusicActive(on: boolean) {
    this.musicActive = on;
    this.syncMusic();
  }

  /** Hold the music silent (the lobby countdown), or let it play again. */
  holdMusic(on: boolean) {
    this.musicHeld = on;
    this.syncMusic();
  }

  /** Whether a screen has the music on (to put it back as it was). */
  get musicOn(): boolean { return this.musicActive; }

  /** Start the music over from the top (a new game). */
  restartMusic() {
    this.musicHeld = false;
    this.musicActive = true;
    this.music?.stop(0.4);
    this.syncMusic();
  }

  /** Music plays where a screen wants it, while it's on (and not held), once
   *  the page has had a gesture, and while the tab is visible. */
  private syncMusic() {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const want = this.musicEnabled && this.musicActive && !hidden && !this.musicHeld;
    if (want && !this.music) this.ensureContext();
    const music = this.music;
    if (!music) return;
    if (want) {
      if (!music.playing) {
        this.ensureContext();
        music.start();
      }
    } else if (music.playing) {
      music.stop();
    }
  }

  /** Debug: the context, for measuring how late sounds are heard. */
  get context(): AudioContext | null { return this.ctx; }

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

  /** Play a sound so it's heard `delay` seconds from now — with whatever
   *  happens on screen then (it starts early by the output's extra delay). */
  playIn(name: SoundName, delay: number) {
    if (!this.enabled) return;
    const graph = this.ensureContext();
    if (!graph) return;
    try {
      SOUNDS[name].play(graph, graph.ctx.currentTime + Math.max(0, delay - this.leadMs / 1000));
    } catch (e) {
      console.warn(`[SoundEngine] failed to play ${name}`, e);
    }
  }

  /** A sound that belongs to something `inMs` from now on screen — a claim
   *  about to smash into a tile, the next card of a deal — heard right on it. */
  cue(name: SoundName, inMs: number) {
    this.playIn(name, Math.max(0, inMs) / 1000);
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
  /** A phase banner's bugle call: 1 → 3, 4 or 5. */
  phaseCall(step: 3 | 4 | 5) { this.play(`phaseCall${step}`); }
  /** The tutorial pointing something out: your base, the rival's, a star hex, glowing tiles. */
  spotlightYou() { this.play('spotlightYou'); }
  spotlightRival() { this.play('spotlightRival'); }
  spotlightStar() { this.play('spotlightStar'); }
  tileGlow() { this.play('tileGlow'); }
  tileAbandon() { this.play('tileAbandon'); }
  tileScorch() { this.play('tileScorch'); }
  floodWave() { this.play('floodWave'); }
  powerBonus() { this.play('powerBonus'); }
  coinGain() { this.play('coinGain'); }
  flagPlant() { this.play('flagPlant'); }
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
if (import.meta.env?.DEV && typeof window !== 'undefined') (window as unknown as { __sound?: unknown }).__sound = soundEngine;
