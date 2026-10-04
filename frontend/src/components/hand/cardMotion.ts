import { CARD_FULL_HEIGHT, CARD_FULL_WIDTH } from '../CardFull';

/**
 * Card motion: every card on screen (hand slots, flights, pile tops) is a
 * 220 × 308 CardFull box placed by a Pose. A Pose is the card's center in
 * screen (or container) px, its in-plane screen rotation and scale, plus an
 * optional "lying on the table" tilt used by the 3D piles.
 */
export const CARD_W = CARD_FULL_WIDTH;
export const CARD_H = CARD_FULL_HEIGHT;

/** Pile geometry, shared by CardPile (rendering) and flights (landing). */
export const PILE_CARD_W = 64;
export const PILE_SCALE = PILE_CARD_W / CARD_W;
/** How far the pile's cards lie back from the viewer (deg). */
export const PILE_TILT = 56;
export const PILE_PERSPECTIVE = 320;
/** Height of one card's edge in a pile (px). */
export const PILE_LAYER = 1.15;
/** Most layers a pile draws; bigger piles still read right from the count. */
export const PILE_MAX_LAYERS = 60;

export interface Pose {
  x: number;
  y: number;
  /** In-plane screen rotation (deg). */
  rot: number;
  scale: number;
  /** Tilt back from the viewer around the card's horizontal axis (deg). */
  tilt?: number;
  /** Rotation within the tilted plane (deg) — a pile card's jitter. */
  spin?: number;
  opacity?: number;
}

export function poseTransform(p: Pose): string {
  return `translate(${p.x - CARD_W / 2}px, ${p.y - CARD_H / 2}px) rotate(${p.rot}deg) perspective(${PILE_PERSPECTIVE}px) rotateX(${p.tilt ?? 0}deg) rotateZ(${p.spin ?? 0}deg) scale(${p.scale})`;
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeIn = (t: number) => t * t * t;

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    rot: lerp(a.rot, b.rot, t),
    scale: lerp(a.scale, b.scale, t),
    tilt: lerp(a.tilt ?? 0, b.tilt ?? 0, t),
    spin: lerp(a.spin ?? 0, b.spin ?? 0, t),
    opacity: lerp(a.opacity ?? 1, b.opacity ?? 1, t),
  };
}

export interface PathOptions {
  /** Upward bow of the path at its midpoint (px). */
  arc?: number;
  /** Progress easing along the path. */
  ease?: (t: number) => number;
  /** Number of sampled keyframes. */
  samples?: number;
  /** Opacity curve over linear time (defaults to the poses' own opacities). */
  opacity?: (t: number) => number;
  /** Extra scale multiplier over linear time (a "lift" swell mid-flight). */
  swell?: (t: number) => number;
}

/** Keyframes moving a card between two absolute poses along a bowed path. */
export function flightKeyframes(from: Pose, to: Pose, opts: PathOptions = {}): Keyframe[] {
  const { arc = 0, ease = easeInOut, samples = 10, opacity, swell } = opts;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = lerpPose(from, to, ease(t));
    p.y -= arc * 4 * t * (1 - t);
    if (swell) p.scale *= swell(t);
    frames.push({
      offset: t,
      transform: poseTransform(p),
      opacity: opacity ? opacity(t) : p.opacity ?? 1,
    });
  }
  return frames;
}

/**
 * Keyframes for a hand card's inner wrapper so it appears to fly from
 * `start` (an absolute pose, e.g. the draw pile's top card) into its slot,
 * ending at identity. The wrapper sits inside the slot element, so each
 * frame expresses the start pose in the slot's local (rotated, scaled)
 * frame; the offset decays to nothing, which keeps the landing exact even
 * if the slot moves while the card is in the air.
 */
export function enterKeyframes(slot: Pose, start: Pose, opts: PathOptions = {}): Keyframe[] {
  const { arc = 0, ease = easeInOut, samples = 10, opacity, swell } = opts;
  const r = (slot.rot * Math.PI) / 180;
  const cos = Math.cos(-r), sin = Math.sin(-r);
  const toLocal = (dx: number, dy: number) => ({
    x: (dx * cos - dy * sin) / slot.scale,
    y: (dx * sin + dy * cos) / slot.scale,
  });
  const frames: Keyframe[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const e = ease(t);
    const k = 1 - e; // remaining share of the start offset
    const lift = arc * 4 * t * (1 - t);
    const d = toLocal((start.x - slot.x) * k, (start.y - slot.y) * k - lift);
    // Scale relative to the slot: start.scale/slot.scale → 1.
    const rel = lerp(start.scale / slot.scale, 1, e) * (swell ? swell(t) : 1);
    const transform =
      `translate(${d.x}px, ${d.y}px) rotate(${lerp(start.rot - slot.rot, 0, e)}deg) ` +
      `perspective(${PILE_PERSPECTIVE / slot.scale}px) rotateX(${lerp(start.tilt ?? 0, 0, e)}deg) ` +
      `rotateZ(${lerp(start.spin ?? 0, 0, e)}deg) scale(${rel})`;
    frames.push({ offset: t, transform, opacity: opacity ? opacity(t) : lerp(start.opacity ?? 1, 1, e) });
  }
  return frames;
}

/** Element.animate when available (absent in jsdom); resolves when done. */
export function runAnimation(el: Element | null, frames: Keyframe[], options: KeyframeAnimationOptions): Promise<void> {
  if (!el || typeof (el as HTMLElement).animate !== 'function') return Promise.resolve();
  const anim = (el as HTMLElement).animate(frames, options);
  return anim.finished.then(() => undefined, () => undefined);
}

/** Center + rect of the element matching a selector (pile tops, etc.). */
export function elementCenter(selector: string): { x: number; y: number; rect: DOMRect } | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
}

/** Deterministic small jitter per card id, so a pile looks hand-stacked. */
export function jitter(id: string, range: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 2 * range;
}
