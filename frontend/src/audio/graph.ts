/**
 * Master bus shared by every sound:
 *
 *   voices ─> input (dry) ─────────────────────────────┐
 *   voices ─> send ─> HPF ─> Convolver ─> LPF ─> return ┴> mix ─> subsonic HPF ─> glue comp ─> limiter ─> volume ─> out
 *
 * The convolver uses a procedurally generated warm room IR. The glue
 * compressor gently evens out overlaps; the limiter keeps stacked sounds
 * from clipping even at volume 1.0. Volume is applied after the limiter so
 * dynamics behave the same at every volume setting.
 */
import { createImpulseResponse, createNoiseBank, dbToGain, type Bus, type Ctx, type NoiseBank } from './synth';

export interface AudioGraph extends Bus {
  ctx: Ctx;
  input: GainNode;
  send: GainNode;
  noise: NoiseBank;
  /** Final volume stage (0..1). */
  volume: GainNode;
  /** Exposed for offline analysis (render dry-only / wet-only). */
  dryTap: GainNode;
  wetTap: GainNode;
}

/**
 * Chrome/Firefox/Safari compressors apply automatic make-up gain
 * (~0.6 × the gain reduction at 0 dBFS). With the settings below that is
 * ≈ +4.8 dB (glue) + ≈ +1.2 dB (limiter); this trim cancels it so recipe
 * levels map roughly 1:1 to output for signals under threshold.
 */
const MAKEUP_TRIM_DB = -6;

export function createAudioGraph(ctx: Ctx, destination: AudioNode = ctx.destination): AudioGraph {
  const noise = createNoiseBank(ctx);

  const input = ctx.createGain();
  const send = ctx.createGain();
  const dryTap = ctx.createGain();
  const wetTap = ctx.createGain();
  const mix = ctx.createGain();
  mix.gain.value = dbToGain(MAKEUP_TRIM_DB);

  // Reverb: keep lows and harsh highs out of the tail.
  const revHp = ctx.createBiquadFilter();
  revHp.type = 'highpass';
  revHp.frequency.value = 220;
  revHp.Q.value = 0.6;
  const convolver = ctx.createConvolver();
  convolver.normalize = false;
  convolver.buffer = createImpulseResponse(ctx);
  const revLp = ctx.createBiquadFilter();
  revLp.type = 'lowpass';
  revLp.frequency.value = 6500;
  revLp.Q.value = 0.5;
  const ret = ctx.createGain();
  ret.gain.value = 0.7;

  const subsonic = ctx.createBiquadFilter();
  subsonic.type = 'highpass';
  subsonic.frequency.value = 28;
  subsonic.Q.value = 0.7;

  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -16;
  glue.knee.value = 10;
  glue.ratio.value = 2;
  glue.attack.value = 0.012;
  glue.release.value = 0.25;

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.12;

  // Chrome's compressor starts fully "clamped" and releases from there, which
  // would duck whatever plays in the first few hundred ms after the context is
  // created (usually the very first sound). Release almost instantly at start.
  const t = ctx.currentTime;
  for (const c of [glue, limiter]) {
    const r = c.release.value;
    c.release.setValueAtTime(0.001, t);
    c.release.setValueAtTime(r, t + 0.02);
  }

  const volume = ctx.createGain();

  input.connect(dryTap).connect(mix);
  send.connect(revHp).connect(convolver).connect(revLp).connect(ret).connect(wetTap).connect(mix);
  mix.connect(subsonic).connect(glue).connect(limiter).connect(volume).connect(destination);

  return { ctx, input, send, noise, volume, dryTap, wetTap };
}
