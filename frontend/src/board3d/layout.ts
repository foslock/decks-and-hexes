import { Color } from 'three';
import type { HexTile } from '../types/game';
import { HEX_DIRS, SQRT3 } from '../utils/hexGeometry';
import { fbm2, hash2, hash2i, smoothstep, valueNoise2 } from './noise';

/**
 * Board layout: which decorative biome each tile gets and the smooth
 * height / color fields the terrain, props and decals all sample from.
 *
 * Gameplay never depends on any of this — biomes are cosmetic, chosen
 * deterministically from the map so every client sees the same world.
 */

export type Biome =
  | 'meadow' | 'forest' | 'farm' | 'pasture' | 'hills'
  | 'mountain' | 'town' | 'castle'
  /** Scorched Retreat: burnt to ash for the rest of the match. */
  | 'scorched';

export interface TileLayout {
  key: string;
  q: number;
  r: number;
  /** World-space center (hex radius = 1). */
  x: number;
  z: number;
  biome: Biome;
  /** Stable per-tile seed for decoration. */
  seed: number;
  /** Ring distance from the board center (for build-in staggering). */
  ring: number;
}

export function axialToWorld(q: number, r: number): { x: number; z: number } {
  return { x: 1.5 * q, z: SQRT3 / 2 * q + SQRT3 * r };
}

/** Fractional axial coords of a world-space point. */
export function worldToAxialFrac(x: number, z: number): { q: number; r: number } {
  return { q: (2 / 3) * x, r: (-1 / 3) * x + (SQRT3 / 3) * z };
}

export function worldToTileKey(x: number, z: number): string {
  const f = worldToAxialFrac(x, z);
  const s = -f.q - f.r;
  let rq = Math.round(f.q);
  let rr = Math.round(f.r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - f.q);
  const dr = Math.abs(rr - f.r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return `${rq},${rr}`;
}

/** Hex corner k (flat-top, corner 0 at angle 0) of a unit hex. */
export function hexCorner(cx: number, cz: number, k: number, radius = 1): { x: number; z: number } {
  const a = (Math.PI / 3) * k;
  return { x: cx + radius * Math.cos(a), z: cz + radius * Math.sin(a) };
}

/** Signed distance to a unit flat-top hex centered at the origin (<0 inside). */
export function hexSdf(px: number, pz: number, radius = 1): number {
  const inr = (radius * SQRT3) / 2;
  const ax = Math.abs(px);
  const az = Math.abs(pz);
  // Edge normals for a flat-top hex: (0,1) and (±sin60, cos60)
  const d = Math.max(az, ax * (SQRT3 / 2) + az * 0.5);
  return d - inr;
}

// ── Palette (sRGB hex — converted to linear for vertex colors) ──────────
const GROUND_HEX: Record<Biome, number> = {
  meadow: 0x62793a,
  forest: 0x384c22,
  farm: 0x77773c,
  pasture: 0x6a8738,
  hills: 0x6e6648,
  mountain: 0x5f5a52,
  town: 0x76684e,
  castle: 0x6a6354,
  scorched: 0x2d2620,
};

const BASE_HEIGHT: Record<Biome, number> = {
  meadow: 0.03,
  forest: 0.05,
  farm: 0.015,
  pasture: 0.04,
  hills: 0.13,
  mountain: 0.2,
  town: 0.06,
  castle: 0.08,
  scorched: 0.012,
};

const linear = (hex: number): [number, number, number] => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const GROUND_LIN: Record<Biome, [number, number, number]> = Object.fromEntries(
  (Object.keys(GROUND_HEX) as Biome[]).map(b => [b, linear(GROUND_HEX[b])]),
) as Record<Biome, [number, number, number]>;
const DIRT = linear(0x5f5238);
const DRY = linear(0x8a7c48);
const LUSH = linear(0x4a6a28);
const ROCK = linear(0x6c6862);
const CHAR = linear(0x15110e);
const ASH = linear(0x6f6a63);

/** What about a tile shapes the terrain and decor (a town's VP value
 *  doesn't — its structure updates on its own). */
export function tileSignature(t: HexTile): string {
  return `${t.is_blocked ? 'b' : ''}${t.is_scorched ? 's' : ''}${t.is_vp ? 'v' : ''}${t.is_base ? `c${t.base_owner}` : ''}`;
}

/** Structural signature — when this changes, terrain and decor rebuild. */
export function structureSignature(tiles: Record<string, HexTile>): string {
  const parts: string[] = [];
  for (const key of Object.keys(tiles).sort()) parts.push(`${key}${tileSignature(tiles[key])}`);
  return parts.join('|');
}

export class BoardLayout {
  readonly tiles: TileLayout[] = [];
  readonly byKey = new Map<string, TileLayout>();
  readonly mapSeed: number;
  /** Bounding radius of the island (world units). */
  readonly radius: number;
  readonly maxRing: number;

  constructor(gameTiles: Record<string, HexTile>) {
    // Map seed from the fixed features so different maps look different.
    // A scorched tile counts as what it was (a plain tile, or a VP town), so
    // burning one never reshuffles the rest of the island's scenery.
    let seed = 7;
    for (const t of Object.values(gameTiles)) {
      const town = t.is_vp || (t.scorched_vp ?? 0) > 0;
      if ((t.is_blocked && !t.is_scorched) || town || t.is_base) seed = (seed * 31 + hash2i(t.q, t.r, 3)) >>> 0;
    }
    this.mapSeed = seed;

    let maxRing = 0;
    let radius = 1;
    for (const [key, t] of Object.entries(gameTiles)) {
      const { x, z } = axialToWorld(t.q, t.r);
      const ring = (Math.abs(t.q) + Math.abs(t.r) + Math.abs(t.q + t.r)) / 2;
      maxRing = Math.max(maxRing, ring);
      radius = Math.max(radius, Math.hypot(x, z) + 1);
      const layout: TileLayout = {
        key, q: t.q, r: t.r, x, z, ring,
        biome: 'meadow',
        seed: hash2i(t.q, t.r, seed),
      };
      this.tiles.push(layout);
      this.byKey.set(key, layout);
    }
    this.maxRing = maxRing;
    this.radius = radius;

    for (const tl of this.tiles) {
      tl.biome = this.pickBiome(gameTiles[tl.key], tl, gameTiles);
    }
  }

  private pickBiome(t: HexTile, tl: TileLayout, all: Record<string, HexTile>): Biome {
    if (t.is_scorched) return 'scorched';
    if (t.is_blocked) return 'mountain';
    if (t.is_base) return 'castle';
    if (t.is_vp) return 'town';
    let nearMountain = 0;
    let nearCastle = 0;
    let nearTown = 0;
    for (const [dq, dr] of HEX_DIRS) {
      const n = all[`${t.q + dq},${t.r + dr}`];
      if (!n) continue;
      // A scorched neighbour counts as what it was, so the land around it
      // keeps its look.
      if (n.is_blocked && !n.is_scorched) nearMountain++;
      if (n.is_base) nearCastle++;
      if (n.is_vp || (n.scorched_vp ?? 0) > 0) nearTown++;
    }
    const s = this.mapSeed % 997;
    const moisture = fbm2(tl.x * 0.32 + s, tl.z * 0.32, 11, 3);
    const fertility = fbm2(tl.x * 0.28 - s, tl.z * 0.28 + 5, 23, 3);
    const rough = fbm2(tl.x * 0.4, tl.z * 0.4 - s, 37, 2) + nearMountain * 0.12;
    const jitter = hash2(t.q, t.r, this.mapSeed) * 0.12;

    if (rough + jitter * 0.5 > 0.68) return 'hills';
    if (nearCastle > 0 || nearTown > 0) {
      if (fertility + jitter > 0.6) return 'farm';
      if (moisture > 0.48) return 'pasture';
    }
    if (moisture + jitter > 0.6) return 'forest';
    if (fertility + jitter > 0.66) return 'farm';
    if (moisture > 0.42 && fertility > 0.4) return 'pasture';
    if (moisture < 0.38 && jitter > 0.08) return 'forest';
    return 'meadow';
  }

  /** Blend weights of the tiles influencing a point (self + neighbors). */
  private weights(x: number, z: number, out: { tile: TileLayout; w: number }[]): number {
    out.length = 0;
    const key = worldToTileKey(x, z);
    const self = this.byKey.get(key);
    const [sq, sr] = key.split(',').map(Number);
    let total = 0;
    const consider = (tl: TileLayout | undefined) => {
      if (!tl) return;
      const d = Math.hypot(x - tl.x, z - tl.z);
      const w = 1 - smoothstep(0, 1.3, d);
      if (w <= 0) return;
      out.push({ tile: tl, w });
      total += w;
    };
    consider(self);
    for (const [dq, dr] of HEX_DIRS) consider(this.byKey.get(`${sq + dq},${sr + dr}`));
    return total;
  }

  private scratch: { tile: TileLayout; w: number }[] = [];

  /** Terrain surface height at a world position. */
  heightAt(x: number, z: number): number {
    const ws = this.scratch;
    const total = this.weights(x, z, ws);
    let h = 0;
    let rough = 0;
    if (total > 0) {
      for (const { tile, w } of ws) {
        h += BASE_HEIGHT[tile.biome] * w;
        if (tile.biome === 'hills' || tile.biome === 'mountain') rough += w;
      }
      h /= total;
      rough /= total;
    }
    const n = fbm2(x * 0.9, z * 0.9, 5, 3) - 0.5;
    const detail = valueNoise2(x * 3.1, z * 3.1, 9) - 0.5;
    return h + n * 0.06 + detail * (0.012 + rough * 0.05);
  }

  /** Linear-space ground color at a world position. */
  colorAt(x: number, z: number): [number, number, number] {
    const ws = this.scratch;
    const total = this.weights(x, z, ws);
    let r = 0, g = 0, b = 0;
    let burnt = 0;
    if (total > 0) {
      for (const { tile, w } of ws) {
        const c = GROUND_LIN[tile.biome];
        r += c[0] * w; g += c[1] * w; b += c[2] * w;
        if (tile.biome === 'scorched') {
          // Burnt right out to the hex's edge, with a ragged rim of scorch
          // licking a little way past it.
          const rag = (fbm2(x * 4.1, z * 4.1, 83, 2) - 0.5) * 0.28;
          burnt = Math.max(burnt, 1 - smoothstep(-0.16, 0.09, hexSdf(x - tile.x, z - tile.z) + rag));
        }
      }
      r /= total; g /= total; b /= total;
    } else {
      [r, g, b] = GROUND_LIN.meadow;
    }
    // Painterly patches: lush / dry grass and bare dirt.
    const patch = fbm2(x * 0.75 + 3, z * 0.75, 41, 3);
    const dry = smoothstep(0.55, 0.75, patch);
    const lush = smoothstep(0.45, 0.25, patch);
    r += (DRY[0] - r) * dry * 0.35 + (LUSH[0] - r) * lush * 0.3;
    g += (DRY[1] - g) * dry * 0.35 + (LUSH[1] - g) * lush * 0.3;
    b += (DRY[2] - b) * dry * 0.35 + (LUSH[2] - b) * lush * 0.3;
    const dirt = smoothstep(0.74, 0.88, fbm2(x * 1.6, z * 1.6 - 7, 53, 2));
    r += (DIRT[0] - r) * dirt * 0.35;
    g += (DIRT[1] - g) * dirt * 0.35;
    b += (DIRT[2] - b) * dirt * 0.35;
    const fleck = (valueNoise2(x * 7, z * 7, 61) - 0.5) * 0.08;
    // Rocky scree toward high ground
    const rocky = smoothstep(0.12, 0.22, this.heightAt(x, z));
    r += (ROCK[0] - r) * rocky * 0.5;
    g += (ROCK[1] - g) * rocky * 0.5;
    b += (ROCK[2] - b) * rocky * 0.5;
    if (burnt > 0) {
      // Burnt ground: black char drifted with grey ash, the grass gone.
      const k = burnt;
      const drift = smoothstep(0.42, 0.7, fbm2(x * 2.3 + 11, z * 2.3, 71, 3));
      const cr = CHAR[0] + (ASH[0] - CHAR[0]) * drift;
      const cg = CHAR[1] + (ASH[1] - CHAR[1]) * drift;
      const cb = CHAR[2] + (ASH[2] - CHAR[2]) * drift;
      r += (cr - r) * k; g += (cg - g) * k; b += (cb - b) * k;
    }
    return [r * (1 + fleck), g * (1 + fleck), b * (1 + fleck)];
  }

  /** Is a world point on the island (inside any tile)? */
  isLand(x: number, z: number): boolean {
    return this.byKey.has(worldToTileKey(x, z));
  }

  /** Sea hexes touching the island (for inland distance). */
  private coastHexes: { x: number; z: number }[] | null = null;

  /** Signed distance to the coastline: negative under the island (capped at -1). */
  signedDistanceToLand(x: number, z: number): number {
    if (!this.isLand(x, z)) return this.distanceToLand(x, z);
    if (!this.coastHexes) {
      const seen = new Set<string>();
      this.coastHexes = [];
      for (const tl of this.tiles) {
        for (const [dq, dr] of HEX_DIRS) {
          const key = `${tl.q + dq},${tl.r + dr}`;
          if (this.byKey.has(key) || seen.has(key)) continue;
          seen.add(key);
          this.coastHexes.push(axialToWorld(tl.q + dq, tl.r + dr));
        }
      }
    }
    let best = 1;
    for (const c of this.coastHexes) {
      const dx = x - c.x, dz = z - c.z;
      if (Math.abs(dx) > 2.2 || Math.abs(dz) > 2.2) continue;
      best = Math.min(best, Math.max(0, hexSdf(dx, dz)));
    }
    return -best;
  }

  /** Approximate distance from a world point to the island edge (0 on land). */
  distanceToLand(x: number, z: number): number {
    let best = Infinity;
    for (const tl of this.tiles) {
      const dx = x - tl.x;
      const dz = z - tl.z;
      if (Math.abs(dx) > best + 2 || Math.abs(dz) > best + 2) continue;
      const d = hexSdf(dx, dz);
      if (d < best) best = d;
    }
    return Math.max(0, best);
  }
}
