import type { Card } from '../types/game';
import { buildCardSubtitle, type CardSubtitleContext } from './cardSubtitle';

/**
 * Is a card in hand boosted right now by the state of the player's turn or
 * by other cards? True when:
 *  - its stat line resolves a live value above its baseline (tile-scaling
 *    power, hand-size power, a met "if you played a Claim" bonus, resources
 *    per tiles captured, …) — the parts buildCardSubtitle marks `dynamic`;
 *  - it carries a granted or conditional bonus (`glow` parts — Rally Cry's
 *    granted Stackable, Rabble's "played another Rabble" action);
 *  - it's a Claim and War Banner-style buffs are waiting for the next Claim.
 * VP readouts are excluded: a card's worth isn't an in-turn boost.
 */
export function isCardEmpowered(
  card: Card,
  ctx: CardSubtitleContext | undefined,
  claimBuffBonus = 0,
): boolean {
  if (claimBuffBonus > 0 && card.card_type === 'claim') return true;
  if (card.granted_stackable) return true;
  if (!ctx) return false;
  return buildCardSubtitle(card, ctx).some(part =>
    (part.dynamic || part.glow) && !part.tokens.some(t => t.kind === 'icon' && t.name === 'vp'),
  );
}
