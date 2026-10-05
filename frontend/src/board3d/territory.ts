import type { HexTile } from '../types/game';
import { BoardLayout, type TileLayout } from './layout';
import { rng } from './noise';
import {
  AMBER_GLOW, C, WINDOW_GLOW, at, banner, edgeAngle, hiveMound, neighbourAcross, pick, roundTowerTop,
  themeOf, wallLevel, worldOf, type AmbientSpots, type Footprint,
} from './props';
import { Soup, lin, mix, type RGB } from './soup';

/**
 * Occupied territory, themed by the occupier's archetype. Every plain tile a
 * player holds gets a small camp in the most open corner of the tile (away
 * from the roads, which run center to edge):
 *  - Vanguard: a war camp — a bell tent in their colors, a banner standard,
 *    a spear rack and a smoking campfire;
 *  - Fortress: a squat watch post — crenellated stone, a lit arrow slit,
 *    their band and flag, a dry-stone wall and supply crates;
 *  - Swarm: a hive cluster — glowing mud mounds, burrows and amber egg pods
 *    on a patch of creep, a ragged flag of their color.
 * The territory's outline is marked too, on each edge that faces someone
 * else's land (or the sea): Vanguard pennants and stakes, Fortress boundary
 * stones capped in their color, Swarm chitin spikes around an amber node.
 * Walled tiles leave the outline to their walls; bases and towns keep their
 * own buildings (towns still mark the outline).
 *
 * Each camp and each outline edge is its own piece, so a change of hands
 * raises and sinks only what changes.
 */

export type Theme = 'vanguard' | 'swarm' | 'fortress';

export interface TerritoryPiece {
  /** `camp:${tileKey}` or `edge:${tileKey}#${k}` */
  key: string;
  tileKey: string;
  /** -1 for the camp, else the outline edge. */
  k: number;
  theme: Theme;
  owner: number;
  /** Camp: where it stands and the radius cleared of decor around it. */
  spot?: { x: number; z: number; clear: number };
  /** Changes whenever the piece must be rebuilt. */
  signature: string;
}

/** A camp's footprint radius (world units); decor closer than this to its
 *  spot is cleared away when there's no open ground. */
const CAMP_R = 0.18;
/** Camps and outline markers are built in small local units, then scaled. */
const CAMP_SCALE = 1.6;
const EDGE_SCALE = 1.3;
/** Distance from the tile center to the outline markers (an edge's midpoint
 *  is at √3/2 ≈ 0.87; decor stays inside ≈ 0.77). */
const EDGE_IN = 0.8;

/** Open ground at a point: distance to the nearest decor footprint's edge. */
function clearance(x: number, z: number, taken: Footprint[]): number {
  let best = 9;
  for (const f of taken) best = Math.min(best, Math.hypot(f.x - x, f.z - z) - f.d);
  return best;
}

/**
 * Where a tile's camp goes: toward one of its corners (between the spokes
 * roads take to its edges), at whichever spot has the most open ground —
 * nearer the middle when it's a tie.
 */
export function campSpot(tile: TileLayout, taken: Footprint[]): { x: number; z: number; clear: number } {
  const r = rng(tile.seed ^ 0x5eed);
  const turn = r() * 6;
  let best = { x: tile.x, z: tile.z, score: -Infinity, room: 0 };
  for (let i = 0; i < 6; i++) {
    const k = (i + Math.floor(turn)) % 6;
    for (const rad of [0.4, 0.47, 0.54]) {
      for (const da of [-0.22, 0, 0.22]) {
        const a = (Math.PI / 3) * k + da;
        const x = tile.x + Math.cos(a) * rad, z = tile.z + Math.sin(a) * rad;
        const room = clearance(x, z, taken);
        const score = Math.min(room, CAMP_R + 0.05) - rad * 0.08;
        if (score > best.score) best = { x, z, score, room };
      }
    }
  }
  // Short of room: clear just enough of the decor (trees whose trunks stand
  // inside the camp's footprint).
  return { x: best.x, z: best.z, clear: best.room >= CAMP_R ? 0 : CAMP_R + 0.03 };
}

/** Every territory piece on the board for the current tile states. */
export function territoryPieces(
  layout: BoardLayout, tiles: Record<string, HexTile>, taken: Map<string, Footprint[]>,
  archetypeOf: (pid: string) => string, ownerColor: (pid: string) => number,
): TerritoryPiece[] {
  const out: TerritoryPiece[] = [];
  for (const tile of layout.tiles) {
    const t = tiles[tile.key];
    const pid = t?.owner;
    if (!t || !pid || t.is_blocked || t.is_base) continue;
    const theme = themeOf(archetypeOf(pid));
    const owner = ownerColor(pid);
    const look = `${theme}|${owner}`;
    if (!t.is_vp) {
      const spot = campSpot(tile, taken.get(tile.key) ?? []);
      out.push({ key: `camp:${tile.key}`, tileKey: tile.key, k: -1, theme, owner, spot, signature: look });
    }
    // The outline: edges facing anyone else's land, or the sea. Walls draw
    // their own.
    if (wallLevel(t) > 0) continue;
    for (let k = 0; k < 6; k++) {
      const across = tiles[neighbourAcross(tile, k)];
      if (across?.owner === pid) continue;
      out.push({ key: `edge:${tile.key}#${k}`, tileKey: tile.key, k, theme, owner, signature: look });
    }
  }
  return out;
}

/** Build one territory piece. Smoke / flicker anchors go into `spots`. */
export function buildTerritoryPiece(s: Soup, tile: TileLayout, layout: BoardLayout, p: TerritoryPiece, spots: AmbientSpots): void {
  s.build = tile.ring / Math.max(1, layout.maxRing);
  s.jitter = 0.07;
  const owner = lin(p.owner);
  if (p.k < 0 && p.spot) {
    const { x, z } = p.spot;
    const y = layout.heightAt(x, z);
    const r = rng(tile.seed ^ 0xca4b);
    s.setAnchor(x, y, z);
    // Face the tile's middle.
    const face = Math.atan2(tile.x - x, tile.z - z);
    s.place(x, y - 0.004, z, face, CAMP_SCALE);
    if (p.theme === 'fortress') watchPost(s, owner, r, spots);
    else if (p.theme === 'swarm') hiveCluster(s, owner, r, spots);
    else warCamp(s, owner, r, spots);
    return;
  }
  const a = edgeAngle(p.k);
  const cx = tile.x + Math.cos(a) * EDGE_IN, cz = tile.z + Math.sin(a) * EDGE_IN;
  // Local +x runs along the edge, +z points back into the tile.
  const tx = Math.cos(a + Math.PI / 2), tz = Math.sin(a + Math.PI / 2);
  const ry = Math.atan2(-tz, tx);
  const r = rng(tile.seed ^ ((p.k + 3) * 0x2f1d));
  const stand = (along: number, fn: () => void) => {
    const px = cx + tx * along, pz = cz + tz * along;
    const py = layout.heightAt(px, pz);
    s.setAnchor(px, py, pz);
    s.place(px, py - 0.006, pz, ry, EDGE_SCALE);
    fn();
  };
  if (p.theme === 'fortress') {
    // Boundary stones capped in the holder's color, a carved marker between.
    for (const along of [-0.24, 0.24]) stand(along, () => {
      s.box(0.036, 0.07, 0.032, mix(C.fortressStone, C.fortressTrim, r() * 0.4), C.fortressStone);
      at(s, 0, 0.07, 0, () => s.pyramid(0.04, 0.025, owner));
    });
    stand(0, () => {
      s.box(0.05, 0.045, 0.03, C.fortressTrim, C.fortressStone);
      at(s, 0, 0.012, -0.0155, () => s.box(0.03, 0.022, 0.003, owner));
    });
  } else if (p.theme === 'swarm') {
    // Chitin spikes around an amber node, on a smear of mud.
    stand(0, () => {
      s.blob(0.035, mix(C.swarmMud[1], C.swarmDark, 0.3), { sy: 0.35, noise: 0.3 });
      at(s, 0, 0.012, 0, () => {
        s.glow = AMBER_GLOW;
        s.blob(0.014, C.swarmDark, { noise: 0 });
        s.glow = [0, 0, 0];
      });
      spots.torches.push(worldOf(s, 0, 0.03, 0));
    });
    for (const along of [-0.2, -0.09, 0.08, 0.21]) stand(along + (r() - 0.5) * 0.04, () => {
      // Leaning out of the tile.
      const sv = s.push(0, 0, 0, (r() - 0.5) * 0.6, 1, 1, -0.35 - r() * 0.25, (r() - 0.5) * 0.3);
      s.cone(0.012, 0.07 + r() * 0.04, 4, mix(C.chitin, C.chitinTip, r() * 0.4));
      at(s, 0, 0.055, 0, () => s.cone(0.006, 0.03, 4, mix(C.chitinTip, owner, 0.65)));
      s.pop(sv);
    });
  } else {
    // A pennant in the holder's colors flanked by sharpened stakes.
    stand(0, () => {
      banner(s, owner, 0.19, 0.075);
      at(s, 0, 0.19, 0, () => s.cone(0.006, 0.022, 4, C.steel));
    });
    for (const along of [-0.24, -0.16, 0.16, 0.24]) stand(along, () => {
      const sv = s.push(0, 0, 0, 0, 1, 1, -0.45, (r() - 0.5) * 0.3);
      s.box(0.012, 0.07, 0.012, mix(C.woodDark, C.vanguardTrim, r() * 0.5));
      at(s, 0, 0.07, 0, () => s.pyramid(0.013, 0.022, C.steel));
      s.pop(sv);
    });
  }
}

/** Ring of points on the ground (local), for flat patches. */
function ring(radius: number, n: number, r?: () => number, wobble = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const rr = radius * (1 + (r ? (r() - 0.5) * 2 * wobble : 0));
    return [Math.cos(a) * rr, Math.sin(a) * rr] as [number, number];
  });
}

const CANVAS: RGB = lin(0xe6dcc4);

/** A cone in alternating stripes (a pavilion roof). */
function stripedCone(s: Soup, r: number, h: number, seg: number, a: RGB, b: RGB): void {
  const apex = [0, h, 0];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    s.tri([Math.cos(a0) * r, 0, Math.sin(a0) * r], apex, [Math.cos(a1) * r, 0, Math.sin(a1) * r], i % 2 ? a : b);
  }
}
const EMBER: RGB = lin(0x3a1c10);

/** Vanguard: tent, banner standard, spear rack, campfire. Local units; the
 *  camp faces +z (the tile's middle). */
function warCamp(s: Soup, owner: RGB, r: () => number, spots: AmbientSpots): void {
  // Trampled earth
  s.flat(ring(0.12, 9, r, 0.15), 0.004, mix(C.plowed, C.plowedDark, 0.4));
  // Pavilion: canvas wall, a roof striped in the holder's color and cream
  // (it stands out on their tinted ground), a scalloped valance, door flap,
  // finial.
  at(s, -0.035, 0, -0.025, () => {
    s.cylinder(0.058, 0.058, 0.03, 10, CANVAS, { top: null });
    at(s, 0, 0.03, 0, () => stripedCone(s, 0.07, 0.085, 10, owner, CANVAS));
    at(s, 0, 0.022, 0, () => s.cylinder(0.071, 0.071, 0.01, 10, mix(owner, [0.04, 0.04, 0.05], 0.35), { top: null }));
    at(s, 0, 0, 0.056, () => s.box(0.024, 0.034, 0.006, C.door));
    at(s, 0, 0.112, 0, () => {
      s.cylinder(0.003, 0.003, 0.025, 3, C.woodDark, { top: null });
      at(s, 0.002, 0.024, 0, () => {
        s.windScale = 7;
        s.windAlongX = true;
        s.pennant(0.035, 0.016, owner);
        s.windAlongX = false;
        s.windScale = 0;
      });
    });
  });
  // Banner standard, spear-tipped
  at(s, 0.07, 0, -0.045, () => {
    banner(s, owner, 0.25, 0.09);
    at(s, 0, 0.25, 0, () => s.cone(0.007, 0.03, 4, C.steel));
    at(s, 0, 0, 0, () => s.cylinder(0.014, 0.016, 0.012, 6, C.vanguardTrim));
  });
  // Spear rack: two posts, a crossbar, spears leaning on it.
  at(s, 0.065, 0, 0.055, () => {
    for (const sx of [-1, 1]) at(s, sx * 0.03, 0, 0, () => s.box(0.006, 0.045, 0.006, C.woodDark));
    at(s, 0, 0.04, 0, () => s.box(0.07, 0.006, 0.006, C.wood));
    for (let i = 0; i < 3; i++) {
      const sv = s.push(-0.022 + i * 0.022, 0, 0.012, 0, 1, 1, -0.3, 0);
      s.cylinder(0.0025, 0.0025, 0.075, 3, C.wood, { top: null });
      at(s, 0, 0.075, 0, () => s.cone(0.005, 0.016, 4, C.steel));
      s.pop(sv);
    }
  }, 0.4);
  // Campfire: a ring of stones, crossed logs, glowing embers, smoke.
  at(s, -0.055, 0, 0.07, () => {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      at(s, Math.cos(a) * 0.024, -0.002, Math.sin(a) * 0.024, () => s.blob(0.008, pick(C.rock, r), { sy: 0.7, noise: 0.2 }));
    }
    for (const ry of [0.4, -0.7]) at(s, 0, 0.006, 0, () => s.box(0.034, 0.006, 0.007, C.trunkDark), ry);
    at(s, 0, 0.004, 0, () => {
      s.glow = AMBER_GLOW;
      s.blob(0.011, EMBER, { sy: 0.8, noise: 0.25 });
      s.glow = [0, 0, 0];
    });
    spots.chimneys.push(worldOf(s, 0, 0.03, 0));
    spots.torches.push(worldOf(s, 0, 0.02, 0));
  });
}

/** Fortress: a squat watch tower on a footing, dry-stone wall, crates. */
function watchPost(s: Soup, owner: RGB, r: () => number, spots: AmbientSpots): void {
  const stone = C.fortressStone, trim = C.fortressTrim;
  s.flat(ring(0.1, 8), 0.004, C.cobble);
  at(s, 0, 0, -0.01, () => {
    s.cylinder(0.078, 0.082, 0.022, 8, trim, { top: stone });
    at(s, 0, 0.022, 0, () => {
      s.cylinder(0.062, 0.055, 0.165, 8, stone, { top: trim });
      // The holder's band below the battlements
      at(s, 0, 0.125, 0, () => s.cylinder(0.059, 0.058, 0.016, 8, owner, { top: null }));
      at(s, 0, 0.165, 0, () => {
        roundTowerTop(s, 0.058, trim);
        at(s, 0.012, 0.01, 0.012, () => banner(s, owner, 0.12, 0.065));
      });
      // Door and a lit arrow slit facing the tile
      at(s, 0, 0, 0.057, () => s.box(0.026, 0.045, 0.006, C.door));
      at(s, 0, 0.085, 0.056, () => {
        s.glow = WINDOW_GLOW;
        s.box(0.01, 0.028, 0.006, C.window);
        s.glow = [0, 0, 0];
        spots.torches.push(worldOf(s, 0, 0.014, 0.004));
      });
      at(s, 0, 0.1, -0.056, () => s.box(0.01, 0.024, 0.006, C.window));
    });
  });
  // A curve of dry-stone wall behind it
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * (1.15 + i * 0.14);
    at(s, Math.cos(a) * 0.115, -0.003, Math.sin(a) * 0.115 - 0.01, () => {
      s.box(0.04, 0.026 + r() * 0.008, 0.024, mix(stone, trim, r() * 0.6));
    }, -a + Math.PI / 2);
  }
  // Supply crates
  at(s, 0.085, 0, 0.055, () => {
    s.box(0.03, 0.028, 0.03, C.wood, C.woodDark);
    at(s, -0.004, 0.028, 0.002, () => s.box(0.022, 0.022, 0.022, C.wood, C.woodDark), 0.4);
    at(s, -0.03, 0, 0.012, () => s.box(0.024, 0.022, 0.024, C.wood, C.woodDark), -0.3);
  });
}

/** Swarm: hive mounds on creep, burrows, amber egg pods, a ragged flag. */
function hiveCluster(s: Soup, owner: RGB, r: () => number, spots: AmbientSpots): void {
  // Creep: an irregular smear of dark mud
  s.flat(ring(0.13, 11, r, 0.22), 0.005, mix(C.swarmDark, C.swarmMud[0], 0.3));
  at(s, 0.02, 0, 0.01, () => s.flat(ring(0.08, 9, r, 0.3), 0.007, mix(C.swarmDark, C.swarmMud[1], 0.5)));
  hiveMound(s, 0.055, 0.15, r, true, spots);
  at(s, 0.085, 0, 0.035, () => hiveMound(s, 0.03, 0.075, r, r() < 0.6, spots));
  at(s, -0.075, 0, 0.045, () => hiveMound(s, 0.026, 0.06, r, false, spots));
  // Burrows: dark holes with a lip of mud
  for (const [bx, bz] of [[0.035, 0.09], [-0.09, -0.04]]) {
    at(s, bx, 0.008, bz, () => {
      s.flat(ring(0.018, 7), 0, [0.02, 0.015, 0.01]);
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + r();
        at(s, Math.cos(a) * 0.022, -0.006, Math.sin(a) * 0.022, () => s.blob(0.008, pick(C.swarmMud, r), { sy: 0.6, noise: 0.3 }));
      }
    });
  }
  // Amber egg pods huddled at the main mound's foot
  for (let i = 0; i < 4; i++) {
    const a = 0.3 + i * 0.55;
    at(s, Math.cos(a) * 0.065, 0, Math.sin(a) * 0.065, () => {
      s.glow = AMBER_GLOW;
      s.blob(0.009 + r() * 0.004, mix(C.swarmDark, [0.6, 0.35, 0.05], 0.4), { sy: 1.25, noise: 0.08 });
      s.glow = [0, 0, 0];
    });
  }
  // A ragged flag of the holder's color on a crooked pole
  at(s, -0.06, 0, -0.06, () => {
    const sv = s.push(0, 0, 0, 0, 1, 1, 0.12, -0.1);
    banner(s, owner, 0.17, 0.07);
    s.pop(sv);
  });
}
