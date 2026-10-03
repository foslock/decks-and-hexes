import type { Card } from '../types/game';
import { CARD_TITLE_FONT, getCardDisplayColor, miniCardBackground, MINI_CARD_SHADOW } from '../constants/cardColors';
import { buildCardSubtitle } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import { CostLabel } from '../icons/Num';

/**
 * A compact card rendered at exactly the same dimensions and styling as the
 * in-hand card (CardHand.tsx:1631–1685). Used by the tutor/search UI so its
 * card tiles are visually identical to cards in the player's hand.
 *
 * Pure presentation — no click handlers, no hover state, no selection logic.
 * Callers are expected to wrap this with their own interactive container.
 */

export const HAND_CARD_WIDTH = 134;
export const HAND_CARD_MIN_HEIGHT = 52;

interface HandStyleCardProps {
  card: Card;
  /** Optional override for the border (e.g. '2px solid #fff' when selected).
   *  Empty string uses the default type-colored border. */
  border?: string;
}

export default function HandStyleCard({ card, border }: HandStyleCardProps) {
  const typeColor = getCardDisplayColor(card);
  return (
    <div
      style={{
        width: HAND_CARD_WIDTH,
        height: HAND_CARD_MIN_HEIGHT,
        padding: 6,
        background: miniCardBackground(typeColor),
        border: border || `2px solid ${typeColor}`,
        borderRadius: 8,
        boxShadow: MINI_CARD_SHADOW,
        color: '#fff',
        boxSizing: 'border-box',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <div
          style={{
            fontWeight: 'bold',
            fontSize: 14,
            fontFamily: CARD_TITLE_FONT,
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'clip',
          }}
        >
          <span
            style={{
              display: 'inline-block',
              maxWidth: '100%',
              transform: 'scaleX(var(--title-scale, 1))',
              transformOrigin: 'left center',
            }}
            ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--title-scale', String(scale));
              }
            }}
          >
            {card.name}
          </span>
        </div>
        <span style={{ fontSize: 13, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}>
          <CostLabel cost={card.buy_cost} size={13} />
        </span>
      </div>
      <div style={{ fontSize: 13, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span
          style={{
            display: 'inline-block',
            maxWidth: '100%',
            transform: 'scaleX(var(--sub-scale, 1))',
            transformOrigin: 'left center',
          }}
          ref={(el) => {
            if (el) {
              const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
              el.style.setProperty('--sub-scale', String(scale));
            }
          }}
        >
          {renderSubtitle(buildCardSubtitle(card), { fontSize: 13, passiveVp: card.passive_vp })}
        </span>
      </div>
    </div>
  );
}
