import { describe, expect, it } from 'vitest';
import type { HexTile } from '../types/game';
import { BoardLayout } from '../board3d/layout';
import { emptySpots, wallEdges, type Footprint } from '../board3d/props';
import { buildTerritoryPiece, campSpot, territoryPieces } from '../board3d/territory';
import { Soup } from '../board3d/soup';
import { makeTile } from './fixtures';

/** A radius-2 board: "a" holds the middle and two tiles east of it. */
function board(over: Record<string, Partial<HexTile>> = {}): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) if (Math.abs(q + r) <= 2) tiles[`${q},${r}`] = makeTile(q, r);
  for (const k of ['0,0', '1,0', '2,0']) tiles[k] = { ...tiles[k], owner: 'a' };
  for (const [k, o] of Object.entries(over)) tiles[k] = { ...tiles[k], ...o };
  return tiles;
}
const arch = (map: Record<string, string>) => (pid: string) => map[pid] ?? 'vanguard';
const color = () => 0xff0000;

describe('territoryPieces', () => {
  it('camps on every held plain tile and outlines only edges facing other land', () => {
    const tiles = board();
    const layout = new BoardLayout(tiles);
    const pieces = territoryPieces(layout, tiles, new Map(), arch({ a: 'swarm' }), color);
    const camps = pieces.filter(p => p.k < 0).map(p => p.tileKey).sort();
    expect(camps).toEqual(['0,0', '1,0', '2,0']);
    expect(pieces.every(p => p.theme === 'swarm')).toBe(true);
    // The middle tile shares one edge with 1,0 — the other five are outline.
    expect(pieces.filter(p => p.tileKey === '0,0' && p.k >= 0)).toHaveLength(5);
    // 1,0 sits between two of its own tiles.
    expect(pieces.filter(p => p.tileKey === '1,0' && p.k >= 0)).toHaveLength(4);
  });

  it('leaves bases alone, gives towns an outline but no camp, and lets walls draw their own outline', () => {
    const tiles = board({
      '0,0': { is_base: true, base_owner: 'a' },
      '1,0': { is_vp: true, base_defense: 0 },
      '2,0': { permanent_defense_bonus: 2 },
    });
    const pieces = territoryPieces(new BoardLayout(tiles), tiles, new Map(), arch({}), color);
    expect(pieces.some(p => p.tileKey === '0,0')).toBe(false);
    expect(pieces.filter(p => p.tileKey === '1,0').every(p => p.k >= 0)).toBe(true);
    expect(pieces.filter(p => p.tileKey === '2,0').map(p => p.k)).toEqual([-1]);
  });

  it('rebuilds a piece when its holder\'s look changes', () => {
    const tiles = board();
    const layout = new BoardLayout(tiles);
    const sig = (a: string) => territoryPieces(layout, tiles, new Map(), arch({ a }), color).find(p => p.key === 'camp:0,0')!.signature;
    expect(sig('vanguard')).not.toBe(sig('fortress'));
  });

  it('builds geometry for every style', () => {
    const tiles = board();
    const layout = new BoardLayout(tiles);
    for (const a of ['vanguard', 'swarm', 'fortress']) {
      for (const p of territoryPieces(layout, tiles, new Map(), arch({ a }), color)) {
        const s = new Soup(1);
        buildTerritoryPiece(s, layout.byKey.get(p.tileKey)!, layout, p, emptySpots());
        expect(s.vertexCount).toBeGreaterThan(0);
      }
    }
  });
});

describe('campSpot', () => {
  const tiles = board();
  const tile = new BoardLayout(tiles).byKey.get('0,0')!;

  it('pitches camp on open ground, clearing nothing', () => {
    // Trees everywhere but toward corner 3 (west).
    const taken: Footprint[] = [];
    for (let k = 0; k < 6; k++) {
      if (k === 3) continue;
      const a = (Math.PI / 3) * k;
      for (const rad of [0.3, 0.5, 0.7]) taken.push({ x: Math.cos(a) * rad, z: Math.sin(a) * rad, d: 0.15 });
    }
    const spot = campSpot(tile, taken);
    expect(spot.x).toBeLessThan(-0.3);
    expect(spot.clear).toBe(0);
  });

  it('clears a little room in a thick forest', () => {
    const taken: Footprint[] = [];
    for (let x = -0.9; x <= 0.9; x += 0.15) for (let z = -0.9; z <= 0.9; z += 0.15) taken.push({ x, z, d: 0.15 });
    expect(campSpot(tile, taken).clear).toBeGreaterThan(0);
  });
});

describe('themed walls', () => {
  it('take their holder\'s archetype; unowned walls stay neutral', () => {
    const tiles = board({ '0,0': { permanent_defense_bonus: 2 }, '-2,0': { base_defense: 1 } });
    const edges = wallEdges(new BoardLayout(tiles), tiles, arch({ a: 'fortress' }), color);
    expect(new Set(edges.filter(e => e.tileKey === '0,0').map(e => e.theme))).toEqual(new Set(['fortress']));
    expect(new Set(edges.filter(e => e.tileKey === '-2,0').map(e => e.theme))).toEqual(new Set(['neutral']));
  });
});
