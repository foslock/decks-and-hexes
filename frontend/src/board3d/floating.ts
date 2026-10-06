import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, ShaderMaterial,
} from 'three';
import type { HexTile } from '../types/game';
import { HEX_DIRS } from '../utils/hexGeometry';
import type { BoardLayout } from './layout';
import { hexCorner } from './layout';
import type { SharedUniforms } from './materials';
import { structureHeight } from './props';

/**
 * Floating tile overlays for tilted views. Flat outlines painted on the
 * terrain foreshorten and hide behind castles and peaks once the camera
 * tilts, so the same hover / target / selection outlines are also drawn as
 * glowing hologram prisms hovering above the tiles: a bright rim at the
 * top and a translucent curtain falling to the ground. They fade in only
 * past a readable angle — and, while the board rises from the sea, only on
 * tiles that have come all the way up (never over open water).
 */

const VERT = /* glsl */ `
attribute vec2 aUv;
attribute float aStagger;
uniform float uBuild;
varying vec2 vUv2;
varying float vUp;
void main() {
  vUv2 = aUv;
  // This tile's own build-in (as the ground's): 0 under water → 1 risen.
  float built = clamp((uBuild - aStagger * 0.6) / 0.4, 0.0, 1.0);
  vUp = smoothstep(0.8, 1.0, built);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uAlpha; uniform float uTime; uniform float uPulse;
varying vec2 vUv2;
varying float vUp;
void main() {
  if (vUp <= 0.0) discard;
  // vUv2.y: 0 at the ground → 1 at the rim; vUv2.x > 1.5 marks rim ribbons.
  float pulse = mix(1.0, 0.55 + 0.45 * (0.5 + 0.5 * sin(uTime * 4.0)), uPulse);
  float a;
  if (vUv2.x > 1.5) {
    a = 0.95;
  } else {
    float h = vUv2.y;
    a = pow(h, 2.2) * 0.32 + (1.0 - smoothstep(0.0, 0.08, 1.0 - h)) * 0.25;
    a *= 0.75 + 0.25 * sin(h * 30.0 - uTime * 3.0);
  }
  a *= uAlpha * pulse * vUp;
  gl_FragColor = vec4(uColor * a * 1.5, 0.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

type SetName = 'hover' | 'highlight' | 'weak' | 'multi' | 'review' | 'focus';

const COLORS: Record<SetName, number> = {
  hover: 0xfff3d6,
  highlight: 0xffd36a,
  weak: 0xff8c1a,
  multi: 0xffe08a,
  review: 0xffffff,
  focus: 0xffe7a8,
};

const PULSE: Record<SetName, number> = { hover: 0, highlight: 1, weak: 1, multi: 0, review: 1, focus: 0 };

interface Layer { mesh: Mesh; mat: ShaderMaterial; sig: string }

export class FloatingOverlay {
  readonly group = new Group();
  private layers = new Map<SetName, Layer>();
  private fade = 0;
  /** The tile being resolved fades its ring in and out on its own, whatever
   *  the tilt. */
  private focusAlpha = 0;
  private focusTarget = 0;

  constructor(private layout: BoardLayout, shared: SharedUniforms) {
    for (const name of Object.keys(COLORS) as SetName[]) {
      const mat = new ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uColor: { value: new Color(COLORS[name]) },
          uAlpha: { value: 0 },
          uTime: { value: 0 },
          uPulse: { value: PULSE[name] },
          uBuild: shared.uBuild,
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: AdditiveBlending,
        premultipliedAlpha: true,
        side: DoubleSide,
      });
      const mesh = new Mesh(new BufferGeometry(), mat);
      mesh.renderOrder = 30;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      this.layers.set(name, { mesh, mat, sig: '' });
    }
  }

  setLayout(layout: BoardLayout): void {
    this.layout = layout;
    for (const l of this.layers.values()) l.sig = '';
  }

  /** Rebuild any set whose membership changed. */
  setSets(tiles: Record<string, HexTile>, sets: Partial<Record<SetName, Set<string> | undefined>>): void {
    for (const [name, layer] of this.layers) {
      const set = sets[name];
      const keys = set ? [...set].filter(k => tiles[k] && !tiles[k].is_blocked).sort() : [];
      const sig = keys.join('|');
      if (sig === layer.sig) continue;
      layer.sig = sig;
      layer.mesh.geometry.dispose();
      layer.mesh.geometry = this.build(keys, tiles, name === 'hover' || name === 'multi' || name === 'focus');
    }
  }

  private build(keys: string[], tiles: Record<string, HexTile>, allEdges: boolean): BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const stagger: number[] = [];
    const inSet = new Set(keys);
    const rim = 0.035;
    const maxRing = Math.max(1, this.layout.maxRing);
    for (const key of keys) {
      const t = tiles[key];
      const tl = this.layout.byKey.get(key);
      if (!t || !tl) continue;
      const before = pos.length;
      const ground = this.layout.heightAt(tl.x, tl.z);
      const top = ground + 0.32 + structureHeight(t) * 0.55;
      for (let k = 0; k < 6; k++) {
        const [dq, dr] = HEX_DIRS[k];
        if (!allEdges && inSet.has(`${t.q + dq},${t.r + dr}`)) continue;
        const a = hexCorner(tl.x, tl.z, k, 0.97);
        const b = hexCorner(tl.x, tl.z, k + 1, 0.97);
        const ga = this.layout.heightAt(a.x, a.z), gb = this.layout.heightAt(b.x, b.z);
        // Curtain: ground → top
        pos.push(a.x, ga, a.z, b.x, gb, b.z, b.x, top, b.z, a.x, ga, a.z, b.x, top, b.z, a.x, top, a.z);
        uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
        // Rim ribbon lying flat at the top, inset slightly
        const ia = hexCorner(tl.x, tl.z, k, 0.97 - rim * 2), ib = hexCorner(tl.x, tl.z, k + 1, 0.97 - rim * 2);
        pos.push(a.x, top, a.z, b.x, top, b.z, ib.x, top, ib.z, a.x, top, a.z, ib.x, top, ib.z, ia.x, top, ia.z);
        uv.push(2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1);
      }
      // Every vertex of this tile's prism rises with the tile.
      for (let i = before; i < pos.length; i += 3) stagger.push(tl.ring / maxRing);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('aUv', new BufferAttribute(new Float32Array(uv), 2));
    g.setAttribute('aStagger', new BufferAttribute(new Float32Array(stagger), 1));
    return g;
  }

  /** Fade the focus ring in (true) or out. */
  setFocusOn(on: boolean): void {
    this.focusTarget = on ? 1 : 0;
  }

  /** The focus ring is still fading. */
  get focusMoving(): boolean {
    return Math.abs(this.focusAlpha - this.focusTarget) > 0.01;
  }

  /** `tiltFactor` 0 = flat view (hidden) → 1 = steep (fully shown). */
  update(dt: number, now: number, tiltFactor: number, hoverStrength: number): void {
    this.fade += (tiltFactor - this.fade) * Math.min(1, dt * 8);
    this.focusAlpha += (this.focusTarget - this.focusAlpha) * Math.min(1, dt * 5);
    for (const [name, layer] of this.layers) {
      const a = name === 'focus' ? this.focusAlpha * 1.4 : this.fade * (name === 'hover' ? hoverStrength : 1);
      layer.mat.uniforms.uAlpha.value = a;
      layer.mat.uniforms.uTime.value = now;
      layer.mesh.visible = a > 0.01 && layer.sig !== '';
    }
  }

  dispose(): void {
    for (const l of this.layers.values()) {
      l.mesh.geometry.dispose();
      l.mat.dispose();
    }
  }
}
