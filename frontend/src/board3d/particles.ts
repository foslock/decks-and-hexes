import {
  AdditiveBlending, BufferAttribute, BufferGeometry, NormalBlending, Points, ShaderMaterial,
  type IUniform, type Vector2,
} from 'three';

/**
 * GPU particle pool. Each particle is spawned once (CPU writes its initial
 * state into a ring buffer) and then integrated analytically in the vertex
 * shader — no per-frame CPU work per particle.
 *
 * Motion: p(t) = p0 + v·(1 − e^(−drag·t))/drag + ½·g·t² + wind·t·windK
 */

const VERT = /* glsl */ `
attribute vec3 aVel;
attribute vec4 aColor;
attribute vec4 aTime;   // birth, life, size0, size1
attribute vec4 aPhys;   // gravity, drag, windK, shape (0 soft, 1 spark, 2 flake)
uniform float uTime;
uniform float uPixelScale;
uniform vec2 uWind;
varying vec4 vColor;
varying float vT;
varying float vShape;
void main() {
  float age = uTime - aTime.x;
  float t = age / aTime.y;
  if (t < 0.0 || t > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  float drag = max(aPhys.y, 0.0001);
  vec3 p = position + aVel * (1.0 - exp(-drag * age)) / drag;
  p.y -= 0.5 * aPhys.x * age * age;
  p.xz += uWind * age * aPhys.z * 40.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = mix(aTime.z, aTime.w, t);
  gl_PointSize = max(0.0, size * uPixelScale / -mv.z);
  vColor = aColor;
  vT = t;
  vShape = aPhys.w;
}
`;

const FRAG = /* glsl */ `
varying vec4 vColor;
varying float vT;
varying float vShape;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a;
  if (vShape > 1.5) {
    // flake: small hard-ish dot
    a = 1.0 - smoothstep(0.3, 0.5, d);
  } else if (vShape > 0.5) {
    // spark: hot core + halo
    a = (1.0 - smoothstep(0.0, 0.5, d));
    a = a * a * 1.6;
  } else {
    a = 1.0 - smoothstep(0.15, 0.5, d);
  }
  float fade = smoothstep(0.0, 0.08, vT) * (1.0 - smoothstep(0.55, 1.0, vT));
  float alpha = vColor.a * a * fade;
  if (alpha < 0.003) discard;
  #ifdef ADDITIVE
  // Premultiplied light: adds color without touching canvas alpha.
  gl_FragColor = vec4(vColor.rgb * alpha, 0.0);
  #else
  gl_FragColor = vec4(vColor.rgb, alpha);
  #endif
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface ParticleSpawn {
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  r: number; g: number; b: number; a?: number;
  life: number;
  size0: number;
  size1?: number;
  gravity?: number;
  drag?: number;
  wind?: number;
  shape?: 0 | 1 | 2;
  delay?: number;
}

export class ParticlePool {
  readonly points: Points;
  private geo: BufferGeometry;
  private material: ShaderMaterial;
  private cursor = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private wrapped = false;
  private attrs: { pos: BufferAttribute; vel: BufferAttribute; color: BufferAttribute; time: BufferAttribute; phys: BufferAttribute };
  private now: () => number;
  /** Multiplies spawn counts (quality setting). */
  density = 1;

  constructor(readonly capacity: number, additive: boolean, uniforms: { uTime: IUniform<number>; uWind: IUniform<Vector2>; uPixelScale: IUniform<number> }) {
    this.geo = new BufferGeometry();
    const mk = (n: number) => {
      const a = new BufferAttribute(new Float32Array(capacity * n), n);
      a.setUsage(35048); // DynamicDrawUsage
      return a;
    };
    this.attrs = { pos: mk(3), vel: mk(3), color: mk(4), time: mk(4), phys: mk(4) };
    // Park every slot in the past so nothing renders until spawned.
    for (let i = 0; i < capacity; i++) this.attrs.time.setXYZW(i, -1e6, 1, 0, 0);
    this.geo.setAttribute('position', this.attrs.pos);
    this.geo.setAttribute('aVel', this.attrs.vel);
    this.geo.setAttribute('aColor', this.attrs.color);
    this.geo.setAttribute('aTime', this.attrs.time);
    this.geo.setAttribute('aPhys', this.attrs.phys);
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uTime: uniforms.uTime, uWind: uniforms.uWind, uPixelScale: uniforms.uPixelScale },
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
      premultipliedAlpha: additive,
      defines: additive ? { ADDITIVE: '' } : {},
    });
    this.points = new Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 20 : 10;
    this.now = () => uniforms.uTime.value;
  }

  spawn(p: ParticleSpawn): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.cursor === 0) this.wrapped = true;
    const { pos, vel, color, time, phys } = this.attrs;
    pos.setXYZ(i, p.x, p.y, p.z);
    vel.setXYZ(i, p.vx ?? 0, p.vy ?? 0, p.vz ?? 0);
    color.setXYZW(i, p.r, p.g, p.b, p.a ?? 1);
    time.setXYZW(i, this.now() + (p.delay ?? 0), p.life, p.size0, p.size1 ?? p.size0);
    phys.setXYZW(i, p.gravity ?? 0, p.drag ?? 0.0001, p.wind ?? 0, p.shape ?? 0);
    this.dirtyLo = Math.min(this.dirtyLo, i);
    this.dirtyHi = Math.max(this.dirtyHi, i);
  }

  /** Upload whatever was spawned since the last flush. */
  flush(): void {
    if (this.dirtyHi < 0) return;
    const ranges: [number, number][] = this.wrapped
      ? [[0, this.capacity]]
      : [[this.dirtyLo, this.dirtyHi - this.dirtyLo + 1]];
    for (const a of Object.values(this.attrs)) {
      a.clearUpdateRanges();
      for (const [start, count] of ranges) a.addUpdateRange(start * a.itemSize, count * a.itemSize);
      a.needsUpdate = true;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
    this.wrapped = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
