import { CARD_H, CARD_W, type Pose } from './cardMotion';

/** Fraction of a resting hand card that shows above the screen's bottom
 *  edge — the name, art, stats and type line; hover reveals the rest. */
export const REST_VISIBLE = 0.6;
/** Gap between hand cards when there's room for them all side by side. */
const GAP = 10;

export interface HandSizing {
  /** Scale of a resting card. */
  rest: number;
  /** Scale of the hovered / inspected card. */
  hover: number;
}

/** Card scales for a viewport: big enough that names read at rest, and the
 *  hovered card always fits on screen. */
export function handSizing(viewportW: number, viewportH: number): HandSizing {
  const rest = Math.max(0.42, Math.min(0.74, (viewportH * 0.27) / CARD_H, (viewportW * 0.2) / CARD_W));
  const hover = Math.max(rest, Math.min(1.08, (viewportH - 70) / CARD_H));
  return { rest, hover };
}

/** Height of the strip the hand (and piles) reserve at the bottom of the
 *  screen. Resting cards rise out of it a little over the board. */
export function handStripHeight(s: HandSizing): number {
  return Math.round(Math.max(96, CARD_H * s.rest * REST_VISIBLE * 0.78));
}

export interface HandLayoutInput {
  count: number;
  /** Width of the hand container (px). */
  width: number;
  /** Height of the hand container; its bottom edge is the screen's bottom. */
  height: number;
  sizing: HandSizing;
  hovered?: number | null;
  selected?: number | null;
  /** Card being dragged (held up, unrotated). */
  lifted?: number | null;
  /** While reordering, the lifted card follows the pointer's x. */
  liftedX?: number | null;
  /** Cards picked in a trash/discard selection (raised a little). */
  raised?: ReadonlySet<number>;
}

export interface SlotPose extends Pose {
  z: number;
}

export interface HandLayout {
  poses: SlotPose[];
  /** Hover strips at rest: card i owns [left, right) horizontally. */
  strips: { left: number; right: number }[];
  /** Top of the resting hand (container px) — the hover band starts here. */
  bandTop: number;
  restW: number;
  restH: number;
}

/**
 * Lay out a fanned hand. Cards sit side by side when they fit and overlap
 * (like cards held in a hand) when they don't, each later card on top of
 * the one before. A slight fan rotation and arc follow the position in the
 * hand. The hovered card straightens, grows to full size and rises fully on
 * screen, nudging its neighbors aside; a selected card rises a little.
 */
export function layoutHand(input: HandLayoutInput): HandLayout {
  const { count: n, width, height, sizing, hovered = null, selected = null, lifted = null, liftedX = null, raised } = input;
  const restW = CARD_W * sizing.rest;
  const restH = CARD_H * sizing.rest;
  const hoverW = CARD_W * sizing.hover;
  const hoverH = CARD_H * sizing.hover;

  // Spacing between card centers: side by side, or overlapping to fit.
  let spacing = restW + GAP;
  if (n > 1 && n * restW + (n - 1) * GAP > width) {
    spacing = Math.max(restW * 0.24, (width - restW) / (n - 1));
  }
  const total = restW + Math.max(0, n - 1) * spacing;
  const startX = (width - total) / 2 + restW / 2;
  const mid = (n - 1) / 2;
  const fanStep = n <= 1 ? 0 : Math.min(3.2, 22 / n);
  const arcDepth = Math.min(20, restH * 0.012 * n);

  const restRise = restH * (REST_VISIBLE - 0.5);
  const bandTop = height - restH * REST_VISIBLE - 4;

  // Neighbors make room for the hovered card.
  const focus = hovered ?? null;
  const push = focus !== null ? Math.max(0, (hoverW / 2 + restW / 2 - spacing) * 0.6) : 0;

  const poses: SlotPose[] = [];
  const strips: { left: number; right: number }[] = [];
  for (let i = 0; i < n; i++) {
    const restX = startX + i * spacing;
    const off = mid > 0 ? (i - mid) / mid : 0;
    let x = restX;
    let rise = restRise - arcDepth * off * off;
    let rot = (i - mid) * fanStep;
    let scale = sizing.rest;
    let z = i + 1;

    if (focus !== null && i !== focus) x += i < focus ? -push : push;

    if (i === lifted) {
      scale = sizing.rest * 1.04;
      rise = restH * 1.04 * 0.5 + 6;
      rot = 0;
      z = 1001;
      if (liftedX != null) x = liftedX;
    } else if (i === focus) {
      scale = sizing.hover;
      rise = hoverH / 2 + 10;
      rot = 0;
      z = 1000;
    } else if (i === selected) {
      rise += restH * 0.2;
      z = n + 2;
    } else if (raised?.has(i)) {
      rise += restH * 0.14;
    }

    poses.push({ x, y: height - rise, rot, scale, z });
    const left = restX - restW / 2;
    const nextLeft = i < n - 1 ? startX + (i + 1) * spacing - restW / 2 : Infinity;
    strips.push({ left, right: Math.min(left + restW, nextLeft) });
  }
  return { poses, strips, bandTop, restW, restH };
}

/** Which card's resting strip holds x (null over a gap or past the ends). */
export function stripAt(strips: { left: number; right: number }[], x: number): number | null {
  for (let i = strips.length - 1; i >= 0; i--) {
    if (x >= strips[i].left && x < strips[i].right) return i;
  }
  return null;
}

/** The slot nearest x — where a card being reordered would land. */
export function nearestSlot(poses: { x: number }[], x: number): number {
  let best = 0;
  for (let i = 1; i < poses.length; i++) {
    if (Math.abs(poses[i].x - x) < Math.abs(poses[best].x - x)) best = i;
  }
  return best;
}

/** Offset a layout horizontally (it was computed in a narrower band). */
export function shiftLayout(l: HandLayout, dx: number): HandLayout {
  if (!dx) return l;
  return {
    ...l,
    poses: l.poses.map(p => ({ ...p, x: p.x + dx })),
    strips: l.strips.map(st => ({ left: st.left + dx, right: st.right + dx })),
  };
}

/**
 * The player's arrangement of their hand (card ids, left → right) after the
 * hand or the cards in play change. Cards stay where they are, and a card
 * played this round keeps its slot so an undo slides it back. Anything else
 * that joins the hand (drawn, tutored, the next round's deal) goes on the
 * right, even when that card id sat in the hand in an earlier round.
 *
 * `held` is every id that was in the hand or in play before the change.
 */
export function reconcileHandOrder(
  prevOrder: readonly string[],
  held: ReadonlySet<string>,
  hand: readonly string[],
  inPlay: ReadonlySet<string>,
): string[] {
  const inHand = new Set(hand);
  const out: string[] = [];
  const placed = new Set<string>();
  for (const id of prevOrder) {
    if (placed.has(id)) continue;
    if (inHand.has(id) ? held.has(id) : inPlay.has(id)) { out.push(id); placed.add(id); }
  }
  for (const id of hand) if (!placed.has(id)) { out.push(id); placed.add(id); }
  return out;
}
