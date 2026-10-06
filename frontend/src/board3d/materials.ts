import {
  DataTexture, DoubleSide, FloatType, MeshDepthMaterial, MeshStandardMaterial, NearestFilter,
  RGBADepthPacking, RGBAFormat, SRGBColorSpace, UnsignedByteType, Vector2, Vector4, Vector3,
  type IUniform, type WebGLProgramParametersWithUniforms,
} from 'three';

/** Uniforms shared by every board material (one object, mutated per frame). */
export interface SharedUniforms {
  uTime: IUniform<number>;
  /** Board build-in progress 0..1 (1 = fully built). */
  uBuild: IUniform<number>;
  /** Wind direction × strength for sway. */
  uWind: IUniform<Vector2>;
  /** Cloud-shadow drift offset. */
  uCloud: IUniform<Vector2>;
}

export function createSharedUniforms(): SharedUniforms {
  return {
    uTime: { value: 0 },
    uBuild: { value: 1 },
    uWind: { value: new Vector2(0.018, 0.009) },
    uCloud: { value: new Vector2(0, 0) },
  };
}

/** Sea level (world y) — kept in sync with terrain.ts WATER_Y. */
const WATER_LEVEL = '-0.3';
/** How far below the board a tile starts its rise out of the sea. */
export const BUILD_DEPTH = 1.2;
/**
 * The point in a tile's own build-in (0..1) where it breaks the surface:
 * bh_rise(t) · BUILD_DEPTH clears the 0.3 to sea level at t ≈ 0.18. A tile at
 * stagger s (ring / maxRing) surfaces at uBuild = s · 0.6 + BUILD_SURFACE.
 */
export const BUILD_SURFACE_T = 0.18;
export const BUILD_SURFACE = 0.4 * BUILD_SURFACE_T;

// ── GLSL snippets ─────────────────────────────────────────────────────────

const NOISE_GLSL = /* glsl */ `
float bh_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bh_noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bh_hash(i), bh_hash(i + vec2(1.0, 0.0)), u.x),
             mix(bh_hash(i + vec2(0.0, 1.0)), bh_hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float bh_fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * bh_noise(p); p *= 2.07; a *= 0.5; }
  return s / 0.875;
}
float bh_cloud(vec2 xz, vec2 drift) {
  float c = bh_fbm(xz * 0.11 + drift);
  return smoothstep(0.52, 0.74, c);
}
`;

const BUILD_GLSL = /* glsl */ `
float bh_easeOutBack(float t) {
  float c1 = 1.70158; float c3 = c1 + 1.0;
  float u = t - 1.0;
  return 1.0 + c3 * u * u * u + c1 * u * u;
}
float bh_build(float stagger) {
  return clamp((uBuild - stagger * 0.6) / 0.4, 0.0, 1.0);
}
/* Rising out of the sea: up from BH_DEPTH below the board, quick under water,
   then a bob — overshooting its rest, sinking back below it, a last little
   rebound — settling exactly level at t = 1. */
const float BH_DEPTH = ${BUILD_DEPTH.toFixed(2)};
const float BH_SURFACE = ${BUILD_SURFACE.toFixed(4)};
/* Build time since this piece's tile broke the surface (negative before). */
float bh_drain(float stagger) { return uBuild - (stagger * 0.6 + BH_SURFACE); }
float bh_rise(float t) {
  float u = min(t / 0.48, 1.0);
  float base = 1.0 - pow(1.0 - u, 3.0);
  float s = max((t - 0.3) / 0.7, 0.0);
  return base + 0.15 * sin(3.0 * 3.14159265 * s) * pow(1.0 - s, 1.3);
}
`;

/* Freshly surfaced land is wet (darker, glossy) and dries over the rest of
   the build — `drain` is build time since it surfaced; the last ring is dry
   just as the build ends. */
const WET_GLSL = /* glsl */ `
float bh_wet(float drain) {
  return drain < 0.0 ? 1.0 : 1.0 - smoothstep(0.0, 0.26, drain);
}
`;

// ── Prop material ─────────────────────────────────────────────────────────

const PROP_VERTEX_HEAD = /* glsl */ `
attribute vec3 aAnchor;
attribute float aWind;
attribute vec3 aGlow;
attribute float aBuild;
uniform float uTime;
uniform float uBuild;
uniform vec2 uWind;
varying vec3 vGlow;
varying float vGlowSeed;
varying vec3 vPropWorld;
varying float vPropBuilt;
varying float vPropDrain;
${BUILD_GLSL}
`;

const PROP_VERTEX_BODY = /* glsl */ `
  {
    // Props ride up out of the sea with their tile, showing once the ground
    // under them has broken the surface (see the fragment discard).
    float bt = bh_build(aBuild);
    vPropBuilt = bt;
    vPropDrain = bh_drain(aBuild);
    if (bt <= 0.0) transformed = aAnchor + (transformed - aAnchor) * 0.0001;
    transformed.y -= (1.0 - bh_rise(bt)) * BH_DEPTH;
    float ph = aAnchor.x * 1.31 + aAnchor.z * 0.73 - aWind * 7.0;
    float sway = sin(uTime * 1.6 + ph) * 0.65 + sin(uTime * 2.9 + ph * 1.7) * 0.35;
    transformed.xz += uWind * sway * aWind;
    transformed.y += sin(uTime * 4.3 + ph * 2.0) * aWind * 0.012;
    vGlow = aGlow;
    vGlowSeed = fract(sin(dot(aAnchor.xz, vec2(12.9898, 78.233))) * 43758.5453);
    vPropWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  }
`;

export interface RoadMask {
  tex: DataTexture;
  /** .z = 1 / (2·extent): world xz → mask uv. */
  rect: Vector3;
}

function patchPropVertex(shader: WebGLProgramParametersWithUniforms, shared: SharedUniforms, mask?: RoadMask): void {
  shader.uniforms.uTime = shared.uTime;
  shader.uniforms.uBuild = shared.uBuild;
  shader.uniforms.uWind = shared.uWind;
  let head = PROP_VERTEX_HEAD;
  let body = PROP_VERTEX_BODY;
  if (mask) {
    shader.uniforms.tRoadMask = { value: mask.tex };
    shader.uniforms.uRoadRect = { value: mask.rect };
    head += `
uniform sampler2D tRoadMask;
uniform vec3 uRoadRect;
`;
    // Decor standing in a road's corridor is cleared away.
    body += `
  {
    float road = texture2D(tRoadMask, aAnchor.xz * uRoadRect.z + 0.5).r;
    float keep = 1.0 - smoothstep(0.3, 0.7, road);
    transformed = aAnchor + (transformed - aAnchor) * max(keep, 0.0001);
  }
`;
  }
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${head}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${body}`);
}

/**
 * Shared flat-shaded, vertex-colored material for all props and structures.
 * Animates wind sway, build-in scaling, flickering window glow and cloud
 * shadows entirely on the GPU.
 */
export function createPropMaterial(shared: SharedUniforms, mask?: RoadMask): { material: MeshStandardMaterial; depth: MeshDepthMaterial } {
  const key = mask ? 'bh-prop-road' : 'bh-prop';
  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.88,
    metalness: 0.0,
    side: DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    patchPropVertex(shader, shared, mask);
    // Cloud shadows are far broader than any prop: shade per vertex.
    shader.uniforms.uCloud = shared.uCloud;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uCloud;
        varying float vCloud;
        ${NOISE_GLSL}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vCloud = bh_cloud(vPropWorld.xz, uCloud);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying vec3 vGlow;
        varying float vGlowSeed;
        varying float vCloud;
        varying vec3 vPropWorld;
        varying float vPropBuilt;
        varying float vPropDrain;
        ${WET_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vPropBuilt < ${BUILD_SURFACE_T.toFixed(2)} || (vPropBuilt < 1.0 && vPropWorld.y < ${WATER_LEVEL})) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 1.0 - 0.2 * vCloud;
        diffuseColor.rgb *= mix(1.0, 0.62, bh_wet(vPropDrain));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.6, bh_wet(vPropDrain));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float s = vGlowSeed;
          float fl = 0.78 + 0.14 * sin(uTime * (6.0 + s * 5.0) + s * 40.0)
                          + 0.08 * sin(uTime * (13.0 + s * 9.0) + s * 11.0);
          totalEmissiveRadiance += vGlow * fl;
        }`);
  };
  material.customProgramCacheKey = () => key;

  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
  depth.onBeforeCompile = (shader) => {
    patchPropVertex(shader, shared, mask);
    // (Still under water: no shadow either.)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vPropWorld;
        varying float vPropBuilt;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vPropBuilt < ${BUILD_SURFACE_T.toFixed(2)} || (vPropBuilt < 1.0 && vPropWorld.y < ${WATER_LEVEL})) discard;`);
  };
  depth.customProgramCacheKey = () => `${key}-depth`;
  return { material, depth };
}

// ── Tile state textures ───────────────────────────────────────────────────

/** Axial coords map into a TEX×TEX texture with this offset. */
export const TILE_TEX = 48;
export const TILE_TEX_OFFSET = 24;

export const TF = {
  EXISTS: 1,
  BLOCKED: 2,
  HIGHLIGHT: 4,
  WEAK: 8,
  MULTI: 16,
  REVIEW: 32,
  ACTIVE_TERRITORY: 64,
  VP: 128,
  BASE: 256,
  IMMUNE: 512,
} as const;

export interface TileTextures {
  color: DataTexture;   // RGBA8 sRGB: owner color, a = owned
  prev: DataTexture;    // RGBA8 sRGB: previous owner color, a = owned
  state: DataTexture;   // RGBA32F: flags, transition start, transition angle, spare
}

export function createTileTextures(): TileTextures {
  const n = TILE_TEX * TILE_TEX;
  const mk8 = () => {
    const t = new DataTexture(new Uint8Array(n * 4), TILE_TEX, TILE_TEX, RGBAFormat, UnsignedByteType);
    t.colorSpace = SRGBColorSpace;
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  const state = new DataTexture(new Float32Array(n * 4), TILE_TEX, TILE_TEX, RGBAFormat, FloatType);
  state.magFilter = NearestFilter;
  state.minFilter = NearestFilter;
  state.generateMipmaps = false;
  state.needsUpdate = true;
  return { color: mk8(), prev: mk8(), state };
}

export function tileTexIndex(q: number, r: number): number {
  const x = q + TILE_TEX_OFFSET;
  const y = r + TILE_TEX_OFFSET;
  if (x < 0 || y < 0 || x >= TILE_TEX || y >= TILE_TEX) return -1;
  return y * TILE_TEX + x;
}

// ── Terrain material ──────────────────────────────────────────────────────

export interface TerrainUniforms {
  tTileColor: IUniform<DataTexture>;
  tTilePrev: IUniform<DataTexture>;
  tTileState: IUniform<DataTexture>;
  /** x, y = hovered q, r; z = hover strength 0..1; w = long-press hold progress 0..1. */
  uHover: IUniform<Vector4>;
  /** x, z = cursor world position; y unused; plus amount in .w. */
  uCursor: IUniform<Vector4>;
  /** Ownership-sweep duration in seconds. */
  uTransDur: IUniform<number>;
  /** Base strength of hex grid lines. */
  uGrid: IUniform<number>;
  uHoverColor: IUniform<Vector3>;
}

const TERRAIN_FRAGMENT_HEAD = /* glsl */ `
uniform sampler2D tTileColor;
uniform sampler2D tTilePrev;
uniform sampler2D tTileState;
uniform float uTime;
uniform vec4 uHover;
uniform vec4 uCursor;
uniform float uTransDur;
uniform float uGrid;
uniform vec3 uHoverColor;
varying vec3 vBoardPos;
varying float vBuilt;
varying float vCloud;
${NOISE_GLSL}

const float BH_SQ3 = 1.7320508;
const float BH_TEX = ${TILE_TEX.toFixed(1)};
const float BH_OFF = ${TILE_TEX_OFFSET.toFixed(1)};

vec2 bh_round(vec2 f) {
  vec3 c = vec3(f.x, f.y, -f.x - f.y);
  vec3 rc = floor(c + 0.5);
  vec3 d = abs(rc - c);
  if (d.x > d.y && d.x > d.z) rc.x = -rc.y - rc.z;
  else if (d.y > d.z) rc.y = -rc.x - rc.z;
  return rc.xy;
}
vec2 bh_center(vec2 qr) { return vec2(1.5 * qr.x, BH_SQ3 * 0.5 * qr.x + BH_SQ3 * qr.y); }
vec2 bh_uv(vec2 qr) { return (qr + BH_OFF + 0.5) / BH_TEX; }
int bh_flags(vec2 qr) { return int(texture2D(tTileState, bh_uv(qr)).r + 0.5); }
bool bh_sameColor(vec4 a, vec4 b) {
  return a.a > 0.5 && b.a > 0.5 && all(lessThan(abs(a.rgb - b.rgb), vec3(0.01)));
}
`;

const TERRAIN_FRAGMENT_BODY = /* glsl */ `
// Build-in: tiles rise out of the sea; nothing shows until its ground has
// surfaced (a mountain's peak doesn't poke up on its own).
if (vBuilt < ${BUILD_SURFACE_T.toFixed(2)} || (vBuilt < 1.0 && vBoardPos.y < ${WATER_LEVEL})) discard;
vec3 boardEmissive = vec3(0.0);
{
  vec2 p = vBoardPos.xz;
  vec2 frac = vec2(2.0 / 3.0 * p.x, -1.0 / 3.0 * p.x + BH_SQ3 / 3.0 * p.y);
  vec2 qr = bh_round(frac);
  vec2 local = p - bh_center(qr);
  vec4 st = texture2D(tTileState, bh_uv(qr));
  int flags = int(st.r + 0.5);
  bool exists = (flags & 1) != 0;
  vec4 own = texture2D(tTileColor, bh_uv(qr));
  vec4 prv = texture2D(tTilePrev, bh_uv(qr));
  float inr = BH_SQ3 * 0.5;

  // Distances to each of the 6 edges, plus the along-edge coordinate.
  float edgeD[6];
  float along[6];
  float minEdge = 10.0;
  for (int k = 0; k < 6; k++) {
    float a = radians(30.0 + 60.0 * float(k));
    vec2 n = vec2(cos(a), sin(a));
    edgeD[k] = inr - dot(local, n);
    along[k] = dot(local, vec2(-n.y, n.x));
    minEdge = min(minEdge, edgeD[k]);
  }
  float aa = max(fwidth(minEdge), 0.0015);

  // ── Ownership tint, with an animated sweep when the owner changes ──
  float tr = clamp((uTime - st.g) / max(uTransDur, 0.001), 0.0, 1.0);
  float m = 1.0;
  float frontGlow = 0.0;
  if (tr < 1.0) {
    float e = 1.0 - pow(1.0 - tr, 2.2);
    float wob = (bh_noise(p * 7.0 + st.g) - 0.5) * 0.14;
    float u; float front;
    if (st.b > 50.0) {
      u = -length(local);
      front = mix(0.0, -1.15, e);
    } else {
      vec2 od = vec2(cos(st.b), sin(st.b));
      u = dot(local, od);
      front = mix(1.05, -1.15, e);
    }
    m = smoothstep(front - 0.035, front + 0.035, u + wob);
    frontGlow = (1.0 - smoothstep(0.0, 0.09, abs(u + wob - front))) * (1.0 - tr);
  }
  float tintAmt = mix(prv.a, own.a, m);
  vec3 tintCol = (prv.a * (1.0 - m) * prv.rgb + own.a * m * own.rgb) / max(tintAmt, 0.001);

  // Cloud shadows drifting over the land (shaded per vertex).
  diffuseColor.rgb *= 1.0 - 0.2 * vCloud;

  if (exists && tintAmt > 0.001) {
    float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 colorized = tintCol * (0.22 + lum * 2.4);
    diffuseColor.rgb = mix(diffuseColor.rgb, colorized, tintAmt * 0.62);
  }
  boardEmissive += own.rgb * frontGlow * 1.6;

  // ── Territory borders + region outlines ──
  float border = 0.0;      // owner border band
  float hlEdge = 0.0;      // highlight region outline
  float weakEdge = 0.0;
  float activeEdge = 0.0;
  bool isHl = (flags & 4) != 0;
  bool isWeak = (flags & 8) != 0;
  bool isActive = (flags & 64) != 0;
  for (int k = 0; k < 6; k++) {
    // Neighbor across edge k (same order as HEX_DIRS).
    vec2 dir = k == 0 ? vec2(1.0, 0.0) : k == 1 ? vec2(0.0, 1.0) : k == 2 ? vec2(-1.0, 1.0)
             : k == 3 ? vec2(-1.0, 0.0) : k == 4 ? vec2(0.0, -1.0) : vec2(1.0, -1.0);
    vec2 nqr = qr + dir;
    vec4 nOwn = texture2D(tTileColor, bh_uv(nqr));
    int nf = int(texture2D(tTileState, bh_uv(nqr)).r + 0.5);
    float d = edgeD[k];
    if (own.a > 0.5 && !bh_sameColor(own, nOwn)) {
      border = max(border, 1.0 - smoothstep(0.0, 0.1, d));
    }
    if (isHl && (nf & 4) == 0) hlEdge = max(hlEdge, 1.0 - smoothstep(0.025, 0.025 + aa * 1.5, d));
    if (isWeak && (nf & 12) == 0) weakEdge = max(weakEdge, 1.0 - smoothstep(0.025, 0.025 + aa * 1.5, d));
    if (isActive && (nf & 64) == 0) activeEdge = max(activeEdge, 1.0 - smoothstep(0.03, 0.03 + aa * 1.5, d));
  }

  if (exists) {
    // Etched hex grid: a soft dark groove with a faint lit lip.
    float groove = 1.0 - smoothstep(0.006, 0.006 + aa * 1.6, minEdge);
    float lip = (1.0 - smoothstep(0.014, 0.014 + aa * 2.0, minEdge)) - groove;
    float cursorNear = uCursor.w * (1.0 - smoothstep(0.0, 3.2, distance(p, uCursor.xz)));
    diffuseColor.rgb *= 1.0 - groove * (uGrid + cursorNear * 0.15);
    boardEmissive += vec3(1.0, 0.86, 0.6) * lip * (0.02 + cursorNear * 0.22);

    // Territory border band in the owner's color.
    if (own.a > 0.5) {
      vec3 bc = own.rgb;
      diffuseColor.rgb = mix(diffuseColor.rgb, bc * 0.85, border * 0.55);
      boardEmissive += bc * border * border * 0.35;
    }
    if (isActive) {
      float pulse = 0.75 + 0.25 * sin(uTime * 2.2);
      boardEmissive += vec3(1.0, 0.97, 0.9) * activeEdge * 0.9 * pulse;
    }

    float t = uTime;
    if (isHl) {
      float glow = 0.06 + 0.04 * sin(t * 3.0);
      boardEmissive += vec3(1.0, 0.72, 0.18) * glow;
      float breathe = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * 4.0));
      boardEmissive += vec3(1.0, 0.86, 0.45) * hlEdge * 2.2 * breathe;
    }
    if (isWeak) {
      float glow = 0.09 + 0.05 * sin(t * 3.0);
      boardEmissive += vec3(1.0, 0.45, 0.05) * glow;
      float breathe = 0.35 + 0.65 * (0.5 + 0.5 * sin(t * 4.0));
      boardEmissive += vec3(1.0, 0.5, 0.05) * weakEdge * 2.0 * breathe;
    }
    if ((flags & 16) != 0) {
      float ring = 1.0 - smoothstep(0.06, 0.06 + aa * 1.5, abs(minEdge - 0.07));
      boardEmissive += vec3(1.0, 0.86, 0.45) * ring * 2.6;
      boardEmissive += vec3(1.0, 0.8, 0.35) * 0.08;
    }
    if ((flags & 32) != 0) {
      float a = 0.3 + 0.4 * (0.5 + 0.5 * sin(t * 2.5));
      float ring = 1.0 - smoothstep(0.03, 0.03 + aa * 1.5, minEdge);
      boardEmissive += vec3(1.0) * ring * a * 2.0;
    }

    // Hover: crisp outline (shrinks toward edge midpoints while long-pressing).
    if (uHover.z > 0.0 && all(equal(qr, uHover.xy))) {
      float hold = uHover.w;
      float line = 0.0;
      for (int k = 0; k < 6; k++) {
        float onEdge = 1.0 - smoothstep(0.035, 0.035 + aa * 1.5, edgeD[k]);
        float span = 0.5 * (1.0 - hold);
        float inSpan = 1.0 - smoothstep(span - 0.01, span + 0.01, abs(along[k]));
        line = max(line, onEdge * inSpan);
      }
      boardEmissive += uHoverColor * line * 2.4 * uHover.z;
      boardEmissive += uHoverColor * 0.05 * uHover.z;
    }
  }
}
`;

/**
 * Ground material: smooth vertex-colored terrain whose fragment shader draws
 * all per-tile state (ownership tint + sweep, borders, grid, highlights,
 * hover) from small data textures.
 */
export function createTerrainMaterial(shared: SharedUniforms, tex: TileTextures): { material: MeshStandardMaterial; uniforms: TerrainUniforms } {
  const uniforms: TerrainUniforms = {
    tTileColor: { value: tex.color },
    tTilePrev: { value: tex.prev },
    tTileState: { value: tex.state },
    uHover: { value: new Vector4(0, 0, 0, 0) },
    uCursor: { value: new Vector4(0, 0, 0, 0) },
    uTransDur: { value: 0.55 },
    uGrid: { value: 0.32 },
    uHoverColor: { value: new Vector3(1.0, 0.95, 0.85) },
  };
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uBuild = shared.uBuild;
    shader.uniforms.uCloud = shared.uCloud;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBuild;
        uniform float uBuild;
        uniform vec2 uCloud;
        varying vec3 vBoardPos;
        varying float vBuilt;
        varying float vDrain;
        varying float vCloud;
        ${BUILD_GLSL}
        ${NOISE_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float bt = bh_build(aBuild);
          vBuilt = bt;
          vDrain = bh_drain(aBuild);
          transformed.y -= (1.0 - bh_rise(bt)) * BH_DEPTH;
          vBoardPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vCloud = bh_cloud(vBoardPos.xz, uCloud);
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_FRAGMENT_HEAD}\n${WET_GLSL}
        varying float vDrain;`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${TERRAIN_FRAGMENT_BODY}
        float bhWet = bh_wet(vDrain);
        float bhFilm = 0.0;
        {
          // The sea a tile brings up with it drains off toward its edges,
          // breaking into rivulets, with foam along the rim.
          float age = vDrain / 0.2;
          if (age < 1.0) {
            vec2 pp = vBoardPos.xz;
            vec2 cq = bh_round(vec2(2.0 / 3.0 * pp.x, -1.0 / 3.0 * pp.x + BH_SQ3 / 3.0 * pp.y));
            float dc = length(pp - bh_center(cq));
            float n = bh_fbm(pp * 5.0 + vec2(0.0, uTime * 0.6));
            float front = max(age, 0.0) * 1.3 - 0.2 + (n - 0.5) * 0.45;
            bhFilm = smoothstep(front - 0.07, front + 0.07, dc) * (1.0 - smoothstep(0.8, 1.0, age));
            float streak = 0.5 + 0.5 * sin(dc * 16.0 - uTime * 7.0 + n * 10.0);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08, 0.23, 0.26) + streak * 0.03, bhFilm * 0.78);
            float rim = smoothstep(0.62, 0.9, dc) * bhFilm * smoothstep(0.35, 0.8, n);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.88, 0.9), rim * 0.55);
          }
        }
        diffuseColor.rgb *= mix(1.0, 0.55, bhWet * (1.0 - bhFilm));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(mix(roughnessFactor, 0.6, bhWet), 0.2, bhFilm);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += boardEmissive;`);
  };
  material.customProgramCacheKey = () => 'bh-terrain';
  return { material, uniforms };
}

/** Craggy island cliffs: flat-shaded, sinks with its tile during build-in. */
export function createSlabMaterial(shared: SharedUniforms): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uBuild = shared.uBuild;
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBuild;
        uniform float uBuild;
        varying float vBuilt;
        varying float vDrain;
        varying float vSlabY;
        varying vec2 vSlabXZ;
        ${BUILD_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float bt = bh_build(aBuild);
          vBuilt = bt;
          vDrain = bh_drain(aBuild);
          transformed.y -= (1.0 - bh_rise(bt)) * BH_DEPTH;
          vec4 wp = modelMatrix * vec4(transformed, 1.0);
          vSlabY = wp.y;
          vSlabXZ = wp.xz;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        varying float vBuilt;
        varying float vDrain;
        varying float vSlabY;
        varying vec2 vSlabXZ;
        ${NOISE_GLSL}
        ${WET_GLSL}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vBuilt < ${BUILD_SURFACE_T.toFixed(2)} || (vBuilt < 1.0 && vSlabY < ${WATER_LEVEL})) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          // Water streaming down the cliffs as the tile above drains.
          float fall = vDrain < 0.0 ? 1.0 : 1.0 - smoothstep(0.0, 0.24, vDrain);
          float stream = smoothstep(0.55, 0.85, bh_noise(vec2((vSlabXZ.x + vSlabXZ.y) * 9.0, vSlabY * 5.0 + uTime * 5.0)));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.86, 0.9), stream * fall * 0.7);
        }
        diffuseColor.rgb *= mix(1.0, 0.58, bh_wet(vDrain));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.6, bh_wet(vDrain));`);
  };
  material.customProgramCacheKey = () => 'bh-slab';
  return material;
}
