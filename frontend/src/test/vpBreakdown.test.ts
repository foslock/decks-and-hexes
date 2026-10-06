import { describe, it, expect } from 'vitest';
import type { HexTile } from '../types/game';
import { boardVpChanges, computeTileBasedVp } from '../utils/vpBreakdown';
import { makeTile } from './fixtures';

/** A row of tiles along r = 0 from q = 0: a base for each player at the ends,
 *  a VP hex (worth 2) at q = 3. */
function row(owners: (string | null)[]): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  owners.forEach((owner, q) => {
    tiles[`${q},0`] = makeTile(q, 0, {
      owner,
      is_base: q === 0 || q === owners.length - 1,
      is_vp: q === 3,
      vp_value: q === 3 ? 2 : 1,
    });
  });
  return tiles;
}

const take = (tiles: Record<string, HexTile>, key: string, owner: string | null) => ({ ...tiles, [key]: { ...tiles[key], owner } });

describe('boardVpChanges', () => {
  it('a third tile scores a VP from the tile just taken', () => {
    const before = row(['a', 'a', null, null, null, null, 'b']);
    const after = take(before, '2,0', 'a');
    expect(boardVpChanges(before, after, ['a'], '2,0')).toEqual([{ playerId: 'a', delta: 1, tileKey: '2,0' }]);
  });

  it('a VP hex connecting to its base scores from the hex, not the tile that connected it', () => {
    // a holds the VP hex at 3 but it's cut off at 2; taking 2 connects it (and makes 4 tiles: still 1 VP).
    const before = row(['a', 'a', null, 'a', null, null, 'b']);
    const after = take(before, '2,0', 'a');
    expect(boardVpChanges(before, after, ['a'], '2,0')).toEqual([{ playerId: 'a', delta: 2, tileKey: '3,0' }]);
  });

  it('losing the tile that connects a VP hex loses its VP from the hex; the taker\'s third tile scores from the tile', () => {
    // a: 4 tiles → 3 (still 1 VP), and the VP hex is cut off. b: 2 tiles → 3.
    const before = row(['a', 'a', 'a', 'a', null, 'b', 'b']);
    const after = take(before, '2,0', 'b');
    const changes = boardVpChanges(before, after, ['b', 'a'], '2,0');
    expect(changes).toEqual([
      { playerId: 'b', delta: 1, tileKey: '2,0' },
      { playerId: 'a', delta: -2, tileKey: '3,0' },
    ]);
    // They add up to the change in score.
    for (const pid of ['a', 'b']) {
      const vp = (t: Record<string, HexTile>) => { const v = computeTileBasedVp(t, pid); return v.tileCount + v.bonusTiles; };
      expect(changes.filter(c => c.playerId === pid).reduce((n, c) => n + c.delta, 0)).toBe(vp(after) - vp(before));
    }
  });

  it('dropping below a multiple of 3 loses a VP from the lost tile', () => {
    const before = row(['a', 'a', 'a', null, null, 'b', 'b']);
    const after = take(before, '2,0', null);
    expect(boardVpChanges(before, after, ['a'], '2,0')).toEqual([{ playerId: 'a', delta: -1, tileKey: '2,0' }]);
  });

  it('nothing changes hands, nothing scores', () => {
    const tiles = row(['a', 'a', 'a', 'a', null, 'b', 'b']);
    expect(boardVpChanges(tiles, { ...tiles }, ['a', 'b'], '4,0')).toEqual([]);
  });
});
