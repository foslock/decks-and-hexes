import {
  Color, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, NormalBlending,
  PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils, Vector3, type Camera, type IUniform,
} from 'three';
import type { BoardLayout } from './layout';
import { rng } from './noise';
import { WATER_Y } from './terrain';

/**
 * Clouds for depth: soft puffs drifting over the sea around the island (with
 * faint shadows on the water), and now and then one thin, see-through wisp
 * sliding high over the board itself — never thick enough to hide a tile,
 * and fading further when the camera zooms in.
 *
 * Every puff is a camera-facing quad in one instanced mesh, shaded as a soft
 * sphere lit by the sun and sorted back to front each frame.
 */

/** Drift direction — the same way the cloud shadows on the land travel. */
const WIND = new Vector3(-0.864, 0, -0.504);
const SEA_SPEED = 0.06;
const SKY_SPEED = 0.2;
/** Thin wisps over the board: at most this many at once. */
const MAX_WISPS = 2;
// Sea clouds and wisps use ~60; the arrival's passage clouds ~170 more.
const MAX_PUFFS = 320;

const PUFF_VERT = /* glsl */ `
attribute vec3 iCenter;
attribute vec4 iData; // size, alpha, seed, wisp (0 sea puff, 1 sky wisp)
varying vec2 vUv;
varying vec4 vData;
#include <fog_pars_vertex>
void main() {
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float stretch = 1.0 + iData.w * 0.7;
  vec3 wp = iCenter + (right * position.x * stretch + up * position.y) * iData.x;
  vUv = position.xy * 2.0;
  vData = iData;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const NOISE = /* glsl */ `
float c_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float c_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(c_hash(i), c_hash(i + vec2(1, 0)), u.x), mix(c_hash(i + vec2(0, 1)), c_hash(i + vec2(1, 1)), u.x), u.y);
}
float c_fbm(vec2 p) {
  return c_noise(p) * 0.55 + c_noise(p * 2.1 + 3.7) * 0.3 + c_noise(p * 4.3 + 9.1) * 0.15;
}
`;

const PUFF_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunView;
uniform vec3 uLit;
uniform vec3 uShade;
varying vec2 vUv;
varying vec4 vData;
${NOISE}
#include <fog_pars_fragment>
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  float wisp = vData.w;
  float n = c_fbm(vUv * (1.7 + wisp) + vec2(vData.z * 13.1, vData.z * 7.3) + uTime * (0.012 + wisp * 0.01));
  // Soft round puff with a ragged, slowly boiling edge; wisps are thinner and frayed.
  float edge = 1.0 - smoothstep(0.3 - wisp * 0.2, 1.0, sqrt(r2) + (n - 0.5) * (0.55 + wisp * 0.45));
  float a = edge * vData.y;
  if (a < 0.004) discard;
  // Light it like a ball of vapour: bright toward the sun, cool underneath.
  vec3 nrm = vec3(vUv, sqrt(max(0.0, 1.0 - r2)));
  float lit = clamp(dot(nrm, uSunView) * 0.55 + 0.55, 0.0, 1.0);
  vec3 col = mix(uShade, uLit, lit) * (0.9 + 0.2 * n);
  // High wisps catch the full sun: bright, so they lift the land under them
  // instead of greying it.
  col = mix(col, vec3(1.0, 0.95, 0.88) * (0.95 + 0.1 * n), wisp * 0.8);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

const SHADOW_VERT = /* glsl */ `
attribute vec3 iCenter;
attribute vec4 iData; // length, width, alpha, angle
varying vec2 vUv;
varying float vAlpha;
void main() {
  float c = cos(iData.w), s = sin(iData.w);
  vec2 p = vec2(position.x * iData.x, position.y * iData.y);
  vec3 wp = iCenter + vec3(p.x * c - p.y * s, 0.0, p.x * s + p.y * c);
  vUv = position.xy * 2.0;
  vAlpha = iData.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const SHADOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vAlpha;
void main() {
  float r = length(vUv);
  float a = (1.0 - smoothstep(0.15, 1.0, r)) * vAlpha;
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.01, 0.03, a);
}
`;

interface Puff { dx: number; dy: number; dz: number; size: number; seed: number }

interface SeaCloud {
  x: number; z: number; y: number;
  /** Distance to the coast (updated as it drifts). */
  land: number;
  puffs: Puff[];
  /** Seconds since it formed (it fades in). */
  age: number;
  phase: number;
}

interface Wisp {
  /** Start of its path and how far along it is (0..1). */
  sx: number; sz: number; t: number;
  length: number;
  y: number;
  puffs: Puff[];
  peak: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A cloud on the camera's way in (setPassage): layers of them stand
 *  across its path, each thinning away as the camera reaches it. */
interface PassageCloud {
  x: number;
  y: number;
  z: number;
  puffs: Puff[];
}

export class CloudLayer {
  readonly group = new Group();
  private puffGeo = new InstancedBufferGeometry();
  private shadowGeo = new InstancedBufferGeometry();
  private centers = new Float32Array(MAX_PUFFS * 3);
  private data = new Float32Array(MAX_PUFFS * 4);
  private shadowCenters: Float32Array;
  private shadowData: Float32Array;
  private puffMat: ShaderMaterial;
  private shadowMat: ShaderMaterial;
  private sea: SeaCloud[] = [];
  private wisps: Wisp[] = [];
  private nextWisp = 0;
  private rand = rng(9371);
  private order: { i: number; depth: number }[] = [];
  private seaCount: number;
  private cover: PassageCloud[] = [];
  /** How much of the passage shows (1 = all, 0 = none). */
  private coverAmount = 0;
  private coverAnim: { from: number; to: number; t: number; dur: number } | null = null;
  private readonly sunView = new Vector3();
  private readonly tmp = new Vector3();

  constructor(private layout: BoardLayout, uTime: IUniform<number>, density = 1) {
    this.seaCount = Math.round((4 + layout.radius * 0.5) * density);
    const quad = new PlaneGeometry(1, 1);
    this.puffGeo.index = quad.index;
    this.puffGeo.setAttribute('position', quad.getAttribute('position'));
    const centerAttr = new InstancedBufferAttribute(this.centers, 3).setUsage(DynamicDrawUsage);
    const dataAttr = new InstancedBufferAttribute(this.data, 4).setUsage(DynamicDrawUsage);
    this.puffGeo.setAttribute('iCenter', centerAttr);
    this.puffGeo.setAttribute('iData', dataAttr);
    this.puffGeo.instanceCount = 0;

    this.shadowCenters = new Float32Array(this.seaCount * 3);
    this.shadowData = new Float32Array(this.seaCount * 4);
    this.shadowGeo.index = quad.index;
    this.shadowGeo.setAttribute('position', quad.getAttribute('position'));
    this.shadowGeo.setAttribute('iCenter', new InstancedBufferAttribute(this.shadowCenters, 3).setUsage(DynamicDrawUsage));
    this.shadowGeo.setAttribute('iData', new InstancedBufferAttribute(this.shadowData, 4).setUsage(DynamicDrawUsage));
    this.shadowGeo.instanceCount = 0;

    this.puffMat = new ShaderMaterial({
      vertexShader: PUFF_VERT,
      fragmentShader: PUFF_FRAG,
      uniforms: UniformsUtils.merge([UniformsLib.fog, {
        uSunView: { value: new Vector3(0, 1, 0) },
        uLit: { value: new Color(0xe6dacb) },
        uShade: { value: new Color(0x4a5274) },
      }]),
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      fog: true,
    });
    // Share the engine's clock (merge() copies values, so link after).
    this.puffMat.uniforms.uTime = uTime;
    this.shadowMat = new ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      transparent: true,
      depthWrite: false,
    });

    const puffs = new Mesh(this.puffGeo, this.puffMat);
    puffs.frustumCulled = false;
    puffs.renderOrder = 8;
    const shadows = new Mesh(this.shadowGeo, this.shadowMat);
    shadows.frustumCulled = false;
    shadows.renderOrder = 0;
    this.group.add(shadows, puffs);

    for (let i = 0; i < this.seaCount; i++) this.sea.push(this.spawnSea(true));
    // One wisp already on its way so the first look has some sky in it.
    this.wisps.push(this.spawnWisp(0.2 + this.rand() * 0.25));
    this.nextWisp = 14 + this.rand() * 16;
  }

  setLayout(layout: BoardLayout): void {
    // Only a new island (another map) scatters the clouds afresh; a tile
    // changing on the same island leaves them drifting where they are.
    const reshaped = Math.abs(layout.radius - this.layout.radius) > 1e-6 || layout.tiles.length !== this.layout.tiles.length;
    this.layout = layout;
    if (reshaped) {
      this.sea = this.sea.map(() => this.spawnSea(true));
      this.cover = [];  // a passage belongs to one island's arrival
    }
  }

  /** Show the passage clouds (1) or fade them out (0), over `seconds`
   *  (0: at once). */
  setCover(amount: number, seconds = 0): void {
    const to = Math.max(0, Math.min(1, amount));
    if (seconds <= 0) {
      this.coverAmount = to;
      this.coverAnim = null;
    } else {
      this.coverAnim = { from: this.coverAmount, to, t: 0, dur: seconds };
    }
  }

  /** True while the cover is fading (the engine keeps drawing). */
  get coverBusy(): boolean { return this.coverAnim !== null; }

  /** Layers of cloud across the camera's straight way in to `look`: one
   *  standing `distances[i]` back from it toward the camera (`back`, a unit
   *  vector) — at several heights, since the way in slopes. The first layer
   *  (the farthest back, met first) fills the view; the ones after it are
   *  broken, thinning toward the last, which only frames the island, so each
   *  altitude shows through the gaps of the one before. */
  setPassage(look: Vector3, back: Vector3, distances: number[], fovDeg: number, aspect: number): void {
    const r = this.rand;
    const dir = back.clone().negate();
    // Two axes across the view: screen-right (level) and screen-up.
    const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
    const up = new Vector3().crossVectors(right, dir).normalize();
    const tan = Math.tan((fovDeg * Math.PI) / 360);
    const out: PassageCloud[] = [];
    const layers = [...distances].sort((a, b) => b - a);
    layers.forEach((along, k) => {
      const first = k === 0;
      // 0 for the first layer met, 1 for the last.
      const late = layers.length > 1 ? k / (layers.length - 1) : 0;
      const cols = first ? 5 : 6, rows = first ? 3 : 4;
      const c = look.clone().addScaledVector(back, along);
      // Half the view's height there, padded so the edges stay covered.
      const h = along * tan * 1.3;
      const w = h * Math.max(1, aspect);
      const size = ((h * 2) / rows) * (first ? 1.2 : 1.05);
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const u = (i + 0.5) / cols * 2 - 1;
          const v = (j + 0.5) / rows * 2 - 1;
          if (!first) {
            // Broken cloud, clearing from the middle out as the layers go by.
            const edge = Math.max(Math.abs(u), Math.abs(v));
            const keep = (0.7 - 0.25 * late) * (1 - late * 0.85 * (1 - edge));
            if (r() > keep) continue;
          }
          const sx = u * w + (r() - 0.5) * (w / cols) * 0.5;
          const sy = v * h + (r() - 0.5) * (h / rows) * 0.5;
          const depth = (r() - 0.5) * size * 0.5;
          out.push({
            x: c.x + right.x * sx + up.x * sy + dir.x * depth,
            y: c.y + right.y * sx + up.y * sy + dir.y * depth,
            z: c.z + right.z * sx + up.z * sy + dir.z * depth,
            puffs: this.puffs(3, size * 0.32, size * 0.1, size * (0.8 + r() * 0.3)),
          });
        }
      }
    });
    this.cover = out;
  }

  private puffs(n: number, spread: number, height: number, size: number): Puff[] {
    const r = this.rand;
    const out: Puff[] = [];
    for (let i = 0; i < n; i++) {
      const along = (i / Math.max(1, n - 1) - 0.5) * 2 * spread + (r() - 0.5) * spread * 0.35;
      const across = (r() - 0.5) * spread * 0.55;
      // Middle puffs sit higher and bigger: a domed cloud.
      const mid = 1 - Math.abs(along) / Math.max(0.001, spread * 1.2);
      out.push({
        dx: WIND.x * along - WIND.z * across,
        dz: WIND.z * along + WIND.x * across,
        dy: height * mid * (0.6 + r() * 0.4),
        size: size * (0.65 + 0.5 * mid) * (0.8 + r() * 0.4),
        seed: r(),
      });
    }
    return out;
  }

  /** A sea cloud somewhere off the coast (`anywhere`) or forming upwind —
   *  always over the open water just beyond the cliffs. */
  private spawnSea(anywhere: boolean): SeaCloud {
    const r = this.rand;
    const R = this.layout.radius;
    let x = 0, z = 0;
    for (let tries = 0; tries < 60; tries++) {
      const a = r() * Math.PI * 2;
      const d = R - 1 + r() * 4.5;
      x = Math.cos(a) * d;
      z = Math.sin(a) * d;
      const upwind = -(x * WIND.x + z * WIND.z) > 0;
      const land = this.layout.signedDistanceToLand(x, z);
      if ((anywhere || upwind) && land > 1.3 && land < 2.8) break;
    }
    const n = 4 + Math.floor(r() * 3);
    return {
      x, z,
      land: this.layout.signedDistanceToLand(x, z),
      y: WATER_Y + 0.18 + r() * 0.3,
      puffs: this.puffs(n, 0.8 + r() * 0.5, 0.3, 1.35 + r() * 0.5),
      age: anywhere ? 10 + r() * 10 : 0,
      phase: r() * 10,
    };
  }

  /** A wisp entering upwind of the board, crossing at a random offset. */
  private spawnWisp(t = 0): Wisp {
    const r = this.rand;
    const R = this.layout.radius;
    const across = (r() - 0.5) * R * 1.1;
    const back = R + 3;
    return {
      sx: -WIND.x * back - WIND.z * across,
      sz: -WIND.z * back + WIND.x * across,
      t,
      length: back * 2,
      y: 2.6 + r() * 0.6,
      puffs: this.puffs(6 + Math.floor(r() * 4), 1.5 + r() * 0.8, 0.35, 1.5 + r() * 0.6),
      peak: 0.16 + r() * 0.05,
    };
  }

  /** Advance the drift and rebuild the instance buffers (sorted for blending). */
  update(dt: number, time: number, build: number, camera: Camera, sunDir: Vector3, zoom: number): void {
    const show = smooth(0.6, 1.0, build);

    // Sea clouds drift downwind, thin out as they near the coast, and new ones
    // form upwind once they've drifted off.
    for (let i = 0; i < this.sea.length; i++) {
      const c = this.sea[i];
      c.x += WIND.x * SEA_SPEED * dt;
      c.z += WIND.z * SEA_SPEED * dt;
      c.age += dt;
      c.land = this.layout.signedDistanceToLand(c.x, c.z);
      if (c.land > 3.6 && c.x * WIND.x + c.z * WIND.z > 0) this.sea[i] = this.spawnSea(false);
    }

    // Wisps over the board: rare, slow and faint.
    for (const w of this.wisps) w.t += (SKY_SPEED * dt) / w.length;
    this.wisps = this.wisps.filter(w => w.t < 1);
    this.nextWisp -= dt;
    if (this.nextWisp <= 0) {
      if (this.wisps.length < MAX_WISPS) this.wisps.push(this.spawnWisp());
      this.nextWisp = 22 + this.rand() * 30;
    }
    if (this.coverAnim) {
      const a = this.coverAnim;
      a.t += dt;
      const u = Math.min(1, a.t / a.dur);
      this.coverAmount = a.from + (a.to - a.from) * u * u * (3 - 2 * u);
      if (u >= 1) this.coverAnim = null;
    }

    // Close-ups get a clear view: wisps all but vanish as the camera zooms in.
    const zoomFade = 1 - 0.8 * smooth(1.25, 2.3, zoom);

    // ── Fill the buffers ──
    const view = camera.matrixWorldInverse;
    this.sunView.copy(sunDir).transformDirection(view);
    (this.puffMat.uniforms.uSunView.value as Vector3).copy(this.sunView);
    let n = 0;
    let s = 0;
    const centers = this.centers, data = this.data;
    const push = (x: number, y: number, z: number, size: number, alpha: number, seed: number, wisp: number) => {
      if (n >= MAX_PUFFS || alpha <= 0.002) return;
      centers[n * 3] = x; centers[n * 3 + 1] = y; centers[n * 3 + 2] = z;
      data[n * 4] = size; data[n * 4 + 1] = alpha; data[n * 4 + 2] = seed; data[n * 4 + 3] = wisp;
      n++;
    };
    const push3 = (x: number, y: number, z: number, size: number, alpha: number, seed: number) => push(x, y, z, size, alpha, seed, 0);

    for (const c of this.sea) {
      // Thin out near the cliffs (never over the board) and far out to sea.
      const coast = smooth(0.9, 1.7, c.land);
      const rim = 1 - smooth(2.7, 3.6, c.land);
      const alpha = 0.5 * show * coast * rim * smooth(0, 5, c.age);
      if (alpha <= 0.002) continue;
      const breathe = 1 + 0.05 * Math.sin(time * 0.35 + c.phase);
      for (const p of c.puffs) {
        push(c.x + p.dx, c.y + p.dy + Math.sin(time * 0.4 + c.phase + p.seed * 6) * 0.015, c.z + p.dz,
          p.size * breathe, alpha, p.seed, 0);
      }
      // Its shadow on the water, cast away from the sun.
      if (s < this.seaCount) {
        const h = c.y - WATER_Y;
        const k = h / Math.max(0.2, sunDir.y);
        this.shadowCenters[s * 3] = c.x - sunDir.x * k;
        this.shadowCenters[s * 3 + 1] = WATER_Y + 0.015;
        this.shadowCenters[s * 3 + 2] = c.z - sunDir.z * k;
        this.shadowData[s * 4] = 3.2 + c.puffs.length * 0.15;
        this.shadowData[s * 4 + 1] = 1.6;
        this.shadowData[s * 4 + 2] = alpha * 0.45;
        this.shadowData[s * 4 + 3] = Math.atan2(WIND.z, WIND.x);
        s++;
      }
    }

    // The passage: each puff thins as the camera nears it (flying through
    // it) and with the cover as a whole.
    if (this.coverAmount > 0.001 && this.cover.length) {
      const cam = camera.position;
      for (const c of this.cover) {
        for (const p of c.puffs) {
          const x = c.x + p.dx, y = c.y + p.dy, z = c.z + p.dz;
          const d = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
          const near = smooth(p.size * 0.35, p.size * 1.25, d);
          const alpha = 0.92 * this.coverAmount * near;
          if (alpha <= 0.002) continue;
          push3(x, y + Math.sin(time * 0.3 + p.seed * 6) * p.size * 0.02, z, p.size, alpha, p.seed);
        }
      }
    }

    for (const w of this.wisps) {
      const fade = smooth(0, 0.18, w.t) * (1 - smooth(0.82, 1, w.t));
      const alpha = w.peak * fade * zoomFade * show;
      const x = w.sx + WIND.x * w.length * w.t;
      const z = w.sz + WIND.z * w.length * w.t;
      for (const p of w.puffs) push(x + p.dx * 1.4, w.y + p.dy, z + p.dz * 1.4, p.size, alpha, p.seed, 1);
    }

    // Back to front, so overlapping puffs blend right.
    const order = this.order;
    order.length = 0;
    for (let i = 0; i < n; i++) {
      this.tmp.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]).applyMatrix4(view);
      order.push({ i, depth: this.tmp.z });
    }
    order.sort((a, b) => a.depth - b.depth);
    const c2 = this.sortScratchC ??= new Float32Array(MAX_PUFFS * 3);
    const d2 = this.sortScratchD ??= new Float32Array(MAX_PUFFS * 4);
    order.forEach((o, j) => {
      c2.set(centers.subarray(o.i * 3, o.i * 3 + 3), j * 3);
      d2.set(data.subarray(o.i * 4, o.i * 4 + 4), j * 4);
    });
    centers.set(c2.subarray(0, n * 3));
    data.set(d2.subarray(0, n * 4));

    this.puffGeo.instanceCount = n;
    (this.puffGeo.getAttribute('iCenter') as InstancedBufferAttribute).needsUpdate = true;
    (this.puffGeo.getAttribute('iData') as InstancedBufferAttribute).needsUpdate = true;
    this.shadowGeo.instanceCount = s;
    (this.shadowGeo.getAttribute('iCenter') as InstancedBufferAttribute).needsUpdate = true;
    (this.shadowGeo.getAttribute('iData') as InstancedBufferAttribute).needsUpdate = true;
  }

  private sortScratchC: Float32Array | undefined;
  private sortScratchD: Float32Array | undefined;

  dispose(): void {
    this.puffGeo.dispose();
    this.shadowGeo.dispose();
    this.puffMat.dispose();
    this.shadowMat.dispose();
  }
}
