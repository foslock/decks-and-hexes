import {
  ACESFilmicToneMapping, BufferAttribute, BufferGeometry, DirectionalLight, DoubleSide, Fog, Group,
  HemisphereLight, Mesh, MeshBasicMaterial, PCFSoftShadowMap, Scene, SRGBColorSpace, Vector3, WebGLRenderer,
} from 'three';
import type { HexTile } from '../types/game';
import { HEX_DIRS, HEX_SIZE, type GridTransform } from '../utils/hexGeometry';
import { AmbientLayer } from './ambient';
import { CameraRig, DEFAULT_TILT, MAX_TILT, MAX_ZOOM } from './camera';
import { PLAYER_COLORS, type ClaimChevron, type PlayerInfo, type VpPath } from './boardTypes';
import { FxLayer } from './fx';
import { BoardLayout, axialToWorld, hexCorner, structureSignature } from './layout';
import { MarkerLayer, type TokenSpec } from './markers';
import {
  createPropMaterial, createSharedUniforms, createSlabMaterial, createTerrainMaterial, createTileTextures,
  tileTexIndex, TF, type SharedUniforms, type TerrainUniforms, type TileTextures,
} from './materials';
import { ParticlePool } from './particles';
import { buildDecor, buildStructure, emptySpots, structureHeight, structureSpec, type AmbientSpots } from './props';
import { FloatingOverlay } from './floating';
import { RoadLayer } from './roads';
import { buildSlabGeometry, buildTerrainGeometry, buildUnderGlow, buildWater } from './terrain';

export type BoardQuality = 'high' | 'low';

export function detectQuality(): BoardQuality {
  if (typeof navigator === 'undefined') return 'high';
  const ua = navigator.userAgent;
  const isPhone = /iPhone|iPod/.test(ua) || (/Android/.test(ua) && /Mobile/.test(ua));
  return isPhone ? 'low' : 'high';
}

/** True when the browser can give us a WebGL2 context. */
export function webglAvailable(): boolean {
  try {
    if (typeof WebGL2RenderingContext === 'undefined') return false;
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    return !!gl && gl instanceof WebGL2RenderingContext;
  } catch {
    return false;
  }
}

export interface BoardInputListener {
  /** Pointer moved over the board (key = hovered tile or null). */
  onHover?(key: string | null, clientX: number, clientY: number, e: PointerEvent): void;
  onTileDown?(key: string, e: PointerEvent): void;
  onTileUp?(key: string | null, e: PointerEvent): void;
  onPointerMove?(e: PointerEvent): void;
  onLeave?(e: PointerEvent): void;
  /** A camera gesture (orbit / pinch) started — cancel any press in progress. */
  onGesture?(): void;
  /** A click / tap (no drag) that landed on empty board space. */
  onEmptyClick?(e: PointerEvent): void;
}

export interface OverlayState {
  highlight?: Set<string>;
  weak?: Set<string>;
  multi?: Set<string>;
  review?: Set<string>;
  activePlayer?: string;
}

interface StructureEntry {
  signature: string;
  mesh: Mesh | null;
  born: number;
  rise: boolean;
  jolt: number;
  joltAt: number;
  base: Vector3;
}

/**
 * The 3D game board. Owns the WebGL renderer, scene, camera and every layer
 * (terrain, decor, structures, ambient life, markers, effects). React talks
 * to it through plain setters; it never re-renders React.
 */
export class BoardEngine {
  readonly ok: boolean;
  readonly canvas: HTMLCanvasElement | null = null;
  readonly transform: GridTransform;
  readonly rig = new CameraRig();

  private renderer: WebGLRenderer | null = null;
  private scene = new Scene();
  private shared: SharedUniforms = createSharedUniforms();
  private tex: TileTextures = createTileTextures();
  private terrainUniforms: TerrainUniforms;
  private terrainMat;
  private slabMat;
  private propMat;
  private world = new Group();
  private terrainMesh: Mesh | null = null;
  private slabMesh: Mesh | null = null;
  private waterDispose: (() => void) | null = null;
  private waterMesh: Mesh | null = null;
  private underGlow: Mesh | null = null;
  private decorMesh: Mesh | null = null;
  private structures = new Map<string, StructureEntry>();
  private structureGroup = new Group();
  private sun: DirectionalLight;
  private layout: BoardLayout | null = null;
  private layoutSig = '';
  private tiles: Record<string, HexTile> = {};
  private prevOwner = new Map<string, string | null>();
  private playerInfo: Record<string, PlayerInfo> = {};
  private connected = new Set<string>();
  private decorSpots: AmbientSpots = emptySpots();
  private structureSpots = new Map<string, AmbientSpots>();
  private overlay: OverlayState = {};
  private pickMesh: Mesh | null = null;
  private pickKeys: string[] = [];
  private pickHeights = '';
  private smokePool: ParticlePool;
  private glowPool: ParticlePool;
  private pixelScale = { value: 400 };
  private ambient: AmbientLayer | null = null;
  private markers: MarkerLayer | null = null;
  private roads: RoadLayer | null = null;
  private floating: FloatingOverlay | null = null;
  /** 0 = near top-down → 1 = steep tilt (overlays float, labels rise). */
  tiltFactor = 0;
  /** Decor material variant that clears props out of road corridors. */
  private decorMat: { material: import('three').MeshStandardMaterial; depth: import('three').MeshDepthMaterial } | null = null;
  fxLayer: FxLayer | null = null;
  private frameCbs = new Set<() => void>();
  private raf = 0;
  private lastFrame = 0;
  private lastRender = 0;
  private time = 0;
  private paused = false;
  private disposed = false;
  private ro: ResizeObserver | null = null;
  private busyUntil = 0;
  private speed = 1;
  private build = 1;
  private hover: { key: string | null; amount: number; target: number } = { key: null, amount: 0, target: 0 };
  private hoverQR = { q: 0, r: 0 };
  private hold = 0;
  private cursor = { x: 0, z: 0, amt: 0, target: 0 };
  private input: BoardInputListener = {};
  private pointers = new Map<number, { x: number; y: number }>();
  private orbit: { id: number; x: number; y: number; button: number } | null = null;
  /** Primary-button press: becomes a click on release, or an orbit once dragged. */
  private press: { id: number; x0: number; y0: number; key: string | null; moved: boolean; mouse: boolean } | null = null;
  private gesture: { dist: number; angle: number; midY: number; zoom: number; rot: number; tilt: number } | null = null;
  private baseRotation = 0;
  private userRotation = 0;
  readonly quality: BoardQuality;
  private hostEl: HTMLElement;
  private cleanup: (() => void)[] = [];

  /** Splash-screen mode: no camera input, lighter rendering, idle sway. */
  private hero: boolean;
  private sway = 0;

  constructor(host: HTMLElement, opts: { quality?: BoardQuality; interactive?: boolean; hero?: boolean } = {}) {
    this.hostEl = host;
    this.hero = !!opts.hero;
    this.quality = opts.quality ?? (this.hero ? 'low' : detectQuality());
    const shared = this.shared;
    const terrain = createTerrainMaterial(shared, this.tex);
    this.terrainMat = terrain.material;
    this.terrainUniforms = terrain.uniforms;
    this.slabMat = createSlabMaterial(shared);
    this.propMat = createPropMaterial(shared);

    const uniformsForPools = { uTime: shared.uTime, uWind: shared.uWind, uPixelScale: this.pixelScale };
    this.smokePool = new ParticlePool(this.quality === 'low' ? 1500 : 3000, false, uniformsForPools);
    this.glowPool = new ParticlePool(this.quality === 'low' ? 1200 : 2400, true, uniformsForPools);

    this.sun = new DirectionalLight(0xffd29a, 2.9);
    const self = this;
    this.transform = {
      scale: 1, offsetX: 0, offsetY: 0, rotation: 0, pivotX: 0, pivotY: 0,
      project: (lx, ly, lift = 0) => self.projectLocal(lx, ly, lift),
      unproject: (cx, cy) => self.unprojectLocal(cx, cy),
    };

    this.ok = webglAvailable();
    if (!this.ok) return;
    try {
      this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      this.ok = false;
      return;
    }
    const r = this.renderer;
    const dpr = window.devicePixelRatio || 1;
    r.setPixelRatio(Math.min(dpr, this.hero ? 2 : this.quality === 'low' ? 1.5 : 2));
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = SRGBColorSpace;
    r.toneMapping = ACESFilmicToneMapping;
    r.toneMappingExposure = 1.12;
    r.shadowMap.enabled = true;
    r.shadowMap.type = PCFSoftShadowMap;
    this.canvas = r.domElement;
    const canvas = r.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    canvas.style.display = 'block';
    host.appendChild(canvas);

    // ── Lights ──
    const hemi = new HemisphereLight(0x8ea2d8, 0x3a2c1e, 0.62);
    this.scene.add(hemi);
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.quality === 'low' ? 1024 : 2048, this.quality === 'low' ? 1024 : 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.025;
    sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);
    const rim = new DirectionalLight(0x6f86d8, 0.5);
    rim.position.set(6, 4, 7);
    this.scene.add(rim);
    this.scene.fog = new Fog(0x0e0e22, 30, 80);

    this.scene.add(this.world);
    this.world.add(this.structureGroup);
    this.scene.add(this.smokePool.points, this.glowPool.points);

    this.attachInput(canvas, opts.interactive !== false, !this.hero);
    if (!this.hero) this.rig.padding = 26;
    this.ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.resize()) : null;
    this.ro?.observe(host);
    this.resize();
    this.raf = requestAnimationFrame(this.loop);

    const onVis = () => { if (!document.hidden) this.kick(); };
    document.addEventListener('visibilitychange', onVis);
    this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  // ── Public API ─────────────────────────────────────────────────────────

  get fx(): FxLayer | null {
    return this.fxLayer;
  }

  setInputListener(l: BoardInputListener): void {
    this.input = l;
  }

  onFrame(cb: () => void): () => void {
    this.frameCbs.add(cb);
    return () => this.frameCbs.delete(cb);
  }

  /** Padding (CSS px) kept around the fitted board. */
  setPadding(px: number): void {
    this.rig.padding = px;
    this.rig.setSize(this.rig.width, this.rig.height);
    this.kick(0.3);
  }

  /** Keep the board framed above a bottom band of the canvas (CSS px). */
  setInsetBottom(px: number): void {
    if (this.rig.insetBottom === px) return;
    this.rig.insetBottom = px;
    this.resize();
  }

  /** Slow idle camera sway (splash screen). Amplitude in radians. */
  setSway(amplitude: number): void {
    this.sway = amplitude;
  }

  setSpeed(mult: number): void {
    this.speed = mult;
    this.terrainUniforms.uTransDur.value = mult <= 0 ? 0.0001 : 0.6 * Math.max(0.5, mult);
    this.fxLayer?.setSpeed(mult);
    this.markers?.setAnimate(mult > 0);
    this.roads?.setAnimate(mult > 0);
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    if (p) {
      this.renderNow();
    } else {
      this.kick();
    }
  }

  /** Board build-in (0 = hidden, 1 = built). undefined = no animation. */
  setBuildProgress(p: number | undefined): void {
    const v = p === undefined ? 1 : Math.max(0, Math.min(1, p));
    if (v < 1 && this.build >= 1 && v < 0.05) this.rig.intro();
    this.build = v;
    this.shared.uBuild.value = v;
    this.kick(1.5);
  }

  /** Base rotation from the game (seat-relative); user orbit adds on top. */
  /** Restart the camera swoop-in (used when an intro begins after a delay). */
  playIntro(): void {
    this.rig.intro();
    this.kick(2);
  }

  setRotation(rad: number): void {
    this.baseRotation = rad;
    this.rig.rotation = this.baseRotation + this.userRotation;
    this.kick(1.5);
  }

  rotateBy(rad: number): void {
    this.userRotation += rad;
    this.rig.rotation = this.baseRotation + this.userRotation;
    this.kick(1.5);
  }

  get tilt(): number { return this.rig.tilt; }

  private swayTilt = DEFAULT_TILT;

  setTilt(t: number): void {
    this.rig.tilt = Math.max(0, Math.min(MAX_TILT, t));
    this.swayTilt = this.rig.tilt;
    this.kick(1.5);
  }

  toggleTilt(): void {
    this.setTilt(this.rig.tilt > DEFAULT_TILT + 0.15 ? DEFAULT_TILT : 0.85);
  }

  zoomBy(factor: number, aboutX?: number, aboutY?: number): void {
    const rig = this.rig;
    const prevZoom = rig.zoom;
    const next = Math.max(1, Math.min(MAX_ZOOM, prevZoom * factor));
    if (next === prevZoom) return;
    if (aboutX != null && aboutY != null && next > 1) {
      // Keep the point under the cursor fixed (approximately) while zooming.
      const before = rig.groundPoint(aboutX, aboutY, 0.05);
      const center = rig.groundPoint(rig.width / 2, rig.viewHeight / 2, 0.05);
      if (before && center) {
        const k = 1 - prevZoom / next;
        rig.pan.x += (before.x - center.x) * k;
        rig.pan.y += (before.z - center.z) * k;
      }
    }
    rig.zoom = next;
    if (next <= 1.001) rig.pan.set(0, 0);
    this.clampPan();
    this.kick(1.5);
  }

  resetView(): void {
    this.userRotation = 0;
    this.rig.rotation = this.baseRotation;
    this.rig.zoom = 1;
    this.rig.pan.set(0, 0);
    this.rig.tilt = DEFAULT_TILT;
    this.kick(1.5);
  }

  /** Sync game tiles (ownership, defense, structure). */
  setBoard(tiles: Record<string, HexTile>, playerInfo: Record<string, PlayerInfo> | undefined, connected: Set<string> | undefined): void {
    if (!this.ok) return;
    this.tiles = tiles;
    this.playerInfo = playerInfo ?? {};
    this.connected = connected ?? new Set();
    const sig = structureSignature(tiles);
    if (sig !== this.layoutSig) {
      const first = !this.layout;
      this.layoutSig = sig;
      this.rebuildLayout(first);
    }
    this.syncStructures();
    this.writeTileTextures();
    this.syncBarriers();
    this.syncPickProxies();
    this.syncFloating();
    this.kick(1);
  }

  setOverlay(o: OverlayState): void {
    this.overlay = o;
    if (this.ok) this.writeTileTextures(true);
    this.syncFloating();
    this.kick(0.3);
  }

  private syncFloating(): void {
    this.floating?.setSets(this.tiles, {
      hover: this.hover.key ? new Set([this.hover.key]) : undefined,
      highlight: this.overlay.highlight,
      weak: this.overlay.weak,
      multi: this.overlay.multi,
      review: this.overlay.review,
    });
  }

  setHover(key: string | null): void {
    if (key === this.hover.key) return;
    this.hover.key = key;
    this.hover.target = key ? 1 : 0;
    if (key) {
      const [q, r] = key.split(',').map(Number);
      this.hoverQR = { q, r };
      this.hover.amount = 1;
      this.syncFloating();
    }
    this.kick(0.3);
  }

  setHold(progress: number): void {
    this.hold = progress;
    this.kick(0.2);
  }

  setTokens(specs: TokenSpec[]): void {
    this.markers?.setTokens(specs);
    this.kick(1.2);
  }

  setChevrons(c: ClaimChevron[] | undefined): void {
    this.markers?.setChevrons(c);
    this.kick(0.3);
  }

  /** VP connections, rendered as cobbled roads from each castle to its towns. */
  setPaths(p: VpPath[] | undefined): void {
    this.paths = p;
    this.roads?.setPaths(p, this.tiles);
    this.kick(1);
  }

  private paths: VpPath[] | undefined;

  /** Pick the tile under a container-relative point. */
  pickTile(cx: number, cy: number): string | null {
    if (!this.pickMesh || !this.ok) return null;
    const rc = this.rig.raycaster;
    rc.setFromCamera(this.rig.ndc(cx, cy), this.rig.camera);
    const hits = rc.intersectObject(this.pickMesh, false);
    if (!hits.length || hits[0].faceIndex == null) return null;
    return this.pickKeys[hits[0].faceIndex] ?? null;
  }

  projectLocal(lx: number, ly: number, lift = 0): { x: number; y: number } {
    if (!this.layout) return { x: 0, y: 0 };
    const x = lx / HEX_SIZE, z = ly / HEX_SIZE;
    const y = this.layout.heightAt(x, z) + lift;
    return this.rig.project(new Vector3(x, y, z));
  }

  unprojectLocal(cx: number, cy: number): { x: number; y: number } | null {
    const key = this.pickTile(cx, cy);
    if (key) {
      const [q, r] = key.split(',').map(Number);
      const w = axialToWorld(q, r);
      return { x: w.x * HEX_SIZE, y: w.z * HEX_SIZE };
    }
    const p = this.rig.groundPoint(cx, cy, 0.05);
    return p ? { x: p.x * HEX_SIZE, y: p.z * HEX_SIZE } : null;
  }

  /** Project a world point (for labels). */
  projectWorld(v: Vector3, out?: { x: number; y: number }): { x: number; y: number } {
    return this.rig.project(v, out);
  }

  /** World center + ground height of a tile. */
  tileWorld(key: string, lift = 0): Vector3 | null {
    const tl = this.layout?.byKey.get(key);
    if (!tl || !this.layout) return null;
    return new Vector3(tl.x, this.layout.heightAt(tl.x, tl.z) + lift, tl.z);
  }

  /** On-screen vertical extent (container px) of a tile's hexagon — its six
   *  corners at ground height. Things that float over a tile (its played
   *  cards) sit above `top` so they never cover the tile itself. */
  tileScreenSpan(key: string): { top: number; bottom: number } | null {
    const tl = this.layout?.byKey.get(key);
    if (!tl || !this.layout) return null;
    const y = this.layout.heightAt(tl.x, tl.z);
    const v = new Vector3();
    const p = { x: 0, y: 0 };
    let top = Infinity;
    let bottom = -Infinity;
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k;
      this.rig.project(v.set(tl.x + Math.cos(a), y, tl.z + Math.sin(a)), p);
      if (p.y < top) top = p.y;
      if (p.y > bottom) bottom = p.y;
    }
    return { top, bottom };
  }

  /** 0..1 visibility of a tile during the build-in (matches the terrain stagger). */
  buildAlpha(key: string): number {
    if (this.build >= 1) return 1;
    const tl = this.layout?.byKey.get(key);
    if (!tl || !this.layout) return 0;
    const stagger = tl.ring / Math.max(1, this.layout.maxRing);
    const t = Math.max(0, Math.min(1, (this.build - stagger * 0.6) / 0.4));
    return t * t;
  }

  /** Height a label should sit at above a tile's structure. */
  structureLift(key: string): number {
    const t = this.tiles[key];
    return t ? structureHeight(t) : 0.1;
  }

  pixelsPerUnitAt(v: Vector3): number {
    return this.rig.pixelsPerUnit(v);
  }

  /** Keep the loop at full rate for a while (interaction, animation). */
  kick(seconds = 0.5): void {
    this.busyUntil = Math.max(this.busyUntil, performance.now() / 1000 + seconds);
    if (!this.raf && !this.disposed && this.ok && !this.paused) this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * Compile every shader in the scene (in parallel where the GPU driver
   * allows) and render one real frame, so the first visible frames don't
   * stall on shader compiles or texture uploads.
   */
  async warmUp(): Promise<void> {
    const r = this.renderer;
    if (!r || this.disposed) return;
    this.rig.update(0);
    try {
      await r.compileAsync(this.scene, this.rig.camera);
    } catch {
      // Older drivers: fall through and let the first render compile.
    }
    if (this.disposed) return;
    await new Promise<void>((resolve) => {
      const off = this.onFrame(() => { off(); resolve(); });
      this.kick(0.3);
      // Paused or hidden tab: don't hang the boot on a frame that never comes.
      setTimeout(() => { off(); resolve(); }, 1500);
    });
  }

  renderNow(): void {
    if (!this.renderer || this.disposed) return;
    this.rig.update(0);
    this.renderer.render(this.scene, this.rig.camera);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ro?.disconnect();
    for (const c of this.cleanup) c();
    this.clearLayout();
    this.smokePool.dispose();
    this.glowPool.dispose();
    this.terrainMat.dispose();
    this.slabMat.dispose();
    this.propMat.material.dispose();
    this.propMat.depth.dispose();
    this.roads?.dispose();
    this.floating?.dispose();
    this.decorMat?.material.dispose();
    this.decorMat?.depth.dispose();
    this.tex.color.dispose();
    this.tex.prev.dispose();
    this.tex.state.dispose();
    const r = this.renderer;
    this.renderer = null;
    if (r) {
      const canvas = r.domElement;
      // Detach now; release the GL context after the next paint so the
      // compositor never shows a lost-context white frame.
      canvas.style.display = 'none';
      canvas.remove();
      const release = () => {
        try { r.dispose(); r.forceContextLoss(); } catch { /* already gone */ }
      };
      requestAnimationFrame(() => setTimeout(release, 32));
    }
  }

  // ── Layout / layers ────────────────────────────────────────────────────

  private clearLayout(): void {
    const disposeMesh = (m: Mesh | null) => {
      if (!m) return;
      m.parent?.remove(m);
      m.geometry.dispose();
    };
    disposeMesh(this.terrainMesh); this.terrainMesh = null;
    disposeMesh(this.slabMesh); this.slabMesh = null;
    disposeMesh(this.decorMesh); this.decorMesh = null;
    if (this.waterMesh) { this.world.remove(this.waterMesh); this.waterDispose?.(); this.waterMesh = null; }
    if (this.underGlow) { this.world.remove(this.underGlow); this.underGlow.geometry.dispose(); (this.underGlow.material as MeshBasicMaterial).dispose(); this.underGlow = null; }
    for (const [, s] of this.structures) if (s.mesh) { this.structureGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
    this.structures.clear();
    this.structureSpots.clear();
    if (this.ambient) { this.world.remove(this.ambient.group); this.ambient.dispose(); this.ambient = null; }
    if (this.markers) { this.world.remove(this.markers.group); this.markers.dispose(); this.markers = null; }
    if (this.fxLayer) { this.world.remove(this.fxLayer.group); this.fxLayer.dispose(); this.fxLayer = null; }
    if (this.pickMesh) { this.pickMesh.geometry.dispose(); this.pickMesh = null; }
  }

  private rebuildLayout(first: boolean): void {
    // Keep fx/markers/ambient objects across structural changes when possible.
    const layout = new BoardLayout(this.tiles);
    this.layout = layout;

    const disposeMesh = (m: Mesh | null) => { if (m) { m.parent?.remove(m); m.geometry.dispose(); } };
    disposeMesh(this.terrainMesh);
    disposeMesh(this.slabMesh);
    disposeMesh(this.decorMesh);
    if (this.waterMesh) { this.world.remove(this.waterMesh); this.waterDispose?.(); }
    if (this.underGlow) { this.world.remove(this.underGlow); this.underGlow.geometry.dispose(); }

    this.terrainMesh = new Mesh(buildTerrainGeometry(layout), this.terrainMat);
    this.terrainMesh.receiveShadow = true;
    this.world.add(this.terrainMesh);

    this.slabMesh = new Mesh(buildSlabGeometry(layout, this.tiles), this.slabMat);
    this.slabMesh.receiveShadow = true;
    this.world.add(this.slabMesh);

    const water = buildWater(layout, this.shared);
    this.waterMesh = water.mesh;
    this.waterDispose = water.dispose;
    this.world.add(water.mesh);
    this.underGlow = buildUnderGlow(layout, this.shared);
    this.world.add(this.underGlow);

    this.decorSpots = emptySpots();
    const decor = buildDecor(layout, this.tiles, this.decorSpots);
    const decorMat = this.decorMat ?? this.propMat;
    this.decorMesh = new Mesh(decor.toGeometry(), decorMat.material);
    this.decorMesh.customDepthMaterial = decorMat.depth;
    this.decorMesh.castShadow = true;
    this.decorMesh.receiveShadow = true;
    this.world.add(this.decorMesh);

    // Structures depend on terrain heights → rebuild them all.
    for (const [, s] of this.structures) if (s.mesh) { this.structureGroup.remove(s.mesh); s.mesh.geometry.dispose(); }
    this.structures.clear();
    this.structureSpots.clear();

    if (!this.fxLayer) {
      const fx = new FxLayer(layout, this.glowPool, this.smokePool, {
        shake: (s, ms) => { this.rig.shake(s, ms); this.kick(ms / 1000 + 0.2); },
        jolt: (q, r, s) => this.joltStructure(`${q},${r}`, s),
      });
      fx.setSpeed(this.speed);
      this.fxLayer = fx;
      this.world.add(fx.group);
    } else {
      this.fxLayer.setLayout(layout);
    }
    if (!this.markers) {
      this.markers = new MarkerLayer(layout, this.propMat, this.fxLayer!, this.glowPool, this.smokePool);
      this.markers.setAnimate(this.speed > 0);
      this.world.add(this.markers.group);
    } else {
      this.markers.setLayout(layout);
    }
    if (!this.roads) {
      this.roads = new RoadLayer(layout, this.fxLayer!, this.ownerColor);
      this.roads.setAnimate(this.speed > 0);
      this.world.add(this.roads.group);
      this.decorMat = createPropMaterial(this.shared, { tex: this.roads.mask, rect: this.roads.maskRect });
      if (this.decorMesh) {
        this.decorMesh.material = this.decorMat.material;
        this.decorMesh.customDepthMaterial = this.decorMat.depth;
      }
    } else {
      this.roads.setLayout(layout);
    }
    if (this.paths) this.roads.setPaths(this.paths, this.tiles);
    if (!this.floating) {
      this.floating = new FloatingOverlay(layout);
      this.world.add(this.floating.group);
    } else {
      this.floating.setLayout(layout);
    }
    if (!this.ambient) {
      this.ambient = new AmbientLayer(layout, this.smokePool, this.glowPool);
      this.ambient.density = this.quality === 'low' ? 0.5 : 1;
      this.world.add(this.ambient.group);
    } else {
      this.ambient.setLayout(layout);
    }

    // Sun + shadow frustum sized to the island.
    const R = layout.radius + 1.5;
    // Low golden-hour sun from the upper-left: long, readable shadows.
    this.sun.position.set(-R * 0.95, R * 0.95, -R * 0.35);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
    cam.near = 0.5; cam.far = R * 4;
    cam.updateProjectionMatrix();

    // Camera fit points: island corners at ground and mid-structure height.
    const pts: Vector3[] = [];
    for (const tl of layout.tiles) {
      let boundary = false;
      for (const [dq, dr] of HEX_DIRS) if (!this.tiles[`${tl.q + dq},${tl.r + dr}`]) boundary = true;
      if (!boundary) continue;
      for (let k = 0; k < 6; k++) {
        const c = hexCorner(tl.x, tl.z, k, 1.02);
        pts.push(new Vector3(c.x, 0, c.z));
      }
      const t = this.tiles[tl.key];
      pts.push(new Vector3(tl.x, t ? Math.max(0.45, structureHeight(t) * 0.9) : 0.45, tl.z));
    }
    this.rig.setFitPoints(pts);
    if (first) this.rig.snap();
    this.pickHeights = '';
  }

  private ownerColor = (pid: string): number => PLAYER_COLORS[pid] ?? 0x888888;
  private archetypeOf = (pid: string): string => this.playerInfo[pid]?.archetype ?? 'vanguard';

  private syncStructures(): void {
    const layout = this.layout;
    if (!layout) return;
    const now = this.time;
    const animate = this.speed > 0 && this.build >= 1;
    let spotsChanged = false;
    for (const tl of layout.tiles) {
      const t = this.tiles[tl.key];
      if (!t) continue;
      const spec = structureSpec(t, this.archetypeOf, this.ownerColor, this.connected.has(tl.key));
      const entry = this.structures.get(tl.key);
      if (entry && entry.signature === spec.signature) continue;
      spotsChanged = true;
      if (entry?.mesh) {
        this.structureGroup.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
      const spots = emptySpots();
      const soup = spec.kind === 'none' ? null : buildStructure(t, tl, layout, this.tiles, this.archetypeOf, this.ownerColor, this.connected.has(tl.key), spots);
      this.structureSpots.set(tl.key, spots);
      let mesh: Mesh | null = null;
      if (soup) {
        mesh = new Mesh(soup.toGeometry(), this.propMat.material);
        mesh.customDepthMaterial = this.propMat.depth;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.structureGroup.add(mesh);
      }
      // Rising animation for walls / new mountains; instant swaps otherwise.
      const kind = spec.kind;
      const grew = !!entry && (kind === 'walls' || kind === 'mountain' || (kind === 'town' && spec.signature.split('|')[4] !== entry.signature.split('|')[4]));
      const rise = animate && grew;
      const se: StructureEntry = {
        signature: spec.signature, mesh, born: now, rise, jolt: 0, joltAt: 0,
        base: new Vector3(tl.x, layout.heightAt(tl.x, tl.z), tl.z),
      };
      if (mesh && rise) mesh.scale.set(1, 0.001, 1);
      this.structures.set(tl.key, se);
      if (entry && animate) {
        const lx = tl.x * HEX_SIZE, lz = tl.z * HEX_SIZE;
        if (kind === 'mountain') {
          this.fxLayer?.dust(lx, lz, 30, 1.6);
          this.fxLayer?.shake(0.6, 500);
        } else if (rise) {
          this.fxLayer?.dust(lx, lz, 14, 0.9);
        } else if (kind === 'town' || kind === 'castle') {
          this.fxLayer?.pillar(lx, lz, kind === 'town' ? 0xffd24a : this.ownerColor(t.owner ?? ''), 900);
        }
      }
    }
    if (spotsChanged && this.ambient) {
      const merged = emptySpots();
      const append = (s: AmbientSpots) => {
        merged.chimneys.push(...s.chimneys);
        merged.windmills.push(...s.windmills);
        merged.pastures.push(...s.pastures);
        merged.peaks.push(...s.peaks);
        merged.torches.push(...s.torches);
      };
      append(this.decorSpots);
      for (const s of this.structureSpots.values()) append(s);
      const castles = layout.tiles.filter(tl => this.tiles[tl.key]?.is_base).map(tl => ({ x: tl.x, y: layout.heightAt(tl.x, tl.z), z: tl.z }));
      // Pastures on tiles that are no longer pastures (became mountains) are dropped by decor rebuild.
      this.ambient.setSpots(merged, castles);
    }
  }

  private joltStructure(key: string, strength: number): void {
    const s = this.structures.get(key);
    if (!s) return;
    s.jolt = Math.max(s.jolt, strength);
    s.joltAt = this.time;
    this.kick(0.6);
  }

  /** In-flight ownership sweeps: tile → start time + origin angle. */
  private sweeps = new Map<string, { start: number; angle: number }>();

  private writeTileTextures(overlayOnly = false): void {
    const layout = this.layout;
    if (!layout) return;
    const col = this.tex.color.image.data as Uint8Array;
    const prev = this.tex.prev.image.data as Uint8Array;
    const st = this.tex.state.image.data as Float32Array;
    const o = this.overlay;
    const now = this.time;
    const animate = this.speed > 0 && this.build >= 1;
    const writeRGB = (arr: Uint8Array, i: number, hex: number | null) => {
      const j = i * 4;
      if (hex == null) { arr[j] = 0; arr[j + 1] = 0; arr[j + 2] = 0; arr[j + 3] = 0; return; }
      arr[j] = (hex >> 16) & 255;
      arr[j + 1] = (hex >> 8) & 255;
      arr[j + 2] = hex & 255;
      arr[j + 3] = 255;
    };
    for (const [key, sw] of this.sweeps) if (sw.start < now - 3) this.sweeps.delete(key);
    st.fill(0);
    if (!overlayOnly) { col.fill(0); }
    const hasTargets = !!(o.highlight?.size || o.weak?.size);
    for (const tl of layout.tiles) {
      const t = this.tiles[tl.key];
      const i = tileTexIndex(tl.q, tl.r);
      if (i < 0 || !t) continue;
      let flags = TF.EXISTS;
      if (t.is_blocked) flags |= TF.BLOCKED;
      if (t.is_vp) flags |= TF.VP;
      if (t.is_base) flags |= TF.BASE;
      if (t.immune) flags |= TF.IMMUNE;
      if (o.highlight?.has(tl.key)) flags |= TF.HIGHLIGHT;
      if (o.weak?.has(tl.key)) flags |= TF.WEAK;
      if (o.multi?.has(tl.key)) flags |= TF.MULTI;
      if (o.review?.has(tl.key)) flags |= TF.REVIEW;
      if (o.activePlayer && t.owner === o.activePlayer && !hasTargets) flags |= TF.ACTIVE_TERRITORY;
      if (!overlayOnly) {
        const owner = t.owner ?? null;
        const had = this.prevOwner.has(tl.key);
        const before = had ? this.prevOwner.get(tl.key)! : owner;
        if (had && before !== owner) {
          if (animate) {
            writeRGB(prev, i, before ? this.ownerColor(before) : null);
            this.sweeps.set(tl.key, { start: now, angle: this.sweepAngle(tl.q, tl.r, owner) });
            if (owner) this.fxLayer?.captureBurst(tl.q, tl.r, this.ownerColor(owner), !!t.is_base || !!t.is_vp);
          } else {
            this.sweeps.delete(tl.key);
          }
        }
        writeRGB(col, i, owner ? this.ownerColor(owner) : null);
        this.prevOwner.set(tl.key, owner);
      }
      const sw = this.sweeps.get(tl.key);
      st[i * 4] = flags;
      st[i * 4 + 1] = sw ? sw.start : -1000;
      st[i * 4 + 2] = sw ? sw.angle : 0;
    }
    if (!overlayOnly) {
      this.tex.color.needsUpdate = true;
      this.tex.prev.needsUpdate = true;
    }
    this.tex.state.needsUpdate = true;
  }

  /** Direction the new owner's color sweeps in from (toward their territory). */
  private sweepAngle(q: number, r: number, owner: string | null): number {
    if (!owner) return 99;
    let sx = 0, sz = 0, n = 0;
    for (let k = 0; k < 6; k++) {
      const [dq, dr] = HEX_DIRS[k];
      const nt = this.tiles[`${q + dq},${r + dr}`];
      if (nt?.owner === owner) {
        const a = Math.PI / 6 + (Math.PI / 3) * k;
        sx += Math.cos(a); sz += Math.sin(a); n++;
      }
    }
    if (!n || Math.hypot(sx, sz) < 0.2) return 99;
    return Math.atan2(sz, sx);
  }

  private syncBarriers(): void {
    if (!this.markers || !this.layout) return;
    const entries: { key: string; q: number; r: number; temp: number; immune: boolean }[] = [];
    for (const tl of this.layout.tiles) {
      const t = this.tiles[tl.key];
      if (!t || t.is_blocked) continue;
      const persist = t.base_defense + (t.permanent_defense_bonus ?? 0);
      const temp = t.defense_power - persist;
      if (t.immune || temp > 0) entries.push({ key: tl.key, q: tl.q, r: tl.r, temp: Math.max(0, temp), immune: !!t.immune });
    }
    this.markers.setBarriers(entries);
  }

  /** Invisible hex frustums used for picking (cover castles / mountains). */
  private syncPickProxies(): void {
    const layout = this.layout;
    if (!layout) return;
    const heights = layout.tiles.map(tl => {
      const t = this.tiles[tl.key];
      return t ? `${tl.key}:${structureHeight(t).toFixed(2)}` : '';
    }).join('|');
    if (heights === this.pickHeights && this.pickMesh) return;
    this.pickHeights = heights;
    const pos: number[] = [];
    const keys: string[] = [];
    for (const tl of layout.tiles) {
      const t = this.tiles[tl.key];
      if (!t) continue;
      const h = structureHeight(t) * 0.85 + 0.05;
      const topR = t.is_blocked ? 0.38 : t.is_base ? 0.72 : 1;
      const bottomY = -0.2;
      const bottom = Array.from({ length: 6 }, (_, k) => hexCorner(tl.x, tl.z, k, 1));
      const top = Array.from({ length: 6 }, (_, k) => hexCorner(tl.x, tl.z, k, topR));
      const tri = (a: number[], b: number[], c: number[]) => { pos.push(...a, ...b, ...c); keys.push(tl.key); };
      for (let k = 0; k < 6; k++) {
        const j = (k + 1) % 6;
        const b0 = [bottom[k].x, bottomY, bottom[k].z], b1 = [bottom[j].x, bottomY, bottom[j].z];
        // Edge-of-frustum: flat tiles use a vertical wall at the hex edge.
        const t0 = [top[k].x, h, top[k].z], t1 = [top[j].x, h, top[j].z];
        tri(b0, t0, t1); tri(b0, t1, b1);
        tri([tl.x, h, tl.z], t1, t0);
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    if (this.pickMesh) this.pickMesh.geometry.dispose();
    const mat = new MeshBasicMaterial({ side: DoubleSide });
    this.pickMesh = new Mesh(g, mat);
    this.pickMesh.updateMatrixWorld();
    this.pickKeys = keys;
  }

  // ── Input ──────────────────────────────────────────────────────────────

  private attachInput(canvas: HTMLCanvasElement, interactive: boolean, cameraInput: boolean): void {
    const rel = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const updateCursor = (x: number, y: number) => {
      const p = this.rig.groundPoint(x, y, 0.05);
      if (p) { this.cursor.x = p.x; this.cursor.z = p.z; this.cursor.target = 1; }
    };

    const onMove = (e: PointerEvent) => {
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = rel(e);
      if (this.orbit && e.pointerId === this.orbit.id) {
        const dx = e.clientX - this.orbit.x;
        const dy = e.clientY - this.orbit.y;
        this.orbit.x = e.clientX;
        this.orbit.y = e.clientY;
        if (e.shiftKey || this.orbit.button === 1) {
          this.panBy(dx, dy);
        } else {
          // Grab-and-turn: the board's near side follows the cursor
          // (drag right → it turns right; drag down → it tips back toward
          // top-down, drag up → it tips further over).
          this.userRotation -= dx * 0.006;
          this.rig.rotation = this.baseRotation + this.userRotation;
          this.setTilt(this.rig.tilt - dy * 0.004);
        }
        this.kick(0.5);
        return;
      }
      if (this.gesture && this.pointers.size >= 2) {
        this.updateGesture();
        return;
      }
      const pr = this.press;
      if (pr && e.pointerId === pr.id && !pr.moved) {
        const dist = Math.hypot(e.clientX - pr.x0, e.clientY - pr.y0);
        if (dist > (pr.mouse ? 6 : 10)) {
          pr.moved = true;
          if (pr.mouse && cameraInput) {
            // Left-drag orbits: hand this pointer over to the camera.
            this.orbit = { id: e.pointerId, x: e.clientX, y: e.clientY, button: 0 };
            canvas.style.cursor = 'grabbing';
            this.input.onGesture?.();
            return;
          }
        }
      }
      updateCursor(p.x, p.y);
      this.input.onPointerMove?.(e);
      if (!interactive) return;
      const key = this.pickTile(p.x, p.y);
      this.input.onHover?.(key, e.clientX, e.clientY, e);
      this.kick(0.25);
    };
    const onDown = (e: PointerEvent) => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!cameraInput) return;
      if (e.button === 2 || e.button === 1) {
        // Orbit / pan: keep the parent from treating this as a deselect click.
        e.stopPropagation();
        e.preventDefault();
        this.orbit = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        this.input.onGesture?.();
        return;
      }
      if (e.pointerType === 'touch' && this.pointers.size >= 2) {
        e.stopPropagation();
        this.press = null;
        this.beginGesture();
        this.input.onGesture?.();
        return;
      }
      if (e.button !== 0) return;
      const p = rel(e);
      const key = interactive ? this.pickTile(p.x, p.y) : null;
      const mouse = e.pointerType !== 'touch';
      this.press = { id: e.pointerId, x0: e.clientX, y0: e.clientY, key, moved: false, mouse };
      if (mouse) {
        try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      if (key) this.input.onTileDown?.(key, e);
    };
    const onUp = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      const pr = this.press && this.press.id === e.pointerId ? this.press : null;
      if (pr) this.press = null;
      if (this.orbit && e.pointerId === this.orbit.id) {
        this.orbit = null;
        canvas.style.cursor = '';
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        return;
      }
      if (pr?.mouse) {
        try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      }
      if (this.gesture) {
        if (this.pointers.size < 2) this.gesture = null;
        return;
      }
      if (!interactive || !pr || pr.moved) return;
      const p = rel(e);
      const key = this.pickTile(p.x, p.y);
      if (pr.key) this.input.onTileUp?.(key, e);
      else if (!key) this.input.onEmptyClick?.(e);
    };
    const onLeave = (e: PointerEvent) => {
      this.cursor.target = 0;
      if (!this.orbit) this.input.onLeave?.(e);
      this.kick(0.3);
    };
    const onCancel = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.gesture = null;
      if (this.orbit?.id === e.pointerId) { this.orbit = null; canvas.style.cursor = ''; }
      if (this.press?.id === e.pointerId) this.press = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!cameraInput) return;
      e.preventDefault();
      const p = rel(e);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomBy(factor, p.x, p.y);
    };
    const onContext = (e: Event) => { if (cameraInput) e.preventDefault(); };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointercancel', onCancel);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContext);
    this.cleanup.push(() => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
    });
  }

  private panBy(dx: number, dy: number): void {
    const cy = this.rig.viewHeight / 2;
    const a = this.rig.groundPoint(this.rig.width / 2, cy, 0);
    const b = this.rig.groundPoint(this.rig.width / 2 + dx, cy + dy, 0);
    if (!a || !b) return;
    this.rig.pan.x -= b.x - a.x;
    this.rig.pan.y -= b.z - a.z;
    if (this.rig.zoom <= 1.001) this.rig.zoom = 1.0001;
    this.clampPan();
  }

  private clampPan(): void {
    const lim = (this.layout?.radius ?? 5) * 0.8 * (1 - 1 / this.rig.zoom) + 0.001;
    const p = this.rig.pan;
    const len = Math.hypot(p.x, p.y);
    if (len > lim) p.multiplyScalar(lim / len);
  }

  private beginGesture(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    this.gesture = {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      midY: (a.y + b.y) / 2,
      zoom: this.rig.zoom,
      rot: this.userRotation,
      tilt: this.rig.tilt,
    };
  }

  private updateGesture(): void {
    const g = this.gesture;
    if (!g) return;
    const pts = [...this.pointers.values()];
    const [a, b] = pts;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const midY = (a.y + b.y) / 2;
    this.rig.zoom = Math.max(1, Math.min(MAX_ZOOM, g.zoom * (dist / Math.max(1, g.dist))));
    if (this.rig.zoom <= 1.001) this.rig.pan.set(0, 0);
    this.userRotation = g.rot + (angle - g.angle);
    this.rig.rotation = this.baseRotation + this.userRotation;
    this.setTilt(g.tilt - (midY - g.midY) * 0.006);
    this.kick(0.5);
  }

  // ── Loop ───────────────────────────────────────────────────────────────

  private resize(): void {
    if (!this.renderer) return;
    const w = this.hostEl.clientWidth;
    const h = this.hostEl.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.rig.setSize(w, h);
    this.pixelScale.value = (this.rig.viewHeight * this.renderer.getPixelRatio()) / (2 * Math.tan((this.rig.camera.fov * Math.PI) / 360));
    this.kick(0.5);
    if (this.paused) this.renderNow();
  }

  private loop = (nowMs: number): void => {
    this.raf = 0;
    if (this.disposed || !this.renderer || this.paused) return;
    // Schedule the next frame first so kick() calls made while stepping
    // never start a second loop.
    this.raf = requestAnimationFrame(this.loop);
    const now = nowMs / 1000;
    const dt = Math.min(0.1, this.lastFrame ? now - this.lastFrame : 1 / 60);
    this.lastFrame = now;
    const busy = now < this.busyUntil || (this.rig.moving && this.sway === 0) || this.build < 1;
    // Ambient-only scenes render at ~30fps to spare the battery.
    const minInterval = busy ? 0 : this.quality === 'low' ? 1 / 24 : 1 / 30;
    if (now - this.lastRender < minInterval - 0.002) return;
    const step = this.lastRender ? Math.min(0.1, now - this.lastRender) : dt;
    this.lastRender = now;
    this.step(step);
    this.renderer.render(this.scene, this.rig.camera);
    for (const cb of this.frameCbs) cb();
  };

  private step(dt: number): void {
    this.time += dt;
    const t = this.time;
    const s = this.shared;
    s.uTime.value = t;
    s.uCloud.value.set(t * 0.012, t * 0.007);
    if (this.sway > 0) {
      this.rig.rotation = this.baseRotation + this.userRotation + Math.sin(t * 0.21) * this.sway;
      this.rig.tilt = this.swayTilt + Math.sin(t * 0.17 + 1.3) * this.sway * 0.35;
    }
    const moving = this.rig.update(dt);
    if (moving) this.kick(0.2);

    // Fog follows camera distance so tilted views fade into the backdrop.
    const dist = this.rig.camera.position.length();
    const fog = this.scene.fog as Fog;
    fog.near = dist * 1.05;
    fog.far = dist * 2.4;

    // Hover / hold / cursor uniforms
    const h = this.hover;
    if (!h.key) h.amount = Math.max(0, h.amount - dt * 8);
    const tu = this.terrainUniforms;
    tu.uHover.value.set(this.hoverQR.q, this.hoverQR.r, h.key ? 1 : h.amount, this.hold);
    this.cursor.amt += (this.cursor.target - this.cursor.amt) * Math.min(1, dt * 6);
    tu.uCursor.value.set(this.cursor.x, 0, this.cursor.z, this.cursor.amt);

    // Structures: rise-in + jolts
    for (const [, se] of this.structures) {
      if (!se.mesh) continue;
      if (se.rise) {
        const k = Math.min(1, (t - se.born) / Math.max(0.2, 0.75 * Math.max(0.5, this.speed)));
        const e = k >= 1 ? 1 : 1 - Math.pow(1 - k, 3) * Math.cos(k * 6) * 1;
        const sy = Math.max(0.001, Math.min(1.12, e));
        se.mesh.scale.set(1, sy, 1);
        se.mesh.position.y = se.base.y * (1 - sy);
        if (k >= 1) { se.rise = false; se.mesh.scale.set(1, 1, 1); se.mesh.position.y = 0; }
        this.kick(0.1);
      }
      if (se.jolt > 0) {
        const age = t - se.joltAt;
        const amp = se.jolt * 0.03 * Math.max(0, 1 - age / 0.45);
        se.mesh.position.x = Math.sin(age * 90) * amp;
        se.mesh.position.z = Math.cos(age * 77) * amp;
        if (age > 0.45) { se.jolt = 0; se.mesh.position.x = 0; se.mesh.position.z = 0; }
      }
    }

    const tilt = this.rig.currentTilt;
    this.tiltFactor = Math.max(0, Math.min(1, (tilt - 0.5) / 0.28));
    this.tiltFactor = this.tiltFactor * this.tiltFactor * (3 - 2 * this.tiltFactor);
    this.floating?.update(dt, t, this.tiltFactor, h.key ? 1 : h.amount);
    this.markers?.setLift(this.tiltFactor);
    this.ambient?.update(dt, t, this.build);
    const fxBusy = this.fxLayer?.update(dt, t) ?? false;
    this.markers?.update(dt, t);
    if (this.roads?.update(dt, t)) this.kick(0.15);
    if (fxBusy) this.kick(0.15);
    this.smokePool.flush();
    this.glowPool.flush();

    // Keep the legacy transform fields roughly in sync.
    if (this.layout) {
      const tf = this.transform;
      const center = new Vector3(0, 0, 0);
      const ppu = this.rig.pixelsPerUnit(center);
      const c = this.rig.project(center);
      tf.scale = ppu / HEX_SIZE;
      tf.rotation = this.rig.currentRotation;
      tf.pivotX = 0;
      tf.pivotY = 0;
      tf.offsetX = c.x;
      tf.offsetY = c.y;
    }
  }
}
