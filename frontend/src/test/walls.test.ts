import { describe, it, expect } from 'vitest';
import type { HexTile } from '../types/game';
import { BoardLayout } from '../board3d/layout';
import { MAX_WALL_LEVEL, wallEdges, wallLevel } from '../board3d/props';
import { makeTile } from './fixtures';

/** A small board: a radius-2 hexagon of plain tiles, with overrides. */
function board(overrides: Record<string, Partial<HexTile>>): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) > 2) continue;
      tiles[`${q},${r}`] = makeTile(q, r, overrides[`${q},${r}`]);
    }
  }
  return tiles;
}

const edgesOf = (tiles: Record<string, HexTile>) => wallEdges(new BoardLayout(tiles), tiles);
const countFor = (edges: ReturnType<typeof edgesOf>, key: string) => edges.filter(e => e.tileKey === key).length;

describe('connected walls', () => {
  it('a lone fortified tile walls all six edges', () => {
    const edges = edgesOf(board({ '0,0': { base_defense: 1 } }));
    expect(edges.length).toBe(6);
    expect(edges.every(e => e.start === 'corner' && e.end === 'corner')).toBe(true);
  });

  it('equal same-holder neighbours share an enclosure: no wall on the shared edge', () => {
    const edges = edgesOf(board({
      '0,0': { base_defense: 1, owner: 'player_0' },
      '1,0': { permanent_defense_bonus: 1, owner: 'player_0' },
    }));
    expect(countFor(edges, '0,0')).toBe(5);
    expect(countFor(edges, '1,0')).toBe(5);
    // The walls either side of the open edge run on into the neighbour's.
    expect(edges.filter(e => e.start === 'merge').length).toBe(2);
    expect(edges.filter(e => e.end === 'merge').length).toBe(2);
  });

  it('a stronger tile keeps its wall next to a weaker one of the same holder', () => {
    const edges = edgesOf(board({
      '0,0': { base_defense: 3 },
      '1,0': { base_defense: 1 },
    }));
    // The stone wall stays on all six edges; the palisade leaves the shared
    // edge to it and runs into its corners.
    expect(countFor(edges, '0,0')).toBe(6);
    expect(countFor(edges, '1,0')).toBe(5);
    const weak = edges.filter(e => e.tileKey === '1,0');
    expect(weak.filter(e => e.start === 'abut').length).toBe(1);
    expect(weak.filter(e => e.end === 'abut').length).toBe(1);
    expect(edges.some(e => e.start === 'merge' || e.end === 'merge')).toBe(false);
  });

  it('wall strength follows lasting defense, up to a citadel', () => {
    expect(wallLevel(makeTile(0, 0, { base_defense: 1 }))).toBe(1);
    expect(wallLevel(makeTile(0, 0, { base_defense: 2, permanent_defense_bonus: 2 }))).toBe(4);
    expect(wallLevel(makeTile(0, 0, { base_defense: 3, permanent_defense_bonus: 4 }))).toBe(MAX_WALL_LEVEL);
    expect(wallLevel(makeTile(0, 0, { is_base: true, base_defense: 3 }))).toBe(0);
    expect(wallLevel(makeTile(0, 0, { defense_power: 4 }))).toBe(0);
  });

  it('unowned fortified tiles count as one holder (neutral)', () => {
    const edges = edgesOf(board({ '0,0': { base_defense: 1 }, '0,1': { base_defense: 1 } }));
    expect(edges.length).toBe(10);
  });

  it('different holders keep their own walls on the shared edge', () => {
    const edges = edgesOf(board({
      '0,0': { base_defense: 1, owner: 'player_0' },
      '1,0': { base_defense: 1, owner: 'player_1' },
    }));
    expect(edges.length).toBe(12);
    const neutralNext = edgesOf(board({ '0,0': { base_defense: 1, owner: 'player_0' }, '1,0': { base_defense: 1 } }));
    expect(neutralNext.length).toBe(12);
  });

  it('bases keep their own castle walls and never merge', () => {
    const edges = edgesOf(board({
      '0,0': { is_base: true, base_owner: 'player_0', owner: 'player_0', base_defense: 3 },
      '1,0': { base_defense: 1, owner: 'player_0' },
    }));
    expect(countFor(edges, '0,0')).toBe(0);
    expect(countFor(edges, '1,0')).toBe(6);
  });

  it('a premium VP ringed by weaker neighbours keeps its towered wall inside their rim', () => {
    const ring = ['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1'];
    const overrides: Record<string, Partial<HexTile>> = { '0,0': { is_vp: true, vp_value: 2, base_defense: 3 } };
    for (const k of ring) overrides[k] = { base_defense: 1 };
    const edges = edgesOf(board(overrides));
    expect(countFor(edges, '0,0')).toBe(6);
    // Each ring tile: only its three outer edges — it merges with the ring
    // tiles either side and leaves the inner edge to the stronger VP.
    for (const k of ring) expect(countFor(edges, k)).toBe(3);
    expect(edges.length).toBe(24);
  });

  it('a tile changing hands re-walls only the edges it shares', () => {
    const base = { '0,0': { base_defense: 1, owner: 'player_0' }, '1,0': { base_defense: 1, owner: 'player_0' } };
    const before = edgesOf(board(base));
    const after = edgesOf(board({ ...base, '1,0': { base_defense: 1, owner: 'player_1' } }));
    const keys = (es: typeof before) => new Map(es.map(e => [e.key, e.signature]));
    const b = keys(before), a = keys(after);
    const added = [...a.keys()].filter(k => !b.has(k));
    const changed = [...a.keys()].filter(k => b.has(k) && b.get(k) !== a.get(k));
    // The shared edge reappears on both tiles; the four edges that met at
    // the open edge now turn their own corners instead.
    expect(added.length).toBe(2);
    expect(changed.length).toBe(4);
  });
});
