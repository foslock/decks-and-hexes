import {
  BufferAttribute, Color, DataTexture, Group, LinearFilter, Mesh, MeshStandardMaterial, RedFormat,
  UnsignedByteType, Vector3, type IUniform,
} from 'three';
import type { HexTile } from '../types/game';
import type { VpPath } from './boardTypes';
import type { FxLayer } from './fx';
import type { BoardLayout } from './layout';
import { axialToWorld } from './layout';
import { rng } from './noise';
import { themeOf } from './props';
import { Soup, lin, mix, type RGB } from './soup';

/**
 * VP connection roads. Each owned VP town that links back to its owner's
 * castle gets a real cobbled road laid across the tiles in between — edged
 * with curb stones and marker pennants in the owner's color.
 *
 * Roads are diffed per segment (tile → neighboring tile), so a growing
 * network only lays the new stretch: stones pop in from the castle side
 * outward with dust at the build front. Segments that disappear are torn
 * up; segments on a broken route (a tile captured mid-resolve) crumble.
 *
 * Each road is laid in its owner's archetype style (see ROAD_STYLES):
 * Vanguard dark slate cobbles, Fortress broad sandstone slabs, Swarm a rutted
 * mud track.
 *
 * Decor in a road's corridor (trees, rocks, bushes) is cleared through a
 * small mask texture the prop shader reads — as is decor standing where an
 * occupier pitched camp (setClearings).
 */

const ROAD_VERT_HEAD = /* glsl */ `
attribute float aAlong;
attribute vec3 aAnchor;
uniform float uProgress;
float bh_roadBack(float t) {
  float c1 = 1.70158; float c3 = c1 + 1.0; float u = t - 1.0;
  return 1.0 + c3 * u * u * u + c1 * u * u;
}
`;

const ROAD_VERT_BODY = /* glsl */ `
{
  float k = clamp((uProgress - aAlong) * 7.0, 0.0, 1.0);
  float s = k <= 0.0 ? 0.0001 : bh_roadBack(k);
  transformed = aAnchor + (transformed - aAnchor) * s;
  transformed.y += (1.0 - k) * 0.12;
}
`;

function createRoadMaterial(progress: IUniform<number>): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uProgress = progress;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ROAD_VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${ROAD_VERT_BODY}`);
  };
  m.customProgramCacheKey = () => 'bh-road';
  return m;
}

const WOOD = lin(0x4a3422);
const STEEL = lin(0x9aa0a8);
const AMBER: RGB = [1.8, 0.75, 0.18];

/** How a road is laid, by its owner's archetype. */
interface RoadStyle {
  /** Bed width. */
  w: number;
  bed: RGB;
  /** Paving: staggered cobbles, broad slabs, or none (a mud track). */
  paving: 'cobble' | 'slab' | 'mud';
  stones: RGB[];
  curb: RGB;
  /** Curb pieces: stones, heavy blocks, or mud lumps. */
  curbs: 'stone' | 'block' | 'lump';
  /** At the tile edge: a pennant, a capped bollard, or an amber spire. */
  marker: 'pennant' | 'bollard' | 'spire';
}
const ROAD_STYLES: Record<'vanguard' | 'fortress' | 'swarm', RoadStyle> = {
  vanguard: {
    w: 0.2, bed: lin(0x4a3e34), paving: 'cobble',
    stones: [lin(0x7a7680), lin(0x6c6870), lin(0x86828a), lin(0x625e66)],
    curb: lin(0x56525a), curbs: 'stone', marker: 'pennant',
  },
  fortress: {
    w: 0.24, bed: lin(0x6a5a44), paving: 'slab',
    stones: [lin(0xc9b896), lin(0xbcab88), lin(0xd2c4a2), lin(0xb2a17e)],
    curb: lin(0x7d7466), curbs: 'block', marker: 'bollard',
  },
  swarm: {
    w: 0.21, bed: lin(0x5a4228), paving: 'mud',
    stones: [lin(0x8a6a40), lin(0x7a5a36), lin(0x9a7848)],
    curb: lin(0x4a3620), curbs: 'lump', marker: 'spire',
  },
};

interface Segment {
  key: string;
  playerId: string;
  a: { x: number; z: number };   // castle-side end (build starts here)
  b: { x: number; z: number };   // town-side end
  mesh: Mesh;
  mat: MeshStandardMaterial;
  progress: IUniform<number>;
  start: number;
  duration: number;
  state: 'building' | 'built' | 'removing';
  crumble: boolean;
  dustAcc: number;
  /** The owner's look it was laid in. */
  look: string;
}

/** A segment key independent of direction: player + both tiles. */
function segKey(pid: string, p: [number, number], q: [number, number]): string {
  const a = `${p[0]},${p[1]}`, b = `${q[0]},${q[1]}`;
  return a < b ? `${pid}|${a}|${b}` : `${pid}|${b}|${a}`;
}

export class RoadLayer {
  readonly group = new Group();
  private segs = new Map<string, Segment>();
  private now = 0;
  private animate = true;
  /** Corridor mask (1 = keep decor clear) covering [-extent, extent]². */
  readonly mask: DataTexture;
  readonly maskRect = new Vector3(0, 0, 1); // x, z offset unused; .z = 1 / (2·extent)
  private maskDirty = false;
  private readonly maskRes = 256;
  private extent = 10;

  constructor(
    private layout: BoardLayout, private fx: FxLayer, private ownerColor: (pid: string) => number,
    private archetypeOf: (pid: string) => string = () => 'vanguard',
  ) {
    this.mask = new DataTexture(new Uint8Array(this.maskRes * this.maskRes), this.maskRes, this.maskRes, RedFormat, UnsignedByteType);
    this.mask.magFilter = LinearFilter;
    this.mask.minFilter = LinearFilter;
    this.mask.needsUpdate = true;
    this.setLayout(layout);
  }

  setLayout(layout: BoardLayout): void {
    this.layout = layout;
    this.extent = layout.radius + 1;
    this.maskRect.set(0, 0, 1 / (2 * this.extent));
    // Terrain heights changed: drop roads; the next setPaths rebuilds them.
    for (const s of [...this.segs.values()]) this.dropSeg(s);
    this.lastSig = '';
    this.maskDirty = true;
  }

  setAnimate(on: boolean): void {
    this.animate = on;
  }

  private clearings: { x: number; z: number; r: number }[] = [];
  private clearSig = '';

  /** Circles (world xz) to keep clear of decor — occupiers' camps. */
  setClearings(list: { x: number; z: number; r: number }[]): void {
    const sig = list.map(c => `${c.x.toFixed(2)},${c.z.toFixed(2)},${c.r.toFixed(2)}`).join('|');
    if (sig === this.clearSig) return;
    this.clearSig = sig;
    this.clearings = list;
    this.maskDirty = true;
  }

  private lastSig = '';
  private lastPaths: VpPath[] = [];
  private tiles: Record<string, HexTile> = {};

  setPaths(paths: VpPath[] | undefined, tiles: Record<string, HexTile>): void {
    this.tiles = tiles;
    const list = paths ?? [];
    this.lastPaths = list;
    // A road is rebuilt when its owner's look changes (color, archetype).
    const look = (pid: string) => `${themeOf(this.archetypeOf(pid))}/${this.ownerColor(pid)}`;
    const sig = list.map(p => `${p.playerId}:${look(p.playerId)}:${p.breaking ? 'x' : ''}${p.points.map(q => q.join(',')).join(';')}`).join('|');
    const looks = new Map<string, string>();
    for (const p of list) looks.set(p.playerId, look(p.playerId));
    if (sig === this.lastSig) return;
    this.lastSig = sig;

    // Desired segments, ordered from each castle outward.
    const want = new Map<string, { pid: string; from: [number, number]; to: [number, number]; order: number; endIsTown: boolean; startIsBase: boolean }>();
    const broken = new Set<string>();
    for (const p of list) {
      const n = p.points.length;
      for (let i = n - 2; i >= 0; i--) {
        // points run town (0) → castle (n-1): build from the castle side.
        const from = p.points[i + 1];
        const to = p.points[i];
        const key = segKey(p.playerId, from, to);
        if (p.breaking) { broken.add(key); continue; }
        if (!want.has(key)) {
          want.set(key, { pid: p.playerId, from, to, order: n - 2 - i, endIsTown: i === 0, startIsBase: i + 1 === n - 1 });
        }
      }
    }

    for (const [key, seg] of this.segs) {
      if (want.has(key) || seg.state === 'removing') continue;
      if (!this.animate) { this.dropSeg(seg); continue; }
      seg.state = 'removing';
      seg.crumble = broken.has(key);
      seg.start = this.now;
      seg.duration = seg.crumble ? 0.35 : 0.45;
      if (seg.crumble && this.animate) this.crumble(seg);
    }

    for (const [key, w] of want) {
      const existing = this.segs.get(key);
      if (existing && existing.state !== 'removing' && existing.look === looks.get(w.pid)) continue;
      if (existing) this.dropSeg(existing);
      const seg = this.buildSeg(key, w.pid, w.from, w.to, w.startIsBase, w.endIsTown, this.animate ? w.order * 0.32 : 0);
      seg.look = looks.get(w.pid) ?? '';
      this.segs.set(key, seg);
    }
    this.maskDirty = true;
  }

  private buildSeg(key: string, pid: string, from: [number, number], to: [number, number], startIsBase: boolean, endIsTown: boolean, delay: number): Segment {
    const A = axialToWorld(from[0], from[1]);
    const B = axialToWorld(to[0], to[1]);
    const dx = B.x - A.x, dz = B.z - A.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;
    const fromTile = this.tiles[`${from[0]},${from[1]}`];
    const toTile = this.tiles[`${to[0]},${to[1]}`];
    // Stop at the castle gate / town plaza instead of running into them.
    const startClip = startIsBase || fromTile?.is_base ? 0.58 : fromTile?.is_vp ? 0.27 : 0;
    const endClip = toTile?.is_vp ? 0.27 : toTile?.is_base ? 0.58 : 0;
    const a = { x: A.x + ux * startClip, z: A.z + uz * startClip };
    const b = { x: B.x - ux * endClip, z: B.z - uz * endClip };
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);

    const owner = lin(this.ownerColor(pid));
    const st = ROAD_STYLES[themeOf(this.archetypeOf(pid))];
    const BED = st.bed;
    const curb = mix(st.curb, owner, st.curbs === 'lump' ? 0.15 : 0.6);
    const r = rng(key.length * 7919 + Math.round(A.x * 100) * 31 + Math.round(B.z * 100));
    const s = new Soup(Math.round(A.x * 997 + B.z * 131));
    s.jitter = 0.06;
    const along = (x: number, z: number) => Math.max(0, Math.min(1, ((x - a.x) * ux + (z - a.z) * uz) / Math.max(0.01, segLen)));
    const heightAt = (x: number, z: number) => this.layout.heightAt(x, z);

    // Earth bed (draped strip)
    const W = st.w;
    const steps = Math.max(2, Math.ceil(segLen / 0.08));
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 };
      const p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      const q = (p: { x: number; z: number }, side: number) => [p.x + nx * W / 2 * side, heightAt(p.x + nx * W / 2 * side, p.z + nz * W / 2 * side) + 0.006, p.z + nz * W / 2 * side];
      const mid = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
      s.setAnchor(mid.x, heightAt(mid.x, mid.z), mid.z);
      s.place(0, 0, 0, 0, 1);
      s.quad(q(p0, -1), q(p0, 1), q(p1, 1), q(p1, -1), BED);
    }
    // Junction pad where two segments meet on an ordinary tile
    const pads: { x: number; z: number }[] = [];
    if (!startIsBase && !fromTile?.is_vp && !fromTile?.is_base) pads.push(a);
    if (!endIsTown && !toTile?.is_vp && !toTile?.is_base) pads.push(b);
    for (const c of pads) {
      const n = 8;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        const p0 = [c.x + Math.cos(a0) * W * 0.62, heightAt(c.x, c.z) + 0.007, c.z + Math.sin(a0) * W * 0.62];
        const p1 = [c.x + Math.cos(a1) * W * 0.62, heightAt(c.x, c.z) + 0.007, c.z + Math.sin(a1) * W * 0.62];
        s.setAnchor(c.x, heightAt(c.x, c.z), c.z);
        s.place(0, 0, 0, 0, 1);
        s.tri([c.x, heightAt(c.x, c.z) + 0.009, c.z], p1, p0, BED);
      }
    }
    const stones = st.stones;
    const roadRy = Math.atan2(-uz, ux);
    if (st.paving === 'cobble') {
      // Cobbles: staggered rows of flat stones
      const rowStep = 0.042;
      const rows = Math.max(1, Math.floor(segLen / rowStep));
      for (let i = 0; i <= rows; i++) {
        const t = i / Math.max(1, rows);
        const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
        const stagger = i % 2 ? 0.5 : 0;
        for (let j = -1.5; j <= 1.5; j += 1) {
          const off = (j + stagger * (j < 1.5 ? 1 : 0)) * 0.042;
          if (Math.abs(off) > W * 0.4) continue;
          const sx = cx + nx * off + (r() - 0.5) * 0.006;
          const sz = cz + nz * off + (r() - 0.5) * 0.006;
          const sy = heightAt(sx, sz) + 0.009;
          s.setAnchor(sx, sy, sz);
          s.place(sx, sy, sz, roadRy + (r() - 0.5) * 0.25, 1);
          const col = stones[Math.floor(r() * stones.length)];
          s.box(0.036, 0.008 + r() * 0.004, 0.034, mix(col, BED, 0.1), col);
        }
      }
    } else if (st.paving === 'slab') {
      // Broad dressed slabs, two to a row, joints staggered
      const rowStep = 0.075;
      const rows = Math.max(1, Math.floor(segLen / rowStep));
      for (let i = 0; i <= rows; i++) {
        const t = i / Math.max(1, rows);
        const cx = a.x + (b.x - a.x) * t, cz = a.z + (b.z - a.z) * t;
        const shift = i % 2 ? 0.025 : -0.025;
        for (const [off, wide] of [[-W * 0.22 + shift, 0.1], [W * 0.22 + shift, 0.09]] as const) {
          if (Math.abs(off) > W * 0.42) continue;
          const sx = cx + nx * off, sz = cz + nz * off;
          const sy = heightAt(sx, sz) + 0.009;
          s.setAnchor(sx, sy, sz);
          s.place(sx, sy, sz, roadRy + (r() - 0.5) * 0.05, 1);
          const col = stones[Math.floor(r() * stones.length)];
          s.box(0.068, 0.01, wide, mix(col, BED, 0.08), col);
        }
      }
    } else {
      // A mud track: two dark wheel ruts, puddled lumps and scattered pebbles
      const steps2 = Math.max(2, Math.ceil(segLen / 0.05));
      const rut = mix(BED, [0.02, 0.015, 0.01], 0.45);
      for (let i = 0; i < steps2; i++) {
        const t0 = i / steps2, t1 = (i + 1) / steps2;
        for (const side of [-1, 1]) {
          const off = side * W * 0.22;
          const p0 = { x: a.x + (b.x - a.x) * t0 + nx * off, z: a.z + (b.z - a.z) * t0 + nz * off };
          const p1 = { x: a.x + (b.x - a.x) * t1 + nx * off, z: a.z + (b.z - a.z) * t1 + nz * off };
          const q = (p: { x: number; z: number }, d: number) => [p.x + nx * d, heightAt(p.x, p.z) + 0.009, p.z + nz * d];
          const mid = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
          s.setAnchor(mid.x, heightAt(mid.x, mid.z), mid.z);
          s.place(0, 0, 0, 0, 1);
          s.quad(q(p0, -0.012), q(p0, 0.012), q(p1, 0.012), q(p1, -0.012), rut);
        }
      }
      const lumps = Math.max(2, Math.floor(segLen / 0.06));
      for (let i = 0; i <= lumps; i++) {
        const t = (i + r() * 0.6) / (lumps + 0.6);
        const off = (r() - 0.5) * W * 0.6;
        const sx = a.x + (b.x - a.x) * t + nx * off, sz = a.z + (b.z - a.z) * t + nz * off;
        const sy = heightAt(sx, sz) + 0.004;
        s.setAnchor(sx, sy, sz);
        s.place(sx, sy, sz, r() * 6, 1);
        s.blob(0.012 + r() * 0.01, stones[Math.floor(r() * stones.length)], { sy: 0.35, noise: 0.3 });
      }
    }
    // Curbs along both edges (owner-tinted stones, heavy blocks, mud lumps)
    const curbStep = st.curbs === 'block' ? 0.095 : st.curbs === 'lump' ? 0.06 : 0.07;
    const curbs = Math.max(1, Math.floor(segLen / curbStep));
    for (const side of [-1, 1]) {
      for (let i = 0; i <= curbs; i++) {
        const t = i / Math.max(1, curbs);
        const px = a.x + (b.x - a.x) * t + nx * side * W * 0.5;
        const pz = a.z + (b.z - a.z) * t + nz * side * W * 0.5;
        const py = heightAt(px, pz);
        s.setAnchor(px, py, pz);
        if (st.curbs === 'lump') {
          s.place(px, py - 0.004, pz, r() * 6, 1);
          s.blob(0.016 + r() * 0.008, mix(curb, stones[0], r() * 0.5), { sy: 0.55, noise: 0.3 });
        } else if (st.curbs === 'block') {
          s.place(px, py, pz, roadRy, 1);
          s.box(0.07, 0.03, 0.03, curb, mix(curb, [1, 1, 1], 0.12));
        } else {
          s.place(px, py, pz, roadRy, 1);
          s.box(0.052, 0.02, 0.022, curb, mix(curb, [1, 1, 1], 0.12));
        }
      }
    }
    // A marker where the road crosses the tile edge
    {
      const t = Math.min(0.95, Math.max(0.05, (len / 2 - startClip) / Math.max(0.01, segLen)));
      const side = r() < 0.5 ? -1 : 1;
      const px = a.x + (b.x - a.x) * t + nx * side * W * 0.72;
      const pz = a.z + (b.z - a.z) * t + nz * side * W * 0.72;
      const py = heightAt(px, pz);
      s.setAnchor(px, py, pz);
      s.place(px, py, pz, Math.atan2(-nz, nx) + (side < 0 ? Math.PI : 0), 1);
      if (st.marker === 'bollard') {
        // A squat stone bollard capped in the owner's color
        s.cylinder(0.022, 0.02, 0.06, 6, st.curb, { top: stones[0] });
        const cap = s.push(0, 0.06, 0, 0, 1);
        s.pyramid(0.034, 0.026, owner);
        s.pop(cap);
      } else if (st.marker === 'spire') {
        // A little mud spire with an amber node, tipped in the owner's color
        s.cone(0.024, 0.09, 6, stones[1], 0.12);
        const tip = s.push(0, 0.075, 0, 0, 1);
        s.cone(0.009, 0.03, 4, mix(owner, st.curb, 0.3));
        s.pop(tip);
        const node = s.push(0.012, 0.028, 0.012, 0, 1);
        s.glow = AMBER;
        s.blob(0.009, st.curb, { noise: 0 });
        s.glow = [0, 0, 0];
        s.pop(node);
      } else {
        s.cylinder(0.008, 0.006, 0.17, 4, WOOD, { top: null });
        const tip = s.push(0, 0.17, 0, 0, 1);
        s.cone(0.006, 0.02, 4, STEEL);
        s.pop(tip);
        const fl = s.push(0.004, 0.165, 0, 0, 1);
        s.windScale = 6;
        s.windAlongX = true;
        s.pennant(0.07, 0.04, owner);
        s.windAlongX = false;
        s.windScale = 0;
        s.pop(fl);
      }
    }

    const geo = s.toGeometry();
    // Each stone pops in when the build front passes its anchor.
    const anchors = geo.getAttribute('aAnchor');
    const alongArr = new Float32Array(anchors.count);
    for (let i = 0; i < anchors.count; i++) alongArr[i] = along(anchors.getX(i), anchors.getZ(i));
    geo.setAttribute('aAlong', new BufferAttribute(alongArr, 1));
    const progress: IUniform<number> = { value: this.animate ? -0.2 : 2 };
    const mat = createRoadMaterial(progress);
    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    this.group.add(mesh);
    const seg: Segment = {
      key, playerId: pid, a, b, mesh, mat, progress,
      start: this.now + delay, duration: 0.42, state: 'building', crumble: false, dustAcc: 0, look: '',
    };
    if (!this.animate) seg.state = 'built';
    return seg;
  }

  private crumble(seg: Segment): void {
    const col = new Color(0x8b8375);
    const n = 10;
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      const x = seg.a.x + (seg.b.x - seg.a.x) * t, z = seg.a.z + (seg.b.z - seg.a.z) * t;
      this.fx.addShard(
        new Vector3(x, this.layout.heightAt(x, z) + 0.03, z),
        new Vector3((Math.random() - 0.5) * 0.9, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 0.9),
        0.018 + Math.random() * 0.014, col,
      );
    }
    const mx = (seg.a.x + seg.b.x) / 2, mz = (seg.a.z + seg.b.z) / 2;
    this.fx.dust(mx * 32, mz * 32, 10, 0.7);
  }

  private dropSeg(seg: Segment): void {
    this.group.remove(seg.mesh);
    seg.mesh.geometry.dispose();
    seg.mat.dispose();
    this.segs.delete(seg.key);
  }

  /** Rebuild the decor-clearing mask from live segments. */
  private rebuildMask(): void {
    const res = this.maskRes;
    const data = this.mask.image.data as Uint8Array;
    data.fill(0);
    const E = this.extent;
    const toPix = (v: number) => ((v / (2 * E)) + 0.5) * res;
    const R = 0.15;
    for (const seg of this.segs.values()) {
      if (seg.state === 'removing') continue;
      const minX = Math.max(0, Math.floor(toPix(Math.min(seg.a.x, seg.b.x) - R)));
      const maxX = Math.min(res - 1, Math.ceil(toPix(Math.max(seg.a.x, seg.b.x) + R)));
      const minZ = Math.max(0, Math.floor(toPix(Math.min(seg.a.z, seg.b.z) - R)));
      const maxZ = Math.min(res - 1, Math.ceil(toPix(Math.max(seg.a.z, seg.b.z) + R)));
      const dx = seg.b.x - seg.a.x, dz = seg.b.z - seg.a.z;
      const l2 = dx * dx + dz * dz || 1;
      for (let j = minZ; j <= maxZ; j++) {
        for (let i = minX; i <= maxX; i++) {
          const x = ((i + 0.5) / res - 0.5) * 2 * E;
          const z = ((j + 0.5) / res - 0.5) * 2 * E;
          const t = Math.max(0, Math.min(1, ((x - seg.a.x) * dx + (z - seg.a.z) * dz) / l2));
          const d = Math.hypot(x - (seg.a.x + dx * t), z - (seg.a.z + dz * t));
          if (d < R) data[j * res + i] = 255;
        }
      }
    }
    for (const c of this.clearings) {
      const minX = Math.max(0, Math.floor(toPix(c.x - c.r))), maxX = Math.min(res - 1, Math.ceil(toPix(c.x + c.r)));
      const minZ = Math.max(0, Math.floor(toPix(c.z - c.r))), maxZ = Math.min(res - 1, Math.ceil(toPix(c.z + c.r)));
      for (let j = minZ; j <= maxZ; j++) {
        for (let i = minX; i <= maxX; i++) {
          const x = ((i + 0.5) / res - 0.5) * 2 * E;
          const z = ((j + 0.5) / res - 0.5) * 2 * E;
          if (Math.hypot(x - c.x, z - c.z) < c.r) data[j * res + i] = 255;
        }
      }
    }
    this.mask.needsUpdate = true;
  }

  update(dt: number, now: number): boolean {
    this.now = now;
    let busy = false;
    for (const seg of [...this.segs.values()]) {
      if (seg.state === 'built') continue;
      busy = true;
      const t = (now - seg.start) / seg.duration;
      if (seg.state === 'building') {
        if (t < 0) { seg.progress.value = -0.2; continue; }
        const p = Math.min(1, t);
        seg.progress.value = p * 1.2;
        // Dust at the build front
        seg.dustAcc += dt;
        if (seg.dustAcc > 0.06 && p < 1) {
          seg.dustAcc = 0;
          const x = seg.a.x + (seg.b.x - seg.a.x) * p, z = seg.a.z + (seg.b.z - seg.a.z) * p;
          this.fx.dust(x * 32, z * 32, 2, 0.45);
        }
        if (t >= 1) { seg.state = 'built'; seg.progress.value = 2; }
      } else {
        seg.progress.value = 1.2 * (1 - Math.min(1, Math.max(0, t)));
        if (t >= 1) { this.dropSeg(seg); this.maskDirty = true; }
      }
    }
    if (this.maskDirty) {
      this.maskDirty = false;
      this.rebuildMask();
    }
    return busy;
  }

  dispose(): void {
    for (const s of [...this.segs.values()]) this.dropSeg(s);
    this.mask.dispose();
  }

  /** Paths currently shown (for re-sync after a layout rebuild). */
  get paths(): VpPath[] {
    return this.lastPaths;
  }
}
