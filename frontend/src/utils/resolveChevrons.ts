import type { HexTile, ResolutionClaimant, ResolutionStep } from '../types/game';

/** Hex distance in axial coordinates. */
export function hexDist(q1: number, r1: number, q2: number, r2: number): number {
  return Math.max(Math.abs(q1 - q2), Math.abs(r1 - r2), Math.abs((q1 + r1) - (q2 + r2)));
}

/** The tile a player owns nearest to a target position. */
export function findNearestOwnedTile(
  targetQ: number, targetR: number,
  tiles: Record<string, HexTile>,
  playerId: string,
): { q: number; r: number } | null {
  let closest: { q: number; r: number } | null = null;
  let minDist = Infinity;
  for (const tile of Object.values(tiles)) {
    if (tile.owner !== playerId) continue;
    const dist = hexDist(tile.q, tile.r, targetQ, targetR);
    if (dist < minDist) {
      minDist = dist;
      closest = { q: tile.q, r: tile.r };
    }
  }
  return closest;
}

/**
 * Where a claimant's advancing chevron starts during the reveal, using the
 * tiles as they were before the round resolved: the nearest tile they held
 * (their base for a long-range claim). A spill-over (Breakthrough's
 * auto-claim) advances from the tile the card was played on instead.
 */
export function chevronSource(
  step: ResolutionStep,
  claimant: ResolutionClaimant,
  preResolveTiles: Record<string, HexTile>,
): { q: number; r: number } | null {
  if (step.outcome === 'auto_claim' && claimant.source_q != null && claimant.source_r != null) {
    return { q: claimant.source_q, r: claimant.source_r };
  }
  const closest = findNearestOwnedTile(step.q, step.r, preResolveTiles, claimant.player_id);
  if (!closest) return null;
  if (hexDist(step.q, step.r, closest.q, closest.r) > 1) {
    const base = Object.values(preResolveTiles).find(t => t.is_base && t.owner === claimant.player_id);
    if (base) return { q: base.q, r: base.r };
  }
  return closest;
}
