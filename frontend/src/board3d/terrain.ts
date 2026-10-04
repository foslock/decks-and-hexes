import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CircleGeometry, DataTexture, LinearFilter,
  Mesh, RedFormat, ShaderMaterial, UnsignedByteType, Vector3,
} from 'three';
import type { HexTile } from '../types/game';
import { HEX_DIRS } from '../utils/hexGeometry';
import { BoardLayout, hexCorner } from './layout';
import { fbm2, valueNoise2 } from './noise';
import type { SharedUniforms } from './materials';
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
varying vec2 vXZ;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
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

  float alpha = pow(1.0 - smoothstep(uRadius * 0.3, uRadius * 0.98, r), 1.5);
  alpha *= smoothstep(0.0, 0.12, uBuild);
  gl_FragColor = vec4(col, alpha * 0.96);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function buildWater(layout: BoardLayout, shared: SharedUniforms): { mesh: Mesh; dispose: () => void } {
  const extent = layout.radius + 4.5;
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
    },
    transparent: true,
    depthWrite: false,
  });
  const geo = new CircleGeometry(extent, 96);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, material);
  mesh.position.y = WATER_Y;
  mesh.renderOrder = -1;
  return {
    mesh,
    dispose: () => { geo.dispose(); material.dispose(); tex.dispose(); },
  };
}

/** Soft additive vignette glow under the island (reads as depth on dark bg). */
export function buildUnderGlow(layout: BoardLayout, shared: SharedUniforms): Mesh {
  const geo = new CircleGeometry(layout.radius + 6, 48);
  geo.rotateX(-Math.PI / 2);
  const material = new ShaderMaterial({
    vertexShader: `varying vec2 vUv2; void main(){ vUv2 = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);} `,
    fragmentShader: `uniform float uR; uniform float uBuild; varying vec2 vUv2; void main(){ float r = length(vUv2)/uR; float a = (1.0 - smoothstep(0.2, 1.0, r)) * 0.15 * smoothstep(0.0, 0.6, uBuild); gl_FragColor = vec4(vec3(0.35,0.42,0.6)*a, 0.0); }`,
    uniforms: { uR: { value: layout.radius + 6 }, uBuild: shared.uBuild },
    transparent: true,
    blending: AdditiveBlending,
    premultipliedAlpha: true,
    depthWrite: false,
  });
  const m = new Mesh(geo, material);
  m.position.y = WATER_Y - 0.05;
  m.renderOrder = -2;
  return m;
}
