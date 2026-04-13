import React from 'react';
import type { Card } from '../types/game';
import { getCardDisplayColor } from '../constants/cardColors';
import { buildCardSubtitle, type CardSubtitleContext } from './cardSubtitle';
import { renderSubtitlePart } from './SubtitlePartRenderer';
import { useCardZoom } from './CardZoomContext';

const COL_W = 134;

interface CompactCardProps {
  card: Card;
  subtitleContext?: CardSubtitleContext;
  effectiveResourceGain?: number;
  effectiveDrawCards?: number;
}

/**
 * Compact card display matching the "In Play" list style.
 * Shows card name + subtitle stats in a small bordered pill.
 */
export default function CompactCard({ card, subtitleContext, effectiveResourceGain, effectiveDrawCards }: CompactCardProps) {
  const typeColor = getCardDisplayColor(card);
  const ctx: CardSubtitleContext = { ...subtitleContext, effectiveResourceGain, effectiveDrawCards };
  const statParts = buildCardSubtitle(card, ctx);
  const { showZoom } = useCardZoom();

  return (
    <div
      onClick={() => showZoom(card)}
      style={{
      width: COL_W,
      padding: '3px 6px',
      background: '#2a2a3e',
      border: `1px solid ${typeColor}`,
      borderRadius: 5,
      color: '#fff',
      cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <div style={{ fontWeight: 'bold', fontSize: 12, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {card.name}
        </div>
      </div>
      <div style={{ fontSize: 11, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span style={{ display: 'inline-block', maxWidth: '100%', transform: 'scaleX(var(--sub-scale, 1))', transformOrigin: 'left center' }} ref={(el) => {
          if (el) {
            const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
            el.style.setProperty('--sub-scale', String(scale));
          }
        }}>
          {statParts.map((part, j) => renderSubtitlePart(part, j))}
        </span>
      </div>
    </div>
  );
}

export { COL_W as COMPACT_CARD_WIDTH };
