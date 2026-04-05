import * as sounds from './sounds';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private enabled = true;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
      this.noiseBuf = sounds.createNoiseBuffer(this.ctx);
    }
    // Resume if suspended (browser autoplay policy)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  private get dest(): GainNode {
    this.ensureContext();
    return this.masterGain!;
  }

  private get noise(): AudioBuffer {
    this.ensureContext();
    return this.noiseBuf!;
  }

  setVolume(v: number) {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(1, v));
    }
  }

  setEnabled(on: boolean) {
    this.enabled = on;
  }

  private ok(): boolean {
    return this.enabled;
  }

  cardDraw() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.cardDraw(ctx, this.dest, this.noise);
  }

  cardPlay() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.cardPlay(ctx, this.dest, this.noise);
  }

  cardDiscard() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.cardDiscard(ctx, this.dest, this.noise);
  }

  cardPurchase() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.cardPurchase(ctx, this.dest, this.noise);
  }

  tileSelect() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.tileSelect(ctx, this.dest);
  }

  countdownTick() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.countdownTick(ctx, this.dest);
  }

  countdownGo() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.countdownGo(ctx, this.dest);
  }

  buttonClick() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.buttonClick(ctx, this.dest);
  }

  deckShuffle() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.deckShuffle(ctx, this.dest, this.noise);
  }

  victoryJingle() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.victoryJingle(ctx, this.dest);
  }

  defeatJingle() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.defeatJingle(ctx, this.dest);
  }

  resolveTileOccupied() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.resolveTileOccupied(ctx, this.dest, this.noise);
  }

  resolveContested() {
    if (!this.ok()) return;
    const ctx = this.ensureContext();
    sounds.resolveContested(ctx, this.dest);
  }
}

export const soundEngine = new SoundEngine();
