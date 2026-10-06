import type { GameState, HexTile } from '../types/game';

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const TILES_PER_VP = 3;

/** Keys of a player's tiles connected to their base through their own land. */
function connectedLand(tiles: Record<string, HexTile>, playerId: string): Set<string> {
  const baseKeys: string[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) baseKeys.push(key);
  }
  const reachable = new Set<string>(baseKeys);
  const queue = [...baseKeys];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const tile = tiles[key];
    if (!tile) continue;
    for (const [dq, dr] of HEX_DIRS) {
      const nk = `${tile.q + dq},${tile.r + dr}`;
      if (reachable.has(nk)) continue;
      const neighbor = tiles[nk];
      if (!neighbor || neighbor.owner !== playerId) continue;
      reachable.add(nk);
      queue.push(nk);
    }
  }
  return reachable;
}

/** VP each of a player's connected VP hexes scores, by tile key. */
function vpHexes(tiles: Record<string, HexTile>, playerId: string): Map<string, number> {
  const reachable = connectedLand(tiles, playerId);
  const out = new Map<string, number>();
  for (const [key, t] of Object.entries(tiles)) {
    if (t.owner === playerId && t.is_vp && reachable.has(key)) out.set(key, t.vp_value);
  }
  return out;
}

const ownedCount = (tiles: Record<string, HexTile>, playerId: string) =>
  Object.values(tiles).filter(t => t.owner === playerId).length;

/** Returns the tile-driven VP components for a player given an arbitrary tile map.
 *  Does not require a full GameState — used during resolve animations to recompute
 *  VP incrementally as tiles change hands. */
export function computeTileBasedVp(
  tiles: Record<string, HexTile>,
  playerId: string,
): { tileCount: number; bonusTiles: number } {
  const tileCount = Math.floor(ownedCount(tiles, playerId) / TILES_PER_VP);
  const bonusTiles = [...vpHexes(tiles, playerId).values()].reduce((sum, v) => sum + v, 0);
  return { tileCount, bonusTiles };
}

/** A player's VP moving with the board, and the tile it comes from. */
export interface BoardVpChange {
  playerId: string;
  delta: number;
  tileKey: string;
}

/**
 * How a change on the board moves these players' VP, and where from: a VP
 * hex connecting to (or cut off from) its holder's base comes from that hex;
 * the tile count crossing a multiple of 3 comes from `changedKey`, the tile
 * that changed hands.
 */
export function boardVpChanges(
  before: Record<string, HexTile>,
  after: Record<string, HexTile>,
  playerIds: Iterable<string>,
  changedKey: string,
): BoardVpChange[] {
  const out: BoardVpChange[] = [];
  for (const playerId of new Set(playerIds)) {
    const counted = Math.floor(ownedCount(after, playerId) / TILES_PER_VP) - Math.floor(ownedCount(before, playerId) / TILES_PER_VP);
    if (counted) out.push({ playerId, delta: counted, tileKey: changedKey });
    const was = vpHexes(before, playerId), now = vpHexes(after, playerId);
    for (const tileKey of new Set([...was.keys(), ...now.keys()])) {
      const delta = (now.get(tileKey) ?? 0) - (was.get(tileKey) ?? 0);
      if (delta) out.push({ playerId, delta, tileKey });
    }
  }
  return out;
}

export interface VpBreakdown {
  tileCount: number;   // VP from owning tiles (tiles // 3)
  bonusTiles: number;  // VP from connected VP hexes
  cards: number;       // VP from card effects (passive_vp + formula + bonus)
}

export function computeVpBreakdown(
  gameState: GameState,
  playerId: string,
): VpBreakdown {
  const player = gameState.players[playerId];
  if (!player || !gameState.grid) return { tileCount: 0, bonusTiles: 0, cards: 0 };
  const { tileCount, bonusTiles } = computeTileBasedVp(gameState.grid.tiles ?? {}, playerId);
  // Cards VP: everything else (passive_vp, formula, bonus)
  const cards = Math.max(0, player.vp - tileCount - bonusTiles);
  return { tileCount, bonusTiles, cards };
}
