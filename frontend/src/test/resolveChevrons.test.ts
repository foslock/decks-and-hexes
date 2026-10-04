import { describe, it, expect } from 'vitest';
import type { HexTile, ResolutionStep } from '../types/game';
import { chevronSource } from '../utils/resolveChevrons';
import { makeTile } from './fixtures';

/** A radius-3 board; `own` maps keys to owners. */
function board(own: Record<string, string>, extra: Record<string, Partial<HexTile>> = {}): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -3; q <= 3; q++) {
    for (let r = -3; r <= 3; r++) {
      if (Math.abs(q + r) > 3) continue;
      const k = `${q},${r}`;
      tiles[k] = makeTile(q, r, { owner: own[k] ?? null, ...extra[k] });
    }
  }
  return tiles;
}

const step = (q: number, r: number, over: Partial<ResolutionStep> = {}): ResolutionStep => ({
  tile_key: `${q},${r}`, q, r, contested: false,
  claimants: [{ player_id: 'p0', power: 2, source_q: null, source_r: null }],
  defender_id: null, defender_power: 0, winner_id: 'p0', previous_owner: null, outcome: 'claimed', ...over,
});

describe('reveal chevrons', () => {
  it('a claim advances from the nearest tile held before the round', () => {
    const tiles = board({ '0,0': 'p0', '-2,0': 'p0' });
    const s = step(1, 0);
    expect(chevronSource(s, s.claimants[0], tiles)).toEqual({ q: 0, r: 0 });
  });

  it('a long-range claim points back at the base', () => {
    const tiles = board({ '-3,0': 'p0' }, { '-3,0': { is_base: true, base_owner: 'p0' } });
    const s = step(2, 0);
    expect(chevronSource(s, s.claimants[0], tiles)).toEqual({ q: -3, r: 0 });
  });

  it('a Breakthrough spill-over advances from the tile the card was played on', () => {
    // p0 held 0,0 and 1,-1 going in; Breakthrough was played on 1,0 and
    // spilled into 2,0 (next to 1,-1 too, which is nearer than 1,0 was then).
    const tiles = board({ '0,0': 'p0', '1,-1': 'p0' });
    const s = step(2, 0, {
      outcome: 'auto_claim', card_name: 'Breakthrough',
      claimants: [{ player_id: 'p0', power: 0, source_q: 1, source_r: 0 }],
    });
    expect(chevronSource(s, s.claimants[0], tiles)).toEqual({ q: 1, r: 0 });
  });
});
