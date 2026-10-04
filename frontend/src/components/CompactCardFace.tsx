import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { Card } from '../types/game';
import { CARD_TITLE_FONT, getCardDisplayColor } from '../constants/cardColors';
import { cardTrimTier, metalGradient, TRIM_INK } from '../constants/cardTrim';
import { buildCardSubtitle, type CardSubtitleContext, type SubtitlePart } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import CardName from './CardName';
import { CostLabel } from '../icons/Num';

/** Text sizes for the two compact densities. */
const SIZES = {
  /** Shop tiles, deck viewers, card browser. */
  md: { title: 15, stat: 14, coin: 12, pad: '5px 7px 6px' },
  /** In-play readouts, board tooltips, tutor tiles. */
  sm: { title: 13, stat: 11.5, coin: 10.5, pad: '3px 6px 4px' },
} as const;

export interface CompactCardFaceProps {
  card: Card;
  /** Outer width (px). */
  width?: number;
  size?: keyof typeof SIZES;
  /** Cost shown on the coin (e.g. a discounted shop price); defaults to the card's. */
  cost?: number | null;
  /** Discounted (green coin) or unaffordable (red numeral). */
  costState?: 'normal' | 'discount' | 'short';
  /** Pre-built glyph shorthand; overrides `subtitleContext`. */
  subtitleParts?: SubtitlePart[];
  subtitleContext?: CardSubtitleContext;
  /** Highlight values resolved from live game context. */
  showDynamic?: boolean;
  /** White selection ring. */
  selected?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Overlays (selection marks, flashes) drawn over the face. */
  children?: ReactNode;
}

/** Squeeze a single line horizontally when it would overflow its box. */
function useSqueeze(deps: unknown[]) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el?.parentElement) return;
    el.style.transform = '';
    const avail = el.parentElement.clientWidth;
    if (!avail) return;
    const k = Math.min(1, avail / el.scrollWidth);
    if (k < 1) el.style.transform = `scaleX(${k})`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

/**
 * The compact card used wherever a card must fit in a small space (shop
 * tiles, deck viewers, the card browser, tooltips, tutor picks): the same
 * information as before — name, cost and the glyph shorthand — dressed like
 * the full card. A thin metallic trim tiered by cost, a navy panel washed
 * with the card type's color, the minted-coin cost badge, and the stats in a
 * recessed plaque.
 */
export default function CompactCardFace({
  card, width = 154, size = 'md', cost, costState = 'normal',
  subtitleParts, subtitleContext, showDynamic, selected, className, style, children,
}: CompactCardFaceProps) {
  const sz = SIZES[size];
  const typeColor = getCardDisplayColor(card);
  const tier = cardTrimTier(card);
  const displayCost = cost === undefined ? card.buy_cost : cost;
  const parts = subtitleParts ?? buildCardSubtitle(card, subtitleContext);
  const nameRef = useSqueeze([card.name, card.is_upgraded, width, size]);
  const statRef = useSqueeze([parts, width, size]);
  const discount = costState === 'discount';

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width,
        boxSizing: 'border-box',
        padding: size === 'md' ? 3 : 2,
        borderRadius: size === 'md' ? 10 : 8,
        background: metalGradient(tier, 145),
        boxShadow: selected
          ? '0 0 0 2px #fff, 0 0 14px rgba(160, 220, 255, 0.8), 0 4px 10px rgba(0,0,0,0.5)'
          : 'inset 0 1px 0 rgba(255,255,255,0.5), 0 0 0 1px rgba(0,0,0,0.6), 0 4px 10px rgba(0,0,0,0.5)',
        color: '#fff',
        ...style,
      }}
    >
      <div style={{
        position: 'relative',
        borderRadius: size === 'md' ? 7 : 6,
        padding: sz.pad,
        overflow: 'hidden',
        background:
          `linear-gradient(180deg, ${typeColor}66 0%, ${typeColor}26 48%, rgba(0,0,0,0) 100%),` +
          `repeating-linear-gradient(-45deg, ${typeColor}14 0 2px, rgba(0,0,0,0) 2px 8px),` +
          '#17172f',
        boxShadow: `inset 0 0 0 1px rgba(0,0,0,0.65), inset 0 0 0 2px rgba(255,255,255,0.05), 0 0 0 1px ${TRIM_INK[tier]}44`,
      }}>
        {/* Name + cost coin */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minHeight: sz.title + 5 }}>
          <div style={{
            flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden',
            fontFamily: CARD_TITLE_FONT, fontWeight: 'bold', fontSize: sz.title, lineHeight: 1.2,
            color: '#fff6e2', letterSpacing: 0.2, textShadow: '0 1px 2px rgba(0,0,0,0.85)',
          }}>
            <span ref={nameRef} style={{ display: 'inline-block', transformOrigin: 'left center' }}>
              <CardName name={card.name} upgraded={card.is_upgraded} />
            </span>
          </div>
          {displayCost != null && (
            <span style={{
              flexShrink: 0,
              fontSize: sz.coin,
              fontWeight: 'bold',
              lineHeight: 1.3,
              padding: '0 6px',
              borderRadius: 999,
              color: costState === 'short' ? '#7a1010' : discount ? '#0f3a1a' : '#2a1d05',
              background: discount
                ? 'linear-gradient(180deg, #a6ffb8 0%, #4fd472 55%, #2e9e4e 100%)'
                : 'linear-gradient(180deg, #ffe9a8 0%, #e8c46a 50%, #b88a32 100%)',
              border: `1px solid ${discount ? '#c8ffd4' : '#f6dc94'}`,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.6)',
              filter: costState === 'short' ? 'saturate(0.55)' : undefined,
            }}>
              <CostLabel cost={displayCost} suffix={discount ? '*' : ''} size={sz.coin} />
            </span>
          )}
        </div>
        {/* Glyph shorthand in a recessed plaque */}
        <div style={{
          marginTop: size === 'md' ? 3 : 2,
          padding: size === 'md' ? '2px 6px' : '1px 5px',
          borderRadius: 5,
          background: 'linear-gradient(180deg, rgba(6, 6, 20, 0.75), rgba(18, 18, 42, 0.75))',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.6), 0 0 0 1px rgba(232, 196, 106, 0.12)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          color: '#d6d4e4',
          fontSize: sz.stat,
          lineHeight: 1.25,
          minHeight: sz.stat + 4,
        }}>
          <span ref={statRef} style={{ display: 'inline-block', transformOrigin: 'left center' }}>
            {renderSubtitle(parts, { fontSize: sz.stat, passiveVp: card.passive_vp, showDynamic })}
          </span>
        </div>
        {/* Laminate sheen, as on the full card */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'linear-gradient(118deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,0) 60%)',
        }} />
      </div>
      {children}
    </div>
  );
}
