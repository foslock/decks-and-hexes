import { forwardRef, memo, type CSSProperties } from 'react';
import type { Card } from '../../types/game';
import CardFull from '../CardFull';
import CardBack from '../CardBack';
import { getCardDisplayColor } from '../../constants/cardColors';
import { mixHex } from '../../constants/cardTrim';
import { CARD_H, CARD_W, jitter, PILE_CARD_W, PILE_LAYER, PILE_MAX_LAYERS, PILE_PERSPECTIVE, PILE_SCALE, PILE_TILT } from './cardMotion';

const PILE_CARD_H = (PILE_CARD_W * CARD_H) / CARD_W;

/** Resting spin of each pile's plane (deg): the draw pile sits square-ish,
 *  the discard pile a little askew. */
export const DRAW_PILE_SPIN = -5;
export const DISCARD_PILE_SPIN = 6;

/** Spin of the discard pile's top card (pile spin + that card's jitter). */
export function discardTopSpin(cardId: string | undefined): number {
  return DISCARD_PILE_SPIN + (cardId ? jitter(cardId, 7) : 0);
}

interface CardPileProps {
  kind: 'draw' | 'discard';
  /** Number shown on the badge. */
  count: number;
  /** Cards in the pile, bottom → top (discard: colors the stack's edges and
   *  supplies the face-up top card). Optional for the draw pile. */
  cards?: Card[];
  onClick?: () => void;
  title?: string;
  /** Pulse while a shuffle is in progress. */
  busy?: boolean;
  label: string;
  style?: CSSProperties;
  /** Overall size (1 = desktop). */
  zoom?: number;
}

/**
 * A pile of cards lying on the table, viewed at an angle: one thin layer per
 * card (up to PILE_MAX_LAYERS) so its height tracks the count, with the top
 * card drawn in full — a card back for the draw pile, the last discard face
 * up for the discard pile. The top card carries data-draw-pile /
 * data-discard-pile so flights can find where to land.
 */
const CardPile = memo(forwardRef<HTMLButtonElement, CardPileProps>(function CardPile(
  { kind, count, cards, onClick, title, busy, label, style, zoom = 1 },
  ref,
) {
  const layers = Math.min(count, PILE_MAX_LAYERS);
  const spin = kind === 'draw' ? DRAW_PILE_SPIN : DISCARD_PILE_SPIN;
  const top = kind === 'discard' && cards && cards.length > 0 ? cards[cards.length - 1] : null;
  // Layer i sits i card-thicknesses up; the top card rests on the last one.
  const topZ = Math.max(0, layers - 1) * PILE_LAYER;
  const anchorAttr = kind === 'draw' ? { 'data-draw-pile': true } : { 'data-discard-pile': true };

  return (
    <button
      ref={ref}
      type="button"
      className="cc-pile"
      onClick={onClick}
      title={title}
      aria-label={`${label}: ${count} card${count === 1 ? '' : 's'}`}
      style={{
        position: 'relative',
        width: 100,
        height: 108,
        // Scaled piles keep their layout box in step with how big they look.
        margin: zoom !== 1 ? `${(108 * (zoom - 1)) / 2}px ${(100 * (zoom - 1)) / 2}px` : undefined,
        transform: zoom !== 1 ? `scale(${zoom})` : undefined,
        padding: 0,
        border: 'none',
        background: 'none',
        cursor: 'var(--cc-cursor-pointer)',
        perspective: PILE_PERSPECTIVE,
        perspectiveOrigin: '50% 10%',
        animation: busy ? 'cc-pile-glow 0.6s ease-in-out infinite' : undefined,
        ...style,
      }}
    >
      {/* The table plane the cards lie on */}
      <div style={{
        position: 'absolute',
        left: '50%',
        top: 16,
        width: PILE_CARD_W,
        height: PILE_CARD_H,
        marginLeft: -PILE_CARD_W / 2,
        transformStyle: 'preserve-3d',
        transform: `rotateX(${PILE_TILT}deg) rotateZ(${spin}deg)`,
        pointerEvents: 'none',
      }}>
        {/* Contact shadow */}
        <div style={{
          position: 'absolute',
          inset: -10,
          borderRadius: 14,
          background: 'radial-gradient(closest-side, rgba(0,0,0,0.7), rgba(0,0,0,0))',
          transform: 'translateZ(-0.5px)',
        }} />
        {/* Empty slot outline */}
        {count === 0 && (
          <div style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 5,
            border: '1.5px dashed rgba(232, 196, 106, 0.35)',
            background: 'rgba(10, 10, 30, 0.35)',
          }} />
        )}
        {/* Edges of the cards beneath the top one */}
        {Array.from({ length: Math.max(0, layers - 1) }, (_, i) => {
          let bg: string;
          let edge: string;
          let layerSpin = 0;
          if (kind === 'draw') {
            bg = '#1d1b45';
            edge = i % 2 ? '#a77d33' : '#e2c27a';
          } else {
            const c = cards?.[Math.max(0, (cards.length - layers) + i)];
            const tc = c ? getCardDisplayColor(c) : '#555577';
            bg = mixHex(tc, '#141428', 0.35);
            edge = mixHex(tc, i % 2 ? '#000000' : '#ffffff', i % 2 ? 0.25 : 0.45);
            layerSpin = c ? jitter(c.id, 7) : 0;
          }
          return (
            <div key={i} style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 5,
              background: bg,
              boxShadow: `0 0 0 1px ${edge}`,
              transform: `translateZ(${i * PILE_LAYER}px) rotateZ(${layerSpin}deg)`,
            }} />
          );
        })}
        {/* Top card */}
        {count > 0 && (
          <div {...anchorAttr} data-pile-top style={{
            position: 'absolute',
            inset: 0,
            transform: `translateZ(${topZ}px) rotateZ(${kind === 'discard' ? (top ? jitter(top.id, 7) : 0) : 0}deg)`,
          }}>
            <div style={{ width: CARD_W, height: CARD_H, transform: `scale(${PILE_SCALE})`, transformOrigin: '0 0' }}>
              {kind === 'draw' || !top
                ? <CardBack />
                : <CardFull card={top} style={{ boxShadow: '0 0 0 1px rgba(0,0,0,0.6)' }} />}
            </div>
          </div>
        )}
        {/* Keep the landing anchor findable on an empty pile */}
        {count === 0 && <div {...anchorAttr} data-pile-top style={{ position: 'absolute', inset: 0 }} />}
      </div>

      {/* Count badge */}
      <div style={{
        position: 'absolute',
        left: '50%',
        bottom: 2,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'baseline',
        gap: 5,
        padding: '2px 9px 3px',
        borderRadius: 999,
        background: 'linear-gradient(180deg, rgba(36, 34, 72, 0.96), rgba(16, 15, 38, 0.96))',
        border: '1px solid rgba(232, 196, 106, 0.45)',
        boxShadow: '0 3px 8px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}>
        <span style={{ fontSize: 17, fontWeight: 900, fontFamily: 'var(--cc-font-display)', color: count === 0 ? '#77758f' : '#fff', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
        <span style={{ fontSize: 8.5, color: 'var(--cc-gold)', opacity: 0.85, textTransform: 'uppercase', letterSpacing: 1.2 }}>{label}</span>
      </div>
    </button>
  );
}));

export default CardPile;
