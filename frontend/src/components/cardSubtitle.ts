import type { Card } from '../types/game';
import { GLYPHS, type IconName } from '../icons/glyphs';

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
  /** Number of Defense cards currently in the player's hand (for Quartermaster) */
  defenseCardsInHand?: number;
  /** Number of the player's owned tiles with any defense bonus (for Watchful Keep) */
  tilesWithDefenseOwned?: number;
  /** Number of cards in the player's trash pile */
  trashCount?: number;
  /** Total cards in the player's deck (draw + hand + discard) */
  totalDeckCards?: number;
  /** Resources the player currently holds */
  resourcesHeld?: number;
  /** Tiles captured from the player last round */
  tilesLostLastRound?: number;
  /** Tiles the player captured from opponents last round (for Pursuit) */
  tilesCapturedFromOpponentsLastRound?: number;
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
  /** True when the active player has already played a Claim card this round
   *  (drives Strike Team's if_played_claim_this_turn power_modifier). */
  hasPlayedClaimThisRound?: boolean;
}

/**
 * One token of a subtitle part:
 *  - `icon` — a glyph from the Card Clash icon set (optionally slashed = "no X")
 *  - `num`  — a numeric value ("3", "+2", "2/4", "≤3", "×5", or a lone sign)
 *  - `text` — anything else (punctuation, separators, words like "Immune")
 */
export type SubtitleToken =
  | { kind: 'icon'; name: IconName; slash?: boolean }
  | { kind: 'num'; text: string }
  | { kind: 'text'; text: string };

/** A single segment of a card subtitle (parts are joined with " · "). */
export interface SubtitlePart {
  tokens: SubtitleToken[];
  /** True when this value was resolved from live game context (e.g. tile count). */
  dynamic?: boolean;
  /** True for granted-stackable indicator — rendered bold yellow with glow. */
  glow?: boolean;
}

/** Numeric values inside text runs. */
const VALUE_RE = /×\d+|[+\-−]?≤?\d+(?:\/\d+)?\+?|[+\-−≤](?=$|[^\s,)])/gu;
const ICON_RE = /\{(!?)([A-Za-z]+)\}/g;

/**
 * Parse the compact authoring syntax used below into tokens:
 * `{name}` is an icon, `{!name}` a slashed icon, numbers become `num`
 * tokens and everything else is `text`. Example: `+2{resource}`,
 * `{power}3{stack} · 2{tile}`, `{opponent}-1{card}`.
 */
export function parseSubtitle(src: string): SubtitleToken[] {
  const out: SubtitleToken[] = [];
  const pushText = (t: string) => {
    let last = 0;
    for (const m of t.matchAll(VALUE_RE)) {
      if (m.index! > last) out.push({ kind: 'text', text: t.slice(last, m.index) });
      out.push({ kind: 'num', text: m[0] });
      last = m.index! + m[0].length;
    }
    if (last < t.length) out.push({ kind: 'text', text: t.slice(last) });
  };
  let last = 0;
  for (const m of src.matchAll(ICON_RE)) {
    if (m.index! > last) pushText(src.slice(last, m.index));
    const name = m[2];
    if (name in GLYPHS) {
      out.push(m[1] ? { kind: 'icon', name: name as IconName, slash: true } : { kind: 'icon', name: name as IconName });
    } else {
      pushText(m[0]); // unknown glyph name — leave visible so it gets noticed
    }
    last = m.index! + m[0].length;
  }
  if (last < src.length) pushText(src.slice(last));
  return out;
}

/** Plain-language reading of a subtitle (aria-labels, logs, tests). */
export function subtitleToText(parts: SubtitlePart[]): string {
  return parts
    .map(part => part.tokens
      .map(t => (t.kind === 'icon' ? ` ${GLYPHS[t.name].label.toLowerCase()}${t.slash ? ' (blocked)' : ''} ` : t.text))
      .join('')
      .replace(/\s+/g, ' ')
      .trim())
    .join(', ');
}

/**
 * Build the compact stat-line parts for a card (e.g. "{power}3 · +2{resource} · {trash}").
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

  const p = (src: string, dynamic?: boolean): SubtitlePart =>
    dynamic ? { tokens: parseSubtitle(src), dynamic: true } : { tokens: parseSubtitle(src) };
  const pg = (src: string, glow: boolean): SubtitlePart =>
    glow ? { tokens: parseSubtitle(src), glow: true } : { tokens: parseSubtitle(src) };

  // Special case: Debt card
  if (card.name === 'Debt') {
    parts.push(p('-3{resource}{then}{trash}'));
    return parts;
  }

  // VP
  if (card.passive_vp !== undefined && card.passive_vp !== 0) {
    parts.push(pg(`${card.passive_vp}{vp}`, card.passive_vp > 0));
  } else if (card.vp_formula) {
    // Prefer authoritative backend-computed current_vp (glowing yellow);
    // fall back to client-side resolution, then generic placeholder.
    if (card.current_vp !== undefined) {
      parts.push(pg(`${card.current_vp}{vp}`, card.current_vp > 0));
    } else {
      const resolvedVP = ctx ? _resolveVPFormula(card, ctx) : undefined;
      if (resolvedVP !== undefined && resolvedVP > 0) {
        parts.push(p(`${resolvedVP}{vp}`, true));
      } else {
        parts.push(p('{vp}'));
      }
    }
  }

  // Defense cards
  if (card.card_type === 'defense') {
    const defBase = card.defense_bonus > 0 ? card.defense_bonus : card.power;
    const hasPerAdj = card.effects?.some(e => e.type === 'defense_per_adjacent');
    const hasPermanent = card.effects?.some(e => e.type === 'permanent_defense');
    const hasImmunity = card.effects?.some(e => e.type === 'tile_immunity');
    const dtc = card.defense_target_count || 1;
    const tileSuffix = dtc >= 2 ? ` · ${dtc}{tile}` : '';
    if (hasImmunity) {
      parts.push(p('{immune}Immune'));
    } else if (hasPerAdj) {
      // Nest: +X defense per adjacent owned tile — scaling is unknown at
      // preview time, so just show "+" to signal "gains defense".
      parts.push(p(`{defense}+${tileSuffix}`));
    } else if (hasPermanent) {
      // Permanent defense (Entrench, Twin Cities) — the fortify glyph signals the
      // bonus persists across rounds.
      const mod = card.effects?.find(e => e.type === 'permanent_defense');
      const permVal = mod
        ? (isUpgraded ? ((mod.metadata?.upgraded_value as number) ?? mod.value) : mod.value)
        : defBase;
      parts.push(p(`{fortify}${permVal}${tileSuffix}`));
    } else if (defBase > 0) {
      // Round-only defense bonus (Fortify, Bulwark, Barricade, etc.) —
      // + marker signals "this round only".
      parts.push(p(`{defense}+${defBase}${tileSuffix}`));
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
    const claimTileSuffix = mtc >= 2 ? ` · ${mtc}{tile}` : '';
    // Natively stackable cards show {stack} inline; granted stackable shows it as a separate glowing part
    const stackIcon = (card.stackable && !card.granted_stackable) ? '{stack}' : '';
    // "Target-any-tile" cards (Eminent Domain, Proliferate) skip adjacency — mark with {anywhere}
    const targetAnyIcon = card.adjacency_required === false ? '{anywhere}' : '';
    // Ranged claims (Overrun, Flanking Strike): can target tiles claim_range > 1 hex steps
    // away from any owned tile. Mark with " · {range}N" where N is the range.
    const rangedIcon = (card.claim_range && card.claim_range > 1) ? ` · {range}${card.claim_range}` : '';
    // Flood cards (e.g. Flood): claim all tiles adjacent to a tile you own
    const isFlood = card.flood === true;

    if (ctx?.powerFrozen) {
      // Power already overridden with effective value — show as-is
      parts.push(p(`{power}${card.power}${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`));
    } else if (hasTileScaling && ctx?.tileCount !== undefined) {
      // Resolve tile-scaling power (Mob Rule, Locust Swarm)
      const tileEff = card.effects?.find(e => e.type === 'power_per_tiles_owned');
      if (tileEff) {
        const divisor = isUpgraded ? (tileEff.upgraded_value ?? tileEff.value) : tileEff.value;
        const replaces = tileEff.metadata?.replaces_base_power;
        const scaledPow = Math.floor(ctx.tileCount / divisor);
        const totalPow = replaces ? scaledPow : card.power + scaledPow;
        parts.push(p(`{power}${totalPow}${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`, totalPow > 0));
      } else {
        parts.push(p(`{power}${card.power}+${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`));
      }
    } else if (isUnbounded) {
      if (powerMods.some(e => e.condition === 'cards_in_hand') && ctx?.handSize !== undefined) {
        // Resolve hand-size power (Strength in Numbers)
        const handMod = powerMods.find(e => e.condition === 'cards_in_hand');
        const bonus = isUpgraded ? (handMod?.upgraded_value ?? handMod?.value ?? 0) : (handMod?.value ?? 0);
        const handPow = Math.max(0, ctx.handSize - 1) + bonus;
        parts.push(p(`{power}${handPow}${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`, handPow > 0));
      } else {
        const handMod = powerMods.find(e => e.condition === 'cards_in_hand');
        const minPow = handMod
          ? (isUpgraded ? (handMod.upgraded_value ?? handMod.value) : handMod.value)
          : card.power;
        parts.push(p(`{power}${minPow}+${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`));
      }
    } else if (fixedBonus) {
      const bonusVal = isUpgraded ? (fixedBonus.upgraded_value ?? fixedBonus.value) : fixedBonus.value;
      const conditionMet =
        fixedBonus.condition === 'if_played_claim_this_turn' &&
        ctx?.hasPlayedClaimThisRound === true;
      if (conditionMet) {
        parts.push(p(`{power}${card.power + bonusVal}${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`, true));
      } else {
        parts.push(p(`{power}${card.power}/${card.power + bonusVal}${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`));
      }
    } else {
      // Rabble+: +1 power per same-name card played → show dynamic power
      const hasSameNamePowerScaling = card.effects?.some(e =>
        e.type === 'power_per_same_name' && (!e.metadata?.upgraded_only || isUpgraded)
      );
      const powerSuffix = hasSameNamePowerScaling ? '+' : '';
      parts.push(p(`{power}${card.power}${powerSuffix}${stackIcon}${targetAnyIcon}${rangedIcon}${claimTileSuffix}`));
    }

    // Granted stackable indicator (Rally Cry) — shown as a separate glowing part
    if (card.granted_stackable) {
      parts.push(pg('{stack}', true));
    }

    // Flood claims hit every adjacent tile — show the bonus-tile indicator
    if (isFlood) {
      parts.push(p('+{tile}'));
    }
  }

  // Grant stackable (shown first among non-combat stats, e.g. Rally Cry).
  // Rally Cry+'s +1 power comes from its claim_buff_next_n effect, rendered below.
  if (card.effects) {
    for (const eff of card.effects) {
      if (eff.type === 'grant_stackable') {
        parts.push(p('{power}{stack}'));
      }
    }
  }

  // Stat icons (defer resource_gain for self_discard cards — shown after discard+action)
  const hasSelfDiscard = card.effects?.some(e => e.type === 'self_discard');
  // When self_discard marks `discard_first` (e.g. Caravan+: "Discard 1. Draw 1. Gain 2 actions."),
  // defer draw_cards so the {discard} icon renders before the +{card} icon.
  const discardFirst = card.effects?.some(
    e => e.type === 'self_discard' && e.metadata?.discard_first === true
  );
  // Legacy guard: a resource_refund_if_neutral effect renders its own "(+X{resource})" below, so skip
  // the flat resource_gain render to avoid duplication. (Juggernaut now uses a conditional
  // gain_resources effect, which the loader no longer double-parses into resource_gain.)
  const hasResourceRefund = card.effects?.some(e => e.type === 'resource_refund_if_neutral');
  // Pursuit / Quartermaster: dynamic resource effects below render their own +{resource} —
  // suppress the flat resource_gain parsed from the description to avoid duplication.
  const hasDynamicResource = card.effects?.some(e =>
    e.type === 'resources_per_tiles_captured_last_round' ||
    e.type === 'gain_resources_per_card_in_hand'
  );
  // Second Wave / Redemption+: search_zone is described first ("Search your discard pile..."),
  // so defer the flat resource/draw/action icons so they render after {search}.
  const hasSearchZone = card.effects?.some(e => e.type === 'search_zone');
  if (card.resource_gain > 0 && !hasSelfDiscard && !hasResourceRefund && !hasDynamicResource && !hasSearchZone) parts.push(p(`+${card.resource_gain}{resource}`));

  // Dynamic resource gain (War Tithe: resources per claims last round)
  if (card.effects) {
    const warTitheEff = card.effects.find(e => e.type === 'resources_per_claims_last_round');
    if (warTitheEff) {
      if (ctx?.effectiveResourceGain !== undefined) {
        // Use frozen snapshot from play time
        const gained = ctx.effectiveResourceGain;
        parts.push(p(`+${gained}{resource}`, gained > 0));
      } else if (ctx?.claimsWonLastRound !== undefined) {
        const perClaim = isUpgraded ? (warTitheEff.upgraded_value ?? warTitheEff.value) : warTitheEff.value;
        const gained = ctx.claimsWonLastRound * perClaim;
        parts.push(p(`+${gained}{resource}`, gained > 0));
      } else {
        // No context — show generic placeholder
        parts.push(p('+{resource}'));
      }
    }
  }

  // Check if card has a trash-conditional effect (self_trash, trash_gain_buy_cost, trash_gain_power)
  // These cards use "{trash}N → bonuses" format where bonuses are conditional on trashing
  const trashEffect = card.effects?.find(e => e.type === 'self_trash' || e.type === 'trash_gain_buy_cost' || e.type === 'trash_gain_power');
  const hasTrashConditional = !!trashEffect;

  // For trash-conditional cards, draw/action are shown after the → arrow, not here
  // For draw_per_connected_vp cards (Toll Road) and draw_per_debt cards (Financier), draw_cards is dynamic — skip flat display
  const hasDrawPerVP = card.effects?.some(e => e.type === 'draw_per_connected_vp');
  const hasDrawPerDebt = card.effects?.some(e => e.type === 'draw_per_debt');
  // Defer action icon when a later effect should appear first (to match description order)
  const hasDelayedDraw = card.effects?.some(e => e.type === 'draw_next_turn' || e.type === 'cease_fire');
  const hasMulligan = card.effects?.some(e => e.type === 'mulligan');
  const hasActionsPerCards = card.effects?.some(e => e.type === 'actions_per_cards_played');
  // Exodus: abandon_tile is described first ("Abandon a tile..."), so defer
  // both draw and action so they render after the {abandon} icon.
  const hasAbandonTile = card.effects?.some(e => e.type === 'abandon_tile');
  const hasResourcesPerTiles = card.effects?.some(e => e.type === 'resources_per_tiles_owned');
  // Pursuit: text leads with "For each tile captured last round, gain X resources…"
  // then follows with draw / action — defer both so they render after +{resource}.
  const hasResourcesPerTilesCapturedLastRound = card.effects?.some(e => e.type === 'resources_per_tiles_captured_last_round');
  // War Banner: text leads with "next N Claim(s) +2 power" and ends with "Gain 1 action" (upgraded) —
  // defer the action icon so it renders last.
  const hasClaimBuffNextN = card.effects?.some(e => e.type === 'claim_buff_next_n');
  // Quartermaster: "Gain X resources per Defense… Gain X action(s)" — defer action so it renders last.
  const hasGainResourcesPerCardInHand = card.effects?.some(e => e.type === 'gain_resources_per_card_in_hand');
  // Hatching Grounds / Master Engineer: text leads with "Add N cards to discard" — defer the action
  // icon so "N{cardAdd}" renders first.
  const hasCreateCardsToDiscard = card.effects?.some(e => e.type === 'create_cards_to_discard');
  // Drone Wave: dynamic draw scaling with tiles owned — suppress the flat draw_cards parsed from
  // the description and let the per-tile effect render the dynamic +{card} value first.
  const hasDrawPerTilesOwned = card.effects?.some(e => e.type === 'draw_per_tiles_owned');
  // Cartographer: "Discard 2. Draw 2. Gain 1 action." — action renders after the cycle icon.
  const hasCycle = card.effects?.some(e => e.type === 'cycle');
  const deferAction = hasCycle || hasDelayedDraw || hasSelfDiscard || hasMulligan || hasActionsPerCards || hasAbandonTile || hasResourcesPerTilesCapturedLastRound || hasClaimBuffNextN || hasGainResourcesPerCardInHand || hasCreateCardsToDiscard || hasDrawPerTilesOwned || hasSearchZone || hasDrawPerDebt;
  const deferDraw = hasAbandonTile || hasResourcesPerTiles || discardFirst || hasResourcesPerTilesCapturedLastRound || hasGainResourcesPerCardInHand || hasSearchZone;
  if (card.draw_cards > 0 && !hasTrashConditional && !hasDrawPerVP && !hasDrawPerDebt && !hasMulligan && !deferDraw && !hasDrawPerTilesOwned) parts.push(p(`+${card.draw_cards}{card}`));
  if (card.action_return > 0 && !hasTrashConditional && !deferAction) parts.push(p(`+${card.action_return}{action}`));
  if (card.forced_discard > 0) parts.push(p(`{opponent}-${card.forced_discard}{card}`));

  // Watchful Keep: dynamic draw per owned tile with any defense bonus (capped).
  // Rendered first — before other effect icons — to lead the subtitle with the main payoff.
  const drawPerDefTiles = card.effects?.find(e => e.type === 'draw_per_tiles_with_defense_bonus');
  if (drawPerDefTiles) {
    const per = isUpgraded && drawPerDefTiles.upgraded_value != null ? drawPerDefTiles.upgraded_value : drawPerDefTiles.value;
    const maxDraws = (isUpgraded
      ? (drawPerDefTiles.metadata?.upgraded_max_draws as number)
      : (drawPerDefTiles.metadata?.max_draws as number)) ?? 999;
    if (ctx?.effectiveDrawCards !== undefined) {
      parts.push(p(`+${ctx.effectiveDrawCards}{card}`, ctx.effectiveDrawCards > 0));
    } else if (ctx?.tilesWithDefenseOwned !== undefined) {
      const drawn = Math.min(ctx.tilesWithDefenseOwned * per, maxDraws);
      parts.push(p(`+${drawn}{card}`, drawn > 0));
    } else {
      parts.push(p('+{card}'));
    }
  }

  // Drone Wave: dynamic draw per N tiles owned (capped).
  // Rendered first so the dynamic +{card} leads the subtitle; action icon follows.
  const drawPerTilesOwnedEff = card.effects?.find(e => e.type === 'draw_per_tiles_owned');
  if (drawPerTilesOwnedEff) {
    const divisor = isUpgraded && drawPerTilesOwnedEff.upgraded_value != null
      ? drawPerTilesOwnedEff.upgraded_value
      : drawPerTilesOwnedEff.value;
    const maxDraws = (isUpgraded
      ? (drawPerTilesOwnedEff.metadata?.upgraded_max_draws as number)
      : (drawPerTilesOwnedEff.metadata?.max_draws as number)) ?? 999;
    if (ctx?.effectiveDrawCards !== undefined) {
      parts.push(p(`+${ctx.effectiveDrawCards}{card}`, ctx.effectiveDrawCards > 0));
    } else if (ctx?.tileCount !== undefined && divisor > 0) {
      const drawn = Math.min(Math.floor(ctx.tileCount / divisor), maxDraws);
      parts.push(p(`+${drawn}{card}`, drawn > 0));
    } else {
      parts.push(p('+{card}'));
    }
    if (card.action_return > 0) {
      parts.push(p(`+${card.action_return}{action}`));
    }
  }

  // Effect-based icons
  if (card.effects) {
    for (const eff of card.effects) {
      if (eff.type === 'trash_gain_power') {
        // Arms Dealer: trash 1, if Claim → gain (multiplier × power) resources + action(s)
        const actionVal = isUpgraded
          ? ((eff.metadata?.upgraded_claim_action_return as number) ?? 1)
          : ((eff.metadata?.claim_action_return as number) ?? 1);
        parts.push(p(`{trash}1{then}+{resource}, +${actionVal}{action}`));
      }
      if (eff.type === 'self_trash' || eff.type === 'trash_gain_buy_cost') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        // Build conditional bonuses after →
        const conditionalParts: string[] = [];
        if (eff.type === 'trash_gain_buy_cost') {
          const bonus = isUpgraded && eff.metadata?.upgrade_bonus ? Number(eff.metadata.upgrade_bonus) : 0;
          conditionalParts.push(bonus > 0 ? `${bonus}+{resource}` : '+{resource}');
        }
        if (card.draw_cards > 0) conditionalParts.push(`+${card.draw_cards}{card}`);
        if (eff.type !== 'trash_gain_buy_cost' && card.action_return > 0) conditionalParts.push(`+${card.action_return}{action}`);
        if (conditionalParts.length > 0) {
          parts.push(p(`{trash}${val}{then}${conditionalParts.join(', ')}`));
        } else {
          parts.push(p(`{trash}${val}`));
        }
      }
      if (eff.type === 'self_discard') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`{discard}${val}`));
        // When discard is declared first (Caravan+: "Discard 1. Draw 1. Gain 2 actions."),
        // emit the deferred draw before the deferred action to match description order.
        if (discardFirst && card.draw_cards > 0 && !hasTrashConditional && !hasDrawPerVP && !hasDrawPerDebt && !hasMulligan) {
          parts.push(p(`+${card.draw_cards}{card}`));
        }
        // Emit deferred action + resource icons after discard (e.g. Regroup: +2{card} · {discard}1 · +1{action})
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
        if (card.resource_gain > 0) {
          parts.push(p(`+${card.resource_gain}{resource}`));
        }
      }
      if (eff.type === 'gain_resources' && eff.condition && eff.condition !== 'always') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        // Conditional gains (Resilience: "If you control the fewest tiles...")
        // are shown in parentheses to signal the condition.
        if (val > 0) parts.push(p(`(+${val}{resource})`));
      }
      if (eff.type === 'draw_next_turn' || eff.type === 'cease_fire') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) {
          // Conditional delayed draws (e.g. Counterattack: "If an opponent's claim
          // on this tile fails, draw 1 card next round.") render in parens.
          const isConditional = eff.condition && eff.condition !== 'always';
          const text = isConditional ? `(+${val}{nextRound}{card})` : `+${val}{nextRound}{card}`;
          parts.push(p(text));
        }
        // Emit deferred action icon after delayed draw (e.g. Plunder: +3{resource} · +1{nextRound}{card} · +1{action})
        if (hasDelayedDraw && card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
      }
      if (eff.type === 'resource_scaling') {
        const divisor = eff.value || 2;
        if (ctx?.effectiveResourceGain !== undefined) {
          parts.push(p(`+${ctx.effectiveResourceGain}{resource}`, true));
        } else if (ctx?.resourcesHeld !== undefined) {
          const gained = Math.max(1, Math.floor(ctx.resourcesHeld / divisor));
          parts.push(p(`+${gained}{resource}`, true));
        } else {
          parts.push(p(`+1{resource}/${divisor}{resource}`));
        }
      }
      if (eff.type === 'cycle') {
        const discardN = (eff.metadata?.discard as number) ?? 2;
        const drawN = isUpgraded
          ? ((eff.metadata?.upgraded_draw as number) ?? (eff.metadata?.draw as number) ?? 2)
          : ((eff.metadata?.draw as number) ?? 2);
        parts.push(p(`{discard}${discardN} · +${drawN}{card}`));
        if (card.action_return > 0 && !hasTrashConditional) parts.push(p(`+${card.action_return}{action}`));
      }
      if (eff.type === 'resources_per_tiles_lost') {
        const perTile = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (ctx?.effectiveResourceGain !== undefined) {
          parts.push(p(`+${ctx.effectiveResourceGain}{resource}`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.tilesLostLastRound !== undefined) {
          const gained = ctx.tilesLostLastRound * perTile;
          parts.push(p(`+${gained}{resource}`, gained > 0));
        } else {
          parts.push(p(`+{resource}`));
        }
      }
      if (eff.type === 'resource_per_vp_hex') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (ctx?.effectiveResourceGain !== undefined) {
          // Use frozen snapshot from play time
          parts.push(p(`+${ctx.effectiveResourceGain}{resource}`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.vpHexCount !== undefined) {
          const gained = ctx.vpHexCount * val;
          parts.push(p(`+${gained}{resource}`, gained > 0));
        } else {
          parts.push(p(`+${val}{resource}/{vpTile}`));
        }
      }
      if (eff.type === 'resources_per_tiles_owned') {
        const divisor = isUpgraded ? (eff.upgraded_value ?? eff.value) : eff.value;
        if (ctx?.effectiveResourceGain !== undefined) {
          parts.push(p(`+${ctx.effectiveResourceGain}{resource}`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.tileCount !== undefined) {
          const gained = Math.floor(ctx.tileCount / divisor);
          parts.push(p(`+${gained}{resource}`, gained > 0));
        } else {
          parts.push(p(`+{resource}`));
        }
        // Emit deferred draw after resource effect (War Economy: "+{resource} · +1{card}")
        if (card.draw_cards > 0) parts.push(p(`+${card.draw_cards}{card}`));
      }
      if (eff.type === 'enhance_vp_tile') parts.push(p('{vpTile}+1'));
      if (eff.type === 'draw_per_connected_vp') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`+${val}{card}/{vpTile}`));
      }
      if (eff.type === 'draw_per_debt') {
        if (ctx?.effectiveDrawCards !== undefined) {
          // Use frozen snapshot from play time
          parts.push(p(`+${ctx.effectiveDrawCards}{card}`, ctx.effectiveDrawCards > 0));
        } else if (ctx?.debtCount !== undefined) {
          const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
          const totalDraw = ctx.debtCount * val;
          parts.push(p(`+${totalDraw}{card}`, totalDraw > 0));
        } else {
          parts.push(p('+1{card}/{debt}'));
        }
        // Emit deferred action after the dynamic draw icon (Financier+: "+N{card} · +2{action}")
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
      }
      if (eff.type === 'free_reroll') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`+${val}{reroll}`));
      }
      if (eff.type === 'conditional_action') {
        const threshold = eff.condition_threshold ?? 3;
        const condParts = `≤${threshold}{hand}, +${eff.value}{action}`;
        if (isUpgraded) {
          parts.push(p(`${condParts} · +1{resource}`));
        } else {
          parts.push(p(condParts));
        }
      }
      if (eff.type === 'conditional_action_return' && eff.condition === 'if_played_same_name') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        const baseName = card.name.replace(/\+$/, '');
        const met = ctx?.playedCardNames?.some(n => n.replace(/\+$/, '') === baseName) ?? false;
        // Always show the conditional bonus in parens (e.g. Rabble "(+1{action})");
        // glow yellow when the condition is active but not frozen.
        const text = `(+${val}{action})`;
        if (met && !ctx?.powerFrozen) {
          parts.push(pg(text, true));
        } else {
          parts.push(p(text));
        }
      }
      if (eff.type === 'grant_actions_next_turn') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) {
          // Forced March: all others gain N actions next round; Battle Cry: one opponent.
          const who = eff.target === 'all_others' ? '{allOpponents}' : '{opponent}';
          parts.push(p(`${who}+${val}{nextRound}{action}`));
        }
      }
      if (eff.type === 'resource_drain') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`({opponent}-${val}{resource})`));
      }
      if (eff.type === 'auto_claim_adjacent_neutral') {
        parts.push(p('(+{tile})'));
      }
      if (eff.type === 'trash_opponent_card') {
        parts.push(p('({opponent}{trash})'));
      }
      if (eff.type === 'grant_actions' && eff.condition === 'zero_actions') {
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`(+${val}{action})`));
      }
      if (eff.type === 'buy_restriction') {
        parts.push(p('{!buy}'));
      }
      if (eff.type === 'stacking_power_bonus') {
        // Dog Pile: each other claim you stack here gains +1 power
        parts.push(p('{power}+'));
      }
      if (eff.type === 'on_defend_forced_discard') {
        // Attrition: if defender holds, they draw 1 fewer card next round
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`(-${val}{nextRound}{card})`));
      }
      if (eff.type === 'resource_refund_if_neutral') {
        // Juggernaut: refund N resources if target tile was neutral
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`(+${val}{resource})`));
      }
      if (eff.type === 'ignore_defense') {
        // Siege Engine: bypass all defense bonuses on the target tile
        parts.push(p('{!defense}'));
      }
      if (eff.type === 'grant_land_grants') {
        // Diplomat: Land Grants for you and for each opponent.
        const md = eff.metadata ?? {};
        const selfCount = isUpgraded
          ? ((md.upgraded_self_count as number) ?? (md.self_count as number) ?? 2)
          : ((md.self_count as number) ?? 1);
        const othersCount = isUpgraded
          ? ((md.upgraded_others_count as number) ?? (md.others_count as number) ?? 1)
          : ((md.others_count as number) ?? 1);
        parts.push(p(selfCount > 1 ? `${selfCount}{cardAdd}` : '{cardAdd}'));
        if (othersCount > 0) parts.push(p(othersCount > 1 ? `{allOpponents}${othersCount}{cardAdd}` : '{allOpponents}{cardAdd}'));
      }
      if (eff.type === 'actions_per_cards_played') {
        const max = isUpgraded
          ? ((eff.metadata?.upgraded_max as number) ?? 4)
          : ((eff.metadata?.max as number) ?? 3);
        parts.push(p(`+≤${max}{action}`));
        if (isUpgraded) parts.push(p('+1{card}'));
      }
      if (eff.type === 'next_turn_bonus') {
        const draw = isUpgraded && eff.metadata?.upgraded_draw != null
          ? (eff.metadata.upgraded_draw as number)
          : ((eff.metadata?.draw as number) ?? 0);
        const resources = isUpgraded && eff.metadata?.upgraded_resources != null
          ? (eff.metadata.upgraded_resources as number)
          : ((eff.metadata?.resources as number) ?? 0);
        const actions = isUpgraded ? ((eff.metadata?.upgraded_actions as number) ?? 0) : 0;
        const bonusParts: string[] = [];
        if (draw > 0) bonusParts.push(`+${draw}{nextRound}{card}`);
        if (resources > 0) bonusParts.push(`+${resources}{nextRound}{resource}`);
        if (actions > 0) bonusParts.push(`+${actions}{nextRound}{action}`);
        if (bonusParts.length > 0) parts.push(p(bonusParts.join(' · ')));
      }
      if (eff.type === 'mulligan') {
        parts.push(p('{discard} · +{card}'));
        if (isUpgraded) parts.push(p('+1{card}'));
        parts.push(p(`+${card.action_return}{action}`));
      }
      if (eff.type === 'inject_rubble') {
        const count = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`{opponent}+${count}{rubble}`));
      }
      if (eff.type === 'global_claim_ban') {
        parts.push(p('{!power}'));
        if (isUpgraded) parts.push(p('+2{card}'));
      }
      if (eff.type === 'global_random_trash') {
        parts.push(p(isUpgraded ? '{opponent}{trash}{card}' : '{trash}{card}'));
      }
      if (eff.type === 'swap_draw_discard') {
        parts.push(p('{swap}'));
        if (isUpgraded) parts.push(p('+2{card}'));
      }
      if (eff.type === 'abandon_tile') {
        parts.push(p('{abandon}'));
        // Exodus: emit deferred action + draw after the abandon icon to match
        // description order ("Abandon. Gain 2 actions. Draw 2 cards.")
        if (card.action_return > 0) parts.push(p(`+${card.action_return}{action}`));
        if (card.draw_cards > 0) parts.push(p(`+${card.draw_cards}{card}`));
      }
      if (eff.type === 'abandon_and_block') {
        const gained = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`{abandon}{mountain} · +${gained}{resource}`));
      }
      if (eff.type === 'mandatory_self_trash') {
        const count = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`{trash}${count}`));
      }
      if (eff.type === 'search_zone') {
        // Compact icon for tutor/search effects. Format: <source> {search}N → <targets>
        // Zones use distinct glyphs so the trash bin is reserved for the
        // permanent trash pile (one-way) and the recycle symbol marks the
        // discard pile (gets reshuffled into the draw pile).
        // Source glyphs: discard {discard}, draw {drawPile}, trash {trash}
        // Target glyphs: hand {hand}, top_of_draw {deckTop}, discard {discard}, trash {trash}
        const count = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        const source = String(eff.metadata?.source ?? 'discard');
        const rawTargets = Array.isArray(eff.metadata?.targets) ? eff.metadata?.targets : ['hand'];
        const targets = (rawTargets as unknown[]).map(t => String(t));
        const srcIcon =
          source === 'draw' ? '{drawPile}' : source === 'trash' ? '{trash}' : '{discard}';
        const targetIcons = targets.map((t) =>
          t === 'hand' ? '{hand}' : t === 'top_of_draw' ? '{deckTop}' : t === 'discard' ? '{discard}' : '{trash}'
        ).join('/');
        parts.push(p(`${srcIcon}{search}${count}{then}${targetIcons}`));
        // Emit deferred icons after the search icon so they render in description order
        // (Redemption+: {trash}{search}→{hand} · +1{card}; Second Wave+: {discard}{search}→{hand} · +1{action} · +1{resource}).
        if (card.draw_cards > 0 && !hasTrashConditional && !hasDrawPerVP && !hasDrawPerDebt && !hasMulligan) {
          parts.push(p(`+${card.draw_cards}{card}`));
        }
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
        if (card.resource_gain > 0 && !hasResourceRefund && !hasDynamicResource) {
          parts.push(p(`+${card.resource_gain}{resource}`));
        }
      }
      if (eff.type === 'adjacency_bridge') {
        // Legacy targeting restriction: must connect two disconnected territory groups
        parts.push(p('{bridge}'));
      }
      if (eff.type === 'cost_reduction') {
        // Supply Line: next purchase this round costs N less
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`{buy}+${val}{resource}`));
      }
      if (eff.type === 'play_resource_cost') {
        const cost = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`-${cost}{resource}`));
      }
      if (eff.type === 'conditional_draw_next_round') {
        // Commander: "If you played a Claim this round, draw N cards next round."
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`(+${val}{nextRound}{card})`));
      }
      if (eff.type === 'conditional_draw') {
        // Chatter: "If 3+ cards played this round, draw N additional card(s)."
        const val = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (val > 0) parts.push(p(`(+${val}{card})`));
      }
      if (eff.type === 'resources_per_tiles_captured_last_round') {
        // Pursuit: resources scale with tiles captured from opponents last round.
        const perTile = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        if (ctx?.effectiveResourceGain !== undefined) {
          // Frozen snapshot at play time
          parts.push(p(`+${ctx.effectiveResourceGain}{resource}`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.tilesCapturedFromOpponentsLastRound !== undefined) {
          // Live: in-hand/in-play dynamic value
          const gained = ctx.tilesCapturedFromOpponentsLastRound * perTile;
          parts.push(p(`+${gained}{resource}`, gained > 0));
        } else {
          parts.push(p('+{resource}'));
        }
        // Emit deferred draw + action after the dynamic resource icon
        // (Pursuit+: "…gain 2 resources. Draw 1 card. Gain 2 actions.")
        if (card.draw_cards > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.draw_cards}{card}`));
        }
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
      }
      if (eff.type === 'create_cards_to_discard') {
        // Hatching Grounds / Master Engineer: add N copies of another card to your discard.
        const count = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        parts.push(p(`${count}{cardAdd}`));
        // Emit deferred action after the add-cards icon (Master Engineer: "3{cardAdd} · +1{action}").
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
      }
      if (eff.type === 'gain_resources_per_card_in_hand') {
        // Quartermaster: resources per Defense card in hand (capped).
        const perCard = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        const maxCounted = (isUpgraded
          ? (eff.metadata?.upgraded_max_counted as number)
          : (eff.metadata?.max_counted as number)) ?? 999;
        if (ctx?.effectiveResourceGain !== undefined) {
          parts.push(p(`+${ctx.effectiveResourceGain}{resource}`, ctx.effectiveResourceGain > 0));
        } else if (ctx?.defenseCardsInHand !== undefined) {
          const counted = Math.min(ctx.defenseCardsInHand, maxCounted);
          const gained = counted * perCard;
          parts.push(p(`+${gained}{resource}`, gained > 0));
        } else {
          parts.push(p('+{resource}'));
        }
        // Emit deferred draw + action after the dynamic resource icon
        if (card.draw_cards > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.draw_cards}{card}`));
        }
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
      }
      if (eff.type === 'claim_buff_next_n') {
        // War Banner: "The next N Claim(s) get +2 power. If successful, draw 1 card next round."
        // Swarm Tactics: next Claim +1 power. Rally Cry+: next 5 Claims +1 power (0 charges base).
        // The conditional delayed draw renders in parens to signal "only if the buffed Claim wins".
        const charges = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
        const powerBonus = (eff.metadata?.power_bonus as number) ?? 0;
        const drawNextRound = (eff.metadata?.draw_next_round_on_success as number) ?? 0;
        const chargeSuffix = charges > 1 ? `×${charges}` : '';
        if (charges > 0 && powerBonus > 0) parts.push(p(`+${powerBonus}{power}${chargeSuffix}`));
        if (charges > 0 && drawNextRound > 0) parts.push(p(`(+${drawNextRound}{nextRound}{card})`));
        // Emit deferred action icon last (Upgraded War Banner: "…Gain 1 action.")
        if (card.action_return > 0 && !hasTrashConditional) {
          parts.push(p(`+${card.action_return}{action}`));
        }
      }
    }
  }

  // Extra action cost (heavy cards like Siege Tower, Elite Vanguard)
  if (card.action_cost > 1) {
    parts.push(p(`-${card.action_cost - 1}{action}`));
  }

  // Trash on use
  if (card.trash_on_use) parts.push(p('{trash}'));

  // Unique (deck may hold one copy)
  if (card.unique) parts.push(p('{unique}'));

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
  if (formula === 'deck_div_12' && ctx.totalDeckCards !== undefined) {
    // Arsenal: 1 VP per 12 cards (10 upgraded)
    const divisor = isUpgraded ? 10 : 12;
    return Math.floor(ctx.totalDeckCards / divisor);
  }
  // Colony, Warden, Ironclad — complex formulas that depend on board state
  // not easily resolved client-side; leave as generic +{vp}
  return undefined;
}
