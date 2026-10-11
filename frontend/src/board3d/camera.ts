import { MathUtils, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';

/** Default tilt away from straight-down (radians, ≈22°): a bird's-eye view
 *  with enough angle that castles, peaks and trees read as 3D. */
export const DEFAULT_TILT = 0.38;
export const MAX_TILT = 1.0;
export const MAX_ZOOM = 3.2;
const FOV = 30;

/** A scripted flight's progress (0–1) at time fraction `u`: ease both ends,
 *  or (`out`) start at full speed and slow to a stop. */
export function flightEase(u: number, ease: 'inOut' | 'out' = 'inOut'): number {
  return ease === 'out'
    ? 1 - Math.pow(1 - u, 4)
    : u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

const _v = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _ground = new Plane(new Vector3(0, 1, 0), 0);

/**
 * Board camera. Everything is expressed relative to an auto "fit" framing:
 * the distance and center at which the whole island fills the viewport for
 * the current rotation + tilt. User zoom divides the fit distance and user
 * pan offsets the fitted center, so resizing the window or rotating keeps a
 * sensible view without any special cases.
 */
export class CameraRig {
  readonly camera: PerspectiveCamera;
  width = 1;
  height = 1;
  /** Extra padding (CSS px) around the fitted board. */
  padding = 16;
  /** Bottom band (CSS px) the canvas draws under but the board is framed
   *  above, e.g. behind the hand. The view's center sits in the area above. */
  insetBottom = 0;

  // Targets (what input sets) and current (smoothed) values.
  rotation = 0;
  tilt = DEFAULT_TILT;
  zoom = 1;
  readonly pan = new Vector2();
  private cur = { rotation: 0, tilt: DEFAULT_TILT, zoom: 1, panX: 0, panZ: 0 };
  /** Damping rate (1/s). Lower during the intro swoop. */
  damping = 9;

  private fitPoints: Vector3[] = [];
  private fitCache = { key: '', dist: 10, cx: 0, cz: 0 };
  private shakeAmp = 0;
  private shakeDecay = 0;
  private shakeT = 0;
  readonly raycaster = new Raycaster();
  /** True while any value is still easing toward its target. */
  moving = false;
  /** A scripted glide (tutorial): eases from where the camera was to the
   *  targets over a fixed time instead of damping, optionally pulling back
   *  mid-flight (`arc`) for a swoop. */
  private flight: {
    from: { rotation: number; tilt: number; zoom: number; panX: number; panZ: number };
    start: number; dur: number; arc: number; ease: 'inOut' | 'out';
  } | null = null;

  constructor() {
    this.camera = new PerspectiveCamera(FOV, 1, 0.1, 200);
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    const vh = this.viewHeight;
    // Project for the area above the inset and let the frustum run on below
    // it, so the bottom band is still drawn.
    this.camera.aspect = this.width / vh;
    if (vh < this.height) this.camera.setViewOffset(this.width, vh, 0, 0, this.width, this.height);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.fitCache.key = '';
  }

  /** Height (CSS px) of the framed area above `insetBottom`. */
  get viewHeight(): number {
    return Math.max(1, Math.min(this.height, this.height - this.insetBottom));
  }

  /** Points that must stay on-screen at zoom 1 (world space). */
  setFitPoints(points: Vector3[]): void {
    this.fitPoints = points;
    this.fitCache.key = '';
  }

  /** Jump the smoothed state straight to the targets. */
  snap(): void {
    this.cur.rotation = this.rotation;
    this.cur.tilt = this.tilt;
    this.cur.zoom = this.zoom;
    this.cur.panX = this.pan.x;
    this.cur.panZ = this.pan.y;
  }

  /** Start from a dramatic angle and let damping swoop into the targets. */
  intro(): void {
    this.cur.rotation = this.rotation - 0.9;
    this.cur.tilt = 0.95;
    this.cur.zoom = 0.62;
    this.cur.panX = this.pan.x;
    this.cur.panZ = this.pan.y;
    this.damping = 1.6;
  }

  /** Glide from the current view to the targets over `seconds` (wall-clock
   *  time, so it lands on schedule even if frames drop). `ease: 'out'` starts
   *  at full speed and slows to a stop (an arrival) instead of easing both ends. */
  beginFlight(seconds: number, arc = 0, ease: 'inOut' | 'out' = 'inOut'): void {
    this.flight = { from: { ...this.cur }, start: performance.now() / 1000, dur: Math.max(0.05, seconds), arc, ease };
  }

  /** Put the camera at a view right now (the targets stay where they are). */
  jumpTo(view: { rotation: number; tilt: number; zoom: number; panX: number; panZ: number }): void {
    Object.assign(this.cur, view);
  }

  /** Point the target view at a ground point (it lands mid-frame). Set the
   *  target rotation and tilt first — the fitted center depends on them. */
  centerOn(x: number, z: number): void {
    const f = this.fit(this.rotation, this.tilt);
    this.pan.set(x - f.cx, z - f.cz);
  }

  shake(strength: number, durationMs = 350): void {
    this.shakeAmp = Math.max(this.shakeAmp, strength);
    this.shakeDecay = 1 / Math.max(0.05, durationMs / 1000);
  }

  /** Screen-up direction on the board for a rotation (world xz). */
  private basis(rotation: number, tilt: number): void {
    // f = the board direction that appears at the top of the screen.
    _fwd.set(-Math.sin(rotation), 0, -Math.cos(rotation));
    _right.set(Math.cos(rotation), 0, -Math.sin(rotation));
    // Camera up (in the view plane) tilts with the camera.
    _up.copy(_fwd).multiplyScalar(Math.cos(tilt)).addScaledVector(new Vector3(0, 1, 0), Math.sin(tilt));
  }

  /** Where the fitted view (zoom 1, no pan) centers, for the target
   *  rotation and tilt. Tilted, it sits toward the island's near side. */
  fitCenter(): { cx: number; cz: number } {
    const f = this.fit(this.rotation, this.tilt);
    return { cx: f.cx, cz: f.cz };
  }

  /** Fit distance + center for a rotation/tilt (cached). */
  private fit(rotation: number, tilt: number): { dist: number; cx: number; cz: number } {
    const vh = this.viewHeight;
    const key = `${rotation.toFixed(4)}|${tilt.toFixed(4)}|${this.width}|${vh}|${this.padding}`;
    if (this.fitCache.key === key) return this.fitCache;
    this.basis(rotation, tilt);
    // View direction (from camera into the scene).
    const view = _fwd.clone().multiplyScalar(Math.sin(tilt)).add(new Vector3(0, -Math.cos(tilt), 0)).normalize();
    const tanY = Math.tan(MathUtils.degToRad(FOV / 2));
    const tanX = tanY * (this.width / vh);
    const padX = 1 - (this.padding * 2) / this.width;
    const padY = 1 - (this.padding * 2) / vh;
    let cx = 0, cz = 0;
    let dist = 10;
    const target = new Vector3();
    for (let iter = 0; iter < 3; iter++) {
      target.set(cx, 0, cz);
      // Bisection on distance so every point fits within the padded NDC box.
      let lo = 0.5, hi = 200;
      for (let i = 0; i < 26; i++) {
        const d = (lo + hi) / 2;
        let ok = true;
        for (const p of this.fitPoints) {
          _v.copy(p).sub(target);
          const depth = d + _v.dot(view);
          if (depth <= 0.01) { ok = false; break; }
          const x = _v.dot(_right) / (depth * tanX);
          const y = _v.dot(_up) / (depth * tanY);
          if (Math.abs(x) > padX || Math.abs(y) > padY) { ok = false; break; }
        }
        if (ok) hi = d; else lo = d;
      }
      dist = hi;
      // Recenter on the projected bounding box.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of this.fitPoints) {
        _v.copy(p).sub(target);
        const depth = dist + _v.dot(view);
        const x = _v.dot(_right) / (depth * tanX);
        const y = _v.dot(_up) / (depth * tanY);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const midX = (minX + maxX) / 2 * dist * tanX;
      const midY = (minY + maxY) / 2 * dist * tanY;
      // Move the target in the ground plane so the box centers.
      cx += _right.x * midX + _fwd.x * midY / Math.max(0.2, Math.cos(tilt));
      cz += _right.z * midX + _fwd.z * midY / Math.max(0.2, Math.cos(tilt));
    }
    this.fitCache = { key, dist, cx, cz };
    return this.fitCache;
  }

  /** Advance smoothing and place the camera. Returns true while animating. */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * this.damping);
    const c = this.cur;
    const before = c.rotation + c.tilt + c.zoom + c.panX + c.panZ;
    const fl = this.flight;
    if (fl) {
      const u = Math.min(1, (performance.now() / 1000 - fl.start) / fl.dur);
      const e = flightEase(u, fl.ease);
      const f = fl.from;
      c.rotation = f.rotation + (this.rotation - f.rotation) * e;
      c.tilt = f.tilt + (this.tilt - f.tilt) * e;
      c.zoom = (f.zoom + (this.zoom - f.zoom) * e) * (1 - fl.arc * Math.sin(Math.PI * u));
      c.panX = f.panX + (this.pan.x - f.panX) * e;
      c.panZ = f.panZ + (this.pan.y - f.panZ) * e;
      if (u >= 1) this.flight = null;
    } else {
      c.rotation += (this.rotation - c.rotation) * k;
      c.tilt += (this.tilt - c.tilt) * k;
      c.zoom += (this.zoom - c.zoom) * k;
      c.panX += (this.pan.x - c.panX) * k;
      c.panZ += (this.pan.y - c.panZ) * k;
    }
    const delta = Math.abs(c.rotation - this.rotation) + Math.abs(c.tilt - this.tilt)
      + Math.abs(c.zoom - this.zoom) + Math.abs(c.panX - this.pan.x) + Math.abs(c.panZ - this.pan.y);
    if (delta < 1e-4 && !this.flight) this.snap();
    if (delta < 0.02 && this.damping < 9) this.damping = Math.min(9, this.damping + dt * 6);
    const after = c.rotation + c.tilt + c.zoom + c.panX + c.panZ;
    this.moving = !!this.flight || delta >= 1e-4 || Math.abs(after - before) > 1e-6;

    this.place(c.rotation, c.tilt, c.zoom, c.panX, c.panZ);

    if (this.shakeAmp > 0.0005) {
      this.shakeT += dt;
      const a = this.shakeAmp;
      this.camera.position.x += Math.sin(this.shakeT * 71) * a;
      this.camera.position.z += Math.cos(this.shakeT * 53) * a;
      this.camera.position.y += Math.sin(this.shakeT * 89) * a * 0.5;
      this.shakeAmp *= Math.exp(-dt * this.shakeDecay * 3);
      this.moving = true;
    } else {
      this.shakeAmp = 0;
    }
    this.camera.updateMatrixWorld();
    return this.moving;
  }

  /** Where the camera would be (and what it would look at) for a view —
   *  without moving it. */
  viewFrom(rotation: number, tilt: number, zoom: number, panX = 0, panZ = 0): { position: Vector3; target: Vector3 } {
    const f = this.fit(rotation, tilt);
    this.basis(rotation, tilt);
    const target = new Vector3(f.cx + panX, 0, f.cz + panZ);
    const view = _fwd.clone().multiplyScalar(Math.sin(tilt)).add(new Vector3(0, -Math.cos(tilt), 0)).normalize();
    return { position: target.clone().addScaledVector(view, -f.dist / zoom), target };
  }

  get fov(): number { return FOV; }

  private place(rotation: number, tilt: number, zoom: number, panX: number, panZ: number): void {
    const f = this.fit(rotation, tilt);
    this.basis(rotation, tilt);
    const dist = f.dist / zoom;
    const target = new Vector3(f.cx + panX, 0, f.cz + panZ);
    const view = _fwd.clone().multiplyScalar(Math.sin(tilt)).add(new Vector3(0, -Math.cos(tilt), 0)).normalize();
    this.camera.position.copy(target).addScaledVector(view, -dist);
    this.camera.up.copy(_fwd);
    this.camera.lookAt(target);
    this.camera.near = Math.max(0.05, dist * 0.05);
    this.camera.far = dist * 3 + 60;
    this.camera.updateProjectionMatrix();
  }

  /** Current smoothed rotation (for legacy GridTransform.rotation). */
  get currentRotation(): number { return this.cur.rotation; }
  get currentTilt(): number { return this.cur.tilt; }
  get currentZoom(): number { return this.cur.zoom; }
  /** Where the camera is right now (it eases toward the targets). */
  get currentState(): { rotation: number; tilt: number; zoom: number; panX: number; panZ: number } { return { ...this.cur }; }

  /** World → container CSS px. */
  project(world: Vector3, out = { x: 0, y: 0 }): { x: number; y: number } {
    _v.copy(world).project(this.camera);
    out.x = (_v.x * 0.5 + 0.5) * this.width;
    out.y = (-_v.y * 0.5 + 0.5) * this.height;
    return out;
  }

  /** Container CSS px → normalized device coords. */
  ndc(x: number, y: number, out = new Vector2()): Vector2 {
    return out.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  /** Intersection of the view ray through a pixel with the plane y = h. */
  groundPoint(x: number, y: number, h = 0): Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(x, y), this.camera);
    _ground.constant = -h;
    const hit = new Vector3();
    return this.raycaster.ray.intersectPlane(_ground, hit) ? hit : null;
  }

  /** Pixels per world unit at a world point (for scaling DOM labels). */
  pixelsPerUnit(world: Vector3): number {
    const a = this.project(world, { x: 0, y: 0 });
    _right.set(1, 0, 0);
    const b = this.project(_v.copy(world).add(new Vector3(Math.cos(this.cur.rotation), 0, -Math.sin(this.cur.rotation))), { x: 0, y: 0 });
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
}
