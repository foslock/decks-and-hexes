import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, Group,
  InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PointLight,
  ShaderMaterial, TetrahedronGeometry, Vector2, Vector3,
} from 'three';
import { HEX_SIZE } from '../utils/hexGeometry';
import type { BoardFx, FxFortifyRing, LocalPoint } from './boardTypes';
import { PLAYER_COLORS } from './boardTypes';
import type { BoardLayout } from './layout';
import { axialToWorld, hexCorner } from './layout';
import type { ParticlePool } from './particles';
import { Soup, lin } from './soup';
import { WATER_Y } from './terrain';

const toWorld = (p: LocalPoint) => ({ x: p.x / HEX_SIZE, z: p.y / HEX_SIZE });

function brighten(c: Color, amt: number): Color {
  return c.clone().lerp(new Color(1, 1, 1), amt);
}

/**
 * Triangulate a star-shaped polygon (fan from its centroid), subdivide each
 * triangle and drape every vertex onto the terrain.
 */
export function drapedPolygon(points: { x: number; z: number }[], layout: BoardLayout, lift: number, subdiv = 3): Float32Array {
  const n = points.length;
  let cx = 0, cz = 0;
  for (const p of points) { cx += p.x; cz += p.z; }
  cx /= n; cz /= n;
  const out: number[] = [];
  const push = (x: number, z: number) => out.push(x, layout.heightAt(x, z) + lift, z);
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    // Sub-triangulate (c, a, b) on a barycentric lattice.
    const P = (u: number, v: number) => ({ x: cx + (a.x - cx) * u + (b.x - a.x) * v, z: cz + (a.z - cz) * u + (b.z - a.z) * v });
    for (let r = 0; r < subdiv; r++) {
      for (let c = 0; c <= r; c++) {
        const p0 = P(r / subdiv, c / subdiv);
        const p1 = P((r + 1) / subdiv, c / subdiv);
        const p2 = P((r + 1) / subdiv, (c + 1) / subdiv);
        push(p0.x, p0.z); push(p1.x, p1.z); push(p2.x, p2.z);
        if (c < r) {
          const p3 = P(r / subdiv, (c + 1) / subdiv);
          push(p0.x, p0.z); push(p2.x, p2.z); push(p3.x, p3.z);
        }
      }
    }
  }
  return new Float32Array(out);
}

/** Draped ribbon along a closed or open polyline. */
export function drapedRibbon(points: { x: number; z: number }[], width: number, layout: BoardLayout, lift: number, closed: boolean): { pos: Float32Array; uv: Float32Array } {
  const pos: number[] = [];
  const uv: number[] = [];
  const n = points.length;
  const segs = closed ? n : n - 1;
  let acc = 0;
  for (let i = 0; i < segs; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len * width / 2, nz = dx / len * width / 2;
    const steps = Math.max(1, Math.ceil(len / 0.12));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const x0 = a.x + dx * t0, z0 = a.z + dz * t0, x1 = a.x + dx * t1, z1 = a.z + dz * t1;
      const y0 = layout.heightAt(x0, z0) + lift, y1 = layout.heightAt(x1, z1) + lift;
      const u0 = acc + len * t0, u1 = acc + len * t1;
      pos.push(x0 - nx, y0, z0 - nz, x0 + nx, y0, z0 + nz, x1 + nx, y1, z1 + nz);
      pos.push(x0 - nx, y0, z0 - nz, x1 + nx, y1, z1 + nz, x1 - nx, y1, z1 - nz);
      uv.push(u0, 0, u0, 1, u1, 1, u0, 0, u1, 1, u1, 0);
    }
    acc += len;
  }
  return { pos: new Float32Array(pos), uv: new Float32Array(uv) };
}

// ── Shockwave ring shader ──
const RING_VERT = /* glsl */ `
varying vec2 vLocal;
uniform vec3 uCenter;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vLocal = wp.xz - uCenter.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const RING_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uProgress;
uniform float uRadius;
varying vec2 vLocal;
void main() {
  float r = length(vLocal) / uRadius;
  float front = uProgress;
  float w = 0.06 + 0.12 * uProgress;
  float ring = 1.0 - smoothstep(0.0, w, abs(r - front));
  float inner = (1.0 - smoothstep(0.0, front, r)) * 0.25 * (1.0 - uProgress);
  float a = (ring + inner) * (1.0 - uProgress);
  gl_FragColor = vec4(uColor * a * 1.6, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ── Light pillar shader ──
const PILLAR_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PILLAR_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
void main() {
  float fade = pow(1.0 - vUv.y, 1.6);
  float streak = 0.65 + 0.35 * sin(vUv.x * 40.0 + uTime * 3.0 - vUv.y * 8.0);
  float a = fade * streak * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.4, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Timed { update(now: number): boolean; dispose(): void }

interface Shard {
  pos: Vector3; vel: Vector3; rot: Vector3; spin: Vector3;
  life: number; age: number; size: number; color: Color;
}

/**
 * Resolve / play effects drawn into the 3D scene. Implements the BoardFx
 * contract the resolve (TileResolver) drives, plus a few helpers the board uses itself
 * (ownership capture bursts, structure appear dust).
 */
export class FxLayer implements BoardFx {
  readonly group = new Group();
  private timed: Timed[] = [];
  private shardMesh: InstancedMesh;
  private shards: Shard[] = [];
  private lights: { light: PointLight; until: number; start: number; peak: number }[] = [];
  private speed = 1;
  private now = 0;
  private dummy = new Object3D();

  constructor(
    private layout: BoardLayout,
    private sparkPool: ParticlePool,
    private dustPool: ParticlePool,
    private hooks: { shake: (s: number, ms: number) => void; jolt: (q: number, r: number, s: number) => void },
  ) {
    const shardGeo = new TetrahedronGeometry(1, 0);
    const shardMat = new MeshStandardMaterial({ flatShading: true, roughness: 0.85 });
    this.shardMesh = new InstancedMesh(shardGeo, shardMat, 160);
    this.shardMesh.count = 0;
    this.shardMesh.castShadow = true;
    this.shardMesh.frustumCulled = false;
    this.group.add(this.shardMesh);
    for (let i = 0; i < 2; i++) {
      const light = new PointLight(0xffffff, 0, 3.5, 1.6);
      light.position.set(0, -50, 0);
      this.group.add(light);
      this.lights.push({ light, until: 0, start: 0, peak: 0 });
    }
  }

  setLayout(layout: BoardLayout): void {
    this.layout = layout;
  }

  setSpeed(mult: number): void {
    this.speed = mult;
  }

  private ground(x: number, z: number): number {
    return this.layout.heightAt(x, z);
  }

  // ── BoardFx ────────────────────────────────────────────────────────────

  createFortifyRing(q: number, r: number): FxFortifyRing {
    const c = axialToWorld(q, r);
    const s = new Soup(q * 31 + r);
    s.jitter = 0.05;
    const stone = lin(0xc9ccd2);
    const trim = lin(0x9aa0aa);
    const y = this.ground(c.x, c.z);
    s.setAnchor(c.x, y, c.z);
    const R = 1.0;
    const blocks: { x: number; z: number }[] = [];
    for (let k = 0; k < 6; k++) {
      const a = hexCorner(c.x, c.z, k, R), b = hexCorner(c.x, c.z, k + 1, R);
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const ry = -Math.atan2(b.z - a.z, b.x - a.x);
      s.place((a.x + b.x) / 2, y - 0.02, (a.z + b.z) / 2, ry, 1);
      s.box(len * 1.02, 0.16, 0.07, stone, trim);
      for (let i = 0; i < 5; i++) {
        const sv = s.push(-len / 2 + (i + 0.5) * len / 5, 0.16, 0, 0, 1);
        s.box(len / 5 * 0.55, 0.05, 0.075, trim);
        s.pop(sv);
      }
      for (let i = 0; i < 4; i++) blocks.push({ x: a.x + (b.x - a.x) * (i + 0.5) / 4, z: a.z + (b.z - a.z) * (i + 0.5) / 4 });
      s.place(a.x, y - 0.02, a.z, 0, 1);
      s.cylinder(0.075, 0.07, 0.26, 7, stone, { top: trim });
    }
    const geo = s.toGeometry();
    const mat = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8, transparent: true, emissive: new Color(0xffffff), emissiveIntensity: 0 });
    const mesh = new Mesh(geo, mat);
    mesh.castShadow = true;
    // Grow from the ground: pivot at ground level.
    mesh.position.set(0, 0, 0);
    this.group.add(mesh);
    let flashT = 0;
    let gone = false;
    const self = this;
    const ticker: Timed = {
      update(now) {
        if (gone) return false;
        if (flashT > 0) {
          const k = Math.max(0, 1 - (now - flashT) / 0.35);
          mat.emissiveIntensity = k * 0.9;
          if (k <= 0) flashT = 0;
        }
        return true;
      },
      dispose() { /* handled by destroy */ },
    };
    this.timed.push(ticker);
    mesh.scale.set(1, 0.001, 1);
    mesh.position.y = 0;
    return {
      setProgress: (t) => {
        const e = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
        // Scale around the ground plane under the ring.
        mesh.scale.set(1, Math.max(0.001, e), 1);
        mesh.position.y = y * (1 - Math.max(0.001, e));
        mat.opacity = Math.min(1, t * 1.6);
        if (t < 1 && Math.random() < 0.6) {
          const b = blocks[Math.floor(Math.random() * blocks.length)];
          this.dustPool.spawn({
            x: b.x, y: this.ground(b.x, b.z) + 0.02, z: b.z,
            vx: (b.x - c.x) * 0.15, vy: 0.06, vz: (b.z - c.z) * 0.15,
            r: 0.55, g: 0.52, b: 0.48, a: 0.4, life: 1.0, size0: 0.08, size1: 0.26, drag: 1.0,
          });
        }
      },
      flash: (strength = 1) => {
        flashT = self.now;
        mat.emissiveIntensity = 0.9 * strength;
        this.flashLight(c.x, y + 0.4, c.z, 0xffffff, 2.2 * strength, 0.25);
      },
      shatter: () => {
        if (gone) return;
        mesh.visible = false;
        const col = new Color(0xc9ccd2);
        for (const b of blocks) {
          for (let i = 0; i < 2; i++) {
            const out = new Vector3(b.x - c.x, 0, b.z - c.z).normalize();
            this.addShard(
              new Vector3(b.x, this.ground(b.x, b.z) + 0.08 + Math.random() * 0.1, b.z),
              new Vector3(out.x * (1.2 + Math.random()) + (Math.random() - 0.5) * 0.6, 1.4 + Math.random() * 1.4, out.z * (1.2 + Math.random()) + (Math.random() - 0.5) * 0.6),
              0.03 + Math.random() * 0.035, col,
            );
          }
        }
        this.dust(c.x * HEX_SIZE, c.z * HEX_SIZE, 26, 1.4);
        this.flashLight(c.x, y + 0.5, c.z, 0xffe0b0, 3.5, 0.5);
      },
      setAlpha: (a) => { mat.opacity = a; },
      destroy: () => {
        gone = true;
        this.group.remove(mesh);
        geo.dispose();
        mat.dispose();
      },
    };
  }

  sparks(x: number, y: number, color: number, count = 24, power = 1): void {
    const w = toWorld({ x, y });
    const gy = this.ground(w.x, w.z) + 0.08;
    const c = brighten(new Color(color), 0.5);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.6 + Math.random() * 1.4) * power;
      this.sparkPool.spawn({
        x: w.x, y: gy, z: w.z,
        vx: Math.cos(a) * sp, vy: (0.6 + Math.random() * 1.2) * power, vz: Math.sin(a) * sp,
        r: c.r, g: c.g, b: c.b, life: 0.4 + Math.random() * 0.45, size0: 0.06, size1: 0.01,
        gravity: 2.4, drag: 2.2, shape: 1,
      });
    }
    this.flashLight(w.x, gy + 0.25, w.z, color, 1.6 * power, 0.22);
  }

  /** A tile breaking the sea's surface as the board builds. The spray comes
   *  off its outer edges — `edges` (0–5, edge k faces angle 60°·k + 30°) are
   *  the ones still facing open water: a sheet thrown up and out, a few
   *  droplets skipping away, water pouring off for a moment after, a little
   *  mist. `density` thins it out on big boards (the particle pools are shared). */
  splash(x: number, y: number, power = 1, density = 1, edges: readonly number[] = [0, 1, 2, 3, 4, 5]): void {
    const w = toWorld({ x, y });
    const wy = WATER_Y + 0.02;
    const n = (count: number) => Math.max(1, Math.round(count * density));
    const inr = Math.sqrt(3) / 2;
    const drop = (px: number, py: number, pz: number, vx: number, vy: number, vz: number, life: number, size: number, delay = 0, gravity = 4.2) => {
      const tint = 0.85 + Math.random() * 0.15;
      this.sparkPool.spawn({
        x: px, y: py, z: pz, vx, vy, vz,
        r: 0.86 * tint, g: 0.95 * tint, b: 1.0, life, size0: size, size1: size * 0.35,
        gravity, drag: 1.1, shape: 2, delay,
      });
    };
    for (const k of edges) {
      const a = (Math.PI / 3) * k + Math.PI / 6;
      const nx = Math.cos(a), nz = Math.sin(a);
      // A point along the edge (u in −0.5..0.5 of its length), just outside it.
      const at = (u: number, off = 0.02) => ({ x: w.x + nx * (inr + off) - nz * u, z: w.z + nz * (inr + off) + nx * u });
      // The sheet of spray: up and out along the whole edge.
      for (let i = 0; i < n(10); i++) {
        const p = at(Math.random() - 0.5);
        const out = (0.35 + Math.random() * 0.6) * power;
        drop(p.x, wy, p.z, nx * out, (1.0 + Math.random() * 1.3) * power, nz * out, 0.6 + Math.random() * 0.45, 0.06 + Math.random() * 0.035);
      }
      // Droplets skipping away low and fast.
      for (let i = 0; i < n(4); i++) {
        const p = at(Math.random() - 0.5);
        const out = (0.8 + Math.random() * 0.5) * power;
        drop(p.x, wy, p.z, nx * out, (0.5 + Math.random() * 0.5) * power, nz * out, 0.45 + Math.random() * 0.3, 0.05, Math.random() * 0.05);
      }
      // Water pouring off the edge for a moment after.
      for (let i = 0; i < n(3); i++) {
        const p = at(Math.random() - 0.5, -0.04);
        const out = 0.25 + Math.random() * 0.3;
        drop(p.x, wy + 0.12, p.z, nx * out, 0.05 + Math.random() * 0.2, nz * out, 0.45 + Math.random() * 0.3, 0.045,
          0.08 + Math.random() * 0.4, 3.4);
      }
      // A little mist.
      if (Math.random() < 0.8 * density + 0.2) {
        const p = at(Math.random() - 0.5, 0.1);
        this.dustPool.spawn({
          x: p.x, y: wy + 0.03, z: p.z,
          vx: nx * 0.3, vy: 0.18 + Math.random() * 0.2, vz: nz * 0.3,
          r: 0.86, g: 0.92, b: 0.98, a: 0.28,
          life: 0.9 + Math.random() * 0.5, size0: 0.12, size1: 0.4 * power, drag: 1.4, wind: 0.05,
        });
      }
    }
  }

  dust(x: number, y: number, count = 16, power = 1): void {
    const w = toWorld({ x, y });
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.5;
      const px = w.x + Math.cos(a) * rr, pz = w.z + Math.sin(a) * rr;
      const shade = 0.36 + Math.random() * 0.14;
      this.dustPool.spawn({
        x: px, y: this.ground(px, pz) + 0.03, z: pz,
        vx: Math.cos(a) * 0.35 * power, vy: 0.12 + Math.random() * 0.2 * power, vz: Math.sin(a) * 0.35 * power,
        r: shade * 1.1, g: shade, b: shade * 0.85, a: 0.45,
        life: 1.1 + Math.random() * 0.6, size0: 0.08, size1: 0.32 * power, drag: 1.6, wind: 0.1,
      });
    }
  }

  shockwave(x: number, y: number, color: number, radius = 1.2, durationMs = 650): void {
    const w = toWorld({ x, y });
    const R = radius;
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      pts.push({ x: w.x + Math.cos(a) * R, z: w.z + Math.sin(a) * R });
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(drapedPolygon(pts, this.layout, 0.05, 4), 3));
    const mat = new ShaderMaterial({
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      uniforms: {
        uColor: { value: brighten(new Color(color), 0.25) },
        uProgress: { value: 0 },
        uRadius: { value: R },
        uCenter: { value: new Vector3(w.x, 0, w.z) },
      },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending, premultipliedAlpha: true,
    });
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = 8;
    this.group.add(mesh);
    const start = this.now;
    const dur = Math.max(0.05, (durationMs / 1000) * Math.max(0.35, this.speed));
    this.timed.push({
      update: (now) => {
        const t = (now - start) / dur;
        mat.uniforms.uProgress.value = Math.min(1, 1 - Math.pow(1 - Math.max(0, t), 2.2));
        return t < 1;
      },
      dispose: () => { this.group.remove(mesh); geo.dispose(); mat.dispose(); },
    });
  }

  pillar(x: number, y: number, color: number, durationMs = 1100): void {
    const w = toWorld({ x, y });
    const gy = this.ground(w.x, w.z);
    const geo = new CylinderGeometry(0.42, 0.55, 2.6, 24, 1, true);
    geo.translate(0, 1.3, 0);
    const mat = new ShaderMaterial({
      vertexShader: PILLAR_VERT,
      fragmentShader: PILLAR_FRAG,
      uniforms: { uColor: { value: brighten(new Color(color), 0.3) }, uAlpha: { value: 0 }, uTime: { value: 0 } },
      transparent: true, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true, side: DoubleSide,
    });
    const mesh = new Mesh(geo, mat);
    mesh.position.set(w.x, gy, w.z);
    mesh.renderOrder = 9;
    this.group.add(mesh);
    const start = this.now;
    const dur = Math.max(0.1, (durationMs / 1000) * Math.max(0.35, this.speed));
    const c = brighten(new Color(color), 0.4);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * 0.45;
      this.sparkPool.spawn({
        x: w.x + Math.cos(a) * rr, y: gy + 0.05, z: w.z + Math.sin(a) * rr,
        vx: 0, vy: 0.5 + Math.random() * 0.9, vz: 0,
        r: c.r, g: c.g, b: c.b, life: 0.9 + Math.random() * 0.6, size0: 0.045, size1: 0.01, drag: 0.6,
        shape: 1, delay: Math.random() * dur * 0.5,
      });
    }
    this.flashLight(w.x, gy + 0.6, w.z, color, 2.6, dur * 0.8);
    this.timed.push({
      update: (now) => {
        const t = (now - start) / dur;
        mat.uniforms.uTime.value = now;
        mat.uniforms.uAlpha.value = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
        mesh.scale.set(1 - t * 0.35, 1, 1 - t * 0.35);
        return t < 1;
      },
      dispose: () => { this.group.remove(mesh); geo.dispose(); mat.dispose(); },
    });
  }

  shake(strength: number, durationMs = 300): void {
    if (this.speed <= 0) return;
    this.hooks.shake(strength * 0.05, durationMs);
  }

  jolt(q: number, r: number, strength = 1): void {
    this.hooks.jolt(q, r, strength);
  }

  // ── Board-internal helpers ─────────────────────────────────────────────

  /** Brief point-light flash (pooled; lights never get added/removed). */
  flashLight(x: number, y: number, z: number, color: number, intensity: number, seconds: number): void {
    const slot = this.lights.reduce((a, b) => (a.until < b.until ? a : b));
    slot.light.position.set(x, y, z);
    slot.light.color.set(color);
    slot.start = this.now;
    slot.until = this.now + Math.max(0.05, seconds);
    slot.peak = intensity;
  }

  addShard(pos: Vector3, vel: Vector3, size: number, color: Color): void {
    if (this.shards.length >= 160) this.shards.shift();
    this.shards.push({
      pos, vel, size, color,
      rot: new Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      spin: new Vector3((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14),
      life: 1.6 + Math.random() * 0.6, age: 0,
    });
  }

  /** Captured-tile burst: ring + motes + puff in the new owner's color. */
  captureBurst(q: number, r: number, color: number, big = false): void {
    const c = axialToWorld(q, r);
    const lx = c.x * HEX_SIZE, ly = c.z * HEX_SIZE;
    this.shockwave(lx, ly, color, big ? 1.6 : 1.05, big ? 900 : 620);
    this.dust(lx, ly, big ? 18 : 8, big ? 1.2 : 0.7);
    const col = brighten(new Color(color), 0.45);
    const gy = this.ground(c.x, c.z);
    for (let i = 0; i < (big ? 36 : 16); i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * 0.7;
      this.sparkPool.spawn({
        x: c.x + Math.cos(a) * rr, y: gy + 0.05, z: c.z + Math.sin(a) * rr,
        vx: Math.cos(a) * 0.1, vy: 0.35 + Math.random() * 0.6, vz: Math.sin(a) * 0.1,
        r: col.r, g: col.g, b: col.b, life: 0.7 + Math.random() * 0.5, size0: 0.04, size1: 0.008, drag: 0.8, shape: 1,
      });
    }
  }

  update(dt: number, now: number): boolean {
    this.now = now;
    let busy = false;
    this.timed = this.timed.filter(t => {
      const alive = t.update(now);
      if (!alive) t.dispose();
      busy = busy || alive;
      return alive;
    });
    for (const l of this.lights) {
      if (now < l.until) {
        const t = (now - l.start) / Math.max(0.001, l.until - l.start);
        l.light.intensity = l.peak * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
        busy = true;
      } else if (l.light.intensity !== 0) {
        l.light.intensity = 0;
        l.light.position.y = -50;
      }
    }
    if (this.shards.length) {
      busy = true;
      const g = 5.5;
      let n = 0;
      for (const s of this.shards) {
        s.age += dt;
        s.vel.y -= g * dt;
        s.pos.addScaledVector(s.vel, dt);
        const floor = this.ground(s.pos.x, s.pos.z) + s.size * 0.6;
        if (s.pos.y < floor) {
          s.pos.y = floor;
          s.vel.y *= -0.32;
          s.vel.x *= 0.6; s.vel.z *= 0.6;
          s.spin.multiplyScalar(0.6);
        }
        s.rot.addScaledVector(s.spin, dt);
        const k = s.age > s.life - 0.4 ? Math.max(0, (s.life - s.age) / 0.4) : 1;
        this.dummy.position.copy(s.pos);
        this.dummy.rotation.set(s.rot.x, s.rot.y, s.rot.z);
        this.dummy.scale.setScalar(Math.max(0.0001, s.size * k));
        this.dummy.updateMatrix();
        this.shardMesh.setMatrixAt(n, this.dummy.matrix);
        this.shardMesh.setColorAt(n, s.color);
        n++;
      }
      this.shards = this.shards.filter(s => s.age < s.life);
      this.shardMesh.count = n;
      this.shardMesh.instanceMatrix.needsUpdate = true;
      if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
    } else if (this.shardMesh.count) {
      this.shardMesh.count = 0;
    }
    return busy;
  }

  dispose(): void {
    for (const t of this.timed) t.dispose();
    this.timed = [];
    this.shardMesh.geometry.dispose();
    (this.shardMesh.material as MeshStandardMaterial).dispose();
    this.shardMesh.dispose();
  }
}
