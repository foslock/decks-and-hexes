import { BufferAttribute, BufferGeometry, Color, Euler, IcosahedronGeometry, Matrix4, Vector3 } from 'three';
import { rng } from './noise';

/**
 * Low-poly triangle-soup builder. Props are composed from primitives
 * directly into one big non-indexed geometry with per-vertex attributes the
 * shared prop material understands:
 *
 *   color    — linear vertex color (per-face, with painterly jitter)
 *   aAnchor  — the prop's ground anchor (build-in scaling pivot, sway phase)
 *   aWind    — sway weight (grows with height above the anchor)
 *   aGlow    — emissive color (lit windows, braziers) — flickers in-shader
 *   aBuild   — 0..1 stagger for the board build-in animation
 *
 * Flat shading is done by the material, so no normals are stored.
 */

export type RGB = [number, number, number];

/** sRGB hex → linear RGB triple. */
export function lin(hex: number): RGB {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scaleRGB(a: RGB, s: number): RGB {
  return [a[0] * s, a[1] * s, a[2] * s];
}

const _v = new Vector3();
const _m = new Matrix4();
const _e = new Euler(0, 0, 0, 'YXZ');

export class Soup {
  private pos: number[] = [];
  private col: number[] = [];
  private anc: number[] = [];
  private wnd: number[] = [];
  private glw: number[] = [];
  private bld: number[] = [];

  /** Current local→world transform for primitives. */
  matrix = new Matrix4();
  anchor = new Vector3();
  build = 0;
  /** Sway weight per world unit of height above the anchor (0 = rigid). */
  windScale = 0;
  /** When set, sway weight grows with local +x distance (flags off a pole)
   *  instead of height. */
  windAlongX = false;
  /** Emissive color applied to faces while set. */
  glow: RGB = [0, 0, 0];
  /** Per-face brightness jitter amplitude. */
  jitter = 0.08;
  private rand: () => number;

  constructor(seed = 1) {
    this.rand = rng(seed);
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  random(): number {
    return this.rand();
  }

  /** Reset the transform to translate(x,y,z)·rotY(ry)·scale(s). */
  place(x: number, y: number, z: number, ry = 0, s = 1, sy = s): this {
    this.matrix.makeRotationY(ry);
    this.matrix.scale(_v.set(s, sy, s));
    this.matrix.setPosition(x, y, z);
    return this;
  }

  /** Post-multiply the current transform (local offset / rotation / scale). */
  push(x: number, y: number, z: number, ry = 0, s = 1, sy = s, rx = 0, rz = 0): Matrix4 {
    const saved = this.matrix.clone();
    _m.makeRotationFromEuler(_e.set(rx, ry, rz, 'YXZ'));
    _m.scale(_v.set(s, sy, s));
    _m.setPosition(x, y, z);
    this.matrix.multiply(_m);
    return saved;
  }

  pop(saved: Matrix4): void {
    this.matrix.copy(saved);
  }

  setAnchor(x: number, y: number, z: number, build = this.build): this {
    this.anchor.set(x, y, z);
    this.build = build;
    return this;
  }

  private vert(x: number, y: number, z: number, c: RGB): void {
    const localX = x;
    _v.set(x, y, z).applyMatrix4(this.matrix);
    this.pos.push(_v.x, _v.y, _v.z);
    this.col.push(c[0], c[1], c[2]);
    this.anc.push(this.anchor.x, this.anchor.y, this.anchor.z);
    this.wnd.push(this.windScale * Math.max(0, this.windAlongX ? localX : _v.y - this.anchor.y));
    this.glw.push(this.glow[0], this.glow[1], this.glow[2]);
    this.bld.push(this.build);
  }

  tri(a: number[], b: number[], c: number[], color: RGB): void {
    const j = this.jitter ? 1 + (this.rand() - 0.5) * 2 * this.jitter : 1;
    const fc: RGB = [color[0] * j, color[1] * j, color[2] * j];
    this.vert(a[0], a[1], a[2], fc);
    this.vert(b[0], b[1], b[2], fc);
    this.vert(c[0], c[1], c[2], fc);
  }

  quad(a: number[], b: number[], c: number[], d: number[], color: RGB): void {
    const j = this.jitter ? 1 + (this.rand() - 0.5) * 2 * this.jitter : 1;
    const fc: RGB = [color[0] * j, color[1] * j, color[2] * j];
    const saved = this.jitter;
    this.jitter = 0;
    this.tri(a, b, c, fc);
    this.tri(a, c, d, fc);
    this.jitter = saved;
  }

  /** Frustum / cylinder / cone standing on y=0. */
  cylinder(rBottom: number, rTop: number, h: number, seg: number, color: RGB, opts: { top?: RGB | null; bottom?: boolean; twist?: number; wobble?: number } = {}): void {
    const ring = (r: number, y: number, off: number) => {
      const pts: number[][] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2 + off;
        const w = opts.wobble ? 1 + (this.rand() - 0.5) * opts.wobble : 1;
        pts.push([Math.cos(a) * r * w, y, Math.sin(a) * r * w]);
      }
      return pts;
    };
    const lo = ring(rBottom, 0, 0);
    const hi = rTop > 0 ? ring(rTop, h, opts.twist ?? 0) : null;
    for (let i = 0; i < seg; i++) {
      const j = (i + 1) % seg;
      if (hi) this.quad(lo[i], hi[i], hi[j], lo[j], color);
      else this.tri(lo[i], [0, h, 0], lo[j], color);
    }
    if (hi && opts.top !== null) {
      const topC = opts.top ?? color;
      for (let i = 1; i < seg - 1; i++) this.tri(hi[0], hi[i + 1], hi[i], topC);
    }
    if (opts.bottom) {
      for (let i = 1; i < seg - 1; i++) this.tri(lo[0], lo[i], lo[i + 1], color);
    }
  }

  cone(r: number, h: number, seg: number, color: RGB, wobble = 0): void {
    this.cylinder(r, 0, h, seg, color, { wobble });
  }

  /** Axis-aligned box resting on y=0. */
  box(w: number, h: number, d: number, color: RGB, top?: RGB): void {
    const x = w / 2, z = d / 2;
    const p = [
      [-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z],
      [-x, h, -z], [x, h, -z], [x, h, z], [-x, h, z],
    ];
    this.quad(p[3], p[7], p[6], p[2], color); // +z
    this.quad(p[1], p[5], p[4], p[0], color); // -z
    this.quad(p[2], p[6], p[5], p[1], color); // +x
    this.quad(p[0], p[4], p[7], p[3], color); // -x
    this.quad(p[4], p[5], p[6], p[7], top ?? color); // top
  }

  /** Gable roof resting on y=0; ridge runs along x. */
  gable(w: number, h: number, d: number, color: RGB, gableEnd?: RGB, overhang = 0.12): void {
    const x = w / 2 * (1 + overhang), z = d / 2 * (1 + overhang);
    const xe = w / 2;
    const end = gableEnd ?? color;
    this.quad([-x, 0, z], [-x, h, 0], [x, h, 0], [x, 0, z], color);
    this.quad([x, 0, -z], [x, h, 0], [-x, h, 0], [-x, 0, -z], color);
    this.tri([xe, 0, z * 0.9], [xe, h * 0.95, 0], [xe, 0, -z * 0.9], end);
    this.tri([-xe, 0, -z * 0.9], [-xe, h * 0.95, 0], [-xe, 0, z * 0.9], end);
  }

  /** Four-sided pyramid resting on y=0. */
  pyramid(w: number, h: number, color: RGB, d = w): void {
    const x = w / 2, z = d / 2;
    const apex = [0, h, 0];
    this.tri([-x, 0, z], apex, [x, 0, z], color);
    this.tri([x, 0, z], apex, [x, 0, -z], color);
    this.tri([x, 0, -z], apex, [-x, 0, -z], color);
    this.tri([-x, 0, -z], apex, [-x, 0, z], color);
  }

  /** Lumpy low-poly blob (foliage, rocks, sheep). Center at y = r·sy. */
  blob(r: number, color: RGB, opts: { sy?: number; detail?: number; noise?: number; flatBottom?: boolean; colorTop?: RGB } = {}): void {
    const geo = new IcosahedronGeometry(r, opts.detail ?? 0);
    const p = geo.getAttribute('position');
    const sy = opts.sy ?? 1;
    const n = opts.noise ?? 0.18;
    // Displace shared vertices consistently (positions are duplicated per face).
    const disp = new Map<string, number>();
    const pts: number[][] = [];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const k = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      let d = disp.get(k);
      if (d === undefined) { d = 1 + (this.rand() - 0.5) * 2 * n; disp.set(k, d); }
      let yy = y * d * sy + r * sy;
      if (opts.flatBottom) yy = Math.max(yy, r * sy * 0.15);
      pts.push([x * d, yy, z * d]);
    }
    for (let i = 0; i < pts.length; i += 3) {
      let c = color;
      if (opts.colorTop) {
        const cy = (pts[i][1] + pts[i + 1][1] + pts[i + 2][1]) / 3;
        c = mix(color, opts.colorTop, Math.min(1, Math.max(0, cy / (2 * r * sy))));
      }
      this.tri(pts[i], pts[i + 1], pts[i + 2], c);
    }
    geo.dispose();
  }

  /** Flat polygon (fan) lying at height y — fields, plazas, water. */
  flat(points: [number, number][], y: number, color: RGB): void {
    for (let i = 1; i < points.length - 1; i++) {
      this.tri([points[0][0], y, points[0][1]], [points[i + 1][0], y, points[i + 1][1]], [points[i][0], y, points[i][1]], color);
    }
  }

  /** Thin vertical plane (flags, pennants). Double-sided via two faces. */
  panel(w: number, h: number, color: RGB): void {
    const a = [0, 0, 0], b = [0, h, 0], c = [w, h, 0], d = [w, 0, 0];
    this.quad(a, b, c, d, color);
    this.quad(d, c, b, a, color);
  }

  /** Swallow-tail pennant hanging from (0,0,0), extending along +x. */
  pennant(w: number, h: number, color: RGB): void {
    const pts = [[0, 0, 0], [0, -h, 0], [w, -h * 1.15, 0], [w * 0.7, -h * 0.6, 0], [w, -h * 0.05, 0]];
    for (const [a, b, c] of [[0, 1, 3], [1, 2, 3], [0, 3, 4]]) {
      this.tri(pts[a], pts[b], pts[c], color);
      this.tri(pts[c], pts[b], pts[a], color);
    }
  }

  toGeometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aAnchor', new BufferAttribute(new Float32Array(this.anc), 3));
    g.setAttribute('aWind', new BufferAttribute(new Float32Array(this.wnd), 1));
    g.setAttribute('aGlow', new BufferAttribute(new Float32Array(this.glw), 3));
    g.setAttribute('aBuild', new BufferAttribute(new Float32Array(this.bld), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
