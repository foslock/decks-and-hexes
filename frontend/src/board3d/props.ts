import { Vector3 } from 'three';
import type { HexTile } from '../types/game';
import { HEX_DIRS } from '../utils/hexGeometry';
import { BoardLayout, hexCorner, hexSdf, worldToTileKey, type TileLayout } from './layout';
import { rng } from './noise';
import { Soup, lin, mix, scaleRGB, type RGB } from './soup';

// ── Palette ──────────────────────────────────────────────────────────────
export const C = {
  trunk: lin(0x5a3f2a),
  trunkDark: lin(0x45301f),
  pine: [lin(0x2c4527), lin(0x33522d), lin(0x2a4024), lin(0x3b5a30)],
  pineTip: lin(0x557a3d),
  leaf: [lin(0x4f7a30), lin(0x648a34), lin(0x76903a), lin(0x587e2c)],
  autumn: [lin(0xb5782a), lin(0x9c5a26), lin(0xc49a3a), lin(0xa86a2c)],
  bush: lin(0x46692c),
  rock: [lin(0x7d7a72), lin(0x8c877b), lin(0x67635d)],
  moss: lin(0x667a3a),
  plaster: [lin(0xd9cfb2), lin(0xcbbb98), lin(0xbfae8c)],
  timber: lin(0x6a4a30),
  stone: lin(0x9a9284),
  stoneDark: lin(0x6f6a62),
  roofs: [lin(0xa8884a), lin(0x8e3d2c), lin(0x4b5563), lin(0x6b4630), lin(0x7a4a2a)],
  wheat: lin(0xcaa448),
  wheatDark: lin(0xa88838),
  crops: lin(0x6c8a33),
  plowed: lin(0x6a4a30),
  plowedDark: lin(0x553b26),
  hay: lin(0xc7a14e),
  snow: lin(0xeef2f6),
  mtnRock: [lin(0x5c5750), lin(0x6c665d), lin(0x7c766b)],
  mtnDark: lin(0x45413d),
  cobble: lin(0x8c8270),
  gold: lin(0xe0b450),
  door: lin(0x3a2a1c),
  window: lin(0x2a2420),
  flowers: [lin(0xd94b4b), lin(0xf0d060), lin(0xf2efe6), lin(0x9b6ad0), lin(0xe58a3a)],
  wood: lin(0x7a5634),
  woodDark: lin(0x5a3e26),
  fortressStone: lin(0x948b7c),
  fortressTrim: lin(0x7d7466),
  vanguardStone: lin(0x6c6870),
  vanguardTrim: lin(0x56525a),
  swarmMud: [lin(0x8a6a40), lin(0x7a5a36), lin(0x9a7848)],
  swarmDark: lin(0x4a3620),
  chitin: lin(0x3a2c2a),
  chitinTip: lin(0x6a5048),
  steel: lin(0x9aa0a8),
};

/** Lit-window emissive (linear, > 1 for a soft bloom-ish punch). */
export const WINDOW_GLOW: RGB = [1.6, 0.85, 0.32];
export const AMBER_GLOW: RGB = [1.8, 0.75, 0.18];
const GOLD_GLOW: RGB = [1.1, 0.75, 0.2];

export function pick<T>(arr: T[], r: () => number): T {
  return arr[Math.floor(r() * arr.length) % arr.length];
}

function hexToRgbLin(hex: number): RGB {
  return lin(hex);
}

// ── Ambient anchors produced while building ──────────────────────────────
export interface AmbientSpots {
  chimneys: Vector3[];
  windmills: { pos: Vector3; ry: number; scale: number }[];
  pastures: { x: number; z: number; radius: number; count: number; key: string }[];
  peaks: Vector3[];
  /** Castle / town window positions for light flicker sparkles. */
  torches: Vector3[];
}

export function emptySpots(): AmbientSpots {
  return { chimneys: [], windmills: [], pastures: [], peaks: [], torches: [] };
}

// ── Small helpers ────────────────────────────────────────────────────────

/** Run `fn` with a local transform pushed on the soup. */
export function at(s: Soup, x: number, y: number, z: number, fn: () => void, ry = 0, sc = 1, sy = sc): void {
  const saved = s.push(x, y, z, ry, sc, sy);
  fn();
  s.pop(saved);
}

/** World position of a local point under the soup's current transform. */
export function worldOf(s: Soup, x: number, y: number, z: number): Vector3 {
  return new Vector3(x, y, z).applyMatrix4(s.matrix);
}

/** Poisson-ish scatter inside a hex ring. */
function scatter(tile: TileLayout, r: () => number, count: number, minR: number, maxR: number, minDist: number, taken: { x: number; z: number; d: number }[] = []): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let tries = 0;
  while (out.length < count && tries < count * 25) {
    tries++;
    const a = r() * Math.PI * 2;
    const rad = minR + Math.sqrt(r()) * (maxR - minR);
    const dx = Math.cos(a) * rad;
    const dz = Math.sin(a) * rad;
    if (hexSdf(dx, dz) > -0.1) continue;
    const x = tile.x + dx;
    const z = tile.z + dz;
    let ok = true;
    for (const t of taken) {
      if (Math.hypot(t.x - x, t.z - z) < Math.max(minDist, t.d)) { ok = false; break; }
    }
    if (!ok) continue;
    for (const o of out) {
      if (Math.hypot(o.x - x, o.z - z) < minDist) { ok = false; break; }
    }
    if (!ok) continue;
    out.push({ x, z });
  }
  return out;
}

// ── Vegetation ───────────────────────────────────────────────────────────

/** Decoration scale relative to a unit hex (bigger reads better from above). */
const DECOR = 1.55;

export function pine(s: Soup, x: number, y: number, z: number, scale: number, r: () => number): void {
  scale *= DECOR;
  s.setAnchor(x, y, z);
  s.windScale = 1.4 / scale;
  s.place(x, y, z, r() * Math.PI * 2, scale);
  s.cylinder(0.024, 0.016, 0.09, 5, C.trunk);
  const g = pick(C.pine, r);
  const tiers = 3;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    at(s, 0, 0.06 + i * 0.085, 0, () => {
      s.cone(0.14 - i * 0.032, 0.17 - i * 0.015, 7, mix(g, C.pineTip, t * 0.45), 0.18);
    }, r() * 1.2);
  }
  s.windScale = 0;
}

export function broadleaf(s: Soup, x: number, y: number, z: number, scale: number, r: () => number, autumn = false): void {
  scale *= DECOR;
  s.setAnchor(x, y, z);
  s.windScale = 1.3 / scale;
  s.place(x, y, z, r() * Math.PI * 2, scale);
  s.cylinder(0.026, 0.018, 0.12, 5, C.trunkDark);
  const base = autumn ? pick(C.autumn, r) : pick(C.leaf, r);
  at(s, 0, 0.08, 0, () => s.blob(0.1, base, { detail: 1, noise: 0.16, colorTop: mix(base, [1, 0.95, 0.6], 0.18) }));
  const extra = 1 + Math.floor(r() * 2);
  for (let i = 0; i < extra; i++) {
    const a = r() * Math.PI * 2;
    at(s, Math.cos(a) * 0.07, 0.1 + r() * 0.05, Math.sin(a) * 0.07, () => s.blob(0.065, mix(base, C.leaf[0], 0.2), { detail: 0, noise: 0.2 }));
  }
  s.windScale = 0;
}

export function bush(s: Soup, x: number, y: number, z: number, scale: number, r: () => number): void {
  scale *= DECOR;
  s.setAnchor(x, y, z);
  s.windScale = 1.0;
  s.place(x, y - 0.01, z, r() * 6.28, scale);
  s.blob(0.055, mix(C.bush, pick(C.leaf, r), r() * 0.5), { sy: 0.7, noise: 0.25 });
  s.windScale = 0;
}

export function rock(s: Soup, x: number, y: number, z: number, scale: number, r: () => number): void {
  scale *= DECOR;
  s.setAnchor(x, y, z);
  s.place(x, y - 0.015 * scale, z, r() * 6.28, scale);
  s.blob(0.07, pick(C.rock, r), { sy: 0.55 + r() * 0.3, noise: 0.3, colorTop: mix(pick(C.rock, r), C.moss, 0.35) });
}

function flowerPatch(s: Soup, x: number, z: number, layout: BoardLayout, r: () => number): void {
  const color = pick(C.flowers, r);
  const n = 4 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const fx = x + (r() - 0.5) * 0.12;
    const fz = z + (r() - 0.5) * 0.12;
    const fy = layout.heightAt(fx, fz);
    s.setAnchor(fx, fy, fz);
    s.windScale = 2.5;
    s.place(fx, fy, fz, 0, 1);
    s.cylinder(0.003, 0.003, 0.03, 3, C.leaf[0], { top: null });
    at(s, 0, 0.026, 0, () => s.blob(0.011, color, { noise: 0 }));
  }
  s.windScale = 0;
}

// ── Buildings ────────────────────────────────────────────────────────────

/** A cottage. Returns its chimney top (world) when it has one. */
export function house(s: Soup, x: number, y: number, z: number, ry: number, scale: number, r: () => number, opts: { chimney?: boolean; wall?: RGB; roof?: RGB; glow?: boolean } = {}): Vector3 | null {
  scale *= 1.35;
  s.setAnchor(x, y, z);
  s.windScale = 0;
  s.place(x, y - 0.005, z, ry, scale);
  const wall = opts.wall ?? pick(C.plaster, r);
  const roof = opts.roof ?? pick(C.roofs, r);
  const w = 0.15 + r() * 0.04, d = 0.1, h = 0.085;
  s.box(w, h, d, wall);
  // timber frame corners
  for (const sx of [-1, 1]) at(s, sx * (w / 2 - 0.006), 0, d / 2 + 0.001, () => s.box(0.012, h, 0.004, C.timber));
  at(s, 0, h, 0, () => s.gable(w, 0.075, d, roof, wall));
  // door + windows on the front, windows on the back
  at(s, -w * 0.22, 0, d / 2 + 0.002, () => s.box(0.028, 0.05, 0.004, C.door));
  const glow = opts.glow !== false;
  for (const side of [1, -1]) {
    for (const wx of side === 1 ? [w * 0.18] : [-w * 0.2, w * 0.2]) {
      at(s, wx, 0.035, side * (d / 2 + 0.003), () => {
        if (glow && r() > 0.25) s.glow = WINDOW_GLOW;
        s.box(0.024, 0.024, 0.004, C.window);
        s.glow = [0, 0, 0];
      });
    }
  }
  let top: Vector3 | null = null;
  if (opts.chimney !== false) {
    const cx = w * 0.28 * (r() > 0.5 ? 1 : -1);
    at(s, cx, h, -d * 0.18, () => {
      s.box(0.024, 0.075, 0.024, C.stoneDark);
      top = worldOf(s, 0, 0.085, 0);
    });
  }
  return top;
}

function windmill(s: Soup, x: number, y: number, z: number, ry: number, scale: number, spots: AmbientSpots): void {
  scale *= 1.45;
  s.setAnchor(x, y, z);
  s.place(x, y - 0.005, z, ry, scale);
  s.cylinder(0.075, 0.048, 0.27, 8, C.plaster[0], { top: C.plaster[1] });
  at(s, 0, 0.27, 0, () => s.cone(0.066, 0.09, 8, C.roofs[3]));
  at(s, 0, 0, 0.072, () => s.box(0.03, 0.055, 0.01, C.door));
  at(s, 0, 0.15, 0.06, () => { s.glow = WINDOW_GLOW; s.box(0.02, 0.022, 0.012, C.window); s.glow = [0, 0, 0]; });
  spots.windmills.push({ pos: worldOf(s, 0, 0.235, 0.078), ry, scale });
}

function field(s: Soup, x: number, y: number, z: number, ry: number, w: number, d: number, kind: 'wheat' | 'crops' | 'plowed', r: () => number): void {
  s.setAnchor(x, y, z);
  s.windScale = kind === 'plowed' ? 0 : 5;
  s.place(x, y, z, ry, 1);
  const rows = Math.max(3, Math.round(d / 0.045));
  const rowD = d / rows;
  const base = kind === 'wheat' ? C.wheatDark : kind === 'crops' ? scaleRGB(C.crops, 0.75) : C.plowedDark;
  const top = kind === 'wheat' ? C.wheat : kind === 'crops' ? C.crops : C.plowed;
  s.flat([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], 0.004, base);
  const hgt = kind === 'wheat' ? 0.03 : kind === 'crops' ? 0.022 : 0.012;
  for (let i = 0; i < rows; i++) {
    const zz = -d / 2 + rowD * (i + 0.5);
    at(s, 0, 0.003, zz, () => s.gable(w * 0.96, hgt * (0.85 + r() * 0.3), rowD * 0.8, mix(top, base, r() * 0.25), base, 0));
  }
  s.windScale = 0;
}

function haystack(s: Soup, x: number, y: number, z: number, r: () => number): void {
  s.setAnchor(x, y, z);
  s.place(x, y - 0.005, z, r() * 6, 1.5);
  s.cylinder(0.04, 0.035, 0.035, 7, C.hay);
  at(s, 0, 0.035, 0, () => s.cone(0.04, 0.045, 7, mix(C.hay, C.wheatDark, 0.3)));
}

function fence(s: Soup, layout: BoardLayout, pts: { x: number; z: number }[]): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / 0.07));
    const ry = -Math.atan2(b.z - a.z, b.x - a.x);
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      const px = a.x + (b.x - a.x) * t;
      const pz = a.z + (b.z - a.z) * t;
      const py = layout.heightAt(px, pz);
      s.setAnchor(px, py, pz);
      s.place(px, py - 0.004, pz, ry, 1);
      s.box(0.008, 0.04, 0.008, C.woodDark);
      if (j < n) {
        const seg = len / n;
        at(s, seg / 2, 0.024, 0, () => s.box(seg, 0.005, 0.005, C.wood));
        at(s, seg / 2, 0.012, 0, () => s.box(seg, 0.005, 0.005, C.wood));
      }
    }
  }
}

// ── Decor per biome ──────────────────────────────────────────────────────

/** Ground a decor piece stands on (world xz, footprint radius). */
export interface Footprint { x: number; z: number; d: number }

/**
 * Static decoration for every claimable tile (trees, farms, pastures, rocks…).
 * Built once per map layout; blocked / VP / base tiles get dynamic structures
 * instead (see buildStructure). `taken` collects each tile's footprints, so
 * later pieces (an occupier's camp) can find open ground.
 */
export function buildDecor(layout: BoardLayout, gameTiles: Record<string, HexTile>, spots: AmbientSpots, taken?: Map<string, Footprint[]>): Soup {
  const s = new Soup(layout.mapSeed);
  const maxRing = Math.max(1, layout.maxRing);
  for (const tile of layout.tiles) {
    const gt = gameTiles[tile.key];
    if (!gt || gt.is_blocked || gt.is_base || gt.is_vp) continue;
    const r = rng(tile.seed);
    s.build = tile.ring / maxRing;
    const h = (x: number, z: number) => layout.heightAt(x, z);
    const marks: Footprint[] = [];
    taken?.set(tile.key, marks);
    const mark = (pts: { x: number; z: number }[], d: number) => { for (const p of pts) marks.push({ x: p.x, z: p.z, d }); };
    switch (tile.biome) {
      case 'forest': {
        const trees = scatter(tile, r, 10 + Math.floor(r() * 4), 0.12, 0.84, 0.19);
        for (const p of trees) {
          const sc = 0.8 + r() * 0.45;
          if (r() < 0.68) pine(s, p.x, h(p.x, p.z), p.z, sc, r);
          else broadleaf(s, p.x, h(p.x, p.z), p.z, sc * 0.9, r, r() < 0.3);
        }
        const bushes = scatter(tile, r, 3, 0.1, 0.8, 0.1, trees.map(t => ({ ...t, d: 0.09 })));
        for (const p of bushes) bush(s, p.x, h(p.x, p.z), p.z, 0.8 + r() * 0.5, r);
        mark(trees, 0.15);
        mark(bushes, 0.07);
        break;
      }
      case 'meadow': {
        const trees = scatter(tile, r, 1 + Math.floor(r() * 3), 0.35, 0.8, 0.3);
        for (const p of trees) broadleaf(s, p.x, h(p.x, p.z), p.z, 0.85 + r() * 0.35, r, r() < 0.35);
        const taken = trees.map(t => ({ ...t, d: 0.12 }));
        const bushes = scatter(tile, r, 3 + Math.floor(r() * 3), 0.25, 0.82, 0.12, taken);
        for (const p of bushes) bush(s, p.x, h(p.x, p.z), p.z, 0.7 + r() * 0.6, r);
        const flowers = scatter(tile, r, 3, 0.25, 0.8, 0.15, taken);
        for (const p of flowers) flowerPatch(s, p.x, p.z, layout, r);
        const rocks = r() < 0.5 ? scatter(tile, r, 2, 0.4, 0.8, 0.12, taken) : [];
        for (const p of rocks) rock(s, p.x, h(p.x, p.z), p.z, 0.6 + r() * 0.4, r);
        mark(trees, 0.15);
        mark(bushes, 0.06);
        mark(flowers, 0.05);
        mark(rocks, 0.07);
        break;
      }
      case 'pasture': {
        // Fenced paddock arc + a lone tree; sheep are animated separately.
        const a0 = r() * Math.PI * 2;
        const pts: { x: number; z: number }[] = [];
        for (let i = 0; i <= 4; i++) {
          const a = a0 + (i / 4) * Math.PI * 0.9;
          pts.push({ x: tile.x + Math.cos(a) * 0.66, z: tile.z + Math.sin(a) * 0.66 });
        }
        fence(s, layout, pts);
        const ta = a0 + Math.PI * 1.4;
        const tree = { x: tile.x + Math.cos(ta) * 0.55, z: tile.z + Math.sin(ta) * 0.55 };
        broadleaf(s, tree.x, h(tree.x, tree.z), tree.z, 1, r);
        const bushes = scatter(tile, r, 2, 0.4, 0.8, 0.2, [{ ...tree, d: 0.2 }]);
        for (const p of bushes) bush(s, p.x, h(p.x, p.z), p.z, 0.8, r);
        const flowers = scatter(tile, r, 2, 0.3, 0.75, 0.2);
        for (const p of flowers) flowerPatch(s, p.x, p.z, layout, r);
        spots.pastures.push({ x: tile.x, z: tile.z, radius: 0.55, count: 3 + Math.floor(r() * 3), key: tile.key });
        // The fence (sampled along its arc), the tree, and the flock's range.
        for (let i = 0; i <= 16; i++) {
          const a = a0 + (i / 16) * Math.PI * 0.9;
          marks.push({ x: tile.x + Math.cos(a) * 0.66, z: tile.z + Math.sin(a) * 0.66, d: 0.05 });
        }
        mark([tree], 0.15);
        mark(bushes, 0.07);
        mark(flowers, 0.05);
        marks.push({ x: tile.x, z: tile.z, d: 0.47 });
        break;
      }
      case 'farm': {
        const base = r() * Math.PI;
        const kinds: ('wheat' | 'crops' | 'plowed')[] = ['wheat', 'crops', 'wheat', 'plowed'];
        const slots = [[-0.3, -0.3], [0.3, -0.28], [-0.3, 0.3], [0.32, 0.3]];
        const rot = (x: number, z: number) => ({ x: x * Math.cos(base) - z * Math.sin(base), z: x * Math.sin(base) + z * Math.cos(base) });
        const used: { x: number; z: number; d: number }[] = [];
        const nFields = 2 + Math.floor(r() * 2);
        for (let i = 0; i < nFields; i++) {
          const o = rot(slots[i][0], slots[i][1]);
          const fx = tile.x + o.x, fz = tile.z + o.z;
          field(s, fx, h(fx, fz), fz, -base + (r() - 0.5) * 0.2, 0.42, 0.3, pick(kinds, r), r);
          used.push({ x: fx, z: fz, d: 0.25 });
        }
        const o = rot(slots[nFields][0] * 0.95, slots[nFields][1] * 0.95);
        const bx = tile.x + o.x, bz = tile.z + o.z;
        if (r() < 0.5) {
          windmill(s, bx, h(bx, bz), bz, -base + Math.PI / 2 + (r() - 0.5), 1, spots);
        } else {
          const top = house(s, bx, h(bx, bz), bz, -base + (r() - 0.5) * 0.5, 1, r);
          if (top) spots.chimneys.push(top);
          const hs = scatter(tile, r, 2, 0.2, 0.7, 0.12, used);
          for (const p of hs) haystack(s, p.x, h(p.x, p.z), p.z, r);
          mark(hs, 0.07);
        }
        used.push({ x: bx, z: bz, d: 0.22 });
        const trees = scatter(tile, r, 1, 0.55, 0.82, 0.2, used);
        for (const p of trees) broadleaf(s, p.x, h(p.x, p.z), p.z, 0.8, r);
        marks.push(...used);
        mark(trees, 0.14);
        break;
      }
      case 'hills': {
        const rocks = scatter(tile, r, 4 + Math.floor(r() * 3), 0.2, 0.84, 0.18);
        for (const p of rocks) rock(s, p.x, h(p.x, p.z), p.z, 0.8 + r() * 0.9, r);
        const taken = rocks.map(t => ({ ...t, d: 0.12 }));
        const pines = scatter(tile, r, 2 + Math.floor(r() * 2), 0.3, 0.8, 0.18, taken);
        for (const p of pines) pine(s, p.x, h(p.x, p.z), p.z, 0.75 + r() * 0.3, r);
        const bushes = scatter(tile, r, 3, 0.25, 0.8, 0.1, taken);
        for (const p of bushes) bush(s, p.x, h(p.x, p.z), p.z, 0.6, r);
        mark(rocks, 0.1);
        mark(pines, 0.15);
        mark(bushes, 0.06);
        if (r() < 0.35) {
          // Ruined standing stones
          const a = r() * 6.28;
          const cx = tile.x + Math.cos(a) * 0.32, cz = tile.z + Math.sin(a) * 0.32;
          marks.push({ x: cx, z: cz, d: 0.15 });
          for (let i = 0; i < 5; i++) {
            const sa = (i / 5) * Math.PI * 2;
            const sx = cx + Math.cos(sa) * 0.1, sz = cz + Math.sin(sa) * 0.1;
            s.setAnchor(sx, h(sx, sz), sz);
            s.place(sx, h(sx, sz) - 0.005, sz, sa, 1);
            s.box(0.03, 0.05 + r() * 0.05, 0.02, C.stone);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return s;
}

// ── Structures (dynamic, per tile) ───────────────────────────────────────

export interface StructureSpec {
  kind: 'mountain' | 'castle' | 'town' | 'none';
  /** Changes whenever the structure must be rebuilt. */
  signature: string;
}

function mountainPeak(s: Soup, height: number, radius: number, r: () => number, spots: AmbientSpots, snowLine = 0.58): void {
  const seg = 9;
  const levels = [0, 0.22, 0.45, 0.66, 0.84];
  const radii = [1, 0.8, 0.55, 0.32, 0.14];
  const rings: number[][][] = [];
  const twist = r() * 6;
  for (let li = 0; li < levels.length; li++) {
    const ring: number[][] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + twist + li * 0.3;
      const rr = radius * radii[li] * (0.78 + r() * 0.4);
      ring.push([Math.cos(a) * rr, height * levels[li] * (li === 0 ? 1 : 0.92 + r() * 0.16), Math.sin(a) * rr]);
    }
    rings.push(ring);
  }
  const apex = [(r() - 0.5) * radius * 0.15, height, (r() - 0.5) * radius * 0.15];
  const colorFor = (y: number) => {
    const t = y / height;
    const noisy = t + (r() - 0.5) * 0.12;
    if (noisy > snowLine) return mix(C.snow, [0.8, 0.85, 0.95], r() * 0.25);
    if (noisy > snowLine - 0.12) return mix(C.mtnRock[2], C.snow, 0.35);
    return mix(pick(C.mtnRock, r), C.mtnDark, Math.max(0, 0.4 - t));
  };
  // Snow gets a faint self-glow so it reads white even on shadowed faces.
  const SNOW_GLOW: RGB = [0.07, 0.075, 0.09];
  const face = (a: number[], b: number[], c: number[]) => {
    const cy = (a[1] + b[1] + c[1]) / 3;
    const col = colorFor(cy);
    s.glow = col[0] > 0.6 ? SNOW_GLOW : [0, 0, 0];
    s.tri(a, b, c, col);
  };
  for (let li = 0; li < rings.length; li++) {
    const lo = rings[li];
    const hi = li + 1 < rings.length ? rings[li + 1] : null;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      if (hi) {
        face(lo[i], hi[i], hi[j]);
        face(lo[i], hi[j], lo[j]);
      } else {
        face(lo[i], apex, lo[j]);
      }
    }
  }
  s.glow = [0, 0, 0];
  spots.peaks.push(worldOf(s, apex[0], apex[1], apex[2]));
}

function buildMountain(s: Soup, tile: TileLayout, layout: BoardLayout, gameTiles: Record<string, HexTile>, spots: AmbientSpots): void {
  const r = rng(tile.seed ^ 0x5bd1);
  const y = layout.heightAt(tile.x, tile.z);
  s.setAnchor(tile.x, y, tile.z);
  s.jitter = 0.05;
  // Main peak, slightly off-center, plus shoulders.
  const ox = (r() - 0.5) * 0.18, oz = (r() - 0.5) * 0.18;
  s.place(tile.x + ox, y - 0.06, tile.z + oz, r() * 6, 1);
  mountainPeak(s, 1.35 + r() * 0.5, 0.74, r, spots);
  const shoulders = 2 + Math.floor(r() * 2);
  for (let i = 0; i < shoulders; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.35 + r() * 0.15;
    const sx = tile.x + Math.cos(a) * d, sz = tile.z + Math.sin(a) * d;
    s.place(sx, layout.heightAt(sx, sz) - 0.05, sz, r() * 6, 1);
    mountainPeak(s, 0.6 + r() * 0.35, 0.4 + r() * 0.1, r, spots, 0.62);
  }
  // Ridges toward neighboring blocked tiles so ranges read as one massif.
  for (let k = 0; k < 6; k++) {
    const [dq, dr] = HEX_DIRS[k];
    const n = gameTiles[`${tile.q + dq},${tile.r + dr}`];
    if (!n?.is_blocked) continue;
    const a = (Math.PI / 3) * k + Math.PI / 6;
    const ex = tile.x + Math.cos(a) * 0.78, ez = tile.z + Math.sin(a) * 0.78;
    s.place(ex, layout.heightAt(ex, ez) - 0.05, ez, r() * 6, 1);
    mountainPeak(s, 0.7 + r() * 0.25, 0.44, r, spots, 0.64);
  }
  // Scree and a few hardy pines on the lower slopes.
  s.jitter = 0.08;
  for (let i = 0; i < 4; i++) {
    const a = r() * Math.PI * 2;
    const d = 0.7 + r() * 0.12;
    const px = tile.x + Math.cos(a) * d, pz = tile.z + Math.sin(a) * d;
    if (hexSdf(px - tile.x, pz - tile.z) > -0.05) continue;
    if (r() < 0.5) pine(s, px, layout.heightAt(px, pz), pz, 0.6 + r() * 0.2, r);
    else rock(s, px, layout.heightAt(px, pz), pz, 0.8 + r() * 0.5, r);
  }
}

export function crenellate(s: Soup, len: number, y: number, thick: number, color: RGB, step = 0.05): void {
  const n = Math.max(2, Math.floor(len / step));
  for (let i = 0; i < n; i += 2) {
    const x = -len / 2 + (i + 0.5) * (len / n);
    at(s, x, y, 0, () => s.box(len / n * 0.9, 0.025, thick * 1.05, color));
  }
}

export function roundTowerTop(s: Soup, radius: number, color: RGB): void {
  const n = 8;
  for (let i = 0; i < n; i += 1) {
    if (i % 2) continue;
    const a = (i / n) * Math.PI * 2;
    at(s, Math.cos(a) * radius * 0.85, 0, Math.sin(a) * radius * 0.85, () => s.box(radius * 0.45, 0.028, radius * 0.3, color), -a);
  }
}

export function banner(s: Soup, color: RGB, height: number, width = 0.09): void {
  s.cylinder(0.006, 0.005, height, 4, C.woodDark, { top: null });
  const saved = s.windScale;
  s.windScale = 7;
  s.windAlongX = true;
  at(s, 0.004, height - 0.005, 0, () => s.pennant(width, width * 0.55, color));
  s.windAlongX = false;
  s.windScale = saved;
}

function windowsAround(s: Soup, radius: number, y: number, count: number, r: () => number, spots: AmbientSpots, glow: RGB = WINDOW_GLOW): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.4;
    at(s, Math.cos(a) * radius, y, Math.sin(a) * radius, () => {
      s.glow = glow;
      s.box(0.018, 0.026, 0.018, C.window);
      s.glow = [0, 0, 0];
      if (i % 2 === 0) spots.torches.push(worldOf(s, 0, 0.013, 0));
    }, -a);
  }
}

function castleFortress(s: Soup, owner: RGB, r: () => number, spots: AmbientSpots): void {
  const stone = C.fortressStone, trim = C.fortressTrim;
  // Curtain wall: hexagonal ring with towers on every corner.
  const R = 0.6;
  for (let k = 0; k < 6; k++) {
    const a0 = (Math.PI / 3) * k, a1 = a0 + Math.PI / 3;
    const p0 = [Math.cos(a0) * R, Math.sin(a0) * R], p1 = [Math.cos(a1) * R, Math.sin(a1) * R];
    const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
    const ry = -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    at(s, mx, 0, mz, () => {
      const len = R * 0.92;
      if (k === 1) {
        // Gatehouse
        for (const sx of [-1, 1]) at(s, sx * 0.13, 0, 0, () => s.box(0.14, 0.22, 0.09, stone));
        at(s, 0, 0.15, 0, () => s.box(0.12, 0.08, 0.08, trim));
        at(s, 0, 0, 0.0, () => s.box(0.1, 0.15, 0.092, C.door));
        crenellate(s, 0.4, 0.22, 0.09, trim);
      } else {
        s.box(len, 0.2, 0.08, stone, trim);
        crenellate(s, len, 0.2, 0.08, trim);
        if (k % 2 === 0) at(s, 0, 0.19, 0.043, () => s.box(0.05, -0.11, 0.004, owner));
      }
    }, ry);
    at(s, p0[0], 0, p0[1], () => {
      s.cylinder(0.105, 0.095, 0.3, 8, stone, { top: trim });
      at(s, 0, 0.3, 0, () => roundTowerTop(s, 0.1, trim));
    });
  }
  // Massive keep
  at(s, 0, 0, -0.02, () => {
    s.box(0.36, 0.48, 0.34, stone, trim);
    at(s, 0, 0.48, 0, () => {
      crenellate(s, 0.36, 0, 0.34, trim);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) at(s, sx * 0.17, 0, sz * 0.16, () => s.box(0.07, 0.07, 0.07, trim));
      at(s, 0, 0, 0, () => s.box(0.16, 0.16, 0.16, stone, trim));
      at(s, 0, 0.16, 0, () => banner(s, owner, 0.28, 0.13));
      spots.chimneys.push(worldOf(s, 0.12, 0.08, 0.1));
    });
    // owner-colored hanging banners on the keep face
    for (const sx of [-0.1, 0.1]) at(s, sx, 0.4, 0.172, () => {
      s.box(0.06, -0.16, 0.006, owner);
    });
    for (let i = 0; i < 4; i++) {
      at(s, 0, 0.12 + i * 0.09, 0, () => windowsAround(s, 0.19, 0, 3, r, spots), i * 0.7);
    }
  });
}

function castleVanguard(s: Soup, owner: RGB, r: () => number, spots: AmbientSpots): void {
  const stone = C.vanguardStone, trim = C.vanguardTrim;
  const roof = mix(owner, [0.05, 0.05, 0.06], 0.45);
  // Low spiked wall
  const R = 0.56;
  const segs = 10;
  for (let i = 0; i < segs; i++) {
    if (i === 2) continue; // gate gap
    const a0 = (i / segs) * Math.PI * 2, a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [Math.cos(a0) * R, Math.sin(a0) * R], p1 = [Math.cos(a1) * R, Math.sin(a1) * R];
    const ry = -Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
    at(s, (p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2, () => {
      s.box(R * 0.64, 0.13, 0.06, stone, trim);
      for (let j = -1; j <= 1; j++) at(s, j * 0.1, 0.13, 0, () => s.cone(0.012, 0.05, 4, C.stoneDark));
    }, ry);
  }
  // Satellite towers with tall cone roofs + pennants
  const towers = 3;
  for (let i = 0; i < towers; i++) {
    const a = (i / towers) * Math.PI * 2 + 0.5;
    const th = 0.42 + r() * 0.14;
    at(s, Math.cos(a) * 0.36, 0, Math.sin(a) * 0.36, () => {
      s.cylinder(0.085, 0.075, th, 8, stone, { top: trim });
      at(s, 0, th, 0, () => {
        s.cone(0.1, 0.22, 8, roof);
        at(s, 0, 0.2, 0, () => banner(s, owner, 0.12, 0.09));
      });
      windowsAround(s, 0.08, th * 0.6, 3, r, spots);
    });
  }
  // Soaring keep
  at(s, 0, 0, 0, () => {
    s.box(0.24, 0.72, 0.24, stone, trim);
    at(s, 0, 0.72, 0, () => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) at(s, sx * 0.12, 0, sz * 0.12, () => s.cone(0.04, 0.12, 6, roof));
      s.pyramid(0.27, 0.32, roof);
      at(s, 0, 0.3, 0, () => banner(s, owner, 0.22, 0.16));
    });
    for (let i = 0; i < 5; i++) at(s, 0, 0.14 + i * 0.12, 0, () => windowsAround(s, 0.125, 0, 4, r, spots), i * 0.4);
    // long war banners down the keep
    for (const face of [0, Math.PI]) at(s, 0, 0.62, 0, () => {
      at(s, 0, 0, 0.123, () => s.box(0.08, -0.3, 0.005, owner));
    }, face);
    spots.chimneys.push(worldOf(s, 0.09, 0.74, -0.09));
  });
}

export function hiveMound(s: Soup, radius: number, height: number, r: () => number, glow: boolean, spots: AmbientSpots): void {
  const tiers = 5;
  let y = 0;
  for (let i = 0; i < tiers; i++) {
    const t0 = i / tiers, t1 = (i + 1) / tiers;
    const r0 = radius * Math.cos(t0 * Math.PI * 0.46);
    const r1 = radius * Math.cos(t1 * Math.PI * 0.46) * 0.98;
    const hh = height / tiers;
    at(s, 0, y, 0, () => s.cylinder(r0, r1 * 0.94, hh, 9, mix(pick(C.swarmMud, r), C.swarmDark, i % 2 ? 0.18 : 0), { wobble: 0.1 }));
    y += hh;
  }
  at(s, 0, y, 0, () => s.cone(radius * 0.3, height * 0.18, 7, C.swarmMud[1]));
  if (glow) {
    const n = 3;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const hy = height * (0.2 + r() * 0.45);
      const rr = radius * Math.cos((hy / height) * Math.PI * 0.46) * 0.98;
      at(s, Math.cos(a) * rr, hy, Math.sin(a) * rr, () => {
        s.glow = AMBER_GLOW;
        s.blob(0.018, C.swarmDark, { noise: 0 });
        s.glow = [0, 0, 0];
        spots.torches.push(worldOf(s, 0, 0.018, 0));
      });
    }
  }
}

function castleSwarm(s: Soup, owner: RGB, r: () => number, spots: AmbientSpots): void {
  // Ring of mud mounds around a towering central hive, owner cloth on poles.
  hiveMound(s, 0.24, 0.72, r, true, spots);
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.3;
    const d = 0.42 + r() * 0.1;
    at(s, Math.cos(a) * d, 0, Math.sin(a) * d, () => hiveMound(s, 0.1 + r() * 0.05, 0.26 + r() * 0.18, r, r() < 0.7, spots));
  }
  // Low mud rampart blobs
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    if (i === 3 || i === 4) continue;
    at(s, Math.cos(a) * 0.66, -0.01, Math.sin(a) * 0.66, () => s.blob(0.06, pick(C.swarmMud, r), { sy: 0.7, noise: 0.25 }));
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 1.1;
    at(s, Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26, () => banner(s, owner, 0.42, 0.13));
  }
  spots.chimneys.push(worldOf(s, 0, 0.82, 0));
}

function buildCastle(s: Soup, tile: TileLayout, layout: BoardLayout, archetype: string, ownerHex: number, spots: AmbientSpots): void {
  const r = rng(tile.seed ^ 0x9e37);
  const y = layout.heightAt(tile.x, tile.z);
  s.setAnchor(tile.x, y, tile.z);
  s.jitter = 0.05;
  // Face the castle gate roughly toward the board center.
  const face = Math.atan2(-tile.z, -tile.x);
  s.place(tile.x, y - 0.02, tile.z, -face + Math.PI / 2, 1.18, 1.32);
  // Cobbled courtyard
  s.flat(Array.from({ length: 8 }, (_, i) => [Math.cos(i / 8 * Math.PI * 2) * 0.62, Math.sin(i / 8 * Math.PI * 2) * 0.62] as [number, number]), 0.025, C.cobble);
  const owner = hexToRgbLin(ownerHex);
  if (archetype === 'swarm') castleSwarm(s, owner, r, spots);
  else if (archetype === 'fortress') castleFortress(s, owner, r, spots);
  else castleVanguard(s, owner, r, spots);
}

function buildTown(s: Soup, tile: TileLayout, layout: BoardLayout, vp: number, ownerHex: number | null, connected: boolean, spots: AmbientSpots): void {
  const r = rng(tile.seed ^ 0x2c1b);
  const y = layout.heightAt(tile.x, tile.z);
  s.setAnchor(tile.x, y, tile.z);
  s.jitter = 0.07;
  s.place(tile.x, y - 0.01, tile.z, r() * 6, 1);
  // Plaza
  s.flat(Array.from({ length: 10 }, (_, i) => [Math.cos(i / 10 * Math.PI * 2) * 0.26, Math.sin(i / 10 * Math.PI * 2) * 0.26] as [number, number]), 0.02, C.cobble);
  const owner = ownerHex != null ? hexToRgbLin(ownerHex) : null;
  const goldGlow: RGB = connected ? GOLD_GLOW : scaleRGB(GOLD_GLOW, 0.35);
  if (vp >= 2) {
    // Temple with a golden dome
    at(s, 0, 0.02, 0, () => {
      s.box(0.3, 0.05, 0.3, C.stone);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) at(s, sx * 0.11, 0.05, sz * 0.11, () => s.cylinder(0.018, 0.018, 0.13, 6, C.plaster[0]));
      at(s, 0, 0.05, 0, () => s.cylinder(0.1, 0.1, 0.14, 10, C.plaster[1]));
      at(s, 0, 0.19, 0, () => {
        s.glow = goldGlow;
        s.blob(0.1, C.gold, { detail: 1, noise: 0.02, sy: 0.9 });
        at(s, 0, 0.17, 0, () => s.cone(0.02, 0.1, 6, C.gold));
        s.glow = [0, 0, 0];
      });
    });
    if (vp >= 3) {
      for (const sx of [-1, 1]) at(s, sx * 0.2, 0.02, 0.0, () => {
        s.box(0.05, 0.3, 0.05, C.plaster[0]);
        at(s, 0, 0.3, 0, () => { s.glow = goldGlow; s.pyramid(0.06, 0.1, C.gold); s.glow = [0, 0, 0]; });
      });
    }
  } else {
    // Obelisk crowned with a golden lodestar
    at(s, 0, 0.02, 0, () => {
      s.box(0.1, 0.04, 0.1, C.stone);
      at(s, 0, 0.04, 0, () => {
        s.cylinder(0.035, 0.025, 0.26, 4, C.plaster[0], { twist: Math.PI / 4 });
        at(s, 0, 0.26, 0, () => {
          s.glow = goldGlow;
          s.blob(0.035, C.gold, { noise: 0 });
          s.glow = [0, 0, 0];
        });
      });
    });
  }
  if (owner) at(s, 0.17, 0.02, 0.1, () => banner(s, owner, 0.3, 0.12));
  // Houses ringed around the plaza, facing in.
  const count = vp >= 2 ? 8 : 6;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (r() - 0.5) * 0.3;
    const d = 0.45 + r() * 0.17;
    const hx = Math.cos(a) * d, hz = Math.sin(a) * d;
    at(s, hx, 0, hz, () => {
      const saved = s.matrix.clone();
      // house() resets the transform, so pass world coords explicitly.
      const wp = worldOf(s, 0, 0, 0);
      const top = house(s, wp.x, layout.heightAt(wp.x, wp.z), wp.z, -a + Math.PI / 2 + (r() - 0.5) * 0.3, 0.85 + r() * 0.25, r, { chimney: r() < 0.7 });
      if (top) spots.chimneys.push(top);
      s.setAnchor(tile.x, y, tile.z);
      s.matrix.copy(saved);
    });
  }
}

// ── Defensive walls (per edge) ───────────────────────────────────────────
//
// Fortified tiles (lasting defense > 0; bases keep their own castle walls)
// wall their hexagon, and the wall grows with the defense: a palisade (1),
// stone wall (2), towered wall (3), fortified wall (4), citadel (5+).
// Neighbouring fortified tiles of the same holder — unowned counts as one
// holder, "neutral" — share an enclosure: a tile leaves an edge unwalled
// when the tile across it is as strong or stronger (equal tiles merge; a
// stronger tile keeps its own wall on that edge, so it still shows). Each
// edge is its own piece so a change of hands animates only what it affects.

/** Inset of the wall line from the hex edge (as a corner radius). */
const WALL_R = 0.86;
/** Where two equal walls meet across an open edge: this far along the open
 *  edge from the shared corner (the mitre of the inset). */
const WALL_JOIN = 1 - WALL_R;
/** Strongest wall drawn (higher defense looks the same). */
export const MAX_WALL_LEVEL = 5;

/** Wall strength of a tile: 0 for none, else palisade (1) … citadel (5). */
export function wallLevel(t: HexTile | undefined): number {
  if (!t || t.is_blocked || t.is_base) return 0;
  return Math.min(MAX_WALL_LEVEL, Math.max(0, t.base_defense + (t.permanent_defense_bonus ?? 0)));
}

/** The enclosure a fortified tile belongs to: its holder, or "neutral". */
function wallHolder(t: HexTile | undefined): string | null {
  return wallLevel(t) > 0 ? (t!.owner ?? 'neutral') : null;
}

/** Direction (radians) from a tile's center across edge k. */
export const edgeAngle = (k: number) => (Math.PI / 3) * k + Math.PI / 6;

/** Key of the tile across edge k (between corners k and k+1). */
export function neighbourAcross(tile: TileLayout, k: number): string {
  const a = edgeAngle(k);
  return worldToTileKey(tile.x + Math.sqrt(3) * Math.cos(a), tile.z + Math.sqrt(3) * Math.sin(a));
}

/**
 * How a wall edge ends at a corner:
 *  - `corner`: it turns a corner of its own tile (the next edge is walled too);
 *  - `merge`: the next edge is shared with an equal tile — the wall runs on
 *    into that tile's, meeting it on the shared edge;
 *  - `abut`: the next edge is shared with a stronger tile that keeps its own
 *    wall — this wall runs into that tile's corner.
 */
export type WallEnd = 'corner' | 'merge' | 'abut';

/** Whose style a wall is built in: its holder's archetype, or unowned. */
export type WallTheme = 'neutral' | 'vanguard' | 'swarm' | 'fortress';

/** A player's archetype as a building style (unknown ones build as Vanguard). */
export function themeOf(archetype: string | undefined): Exclude<WallTheme, 'neutral'> {
  return archetype === 'swarm' || archetype === 'fortress' ? archetype : 'vanguard';
}

export interface WallEdgeSpec {
  /** `${tileKey}#${k}` */
  key: string;
  tileKey: string;
  k: number;
  level: number;
  start: WallEnd;
  end: WallEnd;
  gate: boolean;
  theme: WallTheme;
  /** The holder's color (banners, bands), when owned. */
  owner: number | null;
  /** Changes whenever the edge must be rebuilt. */
  signature: string;
}

/** Every wall edge on the board for the current tile states. Owned walls
 *  take their holder's archetype style. */
export function wallEdges(
  layout: BoardLayout, tiles: Record<string, HexTile>,
  archetypeOf?: (pid: string) => string, ownerColor?: (pid: string) => number,
): WallEdgeSpec[] {
  const out: WallEdgeSpec[] = [];
  for (const tile of layout.tiles) {
    const t = tiles[tile.key];
    const holder = wallHolder(t);
    if (!holder) continue;
    const level = wallLevel(t);
    const owned = holder !== 'neutral';
    const theme: WallTheme = owned && archetypeOf ? themeOf(archetypeOf(holder)) : 'neutral';
    const owner = owned && ownerColor ? ownerColor(holder) : null;
    const across = Array.from({ length: 6 }, (_, k) => tiles[neighbourAcross(tile, k)]);
    const same = across.map(n => wallHolder(n) === holder);
    const open = across.map((n, k) => same[k] && wallLevel(n) >= level);
    if (open.every(Boolean)) continue;
    const endAt = (k: number): WallEnd => !open[k] ? 'corner' : wallLevel(across[k]) === level ? 'merge' : 'abut';
    // One gate per tile, on its preferred edge or the next walled one.
    let gate = Math.floor(rng(tile.seed ^ 0x77a1)() * 6);
    while (open[gate]) gate = (gate + 1) % 6;
    for (let k = 0; k < 6; k++) {
      if (open[k]) continue;
      const start = endAt((k + 5) % 6);
      const end = endAt((k + 1) % 6);
      out.push({
        key: `${tile.key}#${k}`, tileKey: tile.key, k, level, start, end, gate: k === gate, theme, owner,
        signature: `${level}|${start[0]}${end[0]}|${k === gate ? 1 : 0}|${theme}|${owner ?? '-'}`,
      });
    }
  }
  return out;
}

/** End point of a wall edge at a corner (see WallEnd). `side` is the own
 *  edge on the far side of that corner; `along` the corner it runs toward. */
function wallEnd(tile: TileLayout, corner: number, mode: WallEnd, side: number, along: number): { x: number; z: number } {
  if (mode === 'corner') return hexCorner(tile.x, tile.z, corner, WALL_R);
  const c = hexCorner(tile.x, tile.z, corner);
  if (mode === 'merge') {
    const n = hexCorner(tile.x, tile.z, along);
    return { x: c.x + (n.x - c.x) * WALL_JOIN, z: c.z + (n.z - c.z) * WALL_JOIN };
  }
  // The stronger neighbour's own inset corner at this corner.
  const a = edgeAngle(side);
  const nx = tile.x + Math.sqrt(3) * Math.cos(a), nz = tile.z + Math.sqrt(3) * Math.sin(a);
  return { x: c.x + (nx - c.x) * (1 - WALL_R), z: c.z + (nz - c.z) * (1 - WALL_R) };
}

/** Look of each stone wall level (2+; level 1 is a wooden palisade). */
interface StoneTier {
  h: number;
  thick: number;
  body: RGB;
  trim: RGB;
  merlon: number;
  /** A wider footing course under the wall. */
  plinth?: boolean;
  /** A stripe of this colour below the battlements. */
  band?: RGB;
  /** Towers on the enclosure's corners: cone roof, or battlements when null. */
  tower?: { r: number; h: number; roof: RGB | null; tip?: RGB; pennant?: boolean };
}
const STONE_TIERS: StoneTier[] = [
  /* 2 */ { h: 0.11, thick: 0.05, body: C.stone, trim: C.stoneDark, merlon: 0.04 },
  /* 3 */ { h: 0.15, thick: 0.055, body: C.stone, trim: C.stoneDark, merlon: 0.04, tower: { r: 0.055, h: 0.24, roof: C.roofs[2] } },
  /* 4 */ { h: 0.18, thick: 0.065, body: C.fortressStone, trim: C.fortressTrim, merlon: 0.045, plinth: true, tower: { r: 0.068, h: 0.3, roof: null } },
  /* 5 */ { h: 0.21, thick: 0.075, body: C.vanguardStone, trim: C.vanguardTrim, merlon: 0.05, plinth: true, band: C.gold, tower: { r: 0.078, h: 0.36, roof: C.roofs[1], tip: C.gold, pennant: true } },
];

/** A wall tier in its holder's style:
 *  - Vanguard: dark slate, iron spikes on the battlements, roofs in the
 *    holder's darkened color with steel tips and their pennants;
 *  - Fortress: heavy sandstone — thicker, always footed, buttressed, round
 *    battlemented towers, the holder's band once it's strong (4+). */
function themedTier(level: number, theme: WallTheme, owner: number | null): StoneTier & { spikes?: boolean; buttress?: boolean } {
  const base = STONE_TIERS[Math.min(level, MAX_WALL_LEVEL) - 2];
  const own = owner != null ? lin(owner) : null;
  if (theme === 'vanguard') {
    const roof = own ? mix(own, [0.05, 0.05, 0.06], 0.45) : C.roofs[2];
    return {
      ...base, body: C.vanguardStone, trim: C.vanguardTrim, spikes: true,
      band: level >= 5 ? (own ?? C.gold) : undefined,
      tower: base.tower ? { ...base.tower, roof, tip: C.steel, pennant: true } : undefined,
    };
  }
  if (theme === 'fortress') {
    return {
      ...base, body: C.fortressStone, trim: C.fortressTrim, thick: base.thick * 1.25, plinth: true, buttress: true,
      band: level >= 4 ? (own ?? C.gold) : undefined,
      tower: base.tower ? { ...base.tower, r: base.tower.r * 1.15, h: base.tower.h * 0.92, roof: null, tip: undefined, pennant: false } : undefined,
    };
  }
  return base;
}

/** One straight run of stone wall, centered on the current placement. */
function stoneRun(s: Soup, len: number, tier: StoneTier & { spikes?: boolean; buttress?: boolean }): void {
  if (tier.plinth) s.box(len, 0.035, tier.thick * 1.55, tier.trim);
  s.box(len, tier.h, tier.thick, tier.body, tier.trim);
  if (tier.band) at(s, 0, tier.h * 0.8, 0, () => s.box(len, 0.012, tier.thick * 1.06, tier.band!));
  crenellate(s, len, tier.h, tier.thick, tier.trim, tier.merlon);
  if (tier.spikes) {
    // An iron spike on every merlon.
    const n = Math.max(2, Math.floor(len / tier.merlon));
    for (let i = 0; i < n; i += 2) {
      const x = -len / 2 + (i + 0.5) * (len / n);
      at(s, x, tier.h + 0.025, 0, () => s.cone(0.006, 0.03, 4, C.steel));
    }
  }
  if (tier.buttress) {
    // Sloping buttresses on both faces.
    const n = Math.max(1, Math.round(len / 0.16));
    for (let i = 0; i < n; i++) {
      const x = -len / 2 + ((i + 0.5) / n) * len;
      for (const side of [-1, 1]) {
        at(s, x, 0, side * tier.thick * 0.62, () => s.box(0.03, tier.h * 0.62, tier.thick * 0.5, tier.trim, tier.body));
      }
    }
  }
}

/** Swarm walls: a thorn hedge of chitin spikes (1), then a mud rampart that
 *  thickens with the defense — spikes along its crest (3+), amber nodes
 *  glowing in it (4+) and hive mounds for towers. */
function swarmRun(s: Soup, layout: BoardLayout, a: { x: number; z: number }, b: { x: number; z: number }, e: WallEdgeSpec, r: () => number): void {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ry = -Math.atan2(b.z - a.z, b.x - a.x);
  const level = Math.min(e.level, MAX_WALL_LEVEL);
  const gateGap = (t: number) => e.gate && t > 0.36 && t < 0.64;
  if (level <= 1) {
    const n = Math.max(4, Math.round(16 * len / 0.86));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (gateGap(t)) continue;
      if (i === 0 && e.start === 'merge') continue;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      s.place(px, layout.heightAt(px, pz) - 0.01, pz, ry, 1);
      const lean = (r() - 0.5) * 0.7;
      const sv = s.push(0, 0, 0, 0, 1, 1, lean, (r() - 0.5) * 0.5);
      s.cone(0.012, 0.07 + r() * 0.04, 4, mix(C.chitin, C.chitinTip, r() * 0.5));
      s.pop(sv);
      if (i % 3 === 0) at(s, 0, -0.005, 0, () => s.blob(0.02, pick(C.swarmMud, r), { sy: 0.6, noise: 0.25 }));
    }
    return;
  }
  const h = [0, 0, 0.09, 0.12, 0.15, 0.18][level];
  const thick = [0, 0, 0.06, 0.07, 0.08, 0.09][level];
  const n = Math.max(4, Math.round(len / 0.045));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (gateGap(t)) continue;
    if (i === 0 && e.start === 'merge') continue;
    const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
    s.place(px, layout.heightAt(px, pz) - 0.02, pz, ry + (r() - 0.5) * 0.4, 1);
    // Lumps about as tall as the rampart (a blob stands 2·r·sy high).
    const sy = (h / (2 * thick * 0.62)) * (0.9 + r() * 0.25);
    s.blob(thick * 0.62, mix(pick(C.swarmMud, r), C.swarmDark, r() * 0.25), { sy, noise: 0.22 });
    if (level >= 3 && i % 2 === 0) {
      at(s, 0, h * 0.85, 0, () => {
        const sv = s.push(0, 0, 0, 0, 1, 1, (r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
        s.cone(0.011, 0.05 + r() * 0.03, 4, mix(C.chitin, C.chitinTip, r() * 0.5));
        s.pop(sv);
      });
    }
    if (level >= 4 && i % 4 === 2) {
      at(s, 0, h * 0.45, thick * 0.5, () => {
        s.glow = AMBER_GLOW;
        s.blob(0.012, C.swarmDark, { noise: 0 });
        s.glow = [0, 0, 0];
      });
    }
  }
  if (e.gate) {
    // Two swollen mounds flank the opening.
    for (const t of [0.33, 0.67]) {
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      s.place(px, layout.heightAt(px, pz) - 0.02, pz, ry, 1);
      hiveMound(s, thick * 0.75, h * 1.5, r, level >= 4, emptySpots());
    }
  }
  if (level >= 3 && e.start === 'corner') {
    s.place(a.x, layout.heightAt(a.x, a.z) - 0.02, a.z, 0, 1);
    hiveMound(s, thick * 0.95, h * 2.1, r, level >= 5, emptySpots());
    if (e.owner != null) at(s, thick * 0.4, h * 1.4, 0, () => banner(s, lin(e.owner!), 0.12, 0.07));
  }
}

/** Geometry for one wall edge of a tile. */
export function buildWallEdge(s: Soup, tile: TileLayout, layout: BoardLayout, e: WallEdgeSpec): void {
  const r = rng(tile.seed ^ 0x77a1 ^ ((e.k + 1) * 0x9e37));
  s.build = tile.ring / Math.max(1, layout.maxRing);
  s.setAnchor(tile.x, layout.heightAt(tile.x, tile.z), tile.z);
  s.jitter = 0.06;
  const a = wallEnd(tile, e.k, e.start, e.k + 5, e.k + 5);
  const b = wallEnd(tile, e.k + 1, e.end, e.k + 1, e.k + 2);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ry = -Math.atan2(b.z - a.z, b.x - a.x);
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  const owner = e.owner != null ? lin(e.owner) : null;
  if (e.theme === 'swarm') {
    swarmRun(s, layout, a, b, e, r);
    return;
  }
  if (e.level <= 1 && e.theme === 'fortress') {
    // A low dry-stone wall of rough-cut blocks.
    const n = Math.max(4, Math.round(len / 0.05));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (e.gate && t > 0.38 && t < 0.62) continue;
      if (i === 0 && e.start === 'merge') continue;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      s.place(px, layout.heightAt(px, pz) - 0.01, pz, ry + (r() - 0.5) * 0.25, 1);
      s.box(0.05, 0.035 + r() * 0.012, 0.045, mix(C.fortressStone, C.fortressTrim, r() * 0.6));
      at(s, (r() - 0.5) * 0.02, 0.04, 0, () => s.box(0.034, 0.025, 0.036, mix(C.fortressStone, C.stone, r() * 0.5)));
    }
    if (e.gate && owner) {
      for (const t of [0.36, 0.64]) {
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
        s.place(px, layout.heightAt(px, pz) - 0.01, pz, ry, 1);
        s.box(0.045, 0.1, 0.045, C.fortressTrim, C.fortressStone);
        at(s, 0, 0.1, 0, () => s.pyramid(0.05, 0.03, owner));
      }
    }
    return;
  }
  if (e.level <= 1) {
    // Sharpened palisade stakes (Vanguard: dark, iron-tipped, its pennants on the gate)
    const vanguard = e.theme === 'vanguard';
    const n = Math.max(3, Math.round(13 * len / 0.86));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (e.gate && t > 0.35 && t < 0.65) continue;
      // The stake on a meeting point belongs to the wall ending there.
      if (i === 0 && e.start === 'merge') continue;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      s.place(px, layout.heightAt(px, pz) - 0.01, pz, ry + (r() - 0.5) * 0.3, 1);
      const hh = (vanguard ? 0.09 : 0.08) + r() * 0.03;
      s.box(0.02, hh, 0.02, vanguard ? mix(C.woodDark, C.vanguardTrim, r() * 0.6) : mix(C.wood, C.woodDark, r()));
      at(s, 0, hh, 0, () => s.pyramid(0.02, vanguard ? 0.035 : 0.025, vanguard ? C.steel : C.woodDark));
    }
    if (e.gate && vanguard && owner) {
      for (const t of [0.33, 0.67]) {
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
        s.place(px, layout.heightAt(px, pz) - 0.01, pz, ry, 1);
        banner(s, owner, 0.17, 0.07);
      }
    }
    return;
  }
  const tier = themedTier(e.level, e.theme, e.owner);
  s.place(mx, layout.heightAt(mx, mz) - 0.02, mz, ry, 1);
  if (e.gate) {
    for (const sx of [-1, 1]) at(s, sx * len * 0.33, 0, 0, () => stoneRun(s, len * 0.34, tier));
    for (const sx of [-1, 1]) at(s, sx * len * 0.15, 0, 0, () => s.box(0.045, tier.h + 0.045, tier.thick * 1.4, tier.trim));
    if (tier.band) at(s, 0, tier.h + 0.03, 0, () => s.box(len * 0.34, 0.03, tier.thick * 1.2, tier.trim));
    // Vanguard hangs its colors either side of the gate.
    if (e.theme === 'vanguard' && owner) {
      for (const sx of [-1, 1]) at(s, sx * len * 0.15, tier.h + 0.02, tier.thick * 0.72, () => s.box(0.035, -tier.h * 0.8, 0.004, owner));
    }
  } else {
    stoneRun(s, len, tier);
  }
  // A pier where this wall meets an equal neighbour's (one per meeting point).
  if (e.end === 'merge') {
    s.place(b.x, layout.heightAt(b.x, b.z) - 0.02, b.z, ry, 1);
    s.box(tier.thick + 0.025, tier.h + 0.02, tier.thick + 0.025, tier.trim, tier.body);
  }
  // Towers on the enclosure's own corners (not where it runs on).
  const tw = tier.tower;
  if (tw && e.start === 'corner') {
    s.place(a.x, layout.heightAt(a.x, a.z) - 0.02, a.z, 0, 1);
    s.cylinder(tw.r, tw.r * 0.9, tw.h, 8, tier.body, { top: tier.trim });
    at(s, 0, tw.h, 0, () => {
      if (tw.roof) {
        s.cone(tw.r * 1.3, tw.r * 1.9, 8, tw.roof);
        if (tw.tip) at(s, 0, tw.r * 1.85, 0, () => s.cone(tw.r * 0.32, tw.r * 0.7, 6, tw.tip!));
        if (tw.pennant) at(s, 0, tw.r * 2.4, 0, () => banner(s, e.theme === 'vanguard' && owner ? owner : C.gold, 0.1, 0.05));
      } else {
        roundTowerTop(s, tw.r, tier.trim);
        // A Fortress tower flies its holder's flag.
        if (e.theme === 'fortress' && owner) at(s, 0, 0.01, 0, () => banner(s, owner, 0.1, 0.055));
      }
    });
  }
}

/** Decide which structure a tile carries in its current state. */
export function structureSpec(t: HexTile, archetypeOf: (pid: string) => string, ownerColor: (pid: string) => number, connected: boolean): StructureSpec {
  if (t.is_blocked) return { kind: 'mountain', signature: 'mtn' };
  if (t.is_base) {
    const pid = t.base_owner ?? t.owner ?? '';
    const holder = t.owner ?? pid;
    return { kind: 'castle', signature: `castle|${archetypeOf(pid)}|${ownerColor(holder)}` };
  }
  if (t.is_vp) {
    return { kind: 'town', signature: `town|${t.vp_value}|${t.owner ? ownerColor(t.owner) : '-'}|${connected ? 1 : 0}` };
  }
  // Walls are built per edge (wallEdges), not as part of the structure.
  return { kind: 'none', signature: '' };
}

/** Build the structure geometry soup for a tile (or null when it has none). */
export function buildStructure(
  t: HexTile, tile: TileLayout, layout: BoardLayout, gameTiles: Record<string, HexTile>,
  archetypeOf: (pid: string) => string, ownerColor: (pid: string) => number, connected: boolean, spots: AmbientSpots,
): Soup | null {
  const s = new Soup(tile.seed);
  s.build = tile.ring / Math.max(1, layout.maxRing);
  if (t.is_blocked) {
    buildMountain(s, tile, layout, gameTiles, spots);
  } else if (t.is_base) {
    const pid = t.base_owner ?? t.owner ?? '';
    buildCastle(s, tile, layout, archetypeOf(pid), ownerColor(t.owner ?? pid), spots);
  } else if (t.is_vp) {
    buildTown(s, tile, layout, t.vp_value || 1, t.owner ? ownerColor(t.owner) : null, connected, spots);
  } else {
    return null;
  }
  return s.vertexCount > 0 ? s : null;
}

/** Height of the tallest thing standing on a tile (for picking + label lift). */
export function structureHeight(t: HexTile): number {
  if (t.is_blocked) return 1.6;
  if (t.is_base) return 1.15;
  if (t.is_vp) return t.vp_value >= 2 ? 0.42 : 0.36;
  const level = wallLevel(t);
  if (level >= 5) return 0.5;
  if (level >= 4) return 0.36;
  if (level >= 3) return 0.3;
  if (level > 0) return 0.18;
  return 0.12;
}
