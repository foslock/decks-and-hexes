import type { Card, HexTile } from '../types/game';

/** Axial neighbor offsets (same order as the board's). */
const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** What a claim's power can depend on, at the moment it's about to be played. */
export interface ClaimPowerContext {
  tiles: Record<string, HexTile>;
  playerId: string;
  /** Cards in hand, counting the one being played. */
  handSize: number;
  /** Cards already played this round (not counting this one). */
  played: Card[];
  /** Actions left once this card is played (zero-action bonuses). */
  actionsLeftAfter?: number;
}

const effValue = (card: Card, eff: { value?: number; upgraded_value?: number | null }) =>
  card.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : (eff.value ?? 0);
const baseName = (name: string) => name.replace(/\+$/, '');

function ownedCount(tiles: Record<string, HexTile>, pid: string): number {
  let n = 0;
  for (const t of Object.values(tiles)) if (t.owner === pid) n++;
  return n;
}

function adjacentOwned(tiles: Record<string, HexTile>, tile: HexTile, pid: string): number {
  let n = 0;
  for (const [dq, dr] of HEX_DIRS) if (tiles[`${tile.q + dq},${tile.r + dr}`]?.owner === pid) n++;
  return n;
}

/**
 * True if claiming `tile` would connect two or more currently disconnected
 * groups of `playerId`'s tiles (mirrors backend `tile_bridges_territory`).
 */
export function tileBridgesTerritory(tile: HexTile, tiles: Record<string, HexTile>, playerId: string): boolean {
  const owned = new Set(Object.keys(tiles).filter(k => tiles[k].owner === playerId));
  const starts: string[] = [];
  for (const [dq, dr] of HEX_DIRS) {
    const nk = `${tile.q + dq},${tile.r + dr}`;
    if (owned.has(nk)) starts.push(nk);
  }
  if (starts.length < 2) return false;
  const visited = new Set<string>();
  let groups = 0;
  for (const start of starts) {
    if (visited.has(start)) continue;
    if (++groups >= 2) return true;
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const [cq, cr] = queue.pop()!.split(',').map(Number);
      for (const [dq, dr] of HEX_DIRS) {
        const nk = `${cq + dq},${cr + dr}`;
        if (!visited.has(nk) && owned.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
  }
  return false;
}

/** A tile carries a defense *bonus* (fortified, or this round's Defense
 *  cards) — not just intrinsic terrain / base defense. */
const hasDefenseBonus = (t: HexTile) => (t.permanent_defense_bonus ?? 0) > 0 || t.defense_power > t.base_defense;

/**
 * A claim card's power on a tile from its own effects — what the server
 * snapshots when it's played (backend `_calculate_intrinsic_power`). Dog
 * Pile-style stacking bonuses and War Banner buffs come on top.
 *
 * "If contested" (Ambush) can only count a tile an opponent already owns:
 * whether someone else claims it too isn't known until the reveal.
 */
export function intrinsicClaimPower(card: Card, tileKey: string, ctx: ClaimPowerContext): number {
  const { tiles, playerId: me, played } = ctx;
  const tile = tiles[tileKey];
  let bonus = 0;
  for (const eff of card.effects ?? []) {
    const v = effValue(card, eff);
    if (eff.type === 'power_per_tiles_owned') {
      const tileBonus = Math.floor(ownedCount(tiles, me) / (v > 0 ? v : 3));
      if (eff.metadata?.replaces_base_power) return tileBonus;
      bonus += tileBonus;
      continue;
    }
    if (eff.type === 'power_per_same_name') {
      if (eff.metadata?.upgraded_only && !card.is_upgraded) continue;
      bonus += v * played.filter(c => baseName(c.name) === baseName(card.name) && c.id !== card.id).length;
      continue;
    }
    if (eff.type !== 'power_modifier') continue;
    const cond = eff.condition ?? 'always';
    if (cond === 'cards_in_hand') return Math.max(0, ctx.handSize - 1) + v;
    let ok = false;
    switch (cond) {
      case 'always':
      case 'vp_hexes_controlled':
        ok = true; break;
      case 'if_played_claim_this_turn':
        ok = played.some(c => c.card_type === 'claim' && c.id !== card.id); break;
      case 'if_played_same_name':
        ok = played.some(c => baseName(c.name) === baseName(card.name) && c.id !== card.id); break;
      case 'if_adjacent_owned_gte':
        ok = !!tile && adjacentOwned(tiles, tile, me) >= (eff.condition_threshold ?? 0); break;
      case 'if_defending_owned':
        ok = tile?.owner === me; break;
      case 'if_target_neutral':
        ok = !!tile && !tile.owner; break;
      case 'tiles_more_than_defender':
        ok = !!tile?.owner && tile.owner !== me && ownedCount(tiles, me) > ownedCount(tiles, tile.owner); break;
      case 'fewest_tiles': {
        const mine = ownedCount(tiles, me);
        const others = new Set(Object.values(tiles).map(t => t.owner).filter((o): o is string => !!o && o !== me));
        ok = [...others].every(o => ownedCount(tiles, o) >= mine);
        break;
      }
      case 'if_target_has_defense':
        ok = !!tile && hasDefenseBonus(tile); break;
      case 'if_bridges_territory':
        ok = !!tile && tileBridgesTerritory(tile, tiles, me); break;
      case 'zero_actions':
        ok = (ctx.actionsLeftAfter ?? 1) <= 0; break;
      case 'if_cards_played_this_round_gte':
        ok = played.length + 1 >= (eff.condition_threshold ?? 0); break;
      case 'if_contested':
        ok = !!tile?.owner && tile.owner !== me; break;
      default:
        ok = false;
    }
    if (!ok) continue;
    if (cond === 'if_adjacent_owned_gte' && eff.metadata?.per_tile) bonus += v * (tile ? adjacentOwned(tiles, tile, me) : 0);
    else bonus += v;
  }
  return card.power + bonus;
}

/** The power a claim stack gets from Dog Pile-style stacking bonuses: each
 *  claim adds its bonus to every *other* claim on the tile. */
export function stackingBonus(claims: Card[]): number {
  if (claims.length < 2) return 0;
  let total = 0;
  for (const c of claims) {
    for (const eff of c.effects ?? []) if (eff.type === 'stacking_power_bonus') total += effValue(c, eff);
  }
  return total * (claims.length - 1);
}
