import type { Card } from '../types/game';

/**
 * Build the compact stat-line parts for a card (e.g. "⚔️3 · +2💰 · 🗑️").
 * Returns an array of string segments to be joined with " · ".
 *
 * This is the single source of truth for card subtitle rendering —
 * used by ShopOverlay, CardBrowser, CardHand, MarketPanel, GameScreen, etc.
 */
export function buildCardSubtitle(card: Card): string[] {
  const parts: string[] = [];
  const isUpgraded = card.is_upgraded;

  // VP
  if (card.passive_vp !== undefined && card.passive_vp !== 0) {
    parts.push(`${card.passive_vp > 0 ? '+' : ''}${card.passive_vp}★`);
  } else if (card.vp_formula) {
    parts.push('+★');
  }

  // Defense cards
  if (card.card_type === 'defense') {
    const defBase = card.defense_bonus > 0 ? card.defense_bonus : card.power;
    const hasPerAdj = card.effects?.some(e => e.type === 'defense_per_adjacent');
    const hasPermanent = card.effects?.some(e => e.type === 'permanent_defense');
    const hasImmunity = card.effects?.some(e => e.type === 'tile_immunity');
    const dtc = card.defense_target_count || 1;
    const tileSuffix = dtc >= 2 ? ` · ${dtc}🔷` : '';
    if (hasImmunity) {
      parts.push('Immune');
    } else if (hasPerAdj) {
      const mod = card.effects?.find(e => e.type === 'defense_per_adjacent');
      const perVal = mod ? (isUpgraded ? (mod.upgraded_value ?? mod.value) : mod.value) : 1;
      parts.push(`🛡️${perVal}+${tileSuffix}`);
    } else if (hasPermanent) {
      const mod = card.effects?.find(e => e.type === 'permanent_defense');
      const permVal = mod
        ? (isUpgraded ? ((mod.metadata?.upgraded_value as number) ?? mod.value) : mod.value)
        : defBase;
      parts.push(`🛡️${permVal}${tileSuffix}`);
    } else if (defBase > 0) {
      parts.push(`🛡️${defBase}${tileSuffix}`);
    }
  } else if (card.power > 0 || card.card_type === 'claim') {
    // Claim / power cards
    const powerMods = card.effects?.filter(e => e.type === 'power_modifier') ?? [];
    const hasTileScaling = card.effects?.some(e => e.type === 'power_per_tiles_owned');
    const isUnbounded = hasTileScaling || powerMods.some(e =>
      e.condition === 'cards_in_hand' || e.metadata?.per_tile
    );
    const fixedBonus = powerMods.find(e =>
      !isUnbounded && ((isUpgraded ? (e.upgraded_value ?? e.value) : e.value) > 0)
    );
    const mtc = 1 + (card.multi_target_count || 0);
    const claimTileSuffix = mtc >= 2 ? ` · ${mtc}🔷` : '';
    if (isUnbounded) {
      const handMod = powerMods.find(e => e.condition === 'cards_in_hand');
      const minPow = handMod
        ? (isUpgraded ? (handMod.upgraded_value ?? handMod.value) : handMod.value)
        : card.power;
      parts.push(`⚔️${minPow}+${claimTileSuffix}`);
    } else if (fixedBonus) {
      const bonusVal = isUpgraded ? (fixedBonus.upgraded_value ?? fixedBonus.value) : fixedBonus.value;
      parts.push(`⚔️${card.power}/${card.power + bonusVal}${claimTileSuffix}`);
    } else {
      parts.push(`⚔️${card.power}${claimTileSuffix}`);
    }
  }

  // Grant stackable (shown first among non-combat stats, e.g. Rally Cry)
  if (card.effects) {
    for (const eff of card.effects) {
      if (eff.type === 'grant_stackable') {
        parts.push('⚙️');
        if (isUpgraded) parts.push('+⚔️');
      }
    }
  }

  // Stat icons
  if (card.resource_gain > 0) parts.push(`+${card.resource_gain}💰`);
  if (card.draw_cards > 0) parts.push(`+${card.draw_cards}🃏`);
  if (card.action_return > 0) parts.push(`+${card.action_return}⚡`);
  if (card.forced_discard > 0) parts.push(`🎯-${card.forced_discard}🃏`);

  // Effect-based icons
  if (card.effects) {
    for (const eff of card.effects) {
      if (eff.type === 'self_trash' || eff.type === 'trash_gain_buy_cost') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(`✂️${val}`);
        if (eff.type === 'trash_gain_buy_cost') {
          const bonus = isUpgraded && eff.metadata?.upgrade_bonus ? eff.metadata.upgrade_bonus : 0;
          parts.push(bonus > 0 ? `${bonus}+💰` : '+💰');
        }
      }
      if (eff.type === 'gain_resources' && eff.condition) {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(`+${val}💰`);
      }
      if (eff.type === 'draw_next_turn' || eff.type === 'cease_fire') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(`+${val}⏰🃏`);
      }
      if (eff.type === 'enhance_vp_tile') parts.push('🔷+★');
      if (eff.type === 'free_reroll' || eff.type === 'grant_land_grants') parts.push('⚙️');
    }
  }

  // Trash on use
  if (card.trash_on_use) parts.push('🗑️');

  return parts;
}
