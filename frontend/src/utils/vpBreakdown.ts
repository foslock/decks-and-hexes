import type { GameState } from '../types/game';

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const TILES_PER_VP = 3;

export interface VpBreakdown {
  tileCount: number;   // VP from owning tiles (tiles // 3)
  bonusTiles: number;  // VP from connected VP hexes
  cards: number;       // VP from card effects (passive_vp + formula + bonus)
}

export function computeVpBreakdown(
  gameState: GameState,
  playerId: string,
): VpBreakdown {
  const tiles = gameState.grid?.tiles ?? {};
  const player = gameState.players[playerId];
  if (!player || !gameState.grid) return { tileCount: 0, bonusTiles: 0, cards: 0 };

  // Tile VP: owned tiles // 3
  const ownedTiles = Object.values(tiles).filter(t => t.owner === playerId);
  const tileCount = Math.floor(ownedTiles.length / TILES_PER_VP);

  // Connected VP hexes: BFS from base tiles through owned territory
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
  const bonusTiles = ownedTiles
    .filter(t => t.is_vp && reachable.has(`${t.q},${t.r}`))
    .reduce((sum, t) => sum + t.vp_value, 0);

  // Cards VP: everything else (passive_vp, formula, bonus)
  const totalVp = player.vp;
  const cards = Math.max(0, totalVp - tileCount - bonusTiles);

  return { tileCount, bonusTiles, cards };
}
