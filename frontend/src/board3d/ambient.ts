import {
  DoubleSide, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Object3D, Quaternion, Vector3,
  type BufferGeometry,
} from 'three';
import type { BoardLayout } from './layout';
import type { ParticlePool } from './particles';
import type { AmbientSpots } from './props';
import { rng } from './noise';
import { Soup, lin } from './soup';

/** Plain flat-shaded vertex-color material for animated instanced props. */
function flatMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, side: DoubleSide });
}

function sheepGeometry(): BufferGeometry {
  const s = new Soup(17);
  s.jitter = 0.06;
  const wool = lin(0xece6d6);
  const face = lin(0x2b2622);
  s.place(0, 0, 0, 0, 1);
  // body (fluffy blob), head, legs — facing +x
  const saved = s.push(0, 0.018, 0, 0, 1);
  s.blob(0.032, wool, { detail: 1, noise: 0.12, sy: 0.75 });
  s.pop(saved);
  const h = s.push(0.036, 0.04, 0, 0, 1);
  s.blob(0.014, face, { noise: 0.05, sy: 0.9 });
  s.pop(h);
  for (const [lx, lz] of [[0.016, 0.012], [0.016, -0.012], [-0.016, 0.012], [-0.016, -0.012]]) {
    const l = s.push(lx, 0, lz, 0, 1);
    s.box(0.007, 0.022, 0.007, face);
    s.pop(l);
  }
  const g = s.toGeometry();
  g.computeVertexNormals();
  return g;
}

function bladeGeometry(): BufferGeometry {
  const s = new Soup(5);
  s.jitter = 0.04;
  const sail = lin(0xe8dcc0);
  const frame = lin(0x5a3e26);
  s.place(0, 0, 0, 0, 1);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    // blade in the local XY plane (rotates about +z)
    const saved = s.push(0, 0, 0, 0, 1, 1, 0, a);
    const arm = s.push(0, 0, 0, 0, 1);
    s.box(0.008, 0.17, 0.006, frame);
    s.pop(arm);
    const sv = s.push(0.012, 0.04, 0, 0, 1);
    s.box(0.03, 0.12, 0.003, sail);
    s.pop(sv);
    s.pop(saved);
  }
  const hub = s.push(0, 0, 0, 0, 1, 1, Math.PI / 2, 0);
  s.cylinder(0.012, 0.012, 0.02, 6, frame);
  s.pop(hub);
  return s.toGeometry();
}

function birdGeometry(): BufferGeometry {
  const s = new Soup(9);
  s.jitter = 0;
  const c = lin(0x1d1a1c);
  s.place(0, 0, 0, 0, 1);
  // Simple chevron wings (flap = y-scale in the instance matrix).
  s.tri([0, 0, 0], [-0.03, 0.006, -0.07], [0.012, 0, -0.01], c);
  s.tri([0, 0, 0], [0.012, 0, 0.01], [-0.03, 0.006, 0.07], c);
  s.tri([0.02, 0, 0], [-0.01, 0, 0.008], [-0.01, 0, -0.008], c);
  return s.toGeometry();
}

interface Sheep {
  x: number; z: number; heading: number;
  tx: number; tz: number;
  mode: 'walk' | 'graze' | 'idle';
  timer: number;
  home: { x: number; z: number; radius: number };
  phase: number;
  speed: number;
}

interface Bird { cx: number; cz: number; radius: number; height: number; speed: number; phase: number; flap: number }

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _o = new Object3D();

/**
 * Idle life: sheep wandering pastures, windmills turning, chimney smoke,
 * snow blowing off peaks, birds circling, fireflies over forests and embers
 * drifting up from castles. Purely cosmetic.
 */
export class AmbientLayer {
  readonly group = new Group();
  private sheepMesh: InstancedMesh | null = null;
  private bladeMesh: InstancedMesh | null = null;
  private birdMesh: InstancedMesh | null = null;
  private sheep: Sheep[] = [];
  private birds: Bird[] = [];
  private spots: AmbientSpots | null = null;
  private material = flatMaterial();
  private sheepGeo = sheepGeometry();
  private bladeGeo = bladeGeometry();
  private birdGeo = birdGeometry();
  private smokeAcc = 0;
  private snowAcc = 0;
  private flyAcc = 0;
  private emberAcc = 0;
  private coalAcc = 0;
  private rand = rng(4242);
  private forests: { x: number; z: number }[] = [];
  private castles: { x: number; y: number; z: number }[] = [];
  /** Spawn multiplier (quality). */
  density = 1;

  constructor(private layout: BoardLayout, private smoke: ParticlePool, private glow: ParticlePool) {}

  setLayout(layout: BoardLayout): void {
    this.layout = layout;
  }

  /** Install ambient anchors from decor + structures. */
  setSpots(spots: AmbientSpots, castles: { x: number; y: number; z: number }[]): void {
    this.spots = spots;
    this.castles = castles;
    this.forests = this.layout.tiles.filter(t => t.biome === 'forest').map(t => ({ x: t.x, z: t.z }));
    this.rebuildSheep(spots);
    this.rebuildBlades(spots);
    this.rebuildBirds();
  }

  private rebuildSheep(spots: AmbientSpots): void {
    const prevByKey = new Map<string, Sheep[]>();
    for (const sh of this.sheep) {
      const key = `${sh.home.x.toFixed(2)},${sh.home.z.toFixed(2)}`;
      const list = prevByKey.get(key) ?? [];
      list.push(sh);
      prevByKey.set(key, list);
    }
    const next: Sheep[] = [];
    for (const p of spots.pastures) {
      const key = `${p.x.toFixed(2)},${p.z.toFixed(2)}`;
      const keep = prevByKey.get(key);
      if (keep && keep.length) { next.push(...keep); continue; }
      const r = rng(Math.round(p.x * 1000) ^ Math.round(p.z * 7919));
      for (let i = 0; i < p.count; i++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * p.radius * 0.8;
        next.push({
          x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d,
          heading: r() * Math.PI * 2, tx: p.x, tz: p.z,
          mode: 'graze', timer: r() * 4,
          home: { x: p.x, z: p.z, radius: p.radius },
          phase: r() * 10, speed: 0.05 + r() * 0.03,
        });
      }
    }
    this.sheep = next;
    if (this.sheepMesh) { this.group.remove(this.sheepMesh); this.sheepMesh.dispose(); this.sheepMesh = null; }
    if (next.length) {
      this.sheepMesh = new InstancedMesh(this.sheepGeo, this.material, next.length);
      this.sheepMesh.castShadow = true;
      this.sheepMesh.receiveShadow = true;
      this.sheepMesh.frustumCulled = false;
      this.group.add(this.sheepMesh);
    }
  }

  private rebuildBlades(spots: AmbientSpots): void {
    if (this.bladeMesh) { this.group.remove(this.bladeMesh); this.bladeMesh.dispose(); this.bladeMesh = null; }
    if (!spots.windmills.length) return;
    this.bladeMesh = new InstancedMesh(this.bladeGeo, this.material, spots.windmills.length);
    this.bladeMesh.castShadow = true;
    this.bladeMesh.frustumCulled = false;
    this.group.add(this.bladeMesh);
  }

  private rebuildBirds(): void {
    if (this.birdMesh) return;
    const r = this.rand;
    const n = 7;
    for (let i = 0; i < n; i++) {
      this.birds.push({
        cx: (r() - 0.5) * this.layout.radius, cz: (r() - 0.5) * this.layout.radius,
        radius: 0.8 + r() * 1.6, height: 1.9 + r() * 0.8, speed: (0.25 + r() * 0.2) * (r() < 0.5 ? -1 : 1),
        phase: r() * 6.28, flap: 7 + r() * 4,
      });
    }
    this.birdMesh = new InstancedMesh(this.birdGeo, this.material, n);
    this.birdMesh.frustumCulled = false;
    this.birdMesh.castShadow = true;
    this.group.add(this.birdMesh);
  }

  update(dt: number, time: number, build: number): void {
    const layout = this.layout;
    const built = build >= 1;

    // ── Sheep ──
    if (this.sheepMesh) {
      for (let i = 0; i < this.sheep.length; i++) {
        const sh = this.sheep[i];
        sh.timer -= dt;
        if (sh.timer <= 0) {
          const roll = this.rand();
          if (roll < 0.45) {
            sh.mode = 'walk';
            const a = this.rand() * Math.PI * 2;
            const d = Math.sqrt(this.rand()) * sh.home.radius * 0.85;
            sh.tx = sh.home.x + Math.cos(a) * d;
            sh.tz = sh.home.z + Math.sin(a) * d;
            sh.timer = 6;
          } else {
            sh.mode = roll < 0.85 ? 'graze' : 'idle';
            sh.timer = 2 + this.rand() * 5;
          }
        }
        let bob = 0;
        let pitch = 0;
        if (sh.mode === 'walk') {
          const dx = sh.tx - sh.x, dz = sh.tz - sh.z;
          const dist = Math.hypot(dx, dz);
          if (dist < 0.01) { sh.mode = 'graze'; sh.timer = 2 + this.rand() * 4; }
          else {
            const want = Math.atan2(dz, dx);
            let dh = want - sh.heading;
            while (dh > Math.PI) dh -= Math.PI * 2;
            while (dh < -Math.PI) dh += Math.PI * 2;
            sh.heading += dh * Math.min(1, dt * 4);
            const step = Math.min(dist, sh.speed * dt);
            sh.x += Math.cos(sh.heading) * step;
            sh.z += Math.sin(sh.heading) * step;
            bob = Math.abs(Math.sin(time * 11 + sh.phase)) * 0.006;
          }
        } else if (sh.mode === 'graze') {
          pitch = 0.35 + Math.sin(time * 2 + sh.phase) * 0.08;
        }
        const y = layout.heightAt(sh.x, sh.z);
        _o.position.set(sh.x, y + bob, sh.z);
        _o.rotation.set(0, -sh.heading, -pitch, 'YXZ');
        const s = built ? 1 : Math.max(0.0001, (build - 0.7) / 0.3);
        _o.scale.setScalar(Math.max(0.0001, Math.min(1, s)));
        _o.updateMatrix();
        this.sheepMesh.setMatrixAt(i, _o.matrix);
      }
      this.sheepMesh.instanceMatrix.needsUpdate = true;
    }

    // ── Windmill blades ──
    if (this.bladeMesh && this.spots) {
      this.spots.windmills.forEach((w, i) => {
        _o.position.copy(w.pos);
        _o.rotation.set(0, w.ry, time * 1.1 + i, 'YXZ');
        _o.scale.setScalar(built ? w.scale : Math.max(0.0001, Math.min(1, (build - 0.7) / 0.3)) * w.scale);
        _o.updateMatrix();
        this.bladeMesh!.setMatrixAt(i, _o.matrix);
      });
      this.bladeMesh.instanceMatrix.needsUpdate = true;
    }

    // ── Birds ──
    if (this.birdMesh) {
      this.birds.forEach((b, i) => {
        const a = b.phase + time * b.speed;
        const x = b.cx + Math.cos(a) * b.radius;
        const z = b.cz + Math.sin(a) * b.radius;
        const heading = a + (b.speed > 0 ? Math.PI / 2 : -Math.PI / 2);
        const flap = Math.sin(time * b.flap + b.phase);
        _p.set(x, b.height + Math.sin(time * 0.7 + b.phase) * 0.08, z);
        _q.setFromAxisAngle(new Vector3(0, 1, 0), -heading);
        _s.set(1.2, 1 + flap * 2.6, 1.2 * (0.55 + 0.45 * Math.abs(Math.cos(time * b.flap + b.phase))));
        _m.compose(_p, _q, built ? _s : _s.multiplyScalar(0.0001));
        this.birdMesh!.setMatrixAt(i, _m);
      });
      this.birdMesh.instanceMatrix.needsUpdate = true;
    }

    if (!built || !this.spots) return;
    const dens = this.density;

    // ── Chimney smoke ──
    this.smokeAcc += dt * dens;
    const smokeEvery = 0.42;
    while (this.smokeAcc > smokeEvery) {
      this.smokeAcc -= smokeEvery;
      for (const c of this.spots.chimneys) {
        if (this.rand() < 0.45) continue;
        const shade = 0.42 + this.rand() * 0.18;
        this.smoke.spawn({
          x: c.x + (this.rand() - 0.5) * 0.01, y: c.y, z: c.z + (this.rand() - 0.5) * 0.01,
          vx: (this.rand() - 0.5) * 0.01, vy: 0.09 + this.rand() * 0.04, vz: (this.rand() - 0.5) * 0.01,
          r: shade, g: shade, b: shade * 1.05, a: 0.32,
          life: 3.6 + this.rand() * 1.4, size0: 0.035, size1: 0.2 + this.rand() * 0.08,
          drag: 0.25, wind: 0.14, gravity: -0.004,
        });
      }
    }

    // ── Snow + ice off the peaks ──
    this.snowAcc += dt * dens;
    while (this.snowAcc > 0.12) {
      this.snowAcc -= 0.12;
      for (const p of this.spots.peaks) {
        if (this.rand() < 0.75) continue;
        const gust = this.rand() < 0.08;
        const n = gust ? 6 : 1;
        for (let i = 0; i < n; i++) {
          const a = this.rand() * Math.PI * 2;
          const out = gust ? 0.12 : 0.05;
          this.smoke.spawn({
            x: p.x + (this.rand() - 0.5) * 0.06, y: p.y - this.rand() * 0.15, z: p.z + (this.rand() - 0.5) * 0.06,
            vx: Math.cos(a) * out, vy: gust ? 0.03 : 0.0, vz: Math.sin(a) * out,
            r: 0.93, g: 0.96, b: 1.0, a: 0.85,
            life: 2.2 + this.rand() * 1.2, size0: gust ? 0.028 : 0.018, size1: 0.01,
            gravity: gust ? 0.16 : 0.05, drag: 0.6, wind: 0.35, shape: 2,
          });
        }
        if (gust) {
          // Powder plume
          this.smoke.spawn({
            x: p.x, y: p.y - 0.1, z: p.z, vx: 0, vy: 0.02, vz: 0,
            r: 0.9, g: 0.93, b: 0.98, a: 0.22, life: 2.2, size0: 0.08, size1: 0.35,
            drag: 0.5, wind: 0.5,
          });
        }
      }
    }

    // ── Fireflies over forests ──
    this.flyAcc += dt * dens;
    while (this.flyAcc > 0.35 && this.forests.length) {
      this.flyAcc -= 0.35;
      const f = this.forests[Math.floor(this.rand() * this.forests.length)];
      const a = this.rand() * Math.PI * 2, d = this.rand() * 0.7;
      const x = f.x + Math.cos(a) * d, z = f.z + Math.sin(a) * d;
      this.glow.spawn({
        x, y: layout.heightAt(x, z) + 0.12 + this.rand() * 0.25, z,
        vx: (this.rand() - 0.5) * 0.05, vy: (this.rand() - 0.3) * 0.03, vz: (this.rand() - 0.5) * 0.05,
        r: 0.85, g: 1.0, b: 0.45, a: 0.9, life: 2.5 + this.rand() * 2, size0: 0.022, size1: 0.012,
        drag: 0.1, shape: 1,
      });
    }

    // ── Scorched ground smoldering: coals flare, spit a spark, breathe smoke ──
    const coals = this.spots.embers;
    this.coalAcc += dt * dens;
    while (this.coalAcc > 0.09 && coals.length) {
      this.coalAcc -= 0.09;
      const c = coals[Math.floor(this.rand() * coals.length)];
      // A glow that swells and fades on the coal.
      this.glow.spawn({
        x: c.x, y: c.y + 0.004, z: c.z, vx: 0, vy: 0.005, vz: 0,
        r: 1.0, g: 0.38 + this.rand() * 0.2, b: 0.06, a: 0.75,
        life: 0.7 + this.rand() * 0.8, size0: 0.05 + this.rand() * 0.03, size1: 0.02, drag: 1, shape: 0,
      });
      if (this.rand() < 0.35) {
        this.glow.spawn({
          x: c.x, y: c.y + 0.01, z: c.z,
          vx: (this.rand() - 0.5) * 0.05, vy: 0.12 + this.rand() * 0.12, vz: (this.rand() - 0.5) * 0.05,
          r: 1.0, g: 0.6, b: 0.2, a: 0.9, life: 1.2 + this.rand() * 0.9, size0: 0.014, size1: 0.004,
          drag: 0.4, wind: 0.35, shape: 1,
        });
      }
      if (this.rand() < 0.3) {
        const shade = 0.2 + this.rand() * 0.12;
        this.smoke.spawn({
          x: c.x, y: c.y + 0.02, z: c.z,
          vx: (this.rand() - 0.5) * 0.01, vy: 0.07 + this.rand() * 0.04, vz: (this.rand() - 0.5) * 0.01,
          r: shade, g: shade * 0.97, b: shade * 0.95, a: 0.22,
          life: 3 + this.rand() * 1.5, size0: 0.04, size1: 0.22 + this.rand() * 0.1,
          drag: 0.25, wind: 0.3, gravity: -0.004,
        });
      }
    }

    // ── Embers drifting up from castles ──
    this.emberAcc += dt * dens;
    while (this.emberAcc > 0.5 && this.castles.length) {
      this.emberAcc -= 0.5;
      const c = this.castles[Math.floor(this.rand() * this.castles.length)];
      this.glow.spawn({
        x: c.x + (this.rand() - 0.5) * 0.4, y: c.y + 0.2 + this.rand() * 0.3, z: c.z + (this.rand() - 0.5) * 0.4,
        vx: (this.rand() - 0.5) * 0.03, vy: 0.06 + this.rand() * 0.05, vz: (this.rand() - 0.5) * 0.03,
        r: 1.0, g: 0.55, b: 0.18, a: 0.85, life: 2.4 + this.rand(), size0: 0.018, size1: 0.006,
        drag: 0.3, wind: 0.2, shape: 1,
      });
    }
  }

  dispose(): void {
    this.sheepMesh?.dispose();
    this.bladeMesh?.dispose();
    this.birdMesh?.dispose();
    this.sheepGeo.dispose();
    this.bladeGeo.dispose();
    this.birdGeo.dispose();
    this.material.dispose();
  }
}
