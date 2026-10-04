import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull from './CardFull';
import type { SubtitlePart } from './cardSubtitle';
import { CARD_H, CARD_W, runAnimation } from './hand/cardMotion';
import { PLAYER_COLORS } from '../board3d/boardTypes';
import { useAnimated } from './SettingsContext';

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
/** The hover zoom. */
const ZOOM_SCALE = 0.8;
/** Tile cards at rest are see-through so the board shows under them. */
const REST_OPACITY = 0.4;
/** Matches the card box's size transition, so a growing card scales in step
 *  with its box instead of snapping out of its top-left corner. */
const SIZE_EASE = '0.25s ease';

/** Gap between cards sharing a tile (px). */
const STACK_GAP = 8;
/** Horizontal offset (center) of card i of n laid side by side over a tile
 *  (px at scale s). Cards on one tile never overlap. */
export function fanOffset(i: number, n: number, s: number): number {
  return (i - (n - 1) / 2) * (CARD_W * s + STACK_GAP);
}

function playerColor(pid: string): string {
  const n = PLAYER_COLORS[pid];
  return n != null ? `#${n.toString(16).padStart(6, '0')}` : '#888';
}

/** A full card face scaled down to `scale`, top-left anchored in a box of its visual size. */
function ScaledFace({ entry, scale }: { entry: BoardCardEntry; scale: number }) {
  return (
    <div style={{ width: CARD_W, height: CARD_H, transform: `scale(${scale})`, transformOrigin: '0 0', transition: `transform ${SIZE_EASE}`, pointerEvents: 'none' }}>
      <CardFull card={entry.card} subtitleParts={entry.subtitleParts} artZoom={false} />
    </div>
  );
}

/**
 * The hover zoom: the card grows out of its mini copy to a readable size,
 * above it (or below, near the top of the screen) or to its right.
 */
function HoverZoom({ entry, from, placement, hint }: {
  entry: BoardCardEntry;
  from: DOMRect;
  placement: 'above' | 'right';
  hint?: string;
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
    if (cy - h / 2 < 8) cy = from.bottom + 12 + h / 2;
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
      <CardFull card={entry.card} subtitleParts={entry.subtitleParts} artZoom={false} />
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

/** One mini card: hover to zoom, click to open, hold to undo (when offered). */
function MiniCard({ entry, scale, style, placement, onOpen, onUndo, glow }: {
  entry: BoardCardEntry;
  scale: number;
  style?: CSSProperties;
  placement: 'above' | 'right';
  onOpen: () => void;
  onUndo?: () => void;
  /** Ring the card in this color (its player's, when players share a tile). */
  glow?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undone = useRef(false);
  const stopHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  };
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);
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
      onPointerEnter={() => setHoverRect(ref.current?.getBoundingClientRect() ?? null)}
      onPointerLeave={() => { setHoverRect(null); stopHold(); }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!onUndo || e.button !== 0) return;
        undone.current = false;
        setHolding(true);
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null;
          undone.current = true;
          setHolding(false);
          setHoverRect(null);
          onUndo();
        }, HOLD_MS);
      }}
      onPointerUp={stopHold}
      onPointerCancel={stopHold}
      onClick={(e) => {
        e.stopPropagation();
        if (undone.current) { undone.current = false; return; }
        setHoverRect(null);
        onOpen();
      }}
      style={{
        width: CARD_W * scale,
        height: CARD_H * scale,
        cursor: 'pointer',
        borderRadius: 14 * scale,
        opacity: entry.arriving ? 0 : 1,
        boxShadow: glow ? `0 0 0 2px ${glow}, 0 0 10px 3px ${glow}cc, 0 0 22px 6px ${glow}55` : undefined,
        transition: `opacity 0.18s ease, transform 0.25s cubic-bezier(0.2, 0.8, 0.3, 1), width ${SIZE_EASE}, height ${SIZE_EASE}, left ${SIZE_EASE}, box-shadow 0.25s ease`,
        touchAction: 'none',
        ...style,
      }}
    >
      <div style={{ animation: entry.revealed ? 'cc-board-card-reveal 0.55s ease-out both' : undefined, transformOrigin: '50% 50%' }}>
        <ScaledFace entry={entry} scale={scale} />
      </div>
      {holding && <div aria-hidden className="cc-board-card-hold" style={{ borderRadius: 14 * scale }} />}
      {entry.playerName && !glow && (
        <div aria-hidden style={{
          position: 'absolute', left: 0, right: 0, bottom: -3, height: 3, borderRadius: 2,
          background: playerColor(entry.playerId), boxShadow: `0 0 6px ${playerColor(entry.playerId)}`,
        }} />
      )}
      {hoverRect && (
        <HoverZoom entry={entry} from={hoverRect} placement={placement} hint={onUndo ? 'Hold to undo' : undefined} />
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
export function TileCardStack({ entries, scale, focus, open, faded, onOpen, onUndo }: {
  entries: BoardCardEntry[];
  scale: number;
  /** This tile is resolving: its cards grow so everyone sees what was played. */
  focus?: boolean;
  /** Its cards are open in the zoom / detail view. */
  open?: boolean;
  /** Out of the way (a card is being dragged from the hand). */
  faded?: boolean;
  onOpen: (entries: BoardCardEntry[], index: number) => void;
  /** Hold a card to undo it (only the player's own undoable plays). */
  onUndo?: () => void;
}) {
  const [hot, setHot] = useState(false);
  const s = focus ? Math.max(scale, FOCUS_SCALE) : scale;
  const n = entries.length;
  // Players sharing a tile: ring each card in its player's color.
  const mixed = new Set(entries.map(e => e.playerId)).size > 1;
  const w = CARD_W * s;
  const h = CARD_H * s;
  const span = n > 1 ? Math.abs(fanOffset(n - 1, n, s) - fanOffset(0, n, s)) : 0;
  return (
    <div
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
        opacity: faded ? 0.15 : focus || open || hot ? 1 : REST_OPACITY,
        pointerEvents: faded ? 'none' : 'auto',
        transition: `opacity 0.2s ease-out, width ${SIZE_EASE}, height ${SIZE_EASE}`,
      }}
    >
      {entries.map((e, i) => (
        <MiniCard
          key={e.key}
          entry={e}
          scale={s}
          placement="above"
          onOpen={() => onOpen(entries, i)}
          onUndo={onUndo}
          glow={mixed ? playerColor(e.playerId) : undefined}
          style={{
            position: 'absolute',
            left: (w + span) / 2 - w / 2 + fanOffset(i, n, s),
            bottom: 0,
            zIndex: i + 1,
          }}
        />
      ))}
    </div>
  );
}

/** Engine cards played this round (they resolve as they are played), under the player's ID card. */
export function EngineQueue({ entries, onOpen, containerRef, title = 'Played' }: {
  entries: BoardCardEntry[];
  onOpen: (entries: BoardCardEntry[], index: number) => void;
  containerRef?: React.Ref<HTMLDivElement>;
  title?: string;
}) {
  return (
    <div ref={containerRef} data-engine-queue>
      <div style={{ fontSize: 10, color: 'var(--cc-gold)', opacity: 0.8, textTransform: 'uppercase', letterSpacing: 1.5, fontFamily: 'var(--cc-font-display)', fontWeight: 700, marginBottom: 5 }}>
        {title} ({entries.length})
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {entries.map((e, i) => (
          <MiniCard key={e.key} entry={e} scale={QUEUE_CARD_SCALE} placement="right" onOpen={() => onOpen(entries, i)} style={{ position: 'relative' }} />
        ))}
      </div>
    </div>
  );
}

/** Full-size view of several cards at once (a tile's stack, the queue, a
 *  player's revealed plays). Click anywhere or press Escape to close. */
export function CardDetailOverlay({ entries, onClose }: {
  entries: { card: Card; subtitleParts?: SubtitlePart[]; playerId?: string; playerName?: string }[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 30000, background: 'rgba(0, 0, 0, 0.85)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
        animation: 'cc-fade-in 0.18s ease-out both',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 20, maxWidth: 4 * (CARD_W + 20) + 20, padding: 24 }}>
        {entries.map((entry, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <CardFull card={entry.card} subtitleParts={entry.subtitleParts} showKeywordHints={entries.length === 1} />
            {entry.playerName && entry.playerId && (
              <div style={{ fontSize: 12, fontWeight: 'bold', color: playerColor(entry.playerId) }}>{entry.playerName}</div>
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, fontSize: 12, color: '#777' }}>Click anywhere to close</div>
    </div>,
    document.body,
  );
}
