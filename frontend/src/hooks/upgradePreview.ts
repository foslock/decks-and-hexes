import type { Card } from '../types/game';

/** Given a Card, return a new Card object with upgraded stats applied for preview. */
export function getUpgradedPreview(card: Card): Card {
  if (card.is_upgraded) return card;
  // Show upgrade preview if there are stat changes OR a different description
  const hasUpgrade = card.upgraded_stats || card.upgrade_description;
  if (!hasUpgrade) return card;
  const stats = card.upgraded_stats;
  return {
    ...card,
    name: card.name_upgraded || card.name + '+',
    is_upgraded: true,
    description: card.upgrade_description || card.description,
    power: stats?.power ?? card.power,
    resource_gain: stats?.resource_gain ?? card.resource_gain,
    action_return: stats?.action_return ?? card.action_return,
    draw_cards: stats?.draw_cards ?? card.draw_cards,
    forced_discard: stats?.forced_discard ?? card.forced_discard,
    defense_bonus: stats?.defense_bonus ?? card.defense_bonus,
    multi_target_count: stats?.multi_target_count ?? card.multi_target_count,
  };
}

/** Returns true if this card has any upgrade data to preview. */
export function hasUpgradePreview(card: Card): boolean {
  return !card.is_upgraded && !!(card.upgraded_stats || card.upgrade_description);
}
