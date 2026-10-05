import type { Card } from '../types/game';
import type { CardSubtitleContext } from './cardSubtitle';
import CompactCardFace from './CompactCardFace';
import { useCardZoom } from './CardZoomContext';

const COL_W = 134;

interface CompactCardProps {
  card: Card;
  subtitleContext?: CardSubtitleContext;
  effectiveResourceGain?: number;
  effectiveDrawCards?: number;
}

/**
 * Small themed card (name, cost, glyph shorthand) for tight readouts such as
 * the board's planned-card tooltip. Click to open the full card.
 */
export default function CompactCard({ card, subtitleContext, effectiveResourceGain, effectiveDrawCards }: CompactCardProps) {
  const ctx: CardSubtitleContext = { ...subtitleContext, effectiveResourceGain, effectiveDrawCards };
  const { showZoom } = useCardZoom();
  return (
    <div onClick={() => showZoom(card)} style={{ cursor: 'var(--cc-cursor-pointer)' }}>
      <CompactCardFace card={card} width={COL_W} size="sm" subtitleContext={ctx} />
    </div>
  );
}

export { COL_W as COMPACT_CARD_WIDTH };
