import { createAudioGraph, type AudioGraph } from './graph';
import { SOUNDS, type SoundName } from './sounds';

/**
 * Owns the (lazily created) AudioContext and master graph, and exposes one
 * method per sound. Recipes live in sounds.ts; the master bus in graph.ts.
 */
class SoundEngine {
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private enabled = true;
  private volume = 1;
  private unavailable = false;
  private unlockBound = false;

  constructor() {
    this.bindUnlock();
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
      if (!this.enabled) return;
      const graph = this.ensureContext();
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

  /** Play any sound by name. Audio failures never propagate into game code. */
  play(name: SoundName) {
    if (!this.enabled) return;
    const graph = this.ensureContext();
    if (!graph) return;
    try {
      SOUNDS[name].play(graph);
    } catch (e) {
      console.warn(`[SoundEngine] failed to play ${name}`, e);
    }
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
  beginJingle() { this.play('beginJingle'); }

  // Optional extras — available but not yet wired into components.
  hoverTick() { this.play('hoverTick'); }
  coinSpend() { this.play('coinSpend'); }
  vpGain() { this.play('vpGain'); }
  phaseChange() { this.play('phaseChange'); }
  invalidAction() { this.play('invalidAction'); }
}

export const soundEngine = new SoundEngine();
