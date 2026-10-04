// Deterministic noise + RNG helpers. Everything on the board that looks
// "random" (biomes, tree placement, mountain shapes) derives from these so a
// given map always renders identically on every client.

/** 32-bit integer hash of two ints. */
export function hash2i(x: number, y: number, seed = 0): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return h >>> 0;
}

/** Hash of two ints → [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  return hash2i(x, y, seed) / 4294967296;
}

/** Small fast seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth value noise in [0, 1]. */
export function valueNoise2(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf);
  const v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal value noise in roughly [0, 1]. */
export function fbm2(x: number, y: number, seed = 0, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * f, y * f, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
