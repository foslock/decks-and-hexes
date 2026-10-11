import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull from './CardFull';
import CardBack from './CardBack';
import type { SubtitlePart } from './cardSubtitle';
import { CARD_H, CARD_W, runAnimation } from './hand/cardMotion';
import { PLAYER_COLORS } from '../board3d/boardTypes';
import { cursor } from '../utils/cursors';
import { useAnimated, useResolveSpeed } from './SettingsContext';

/** A played card shown on the board (over its tile) or in the engine queue. */
export interface BoardCardEntry {
  /** Unique per card instance and tile (a multi-target card has one per tile). */
  key: string;
  card: Card;
  /** Stat plaque frozen at play time (effective power, resolved gains). */
  subtitleParts?: SubtitlePart[];
  playerId: string;
  playerName?: string;
  /** Hidden while the card's flight from the hand is still landing. */
  arriving?: boolean;
  /** An opponent's card turned face up at the reveal (flips in). */
  revealed?: boolean;
  /** Played face down: shows its back (no zoom) until it turns over. */
  faceDown?: boolean;
  /** In one pile with the same player's other stacked cards on the tile —
   *  face down at the reveal until they spread out to turn over, face up
   *  when a tile's plays are reviewed. */
  stacked?: boolean;
  /** Pulse (a War Banner whose buff a hovered/selected Claim will use). */
  pulse?: boolean;
}

/** Board card size at board zoom 1, and its bounds as the board zooms. */
const BOARD_CARD_SCALE = 0.24;
export function boardCardScale(zoom: number): number {
  return Math.max(0.17, Math.min(0.36, BOARD_CARD_SCALE * zoom));
}
/** Cards on the tile currently resolving grow to this. */
const FOCUS_SCALE = 0.44;
/** Engine queue cards (under the player's ID card). */
export const QUEUE_CARD_SCALE = 0.25;
/** The Played box holds this many cards per row, then wraps. */
const QUEUE_PER_ROW = 3;
/** The hover zoom. */
const ZOOM_SCALE = 0.8;
/** Tile cards at rest are see-through so the board shows under them. */
const REST_OPACITY = 0.4;
/** While a card is dragged or aimed at a tile they stay readable… */
const AIM_REST_OPACITY = 0.8;
/** …except the pile the pointer comes near, which fades out of the way. */
const AIMING_OPACITY = 0.15;
/** How near (px from a pile's box) counts as near. */
const AIM_NEAR_PX = 56;

/** Where the pointer was last seen (piles check it as soon as aiming starts). */
let lastPointer: { x: number; y: number } | null = null;
let pointerTracked = false;
function trackPointer() {
  if (pointerTracked || typeof window === 'undefined') return;
  pointerTracked = true;
  window.addEventListener('pointermove', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
  window.addEventListener('pointerdown', (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, { passive: true, capture: true });
}

/** While `on`, whether the pointer is within AIM_NEAR_PX of the element's box
 *  (rechecked as the pointer moves, and now and then as the board moves). */
function usePointerNear(ref: React.RefObject<HTMLElement | null>, on: boolean): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!on) { setNear(false); return; }
    trackPointer();
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = ref.current;
      const p = lastPointer;
      if (!el || !p) { setNear(false); return; }
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - p.x, 0, p.x - r.right);
      const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      setNear(Math.hypot(dx, dy) < AIM_NEAR_PX);
    };
    const onMove = () => { if (!raf) raf = requestAnimationFrame(check); };
    window.addEventListener('pointermove', onMove, { passive: true });
    const timer = setInterval(onMove, 150);
    check();
    return () => {
      window.removeEventListener('pointermove', onMove);
      clearInterval(timer);
      cancelAnimationFrame(raf);
    };
  }, [on, ref]);
  return near;
}
/** Matches the card box's size transition, so a growing card scales in step
 *  with its box instead of snapping out of its top-left corner. */
const SIZE_EASE = '0.25s ease';

/** Gap between cards sharing a tile (px). */
const STACK_GAP = 8;
/** Horizontal offset (center) of card i of n laid side by side over a tile
 *  (px at scale s). Cards on one tile never overlap (piles aside). */
export function fanOffset(i: number, n: number, s: number): number {
  return (i - (n - 1) / 2) * (CARD_W * s + STACK_GAP);
}

/** Where each card sits in a tile's row: a player's stacked cards share one
 *  slot as a pile (depth 0 on top); every other card has its own. */
export function tileSlots(entries: BoardCardEntry[]): { slot: number[]; depth: number[]; pile: number[]; slots: number } {
  const piled = (e: BoardCardEntry) => !!e.stacked;
  const count = new Map<string, number>();
  for (const e of entries) if (piled(e)) count.set(e.playerId, (count.get(e.playerId) ?? 0) + 1);
  const at = new Map<string, number>();
  const seen = new Map<string, number>();
  const slot: number[] = [], depth: number[] = [], pile: number[] = [];
  let slots = 0;
  for (const e of entries) {
    const n = piled(e) ? count.get(e.playerId) ?? 0 : 0;
    if (n > 1) {
      if (!at.has(e.playerId)) at.set(e.playerId, slots++);
      slot.push(at.get(e.playerId)!);
      const d = seen.get(e.playerId) ?? 0;
      seen.set(e.playerId, d + 1);
      depth.push(d);
      pile.push(n);
    } else {
      slot.push(slots++);
      depth.push(0);
      pile.push(1);
    }
  }
  return { slot, depth, pile, slots };
}

/** A card's place in its pile: the ones under the top peek out askew. */
function pileTransform(depth: number, size: number, w: number, h: number): string | undefined {
  if (size < 2) return undefined;
  const dx = (depth - (size - 1) / 2) * w * 0.12;
  const dy = -depth * h * 0.05;
  const rot = depth === 0 ? -2 : depth % 2 ? 7 : -6;
  return `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
}

function playerColor(pid: string): string {
  const n = PLAYER_COLORS[pid];
  return n != null ? `#${n.toString(16).padStart(6, '0')}` : '#888';
}

/** How long a face-down board card takes to turn over (ms, at resolve speed 1). */
export const BOARD_FLIP_MS = 520;
/** The turn-over animation's id (so the resolve can wait for it to finish). */
export const BOARD_FLIP_ID = 'board-card-flip';

/** A card back scaled down to `scale`, laid over the card's face while it's face down. */
function ScaledBack({ scale }: { scale: number }) {
  return (
    <div style={{ width: CARD_W, height: CARD_H, transform: `scale(${scale})`, transformOrigin: '0 0', transition: `transform ${SIZE_EASE}`, pointerEvents: 'none' }}>
      <CardBack />
    </div>
  );
}

/** A full card face scaled down to `scale`, top-left anchored in a box of its visual size. */
function ScaledFace({ entry, scale }: { entry: BoardCardEntry; scale: number }) {
  return (
    <div style={{ width: CARD_W, height: CARD_H, transform: `scale(${scale})`, transformOrigin: '0 0', transition: `transform ${SIZE_EASE}`, pointerEvents: 'none' }}>
      <CardFull card={entry.card} subtitleParts={entry.subtitleParts} />
    </div>
  );
}

/**
 * The hover zoom: the card grows out of its mini copy to a readable size,
 * above it (or below, near the top of the screen) or to its right.
 */
function HoverZoom({ entry, from, placement, hint, hangsBelow }: {
  entry: BoardCardEntry;
  from: DOMRect;
  placement: 'above' | 'right';
  hint?: string;
  /** Its row hangs below the tile (GameBoard marks it data-below). */
  hangsBelow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const animated = useAnimated();
  const w = CARD_W * ZOOM_SCALE;
  const h = CARD_H * ZOOM_SCALE;
  let cx: number;
  let cy: number;
  if (placement === 'right') {
    cx = from.right + 14 + w / 2;
    cy = from.top + from.height / 2;
  } else {
    cx = from.left + from.width / 2;
    cy = from.top - 12 - h / 2;
    // A row hanging below its tile opens downward, so the zoom never sits
    // on the tile itself.
    if (cy - h / 2 < 8 || (hangsBelow && from.bottom + 12 + h <= window.innerHeight - 8)) cy = from.bottom + 12 + h / 2;
  }
  cx = Math.max(8 + w / 2, Math.min(window.innerWidth - 8 - w / 2, cx));
  cy = Math.max(8 + h / 2, Math.min(window.innerHeight - 8 - h / 2 - (hint ? 22 : 0), cy));
  const to = `translate(${cx - CARD_W / 2}px, ${cy - CARD_H / 2}px) scale(${ZOOM_SCALE})`;

  useLayoutEffect(() => {
    if (!animated) return;
    const s0 = from.width / CARD_W;
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    runAnimation(ref.current, [
      { transform: `translate(${fx - CARD_W / 2}px, ${fy - CARD_H / 2}px) scale(${s0})`, opacity: 0.6 },
      { transform: to, opacity: 1 },
    ], { duration: 160, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)' });
    // The zoom plays once per hover.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return createPortal(
    <div ref={ref} style={{
      position: 'fixed', left: 0, top: 0, width: CARD_W, height: CARD_H,
      transform: to, transformOrigin: '50% 50%', pointerEvents: 'none', zIndex: 20000,
      filter: 'drop-shadow(0 14px 28px rgba(0,0,0,0.6))',
    }}>
      <CardFull card={entry.card} subtitleParts={entry.subtitleParts} />
      {hint && (
        <div style={{
          position: 'absolute', left: '50%', top: '100%', marginTop: 8 / ZOOM_SCALE,
          transform: `translateX(-50%) scale(${1 / ZOOM_SCALE})`, transformOrigin: '50% 0',
          whiteSpace: 'nowrap', fontSize: 11, color: '#d8d6e8', background: 'rgba(12, 12, 30, 0.92)',
          border: '1px solid rgba(232, 196, 106, 0.35)', borderRadius: 6, padding: '2px 8px',
        }}>
          {hint}
        </div>
      )}
    </div>,
    document.body,
  );
}

const HOLD_MS = 550;
/** How long the pointer rests on a board card before its zoom opens. */
const HOVER_DELAY_MS = 220;

/** One mini card: hover to zoom, click to open, hold to undo (when offered). */
function MiniCard({ entry, scale, style, placement, onOpen, onUndo, glow, still, count }: {
  entry: BoardCardEntry;
  scale: number;
  style?: CSSProperties;
  placement: 'above' | 'right';
  onOpen: () => void;
  onUndo?: () => void;
  /** Ring the card in this color even if it isn't attributed to a player
   *  (players share its tile). Attributed cards ring in their player's color. */
  glow?: string;
  /** No hover zoom or open (the resolve is playing; previews get in the way). */
  still?: boolean;
  /** Top of a face-down pile: how many cards it holds (rides on its corner,
   *  so it follows the card as the board zooms). */
  count?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endHover = () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    setHoverRect(null);
  };
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undone = useRef(false);
  const stopHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  };
  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);
  // Face down → face up: the card turns edge-on showing its back, then the
  // face comes round (the back drops away at the edge-on moment).
  const animated = useAnimated();
  const resolveSpeed = useResolveSpeed();
  const flipRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const [showBack, setShowBack] = useState(!!entry.faceDown);
  const wasDown = useRef(!!entry.faceDown);
  useEffect(() => {
    const down = !!entry.faceDown;
    if (down === wasDown.current) return;
    wasDown.current = down;
    const canAnimate = typeof flipRef.current?.animate === 'function' && !!backRef.current;
    if (down || !animated || !canAnimate) { setShowBack(down); return; }
    let live = true;
    const timing: KeyframeAnimationOptions = { duration: Math.round(BOARD_FLIP_MS * (resolveSpeed || 1)), easing: 'linear' };
    const turn = flipRef.current!.animate([
      { offset: 0, transform: 'perspective(600px) rotateY(0deg) scale(1)', easing: 'ease-in' },
      { offset: 0.5, transform: 'perspective(600px) rotateY(90deg) scale(1.08)' },
      { offset: 0.5, transform: 'perspective(600px) rotateY(-90deg) scale(1.08)', easing: 'ease-out' },
      { offset: 1, transform: 'perspective(600px) rotateY(0deg) scale(1)' },
    ], timing);
    turn.id = BOARD_FLIP_ID;
    backRef.current!.animate([
      { offset: 0, opacity: 1 }, { offset: 0.5, opacity: 1 }, { offset: 0.5, opacity: 0 }, { offset: 1, opacity: 0 },
    ], { ...timing, fill: 'forwards' });
    turn.finished.then(() => { if (live) setShowBack(false); }, () => { if (live) setShowBack(false); });
    return () => { live = false; };
  }, [entry.faceDown, animated, resolveSpeed]);
  const hidden = !!entry.faceDown;
  const inert = hidden || !!still;
  // A zoom that was open when the resolve began closes.
  useEffect(() => {
    if (still) endHover();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still]);
  // Whose card it is: a glow all round it in their color, fading in once the
  // card is in place (not while it's still flying there).
  const [ringIn, setRingIn] = useState(false);
  useEffect(() => {
    if (entry.arriving) { setRingIn(false); return; }
    const id = requestAnimationFrame(() => setRingIn(true));
    return () => cancelAnimationFrame(id);
  }, [entry.arriving]);
  const ring = ringIn ? glow ?? (entry.playerName ? playerColor(entry.playerId) : undefined) : undefined;
  // A card that moves (fan reflow, focus) refreshes its zoom anchor.
  useEffect(() => {
    if (hoverRect && ref.current) setHoverRect(ref.current.getBoundingClientRect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale]);

  return (
    <div
      ref={ref}
      data-board-card={entry.key}
      className={entry.pulse ? 'war-banner-pulse' : undefined}
      // The zoom waits for a deliberate hover, so sweeping past a card on the
      // way to a tile doesn't throw it over the board.
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch' || inert) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => {
          hoverTimer.current = null;
          setHoverRect(ref.current?.getBoundingClientRect() ?? null);
        }, HOVER_DELAY_MS);
      }}
      onPointerLeave={() => { endHover(); stopHold(); }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!onUndo || e.button !== 0) return;
        undone.current = false;
        setHolding(true);
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          undone.current = true;
          setHolding(false);
          endHover();
          onUndo();
        }, HOLD_MS);
      }}
      onPointerUp={stopHold}
      onPointerCancel={stopHold}
      onClick={(e) => {
        e.stopPropagation();
        if (undone.current) { undone.current = false; return; }
        if (inert) return;
        endHover();
        onOpen();
      }}
      style={{
        width: CARD_W * scale,
        height: CARD_H * scale,
        cursor: inert ? cursor('arrow') : 'var(--cc-cursor-pointer)',
        borderRadius: 14 * scale,
        // In place the moment its flight lands (a fade would flicker). Not
        // quite 0 while it's on its way: Safari doesn't paint a fully
        // transparent card, so its art would come in dark when it shows.
        opacity: entry.arriving ? 0.001 : 1,
        transition: `transform 0.25s cubic-bezier(0.2, 0.8, 0.3, 1), width ${SIZE_EASE}, height ${SIZE_EASE}, left ${SIZE_EASE}, box-shadow 0.25s ease, filter 0.45s ease-out`,
        touchAction: 'none',
        ...style,
      }}
    >
      <div style={{ animation: entry.revealed ? 'cc-board-card-reveal 0.55s ease-out both' : undefined, transformOrigin: '50% 50%' }}>
        {/* The ring sits on the part that turns over, so it turns with the card. */}
        <div ref={flipRef} data-board-card-body style={{
          position: 'relative', width: CARD_W * scale, height: CARD_H * scale, transformOrigin: '50% 50%',
          borderRadius: 14 * scale,
          boxShadow: ring ? `0 0 0 2px ${ring}, 0 0 10px 3px ${ring}cc, 0 0 22px 6px ${ring}55` : undefined,
          transition: `width ${SIZE_EASE}, height ${SIZE_EASE}, box-shadow 0.45s ease-out`,
        }}>
          {/* The card itself (inside its player ring): the resolve pulses
              this, so the ring stays steady. */}
          <div data-board-card-face style={{ position: 'absolute', inset: 0, transformOrigin: '50% 50%', borderRadius: 14 * scale }}>
            <ScaledFace entry={entry} scale={scale} />
            {showBack && (
              <div ref={backRef} data-face-down style={{ position: 'absolute', left: 0, top: 0 }}>
                <ScaledBack scale={scale} />
              </div>
            )}
          </div>
        </div>
      </div>
      {holding && <div aria-hidden className="cc-board-card-hold" style={{ borderRadius: 14 * scale }} />}
      {count != null && count > 1 && (
        <div
          aria-label={`${count} cards`}
          className="cc-tile-pile-count"
          style={{ fontSize: Math.max(10, Math.min(16, CARD_W * scale * 0.2)), borderColor: playerColor(entry.playerId) }}
        >
          ×{count}
        </div>
      )}
      {hoverRect && !inert && (
        <HoverZoom
          entry={entry}
          from={hoverRect}
          placement={placement}
          hint={onUndo ? 'Hold to undo' : undefined}
          hangsBelow={!!ref.current?.closest('[data-below="1"]')}
        />
      )}
    </div>
  );
}

/**
 * The cards played on one tile, side by side above it (they never overlap,
 * so it's clear at a glance how many landed there). GameBoard positions the
 * row (bottom-center) over the tile each frame. At rest the row is
 * see-through; hovering it, opening it or resolving its tile makes it solid.
 */
export function TileCardStack({ entries, scale, focus, open, faded, passThrough, peek, still, onOpen, onUndo }: {
  entries: BoardCardEntry[];
  scale: number;
  /** This tile is resolving: its cards grow so everyone sees what was played. */
  focus?: boolean;
  /** Its cards are open in the zoom / detail view. */
  open?: boolean;
  /** A card is being dragged from the hand: see `passThrough`. */
  faded?: boolean;
  /** A card is being aimed at a tile: the pointer goes through to the tiles
   *  beneath (no hover zoom while picking a tile), and the cards stay at 80%
   *  except when the pointer comes near them — then they fade out of the way. */
  passThrough?: boolean;
  onOpen: (entries: BoardCardEntry[], index: number) => void;
  /** Hold a card to undo it (only the player's own undoable plays). */
  onUndo?: () => void;
  /** The resolve is playing: no hover zoom or open. */
  still?: boolean;
  /** Shown while its tile is hovered (reviewing a round): solid, and the
   *  pointer goes through to the board. */
  peek?: boolean;
}) {
  const [hot, setHot] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const aiming = !!(faded || passThrough) && !peek;
  const near = usePointerNear(rootRef, aiming);
  const s = focus ? Math.max(scale, FOCUS_SCALE) : scale;
  const n = entries.length;
  // Players sharing a tile: ring each card in its player's color.
  const mixed = new Set(entries.map(e => e.playerId)).size > 1;
  // Opening the tile's cards never shows ones still face down.
  const shown = entries.filter(e => !e.faceDown);
  const w = CARD_W * s;
  const h = CARD_H * s;
  const lay = tileSlots(entries);
  const m = lay.slots;
  const span = m > 1 ? Math.abs(fanOffset(m - 1, m, s) - fanOffset(0, m, s)) : 0;
  return (
    <div
      ref={rootRef}
      className={focus ? 'cc-tile-stack is-focus' : 'cc-tile-stack'}
      // Final height (the box eases toward it) — the board places the row
      // above or below its tile by the size it's growing to.
      data-stack-h={Math.round(h)}
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => setHot(false)}
      style={{
        position: 'relative',
        width: w + span,
        height: h,
        opacity: peek ? 1 : aiming ? (near ? AIMING_OPACITY : AIM_REST_OPACITY) : focus || open || hot ? 1 : REST_OPACITY,
        pointerEvents: peek || faded || passThrough ? 'none' : 'auto',
        transition: `opacity 0.2s ease-out, width ${SIZE_EASE}, height ${SIZE_EASE}`,
      }}
    >
      {entries.map((e, i) => (
        <MiniCard
          key={e.key}
          entry={e}
          scale={s}
          placement="above"
          onOpen={() => onOpen(shown, shown.indexOf(e))}
          onUndo={onUndo}
          glow={mixed ? playerColor(e.playerId) : undefined}
          still={still}
          count={lay.depth[i] === 0 ? lay.pile[i] : undefined}
          style={{
            position: 'absolute',
            left: (w + span) / 2 - w / 2 + fanOffset(lay.slot[i], m, s),
            bottom: 0,
            // Piles sit under every card that's out on its own (spread,
            // turning over, counting); within a pile the top card is highest.
            zIndex: lay.pile[i] > 1 ? lay.pile[i] - lay.depth[i] : n + 2 + i,
            transform: pileTransform(lay.depth[i], lay.pile[i], w, h),
            // The cards under the top one sit in its shadow.
            filter: lay.pile[i] > 1 && lay.depth[i] > 0 ? 'brightness(0.72)' : undefined,
          }}
        />
      ))}
    </div>
  );
}

/** Size of a rival's engine-card pile beside their ID card. */
const RIVAL_PILE_SCALE = 0.26;

/**
 * At the reveal, a rival's engine cards (no tile to land on) wait in a face
 * down pile beside their ID card until they peel off into it. The piles
 * follow the ID cards' rows (the player panel can move and resize), above
 * the HUD but under the overlays (shop, deck viewer…).
 */
export function RivalEnginePiles({ piles, rowOf }: {
  piles: { playerId: string; entries: BoardCardEntry[] }[];
  rowOf: (playerId: string) => HTMLElement | null | undefined;
}) {
  const boxes = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    let raf = 0;
    const place = () => {
      for (const [pid, el] of boxes.current) {
        const r = rowOf(pid)?.getBoundingClientRect();
        if (!r || r.width === 0) { el.style.visibility = 'hidden'; continue; }
        el.style.visibility = '';
        el.style.transform = `translate(${Math.round(r.right + 12)}px, ${Math.round(r.top + r.height / 2 - el.offsetHeight / 2)}px)`;
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [rowOf]);
  return createPortal(
    <>
      {piles.map(p => (
        <div
          key={p.playerId}
          ref={el => { if (el) boxes.current.set(p.playerId, el); else boxes.current.delete(p.playerId); }}
          style={{ position: 'fixed', left: 0, top: 0, zIndex: 400, pointerEvents: 'none', visibility: 'hidden' }}
        >
          <TileCardStack entries={p.entries} scale={RIVAL_PILE_SCALE} peek still onOpen={() => {}} />
        </div>
      ))}
    </>,
    document.body,
  );
}

/** Engine cards played this round (they resolve as they are played), under the player's ID card. */
export function EngineQueue({ entries, onOpen, containerRef, title = 'Played', still }: {
  entries: BoardCardEntry[];
  onOpen: (entries: BoardCardEntry[], index: number) => void;
  containerRef?: React.Ref<HTMLDivElement>;
  title?: string;
  /** The resolve is playing: no hover zoom or open. */
  still?: boolean;
}) {
  return (
    <div ref={containerRef} data-engine-queue>
      <div style={{ fontSize: 10, color: 'var(--cc-gold)', opacity: 0.8, textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'var(--cc-font-display)', fontWeight: 700, marginBottom: 5 }}>
        {title} ({entries.length})
      </div>
      {/* Only as wide as the cards it holds (up to three a row). */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(1, Math.min(entries.length, QUEUE_PER_ROW))}, ${CARD_W * QUEUE_CARD_SCALE}px)`,
        gap: 6,
      }}>
        {entries.map((e, i) => (
          <MiniCard key={e.key} entry={e} scale={QUEUE_CARD_SCALE} placement="right" onOpen={() => onOpen(entries, i)} style={{ position: 'relative' }} still={still} />
        ))}
      </div>
    </div>
  );
}

/** The detail overlay shows cards half again their size. */
const DETAIL_SCALE = 1.5;
const DETAIL_GAP = 20;
const DETAIL_PAD = 24;

/** How big the overlay's cards can be, and how many to a row: the largest
 *  scale up to DETAIL_SCALE at which they all fit the screen, never below
 *  their normal size. `reserve` is the height taken by everything else. */
export function detailLayout(count: number, vw: number, vh: number, reserve: number): { scale: number; cols: number } {
  let best = { scale: 0, cols: 1 };
  for (let cols = 1; cols <= Math.min(Math.max(count, 1), 4); cols++) {
    const rows = Math.ceil(count / cols);
    const sw = (vw - 2 * DETAIL_PAD - (cols - 1) * DETAIL_GAP) / (cols * CARD_W);
    const sh = (vh - 2 * DETAIL_PAD - reserve - (rows - 1) * DETAIL_GAP) / (rows * CARD_H);
    const scale = Math.min(DETAIL_SCALE, sw, sh);
    if (scale > best.scale + 1e-6) best = { scale, cols };
  }
  return { scale: Math.max(1, best.scale), cols: best.cols };
}

/** Full-size view of several cards at once (a tile's stack, the queue, a
 *  player's revealed plays), half again their size where the screen has
 *  room — keyword hints included. Click anywhere or press Escape to close. */
export function CardDetailOverlay({ entries, onClose, onReplay }: {
  entries: { card: Card; subtitleParts?: SubtitlePart[]; playerId?: string; playerName?: string }[];
  onClose: () => void;
  /** A tile's plays: a gold Replay button that closes the view and plays the
   *  tile's resolve again. */
  onReplay?: () => void;
}) {
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onResize);
    };
  }, [onClose]);
  // Below the cards: the close hint, the Replay button, player names.
  const named = entries.some(e => e.playerName && e.playerId);
  const reserve = 32 + (onReplay ? 64 : 0) + (named ? 22 * Math.ceil(entries.length / 4) : 0);
  const { scale, cols } = detailLayout(entries.length, viewport.w, viewport.h, reserve);
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 30000, background: 'rgba(0, 0, 0, 0.85)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'var(--cc-cursor-pointer)',
        animation: 'cc-fade-in 0.18s ease-out both',
      }}
    >
      <div style={{
        display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: DETAIL_GAP, padding: DETAIL_PAD, boxSizing: 'border-box',
        maxWidth: cols * CARD_W * scale + (cols - 1) * DETAIL_GAP + 2 * DETAIL_PAD,
      }}>
        {entries.map((entry, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            {/* Scaled as a whole, so the keyword hints grow with the card. */}
            <div style={{ position: 'relative', width: CARD_W * scale, height: CARD_H * scale }}>
              <div style={{ position: 'absolute', left: 0, top: 0, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                <CardFull card={entry.card} subtitleParts={entry.subtitleParts} showKeywordHints={entries.length === 1} />
              </div>
            </div>
            {entry.playerName && entry.playerId && (
              <div style={{ fontSize: 12, fontWeight: 'bold', color: playerColor(entry.playerId) }}>{entry.playerName}</div>
            )}
          </div>
        ))}
      </div>
      {onReplay && (
        <button
          type="button"
          className="cc-btn-primary"
          style={{ marginTop: 18, padding: '10px 36px', fontSize: 16 }}
          onClick={(e) => { e.stopPropagation(); onReplay(); }}
        >
          Replay
        </button>
      )}
      <div style={{ marginTop: 16, fontSize: 12, color: '#777' }}>Click anywhere to close</div>
    </div>,
    document.body,
  );
}
