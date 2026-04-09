import type { Card } from '../types/game';

/**
 * Optional game context for resolving dynamic card values.
 * When provided, cards like War Tithe show their resolved resource gain
 * instead of generic text.
 */
export interface CardSubtitleContext {
  /** Number of tiles the player successfully claimed last round */
  claimsWonLastRound?: number;
  /** Total tiles the player currently owns */
  tileCount?: number;
  /** Number of cards currently in the player's hand */
  handSize?: number;
  /** Number of cards in the player's trash pile */
  trashCount?: number;
  /** Total cards in the player's deck (draw + hand + discard) */
  totalDeckCards?: number;
  /** Resources the player currently holds */
  resourcesHeld?: number;
  /** Tiles captured from the player last round */
  tilesLostLastRound?: number;
  /** When true, card.power is already the frozen effective value — skip dynamic power resolution */
  powerFrozen?: boolean;
  /** Override for dynamic resource gain (e.g. War Tithe), snapshotted at play time */
  effectiveResourceGain?: number;
  /** Number of VP tiles connected to the player's base */
  vpHexCount?: number;
  /** Number of Debt cards in the player's deck (draw + hand + discard, excluding trash) */
  debtCount?: number;
  /** Override for dynamic draw count (e.g. Financier), snapshotted at play time */
  effectiveDrawCards?: number;
  /** Names of cards already played this round (for conditional_action_return / if_played_same_name) */
  playedCardNames?: string[];
}

/** A single segment of a card subtitle. */
export interface SubtitlePart {
  text: string;
  /** True when this value was resolved from live game context (e.g. tile count). */
  dynamic?: boolean;
  /** True for granted-stackable indicator — rendered bold yellow with glow. */
  glow?: boolean;
}

/**
 * Build the compact stat-line parts for a card (e.g. "⚔️3 · +2💰 · 🗑️").
 * Returns an array of SubtitlePart segments to be joined with " · ".
 *
 * This is the single source of truth for card subtitle rendering —
 * used by ShopOverlay, CardBrowser, CardHand, MarketPanel, GameScreen, etc.
 *
 * When `ctx` is provided, dynamic values (e.g. War Tithe resource gain,
 * tile-scaling power) are resolved to their current effective values.
 */
export function buildCardSubtitle(card: Card, ctx?: CardSubtitleContext): SubtitlePart[] {
  const parts: SubtitlePart[] = [];
  const isUpgraded = card.is_upgraded;

  const p = (text: string, dynamic?: boolean): SubtitlePart =>
    dynamic ? { text, dynamic: true } : { text };

  // Special case: Debt card
  if (card.name === 'Debt') {
    parts.push(p('3💰 → 🗑️'));
    return parts;
  }

  // VP
  if (card.passive_vp !== undefined && card.passive_vp !== 0) {
    parts.push(p(`${card.passive_vp > 0 ? '+' : ''}${card.passive_vp}★`));
  } else if (card.vp_formula) {
    // Try to resolve dynamic VP from context
    const resolvedVP = ctx ? _resolveVPFormula(card, ctx) : undefined;
    if (resolvedVP !== undefined && resolvedVP > 0) {
      parts.push(p(`${resolvedVP}★`, true));
    } else {
      parts.push(p('+★'));
    }
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
      parts.push(p('Immune'));
    } else if (hasPerAdj) {
      const mod = card.effects?.find(e => e.type === 'defense_per_adjacent');
      const perVal = mod ? (isUpgraded ? (mod.upgraded_value ?? mod.value) : mod.value) : 1;
      parts.push(p(`🛡️${perVal}+${tileSuffix}`));
    } else if (hasPermanent) {
      const mod = card.effects?.find(e => e.type === 'permanent_defense');
      const permVal = mod
        ? (isUpgraded ? ((mod.metadata?.upgraded_value as number) ?? mod.value) : mod.value)
        : defBase;
      parts.push(p(`🛡️${permVal}${tileSuffix}`));
    } else if (defBase > 0) {
      parts.push(p(`🛡️${defBase}${tileSuffix}`));
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
    // Natively stackable cards show ↑ inline; granted stackable shows it as a separate glowing part
    const stackIcon = (card.stackable && !card.granted_stackable) ? '↑' : '';

    if (ctx?.powerFrozen) {
      // Power already overridden with effective value — show as-is
      parts.push(p(`⚔️${card.power}${stackIcon}${claimTileSuffix}`));
    } else if (hasTileScaling && ctx?.tileCount !== undefined) {
      // Resolve tile-scaling power (Mob Rule, Locust Swarm)
      const tileEff = card.effects?.find(e => e.type === 'power_per_tiles_owned');
      if (tileEff) {
        const divisor = isUpgraded ? (tileEff.upgraded_value ?? tileEff.value) : tileEff.value;
        const replaces = tileEff.metadata?.replaces_base_power;
        const scaledPow = Math.floor(ctx.tileCount / divisor);
        const totalPow = replaces ? scaledPow : card.power + scaledPow;
        parts.push(p(`⚔️${totalPow}${stackIcon}${claimTileSuffix}`, totalPow > 0));
      } else {
        parts.push(p(`⚔️${card.power}+${stackIcon}${claimTileSuffix}`));
      }
    } else if (isUnbounded) {
      if (powerMods.some(e => e.condition === 'cards_in_hand') && ctx?.handSize !== undefined) {
        // Resolve hand-size power (Strength in Numbers)
        const handMod = powerMods.find(e => e.condition === 'cards_in_hand');
        const bonus = isUpgraded ? (handMod?.upgraded_value ?? handMod?.value ?? 0) : (handMod?.value ?? 0);
        const handPow = Math.max(0, ctx.handSize - 1) + bonus;
        parts.push(p(`⚔️${handPow}${stackIcon}${claimTileSuffix}`, handPow > 0));
      } else {
        const handMod = powerMods.find(e => e.condition === 'cards_in_hand');
        const minPow = handMod
          ? (isUpgraded ? (handMod.upgraded_value ?? handMod.value) : handMod.value)
          : card.power;
        parts.push(p(`⚔️${minPow}+${stackIcon}${claimTileSuffix}`));
      }
    } else if (fixedBonus) {
      const bonusVal = isUpgraded ? (fixedBonus.upgraded_value ?? fixedBonus.value) : fixedBonus.value;
      parts.push(p(`⚔️${card.power}/${card.power + bonusVal}${stackIcon}${claimTileSuffix}`));
    } else {
      parts.push(p(`⚔️${card.power}${stackIcon}${claimTileSuffix}`));
    }

    // Granted stackable indicator (Rally Cry) — shown as a separate glowing part
    if (card.granted_stackable) {
      parts.push({ text: '↑', glow: true });
    }
  }

  // Grant stackable (shown first among non-combat stats, e.g. Rally Cry)
  if (card.effects) {
    for (const eff of card.effects) {
      if (eff.type === 'grant_stackable') {
        parts.push(p(isUpgraded ? '⚔️+1↑' : '⚔️↑'));
      }
    }
  }

  // Stat icons (defer resource_gain for self_discard cards — shown after discard+action)
  const hasSelfDiscard = card.effects?.some(e => e.type === 'self_discard');
  if (card.resource_gain > 0 && !hasSelfDiscard) parts.push(p(`+${card.resource_gain}💰`));

  // Dynamic resource gain (War Tithe: resources per claims last round)
  if (card.effects) {
    const warTitheEff = card.effects.find(e => e.type === 'resources_per_claims_last_round');
    if (warTitheEff) {
      if (ctx?.effectiveResourceGain !== undefined) {
        // Use frozen snapshot from play time
        const gained = ctx.effectiveResourceGain;
        parts.push(p(`${gained}💰`, gained > 0));
      } else if (ctx?.claimsWonLastRound !== undefined) {
        const perClaim = isUpgraded ? (warTitheEff.upgraded_value ?? warTitheEff.value) : warTitheEff.value;
        const maxRes = (isUpgraded
          ? (warTitheEff.metadata?.upgraded_max_resources as number)
          : (warTitheEff.metadata?.max_resources as number)) ?? 999;
        const gained = Math.min(ctx.claimsWonLastRound * perClaim, maxRes);
        parts.push(p(`${gained}💰`, gained > 0));
      } else {
        // No context — show range
        const maxRes = (isUpgraded
          ? (warTitheEff.metadata?.upgraded_max_resources as number)
          : (warTitheEff.metadata?.max_resources as number)) ?? '?';
        parts.push(p(`0-${maxRes}💰`));
      }
    }
  }

  // Check if card has a trash-conditional effect (self_trash or trash_gain_buy_cost)
  // These cards use "✂️N → bonuses" format where bonuses are conditional on trashing
  const trashEffect = card.effects?.find(e => e.type === 'self_trash' || e.type === 'trash_gain_buy_cost');
  const hasTrashConditional = !!trashEffect;

  // For trash-conditional cards, draw/action are shown after the → arrow, not here
  // For draw_per_connected_vp cards (Toll Road) and draw_per_debt cards (Financier), draw_cards is dynamic — skip flat display
  const hasDrawPerVP = card.effects?.some(e => e.type === 'draw_per_connected_vp');
  const hasDrawPerDebt = card.effects?.some(e => e.type === 'draw_per_debt');
  // Defer action icon when a later effect should appear first (to match description order)
  const hasDelayedDraw = card.effects?.some(e => e.type === 'draw_next_turn' || e.type === 'cease_fire');
  const hasMulligan = card.effects?.some(e => e.type === 'mulligan');
  const hasActionsPerCards = card.effects?.some(e => e.type === 'actions_per_cards_played');
  const deferAction = hasDelayedDraw || hasSelfDiscard || hasMulligan || hasActionsPerCards;
  if (card.draw_cards > 0 && !hasTrashConditional && !hasDrawPerVP && !hasDrawPerDebt && !hasMulligan) parts.push(p(`+${card.draw_cards}🃏`));
  if (card.action_return > 0 && !hasTrashConditional && !deferAction) parts.push(p(`+${card.action_return}⚡`));
  if (card.forced_discard > 0) parts.push(p(`🎯-${card.forced_discard}🃏`));

  // Effect-based icons
  if (card.effects) {
    for (const eff of card.effects) {
      if (eff.type === 'self_trash' || eff.type === 'trash_gain_buy_cost') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        // Build conditional bonuses after →
        const conditionalParts: string[] = [];
        if (eff.type === 'trash_gain_buy_cost') {
          const bonus = isUpgraded && eff.metadata?.upgrade_bonus ? Number(eff.metadata.upgrade_bonus) : 0;
          conditionalParts.push(bonus > 0 ? `${bonus}+💰` : '+💰');
        }
        if (card.draw_cards > 0) conditionalParts.push(`+${card.draw_cards}🃏`);
        if (eff.type !== 'trash_gain_buy_cost' && card.action_return > 0) conditionalParts.push(`+${card.action_return}⚡`);
        if (conditionalParts.length > 0) {
          parts.push(p(`✂️${val} → ${conditionalParts.join(', ')}`));
        } else {
          parts.push(p(`✂️${val}`));
        }
      }
      if (eff.type === 'self_discard') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`🃏↘${val}`));
        // Emit deferred action + resource icons after discard (e.g. Regroup: +2🃏 · 🃏↘1 · +1⚡)
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}⚡`));
        }
        if (card.resource_gain > 0) {
          parts.push(p(`+${card.resource_gain}💰`));
        }
      }
      if (eff.type === 'gain_resources' && eff.condition) {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`+${val}💰`));
      }
      if (eff.type === 'draw_next_turn' || eff.type === 'cease_fire') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`+${val}⏰🃏`));
        // Emit deferred action icon after delayed draw (e.g. Plunder: +3💰 · +1⏰🃏 · +1⚡)
        if (hasDelayedDraw && card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}⚡`));
        }
      }
      if (eff.type === 'resource_scaling') {
        const divisor = eff.value || 2;
        if (ctx?.effectiveResourceGain !== undefined) {
          parts.push(p(`+${ctx.effectiveResourceGain}💰`, true));
        } else if (ctx?.resourcesHeld !== undefined) {
          const gained = Math.max(1, Math.floor(ctx.resourcesHeld / divisor));
          parts.push(p(`+${gained}💰`, true));
        } else {
          parts.push(p(`+1💰/${divisor}💰`));
        }
      }
      if (eff.type === 'cycle') {
        const discardN = (eff.metadata?.discard as number) ?? 2;
        const drawN = isUpgraded
          ? ((eff.metadata?.upgraded_draw as number) ?? (eff.metadata?.draw as number) ?? 2)
          : ((eff.metadata?.draw as number) ?? 2);
        parts.push(p(`🃏↘${discardN} · +${drawN}🃏`));
      }
      if (eff.type === 'resources_per_tiles_lost') {
        const perTile = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (ctx?.effectiveResourceGain !== undefined) {
          parts.push(p(`+${ctx.effectiveResourceGain}💰`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.tilesLostLastRound !== undefined) {
          const gained = ctx.tilesLostLastRound * perTile;
          parts.push(p(`+${gained}💰`, gained > 0));
        } else {
          parts.push(p(`+💰`));
        }
      }
      if (eff.type === 'resource_per_vp_hex') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (ctx?.effectiveResourceGain !== undefined) {
          // Use frozen snapshot from play time
          parts.push(p(`+${ctx.effectiveResourceGain}💰`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.vpHexCount !== undefined) {
          const gained = ctx.vpHexCount * val;
          parts.push(p(`+${gained}💰`, gained > 0));
        } else {
          parts.push(p(`+${val}💰/★🔷`));
        }
      }
      if (eff.type === 'enhance_vp_tile') parts.push(p('🔷+★'));
      if (eff.type === 'draw_per_connected_vp') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`+${val}🃏/★🔷`));
      }
      if (eff.type === 'draw_per_debt') {
        if (ctx?.effectiveDrawCards !== undefined) {
          // Use frozen snapshot from play time
          parts.push(p(`+${ctx.effectiveDrawCards}🃏`, ctx.effectiveDrawCards > 0));
        } else if (ctx?.debtCount !== undefined) {
          const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
          const totalDraw = ctx.debtCount * val;
          parts.push(p(`+${totalDraw}🃏`, totalDraw > 0));
        } else {
          parts.push(p('+1🃏/🃏'));
        }
      }
      if (eff.type === 'free_reroll') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`+${val}🎲`));
      }
      if (eff.type === 'conditional_action') {
        const threshold = eff.condition_threshold ?? 3;
        const condParts = `≤${threshold}🃏, +${eff.value}⚡`;
        if (isUpgraded) {
          parts.push(p(`${condParts} · +1💰`));
        } else {
          parts.push(p(condParts));
        }
      }
      if (eff.type === 'conditional_action_return' && eff.condition === 'if_played_same_name') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        const baseName = card.name.replace(/\+$/, '');
        const met = ctx?.playedCardNames?.some(n => n.replace(/\+$/, '') === baseName) ?? false;
        if (met) {
          // In hand: glow yellow; in-play (powerFrozen): static resolved
          parts.push({ text: `+${val}⚡`, glow: !ctx?.powerFrozen });
        }
      }
      if (eff.type === 'grant_land_grants') {
        parts.push(p(isUpgraded ? '↓2🃏' : '↓🃏'));
        parts.push(p('↑🃏'));
      }
      if (eff.type === 'actions_per_cards_played') {
        const max = isUpgraded
          ? ((eff.metadata?.upgraded_max as number) ?? 4)
          : ((eff.metadata?.max as number) ?? 3);
        parts.push(p(`+≤${max}⚡`));
        if (isUpgraded) parts.push(p('+1🃏'));
      }
      if (eff.type === 'next_turn_bonus') {
        const draw = (eff.metadata?.draw as number) ?? 0;
        const resources = (eff.metadata?.resources as number) ?? 0;
        const actions = isUpgraded ? ((eff.metadata?.upgraded_actions as number) ?? 0) : 0;
        const bonusParts: string[] = [];
        if (draw > 0) bonusParts.push(`+${draw}⏰🃏`);
        if (resources > 0) bonusParts.push(`+${resources}⏰💰`);
        if (actions > 0) bonusParts.push(`+${actions}⏰⚡`);
        if (bonusParts.length > 0) parts.push(p(bonusParts.join(' · ')));
      }
      if (eff.type === 'mulligan') {
        parts.push(p('🃏↘ · +🃏'));
        if (isUpgraded) parts.push(p('+1🃏'));
        parts.push(p(`+${card.action_return}⚡`));
      }
      if (eff.type === 'inject_rubble') {
        const count = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`🎯+${count}🧱`));
      }
      if (eff.type === 'global_claim_ban') {
        parts.push(p('🚫⚔️'));
        if (isUpgraded) parts.push(p('+2🃏'));
      }
      if (eff.type === 'global_random_trash') {
        parts.push(p(isUpgraded ? '🎯✂️🃏' : '✂️🃏'));
      }
      if (eff.type === 'swap_draw_discard') {
        parts.push(p('🔄'));
        if (isUpgraded) parts.push(p('+2🃏'));
      }
      if (eff.type === 'abandon_tile') {
        parts.push(p('🔷↘'));
      }
      if (eff.type === 'abandon_and_block') {
        const gained = isUpgraded ? 3 : 2;
        parts.push(p(`🔷↘🚧 · +${gained}💰`));
      }
      if (eff.type === 'mandatory_self_trash') {
        const count = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`✂️${count}`));
      }
      if (eff.type === 'play_resource_cost') {
        const cost = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`-${cost}💰`));
      }
    }
  }

  // Extra action cost (heavy cards like Siege Tower, Elite Vanguard)
  if (card.action_cost > 1) {
    parts.push(p(`-${card.action_cost - 1}⚡`));
  }

  // Trash on use
  if (card.trash_on_use) parts.push(p('🗑️'));

  return parts;
}

/** Resolve a VP formula to a concrete number given game context. */
function _resolveVPFormula(card: Card, ctx: CardSubtitleContext): number | undefined {
  const formula = card.vp_formula;
  const isUpgraded = card.is_upgraded;

  if (formula === 'trash_div_5' && ctx.trashCount !== undefined) {
    const divisor = isUpgraded ? 4 : 5;
    return Math.floor(ctx.trashCount / divisor);
  }
  if (formula === 'deck_div_10' && ctx.totalDeckCards !== undefined) {
    const divisor = isUpgraded ? 8 : 10;
    return Math.floor(ctx.totalDeckCards / divisor);
  }
  // Colony, Warden, Ironclad — complex formulas that depend on board state
  // not easily resolved client-side; leave as generic +★
  return undefined;
}
