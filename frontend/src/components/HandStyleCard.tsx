import type { Card } from '../types/game';
import CompactCardFace from './CompactCardFace';

/**
 * A compact card at the size the tutor/search UI uses for its picks (and
 * their flights into the hand). Pure presentation — callers add their own
 * interaction.
 */

export const HAND_CARD_WIDTH = 134;

interface HandStyleCardProps {
  card: Card;
  /** Any non-empty value draws the selection ring (e.g. '2px solid #fff'). */
  border?: string;
}

export default function HandStyleCard({ card, border }: HandStyleCardProps) {
  return <CompactCardFace card={card} width={HAND_CARD_WIDTH} size="sm" selected={!!border} />;
}
