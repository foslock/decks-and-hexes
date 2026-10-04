import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh,
  type MeshDepthMaterial, type MeshStandardMaterial, ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { SQRT3 } from '../utils/hexGeometry';
import type { ClaimChevron } from './boardTypes';
import type { BoardLayout } from './layout';
import { axialToWorld, hexCorner } from './layout';
import type { FxLayer } from './fx';
import { drapedPolygon } from './fx';
import type { ParticlePool } from './particles';
import { Soup, lin, mix } from './soup';

export type TokenKind = 'claim' | 'defense' | 'target' | 'abandon' | 'consecrate';

export interface TokenSpec {
  key: string;
  q: number;
  r: number;
  kind: TokenKind;
  color: number;
}

/** Height above the ground that a token's label should float at. */
export const TOKEN_LABEL_LIFT: Record<TokenKind, number> = {
  claim: 1.05,
  defense: 0.82,
  target: 0.2,
  abandon: 0.48,
  consecrate: 0.4,
};

const GLSL_OUT = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

const DECAL_VERT = /* glsl */ `
varying vec2 vLocal;
uniform vec3 uCenter;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vLocal = wp.xz - uCenter.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

/** Ground ring under a planned claim (pulsing, rotating ticks). */
const CLAIM_RING_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  float ring = 1.0 - smoothstep(0.0, 0.035, abs(r - 0.56));
  float ticks = step(0.5, fract(ang * 6.0 / 6.2831 * 4.0 + uTime * 0.25)) * (1.0 - smoothstep(0.0, 0.03, abs(r - 0.66)));
  float glow = (1.0 - smoothstep(0.0, 0.62, r)) * 0.22;
  float pulse = 0.75 + 0.25 * sin(uTime * 3.0);
  float a = (ring * pulse + ticks * 0.8 + glow) * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.5, 0.0);
  ${GLSL_OUT}
}`;

/** Red rotating crosshair under an opponent-targeting card. */
const TARGET_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x) + uTime * 0.8;
  float ring1 = 1.0 - smoothstep(0.0, 0.03, abs(r - 0.6));
  float ring2 = (1.0 - smoothstep(0.0, 0.02, abs(r - 0.36))) * step(0.35, fract(ang / 6.2831 * 3.0));
  float cross = (1.0 - smoothstep(0.0, 0.025, min(abs(vLocal.x), abs(vLocal.y)))) * step(0.12, r) * step(r, 0.72);
  float pulse = 0.7 + 0.3 * sin(uTime * 4.0);
  float a = (ring1 + ring2 * 0.9 + cross * 0.7) * pulse * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.6, 0.0);
  ${GLSL_OUT}
}`;

const CHEVRON_VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv2;
void main() { vUv2 = aUv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const CHEVRON_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
varying vec2 vUv2;
void main() {
  float x = abs(vUv2.x);       // 0 at the centerline → 1 at the sides
  float y = vUv2.y;            // 0 outside the target → 1 deep inside
  float v = y + x * 0.6;
  float stripes = fract(v * 2.4 - uTime * 1.4);
  float band = smoothstep(0.0, 0.1, stripes) * (1.0 - smoothstep(0.32, 0.46, stripes));
  float shape = 1.0 - smoothstep(0.82, 1.0, x + (1.0 - y) * 0.15);
  float fade = smoothstep(0.0, 0.3, y) * (1.0 - smoothstep(0.75, 1.0, y));
  float a = (band * 0.9 + 0.18) * shape * fade * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.7, 0.0);
  ${GLSL_OUT}
}`;

const BARRIER_VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv2;
void main() { vUv2 = aUv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BARRIER_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
varying vec2 vUv2;
void main() {
  float h = vUv2.y;
  float base = 1.0 - smoothstep(0.0, 1.0, h);
  float scan = 0.6 + 0.4 * sin(h * 26.0 - uTime * 4.0 + vUv2.x * 3.0);
  float topEdge = (1.0 - smoothstep(0.0, 0.08, abs(h - 0.96))) * 0.9;
  float shimmer = 0.75 + 0.25 * sin(vUv2.x * 9.0 + uTime * 2.3);
  float a = (base * scan * 0.55 + topEdge) * shimmer * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.6, 0.0);
  ${GLSL_OUT}
}`;

const DOME_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  vP = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  float fres = pow(1.0 - abs(dot(vN, vV)), 2.2);
  vec2 p = vP.xz * 9.0 + vec2(0.0, vP.y * 9.0);
  vec2 hexg = abs(fract(p * vec2(1.0, 0.577)) - 0.5);
  float cells = smoothstep(0.42, 0.5, max(hexg.x, hexg.y));
  float sweep = 0.5 + 0.5 * sin(vP.y * 14.0 - uTime * 2.5);
  float a = (fres * 0.85 + cells * 0.18 * sweep + 0.04) * uAlpha;
  gl_FragColor = vec4(uColor * a * 1.5, 0.0);
  ${GLSL_OUT}
}`;

interface Token {
  spec: TokenSpec;
  group: Group;
  born: number;
  removing: number;
  landed: boolean;
  ringMat?: ShaderMaterial;
  disposers: (() => void)[];
  bob?: Group;
}

interface Barrier { group: Group; mat: ShaderMaterial; alpha: number; target: number; sig: string; dispose: () => void }

export class MarkerLayer {
  readonly group = new Group();
  private tokens = new Map<string, Token>();
  private chevronGroup = new Group();
  private chevronSig = '';
  private chevronMats: { mat: ShaderMaterial; alpha: number }[] = [];
  private barriers = new Map<string, Barrier>();
  private emberAcc = 0;
  private now = 0;
  private animate = true;

  constructor(
    private layout: BoardLayout,
    private propMat: { material: MeshStandardMaterial; depth: MeshDepthMaterial },
    private fx: FxLayer,
    private spark: ParticlePool,
    private smoke: ParticlePool,
  ) {
    this.group.add(this.chevronGroup);
  }

  setLayout(layout: BoardLayout): void {
    this.layout = layout;
    // Draped geometry depends on terrain heights: rebuild on next sync.
    this.chevronSig = '';
    for (const key of [...this.tokens.keys()]) this.dropToken(key, true);
    for (const key of [...this.barriers.keys()]) this.dropBarrier(key);
  }

  setAnimate(on: boolean): void {
    this.animate = on;
  }

  /** Raise ground decals (claim chevrons) off the terrain in tilted views. */
  setLift(f: number): void {
    this.chevronGroup.position.y = f * 0.3;
  }

  private ground(x: number, z: number): number {
    return this.layout.heightAt(x, z);
  }

  // ── Planned-action tokens ──────────────────────────────────────────────

  setTokens(specs: TokenSpec[]): void {
    const next = new Map(specs.map(s => [s.key, s]));
    for (const [key, tok] of this.tokens) {
      const spec = next.get(key);
      if (!spec || spec.kind !== tok.spec.kind || spec.color !== tok.spec.color) {
        if (!tok.removing) tok.removing = this.now;
        if (spec) {
          // Replace immediately with the new kind.
          this.dropToken(key, true);
        }
      }
    }
    for (const spec of specs) {
      const existing = this.tokens.get(spec.key);
      if (existing && !existing.removing) continue;
      if (existing) this.dropToken(spec.key, true);
      this.tokens.set(spec.key, this.makeToken(spec));
    }
  }

  private dropToken(key: string, immediate: boolean): void {
    const tok = this.tokens.get(key);
    if (!tok) return;
    if (!immediate) { tok.removing = this.now; return; }
    this.group.remove(tok.group);
    for (const d of tok.disposers) d();
    this.tokens.delete(key);
  }

  private decal(cx: number, cz: number, radius: number, frag: string, color: number): { mesh: Mesh; mat: ShaderMaterial; dispose: () => void } {
    const pts: { x: number; z: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius });
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(drapedPolygon(pts, this.layout, 0.04, 3), 3));
    const mat = new ShaderMaterial({
      vertexShader: DECAL_VERT,
      fragmentShader: frag,
      uniforms: {
        uColor: { value: new Color(color) }, uTime: { value: 0 }, uAlpha: { value: 0 },
        uCenter: { value: new Vector3(cx, 0, cz) },
      },
      transparent: true, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true,
    });
    const mesh = new Mesh(geo, mat);
    mesh.renderOrder = 7;
    return { mesh, mat, dispose: () => { geo.dispose(); mat.dispose(); } };
  }

  private makeToken(spec: TokenSpec): Token {
    const { x, z } = axialToWorld(spec.q, spec.r);
    const y = this.ground(x, z);
    const group = new Group();
    const tok: Token = { spec, group, born: this.now, removing: 0, landed: false, disposers: [] };
    const owner = lin(spec.color);
    const s = new Soup(spec.q * 97 + spec.r);
    s.jitter = 0.04;
    s.setAnchor(0, 0, 0, 0);
    s.place(0, 0, 0, 0, spec.kind === 'claim' ? 1.45 : spec.kind === 'defense' ? 1.5 : 1.3);
    const gold = lin(0xe0b450);
    if (spec.kind === 'claim') {
      // War standard: pole, crossbar and a big waving flag.
      s.cylinder(0.014, 0.011, 0.66, 5, lin(0x3d2a1a), { top: null });
      const cb = s.push(0, 0.6, 0, 0, 1);
      s.box(0.012, 0.012, 0.012, gold);
      s.pop(cb);
      const fin = s.push(0, 0.66, 0, 0, 1);
      s.glow = [0.6, 0.4, 0.1];
      s.cone(0.024, 0.06, 5, gold);
      s.glow = [0, 0, 0];
      s.pop(fin);
      s.windScale = 2.2;
      s.windAlongX = true;
      const fl = s.push(0.012, 0.62, 0, 0, 1);
      s.pennant(0.24, 0.17, owner);
      const trim = s.push(0, 0.002, 0.0005, 0, 1);
      s.pennant(0.24, 0.025, mix(owner, gold, 0.6));
      s.pop(trim);
      s.pop(fl);
      s.windAlongX = false;
      s.windScale = 0;
      const ring = this.decal(x, z, 0.72, CLAIM_RING_FRAG, spec.color);
      this.group.add(ring.mesh);
      tok.ringMat = ring.mat;
      tok.disposers.push(() => { this.group.remove(ring.mesh); ring.dispose(); });
    } else if (spec.kind === 'defense') {
      // Floating kite shield with a silver rim.
      const blue = lin(0x3a7abf);
      const silver = lin(0xd8dde6);
      const pts: [number, number][] = [[-0.13, 0.1], [0.13, 0.1], [0.13, -0.02], [0, -0.17], [-0.13, -0.02]];
      const depth = 0.025;
      for (let i = 1; i < pts.length - 1; i++) {
        for (const zz of [depth, -depth]) {
          s.tri([pts[0][0], pts[0][1], zz], [pts[i][0], pts[i][1], zz], [pts[i + 1][0], pts[i + 1][1], zz], zz > 0 ? blue : mix(blue, silver, 0.3));
        }
      }
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        s.quad([a[0], a[1], depth], [b[0], b[1], depth], [b[0], b[1], -depth], [a[0], a[1], -depth], silver);
      }
      // Boss + cross
      const boss = s.push(0, 0.0, depth, 0, 1, 1, Math.PI / 2, 0);
      s.glow = [0.25, 0.45, 0.8];
      s.cylinder(0.035, 0.03, 0.012, 7, silver);
      s.glow = [0, 0, 0];
      s.pop(boss);
    } else if (spec.kind === 'target') {
      const ring = this.decal(x, z, 0.75, TARGET_FRAG, 0xff4a4a);
      this.group.add(ring.mesh);
      tok.ringMat = ring.mat;
      tok.disposers.push(() => { this.group.remove(ring.mesh); ring.dispose(); });
    } else if (spec.kind === 'abandon') {
      s.cylinder(0.016, 0.013, 0.28, 5, lin(0x3d2a1a), { top: null });
      const head = s.push(0, 0.28, 0, 0, 1);
      s.glow = [2.2, 0.9, 0.25];
      s.blob(0.03, lin(0xff8a2a), { noise: 0.25 });
      s.glow = [0, 0, 0];
      s.pop(head);
    } else if (spec.kind === 'consecrate') {
      const ring = this.decal(x, z, 0.7, CLAIM_RING_FRAG, 0xffd24a);
      this.group.add(ring.mesh);
      tok.ringMat = ring.mat;
      tok.disposers.push(() => { this.group.remove(ring.mesh); ring.dispose(); });
    }
    if (s.vertexCount > 0) {
      const geo = s.toGeometry();
      const mesh = new Mesh(geo, this.propMat.material);
      mesh.customDepthMaterial = this.propMat.depth;
      mesh.castShadow = true;
      const bob = new Group();
      bob.add(mesh);
      group.add(bob);
      tok.bob = bob;
      tok.disposers.push(() => geo.dispose());
    }
    group.position.set(x, y, z);
    this.group.add(group);
    if (!this.animate) tok.born = -100;
    return tok;
  }

  // ── Chevrons ───────────────────────────────────────────────────────────

  setChevrons(chevrons: ClaimChevron[] | undefined): void {
    const list = chevrons ?? [];
    const sig = list.map(c => `${c.targetQ},${c.targetR},${c.sourceQ},${c.sourceR},${c.color}`).join('|');
    if (sig !== this.chevronSig) {
      this.chevronSig = sig;
      for (const child of [...this.chevronGroup.children]) {
        const m = child as Mesh;
        m.geometry.dispose();
        (m.material as ShaderMaterial).dispose();
        this.chevronGroup.remove(m);
      }
      this.chevronMats = [];
      for (const c of list) {
        const t = axialToWorld(c.targetQ, c.targetR);
        const sPos = axialToWorld(c.sourceQ, c.sourceR);
        // Pick the target edge facing the source.
        const ang = Math.atan2(sPos.z - t.z, sPos.x - t.x);
        let best = 0, bestD = Infinity;
        for (let k = 0; k < 6; k++) {
          const na = Math.PI / 6 + (Math.PI / 3) * k;
          let d = Math.abs(ang - na) % (Math.PI * 2);
          if (d > Math.PI) d = Math.PI * 2 - d;
          if (d < bestD) { bestD = d; best = k; }
        }
        const na = Math.PI / 6 + (Math.PI / 3) * best;
        const inr = SQRT3 / 2;
        const mx = t.x + Math.cos(na) * inr, mz = t.z + Math.sin(na) * inr;
        const ix = -Math.cos(na), iz = -Math.sin(na); // inward
        const tx = -iz, tz = ix;                       // along edge
        const pos: number[] = [];
        const uv: number[] = [];
        const nu = 6, nv = 6;
        const back = 0.3, fwd = 0.42, half = 0.36;
        const P = (u: number, v: number) => {
          const along = -back + (back + fwd) * v;
          const across = (u * 2 - 1) * half;
          const px = mx + ix * along + tx * across;
          const pz = mz + iz * along + tz * across;
          return [px, this.ground(px, pz) + 0.05, pz];
        };
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
          const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
          const quad = [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]];
          for (const [u, v] of quad) {
            pos.push(...P(u, v));
            uv.push(u * 2 - 1, v);
          }
        }
        const geo = new BufferGeometry();
        geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
        geo.setAttribute('aUv', new BufferAttribute(new Float32Array(uv), 2));
        const mat = new ShaderMaterial({
          vertexShader: CHEVRON_VERT, fragmentShader: CHEVRON_FRAG,
          uniforms: { uColor: { value: new Color(c.color).lerp(new Color(1, 1, 1), 0.2) }, uTime: { value: 0 }, uAlpha: { value: c.alpha } },
          transparent: true, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true, side: DoubleSide,
        });
        const mesh = new Mesh(geo, mat);
        mesh.renderOrder = 7;
        this.chevronGroup.add(mesh);
        this.chevronMats.push({ mat, alpha: c.alpha });
      }
    } else {
      list.forEach((c, i) => { if (this.chevronMats[i]) this.chevronMats[i].alpha = c.alpha; });
    }
  }

  // ── Temporary defense barriers + immunity domes ────────────────────────

  setBarriers(entries: { key: string; q: number; r: number; temp: number; immune: boolean }[]): void {
    const want = new Map(entries.map(e => [e.key, e]));
    for (const [key, b] of this.barriers) {
      const e = want.get(key);
      const sig = e ? `${e.immune ? 'i' : 't'}${Math.min(4, e.temp)}` : '';
      if (!e || sig !== b.sig) b.target = 0;
    }
    for (const e of entries) {
      const sig = `${e.immune ? 'i' : 't'}${Math.min(4, e.temp)}`;
      const existing = this.barriers.get(e.key);
      if (existing && existing.sig === sig) { existing.target = 1; continue; }
      if (existing) this.dropBarrier(e.key);
      this.barriers.set(e.key, this.makeBarrier(e.q, e.r, e.temp, e.immune, sig));
    }
  }

  private dropBarrier(key: string): void {
    const b = this.barriers.get(key);
    if (!b) return;
    this.group.remove(b.group);
    b.dispose();
    this.barriers.delete(key);
  }

  private makeBarrier(q: number, r: number, temp: number, immune: boolean, sig: string): Barrier {
    const { x, z } = axialToWorld(q, r);
    const group = new Group();
    const color = new Color(0x66ccff);
    let mat: ShaderMaterial;
    let geo: BufferGeometry;
    if (immune) {
      geo = new SphereGeometry(0.92, 32, 12, 0, Math.PI * 2, 0, Math.PI / 2);
      geo.scale(1, 0.62, 1);
      mat = new ShaderMaterial({
        vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
        uniforms: { uColor: { value: color }, uTime: { value: 0 }, uAlpha: { value: 0 } },
        transparent: true, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true, side: DoubleSide,
      });
      const mesh = new Mesh(geo, mat);
      mesh.position.set(x, this.ground(x, z), z);
      mesh.renderOrder = 12;
      group.add(mesh);
    } else {
      const height = 0.16 + Math.min(4, temp) * 0.05;
      const pos: number[] = [];
      const uv: number[] = [];
      const R = 0.93;
      for (let k = 0; k < 6; k++) {
        const a = hexCorner(x, z, k, R), b = hexCorner(x, z, k + 1, R);
        const steps = 5;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const x0 = a.x + (b.x - a.x) * t0, z0 = a.z + (b.z - a.z) * t0;
          const x1 = a.x + (b.x - a.x) * t1, z1 = a.z + (b.z - a.z) * t1;
          const y0 = this.ground(x0, z0), y1 = this.ground(x1, z1);
          const u0 = k + t0, u1 = k + t1;
          pos.push(x0, y0, z0, x1, y1, z1, x1, y1 + height, z1, x0, y0, z0, x1, y1 + height, z1, x0, y0 + height, z0);
          uv.push(u0, 0, u1, 0, u1, 1, u0, 0, u1, 1, u0, 1);
        }
      }
      geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
      geo.setAttribute('aUv', new BufferAttribute(new Float32Array(uv), 2));
      mat = new ShaderMaterial({
        vertexShader: BARRIER_VERT, fragmentShader: BARRIER_FRAG,
        uniforms: { uColor: { value: color }, uTime: { value: 0 }, uAlpha: { value: 0 } },
        transparent: true, depthWrite: false, blending: AdditiveBlending, premultipliedAlpha: true, side: DoubleSide,
      });
      const mesh = new Mesh(geo, mat);
      mesh.renderOrder = 12;
      group.add(mesh);
    }
    this.group.add(group);
    if (this.animate) this.fx.captureBurst(q, r, 0x66ccff, false);
    return {
      group, mat, alpha: this.animate ? 0 : 1, target: 1, sig,
      dispose: () => { geo.dispose(); mat.dispose(); },
    };
  }

  // ── Per-frame ──────────────────────────────────────────────────────────

  update(dt: number, now: number): boolean {
    this.now = now;
    const busy = this.tokens.size > 0 || this.barriers.size > 0 || this.chevronMats.length > 0;
    for (const [key, tok] of this.tokens) {
      const age = now - tok.born;
      const { x, z } = axialToWorld(tok.spec.q, tok.spec.r);
      const y = this.ground(x, z);
      let appear = Math.min(1, age / 0.45);
      if (tok.removing) {
        const out = (now - tok.removing) / 0.3;
        if (out >= 1) { this.dropToken(key, true); continue; }
        appear = 1 - out;
        if (tok.bob) {
          tok.bob.position.y += dt * 1.6;
          tok.bob.scale.setScalar(Math.max(0.001, 1 - out));
        }
      } else if (tok.bob) {
        if (tok.spec.kind === 'claim') {
          // Drop in from above, accelerating, then plant with a thud.
          const t = Math.min(1, age / 0.42);
          tok.bob.position.y = (1 - t * t) * 1.5;
          const squash = t >= 1 ? 1 + Math.sin(Math.min(1, (age - 0.42) / 0.25) * Math.PI) * -0.12 : 1;
          tok.bob.scale.set(1, squash, 1);
          if (t >= 1 && !tok.landed) {
            tok.landed = true;
            if (age < 1.2 && this.animate) {
              const lx = x * 32, lz = z * 32;
              this.fx.dust(lx, lz, 12, 0.8);
              this.fx.shockwave(lx, lz, tok.spec.color, 0.9, 520);
              this.fx.sparks(lx, lz, tok.spec.color, 14, 0.6);
              this.fx.shake(0.25, 220);
            }
          }
        } else if (tok.spec.kind === 'defense') {
          const t = Math.min(1, age / 0.5);
          const e = 1 - Math.pow(1 - t, 3);
          tok.bob.position.y = 0.42 + Math.sin(now * 2.2 + x) * 0.03 + (1 - e) * 0.3;
          tok.bob.rotation.y = now * 0.8;
          tok.bob.scale.setScalar(Math.max(0.001, e));
          if (t >= 1 && !tok.landed) {
            tok.landed = true;
            if (age < 1.2 && this.animate) this.fx.shockwave(x * 32, z * 32, 0x66ccff, 0.85, 500);
          }
        } else {
          tok.bob.scale.setScalar(Math.max(0.001, Math.min(1, age / 0.3)));
        }
      }
      if (tok.ringMat) {
        tok.ringMat.uniforms.uTime.value = now;
        tok.ringMat.uniforms.uAlpha.value = appear * (tok.spec.kind === 'claim' && !tok.landed ? 0.3 : 1);
      }
      if (!tok.removing && tok.spec.kind === 'abandon') {
        this.emberAcc += dt;
        if (this.emberAcc > 0.08) {
          this.emberAcc = 0;
          this.spark.spawn({ x: x + (Math.random() - 0.5) * 0.03, y: y + 0.31, z: z + (Math.random() - 0.5) * 0.03, vx: (Math.random() - 0.5) * 0.06, vy: 0.25, vz: (Math.random() - 0.5) * 0.06, r: 1, g: 0.55, b: 0.15, life: 0.8, size0: 0.04, size1: 0.01, shape: 1, drag: 0.6, wind: 0.2 });
          this.smoke.spawn({ x, y: y + 0.33, z, vy: 0.12, r: 0.3, g: 0.28, b: 0.27, a: 0.3, life: 2, size0: 0.04, size1: 0.18, drag: 0.4, wind: 0.2 });
        }
      }
      if (!tok.removing && tok.spec.kind === 'consecrate' && Math.random() < dt * 14) {
        const a = Math.random() * Math.PI * 2, rr = Math.random() * 0.5;
        this.spark.spawn({ x: x + Math.cos(a) * rr, y: y + 0.05, z: z + Math.sin(a) * rr, vy: 0.4 + Math.random() * 0.3, r: 1, g: 0.85, b: 0.4, life: 1.2, size0: 0.035, size1: 0.01, shape: 1, drag: 0.4 });
      }
    }
    for (const c of this.chevronMats) {
      c.mat.uniforms.uTime.value = now;
      c.mat.uniforms.uAlpha.value = c.alpha;
    }
    for (const [key, b] of this.barriers) {
      b.alpha += (b.target - b.alpha) * Math.min(1, dt * (this.animate ? 5 : 100));
      b.mat.uniforms.uAlpha.value = b.alpha;
      b.mat.uniforms.uTime.value = now;
      if (b.target === 0 && b.alpha < 0.01) this.dropBarrier(key);
    }
    return busy;
  }

  dispose(): void {
    for (const key of [...this.tokens.keys()]) this.dropToken(key, true);
    for (const key of [...this.barriers.keys()]) this.dropBarrier(key);
    this.setChevrons([]);
  }
}
