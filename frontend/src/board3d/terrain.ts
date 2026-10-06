import {
  BufferAttribute, BufferGeometry, CircleGeometry, DataTexture, LinearFilter,
  Mesh, RedFormat, ShaderMaterial, UnsignedByteType, Vector3,
} from 'three';
import type { HexTile } from '../types/game';
import { HEX_DIRS } from '../utils/hexGeometry';
import { BoardLayout, hexCorner } from './layout';
import { fbm2, valueNoise2 } from './noise';
import { BUILD_SURFACE, type SharedUniforms } from './materials';
import { lin, mix, type RGB } from './soup';

export const WATER_Y = -0.3;
const SLAB_BOTTOM = -0.62;

/**
 * Smooth ground: one subdivided hex patch per tile. Heights and colors come
 * from the layout's blended fields, which are pure functions of world
 * position — so shared tile edges line up exactly and the terrain reads as
 * one continuous landscape.
 */
export function buildTerrainGeometry(layout: BoardLayout): BufferGeometry {
  const sub = layout.tiles.length > 150 ? 6 : 7;
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const bld: number[] = [];
  const idx: number[] = [];
  const eps = 0.03;
  const maxRing = Math.max(1, layout.maxRing);

  for (const tile of layout.tiles) {
    const build = tile.ring / maxRing;
    for (let k = 0; k < 6; k++) {
      const a = hexCorner(tile.x, tile.z, k);
      const b = hexCorner(tile.x, tile.z, k + 1);
      // Triangular lattice over (center, a, b): P(i,j) = c + (a-c)·i/n + (b-a)·j/n
      const base = pos.length / 3;
      const rowStart: number[] = [];
      for (let i = 0; i <= sub; i++) {
        rowStart.push(pos.length / 3 - base);
        for (let j = 0; j <= i; j++) {
          const x = tile.x + (a.x - tile.x) * (i / sub) + (b.x - a.x) * (j / sub);
          const z = tile.z + (a.z - tile.z) * (i / sub) + (b.z - a.z) * (j / sub);
          const h = layout.heightAt(x, z);
          const hx = layout.heightAt(x + eps, z) - layout.heightAt(x - eps, z);
          const hz = layout.heightAt(x, z + eps) - layout.heightAt(x, z - eps);
          const n = new Vector3(-hx, 2 * eps, -hz).normalize();
          const c = layout.colorAt(x, z);
          pos.push(x, h, z);
          nrm.push(n.x, n.y, n.z);
          col.push(c[0], c[1], c[2]);
          bld.push(build);
        }
      }
      for (let i = 0; i < sub; i++) {
        for (let j = 0; j <= i; j++) {
          const v0 = base + rowStart[i] + j;
          const v1 = base + rowStart[i + 1] + j;
          const v2 = base + rowStart[i + 1] + j + 1;
          idx.push(v0, v2, v1);
          if (j < i) {
            const v3 = base + rowStart[i] + j + 1;
            idx.push(v0, v3, v2);
          }
        }
      }
    }
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aBuild', new BufferAttribute(new Float32Array(bld), 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** Re-sample the ground (height, normal, color) wherever `near(x, z)` —
 *  after a tile's biome changes (scorched), without rebuilding the island. */
export function patchTerrainGeometry(g: BufferGeometry, layout: BoardLayout, near: (x: number, z: number) => boolean): void {
  const pos = g.getAttribute('position') as BufferAttribute;
  const nrm = g.getAttribute('normal') as BufferAttribute;
  const col = g.getAttribute('color') as BufferAttribute;
  const eps = 0.03;
  const n = new Vector3();
  let touched = false;
  const arr = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const x = arr[i * 3], z = arr[i * 3 + 2];
    if (!near(x, z)) continue;
    touched = true;
    pos.setY(i, layout.heightAt(x, z));
    const hx = layout.heightAt(x + eps, z) - layout.heightAt(x - eps, z);
    const hz = layout.heightAt(x, z + eps) - layout.heightAt(x, z - eps);
    n.set(-hx, 2 * eps, -hz).normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
    const c = layout.colorAt(x, z);
    col.setXYZ(i, c[0], c[1], c[2]);
  }
  if (!touched) return;
  pos.needsUpdate = true;
  nrm.needsUpdate = true;
  col.needsUpdate = true;
  g.computeBoundingSphere();
}

const STRATA: RGB[] = [
  lin(0x4a5a2a), // turf lip
  lin(0x5a4630), // topsoil
  lin(0x6e5a44), // earth
  lin(0x585450), // rock
  lin(0x48474a), // deep rock
  lin(0x8b7e62), // sand at the waterline
];

/**
 * Island cliffs: every board-boundary edge drops to the waterline as a
 * craggy, stratified rock face — visible once the board is tilted.
 */
export function buildSlabGeometry(layout: BoardLayout, gameTiles: Record<string, HexTile>): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const bld: number[] = [];
  const maxRing = Math.max(1, layout.maxRing);
  const segs = 4;
  const rows = [0, 0.06, 0.16, 0.3, 0.46, 0.62];

  const crag = (x: number, z: number, y: number) =>
    (fbm2(x * 3.1 + y * 2.0, z * 3.1 - y * 2.0, 71, 2) - 0.5) * 0.09;

  for (const tile of layout.tiles) {
    const build = tile.ring / maxRing;
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = HEX_DIRS[k];
      if (gameTiles[`${tile.q + dq},${tile.r + dr}`]) continue;
      const a = hexCorner(tile.x, tile.z, k);
      const b = hexCorner(tile.x, tile.z, k + 1);
      const na = (Math.PI / 3) * k + Math.PI / 6;
      const nx = Math.cos(na);
      const nz = Math.sin(na);
      // grid[seg][row] → vertex
      const grid: { x: number; y: number; z: number; c: RGB }[][] = [];
      for (let s = 0; s <= segs; s++) {
        const t = s / segs;
        const ex = a.x + (b.x - a.x) * t;
        const ez = a.z + (b.z - a.z) * t;
        const top = layout.heightAt(ex, ez);
        const column: { x: number; y: number; z: number; c: RGB }[] = [];
        for (let ri = 0; ri < rows.length; ri++) {
          const f = rows[ri] / rows[rows.length - 1];
          const y = ri === 0 ? top : top + (SLAB_BOTTOM - top) * f;
          // Corners stay put so neighboring edges meet; interior bulges.
          const edgeFade = Math.sin(t * Math.PI);
          const out = ri === 0 ? 0 : crag(ex, ez, y) * (0.4 + edgeFade) + (ri === rows.length - 1 ? -0.06 : 0);
          const vary = (valueNoise2(ex * 5, y * 9, 13) - 0.5) * 0.25;
          const c = mix(STRATA[Math.min(ri, STRATA.length - 1)], STRATA[Math.min(ri + 1, STRATA.length - 1)], 0.5 + vary);
          column.push({ x: ex + nx * out, y, z: ez + nz * out, c: y < WATER_Y + 0.05 && y > WATER_Y - 0.08 ? STRATA[5] : c });
        }
        grid.push(column);
      }
      for (let s = 0; s < segs; s++) {
        for (let ri = 0; ri < rows.length - 1; ri++) {
          const p00 = grid[s][ri], p10 = grid[s + 1][ri], p01 = grid[s][ri + 1], p11 = grid[s + 1][ri + 1];
          for (const [p, q, r] of [[p00, p10, p01], [p10, p11, p01]]) {
            const c = mix(mix(p.c, q.c, 0.5), r.c, 0.33);
            for (const v of [p, q, r]) {
              pos.push(v.x, v.y, v.z);
              col.push(c[0], c[1], c[2]);
              bld.push(build);
            }
          }
        }
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aBuild', new BufferAttribute(new Float32Array(bld), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ── Water ────────────────────────────────────────────────────────────────

const WATER_VERT = /* glsl */ `
varying vec2 vXZ;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const WATER_FRAG = /* glsl */ `
uniform float uTime;
uniform float uBuild;
uniform sampler2D tDist;
uniform float uExtent;
uniform float uDistMax;
uniform float uDistMin;
uniform float uRadius;
uniform float uGlowR;
uniform float uMaxRing;
uniform float uSurfaceAt;
varying vec2 vXZ;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// The hex cell (axial q, r — the board's own) a world point lies in.
vec2 hexRound(vec2 f) {
  vec3 c = vec3(f.x, f.y, -f.x - f.y);
  vec3 rc = floor(c + 0.5);
  vec3 d = abs(rc - c);
  if (d.x > d.y && d.x > d.z) rc.x = -rc.y - rc.z;
  else if (d.y > d.z) rc.y = -rc.x - rc.z;
  return rc.xy;
}

void main() {
  vec2 uv = vXZ / (2.0 * uExtent) + 0.5;
  float d = mix(uDistMin, uDistMax, texture2D(tDist, uv).r);
  float r = length(vXZ);

  vec3 shallow = vec3(0.08, 0.22, 0.24);
  vec3 deep = vec3(0.03, 0.075, 0.13);
  float depthT = smoothstep(0.0, 2.6, max(d, 0.0));
  vec3 col = mix(shallow, deep, depthT);

  // Gentle swell shading.
  float n1 = noise(vXZ * 1.4 + vec2(uTime * 0.09, uTime * 0.05));
  float n2 = noise(vXZ * 3.3 - vec2(uTime * 0.12, -uTime * 0.07));
  col *= 0.85 + 0.3 * (n1 * 0.6 + n2 * 0.4);

  // Sun glints.
  float glint = smoothstep(0.82, 0.97, noise(vXZ * 6.0 + vec2(uTime * 0.35, -uTime * 0.2)) * n1 * 1.35);
  col += vec3(1.0, 0.82, 0.55) * glint * 0.35 * (1.0 - depthT * 0.5);

  // Shore foam: a bright lap at the cliff plus bands rolling outward.
  float lap = (1.0 - smoothstep(0.0, 0.07 + 0.03 * sin(uTime * 1.3 + vXZ.x * 2.0), d)) * smoothstep(-0.08, 0.0, d);
  float band = 0.5 + 0.5 * sin(d * 11.0 - uTime * 1.25 + noise(vXZ * 2.0) * 2.5);
  band = smoothstep(0.82, 0.98, band) * (1.0 - smoothstep(0.05, 0.75, d)) * step(0.0, d);
  band *= smoothstep(0.3, 0.6, noise(vXZ * 3.0 + uTime * 0.1));
  // Foam belongs to a coastline — it surfaces with the island.
  float foamOn = smoothstep(0.85, 1.0, uBuild);
  col = mix(col, vec3(0.78, 0.82, 0.8), clamp(lap * 0.85 + band * 0.45, 0.0, 1.0) * foamOn);

  // Land rising: whitewater churns along the hex edges where tiles have just
  // broken the surface, ripples running out from them. Each water cell foams
  // on its inner edges (those facing land) once the ring inside it surfaces,
  // then settles; the coast gets the same as the last ring comes up.
  if (uBuild > 0.0 && uBuild < 1.0) {
    const float SQ3 = 1.7320508;
    vec2 qr = hexRound(vec2(2.0 / 3.0 * vXZ.x, -1.0 / 3.0 * vXZ.x + SQ3 / 3.0 * vXZ.y));
    vec2 c = vec2(1.5 * qr.x, SQ3 * 0.5 * qr.x + SQ3 * qr.y);
    vec2 local = vXZ - c;
    float ring = (abs(qr.x) + abs(qr.y) + abs(qr.x + qr.y)) * 0.5;
    // Shoaling: the sea over a tile about to surface turns shallow and
    // starts to bubble.
    if (ring < uMaxRing + 0.5) {
      float tS = ring / uMaxRing * 0.6 + uSurfaceAt;
      float near = smoothstep(tS - 0.14, tS, uBuild) * (1.0 - step(tS + 0.03, uBuild));
      float bubbles = smoothstep(0.78, 0.97, noise(vXZ * 11.0 + vec2(uTime * 2.3, uTime * 1.7)));
      col = mix(col, vec3(0.2, 0.42, 0.4), near * 0.6);
      col = mix(col, vec3(0.86, 0.92, 0.94), bubbles * near * 0.75);
    }
    float age = uBuild - ((ring - 1.0) / uMaxRing * 0.6 + uSurfaceAt);
    if (ring > 0.5 && ring < uMaxRing + 1.5 && age > 0.0) {
      vec2 inward = -normalize(c);
      float edge = 0.0;
      float stir = 0.0;
      for (int k = 0; k < 6; k++) {
        float a = radians(30.0 + 60.0 * float(k));
        vec2 n = vec2(cos(a), sin(a));
        float d = max(SQ3 * 0.5 - dot(local, n), 0.0);
        float facing = smoothstep(0.4, 0.8, dot(n, inward));
        edge = max(edge, facing * exp(-d / 0.08));
        stir = max(stir, facing * exp(-d / 0.32));
      }
      float life = smoothstep(0.0, 0.025, age) * (1.0 - smoothstep(0.1, 0.32, age))
        * (1.0 - smoothstep(0.93, 1.0, uBuild));
      float churn = noise(vXZ * 7.0 + vec2(uTime * 1.9, -uTime * 1.4));
      float foam = edge * smoothstep(0.2, 0.8, churn);
      // Whitewater right on the edge, stirred-up lighter water just off it.
      col = mix(col, col * 1.35 + vec3(0.04, 0.07, 0.08), stir * life * 0.6);
      col = mix(col, vec3(0.8, 0.88, 0.9), clamp(foam * 0.85, 0.0, 1.0) * life);
    }
  }

  float alpha = pow(1.0 - smoothstep(uRadius * 0.3, uRadius * 0.98, r), 1.5);
  alpha *= smoothstep(0.0, 0.12, uBuild) * 0.96;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Soft glow under and around the island (reads as depth on the dark
  // backdrop), seen through the water's fade. Premultiplied output: the
  // same result as drawing the glow additively and the water over it.
  float g = (1.0 - smoothstep(0.2, 1.0, r / uGlowR)) * 0.15 * smoothstep(0.0, 0.6, uBuild);
  gl_FragColor = vec4(gl_FragColor.rgb * alpha + vec3(0.35, 0.42, 0.6) * g * (1.0 - alpha), alpha);
}
`;

export function buildWater(layout: BoardLayout, shared: SharedUniforms): { mesh: Mesh; dispose: () => void } {
  const extent = layout.radius + 4.5;
  const glowR = layout.radius + 6;
  const res = 160;
  const distMax = 4;
  const distMin = -1;
  // Signed distance to the coastline (negative under the island).
  const data = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = ((i + 0.5) / res - 0.5) * 2 * extent;
      const z = ((j + 0.5) / res - 0.5) * 2 * extent;
      const d = Math.max(distMin, Math.min(distMax, layout.signedDistanceToLand(x, z)));
      data[j * res + i] = Math.round(((d - distMin) / (distMax - distMin)) * 255);
    }
  }
  const tex = new DataTexture(data, res, res, RedFormat, UnsignedByteType);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearFilter;
  tex.needsUpdate = true;

  const material = new ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    uniforms: {
      uTime: shared.uTime,
      uBuild: shared.uBuild,
      tDist: { value: tex },
      uExtent: { value: extent },
      uDistMax: { value: distMax },
      uDistMin: { value: distMin },
      uRadius: { value: extent },
      uGlowR: { value: glowR },
      uMaxRing: { value: Math.max(1, layout.maxRing) },
      uSurfaceAt: { value: BUILD_SURFACE },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
  });
  // Out to the glow's rim; past the water's own edge only the glow shows.
  const geo = new CircleGeometry(glowR, 96);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, material);
  mesh.position.y = WATER_Y;
  mesh.renderOrder = -1;
  return {
    mesh,
    dispose: () => { geo.dispose(); material.dispose(); tex.dispose(); },
  };
}
