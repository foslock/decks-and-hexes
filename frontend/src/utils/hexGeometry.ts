// Hex geometry shared by the 3D board and every DOM overlay that needs to
// line up with it (resolve numbers, effect popups, card fly-ins, drag-drop).
//
// "Hex-local pixel" space is the legacy 2D layout: flat-top hexes with a
// center-to-corner radius of HEX_SIZE px, x right / y down. The 3D board uses
// world units where one hex radius = 1 (world X = localX / HEX_SIZE,
// world Z = localY / HEX_SIZE), so this space stays the lingua franca.

export const HEX_SIZE = 32;
export const SQRT3 = Math.sqrt(3);

/**
 * Screen mapping for the board. `project` / `unproject` are the source of
 * truth (they follow the live 3D camera, including tilt and perspective);
 * the scalar fields are a flat approximation kept for coarse sizing.
 */
export interface GridTransform {
  /** Approximate CSS px per hex-local px at the board center. */
  scale: number;
  offsetX: number;
  offsetY: number;
  /** Approximate on-screen rotation of the board (radians, clockwise). */
  rotation: number;
  pivotX: number;
  pivotY: number;
  /** Hex-local px → container-relative CSS px. `lift` raises the point above
   *  the board surface (in hex radii) — use it to anchor things to tokens. */
  project?: (localX: number, localY: number, lift?: number) => { x: number; y: number };
  /** Container-relative CSS px → hex-local px. Hits on a tile (including its
   *  castle / mountain) return that tile's center; misses intersect the board
   *  plane. Returns null when the ray never reaches the board plane. */
  unproject?: (canvasX: number, canvasY: number) => { x: number; y: number } | null;
}

export function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (SQRT3 / 2 * q + SQRT3 * r);
  return { x, y };
}

/** Fractional axial coordinates for a hex-local pixel position. */
export function pixelToAxialFrac(px: number, py: number): { q: number; r: number } {
  const q = (2 / 3 * px) / HEX_SIZE;
  const r = (-1 / 3 * px + SQRT3 / 3 * py) / HEX_SIZE;
  return { q, r };
}

/** Round fractional axial coords to the nearest hex. */
export function axialRound(q: number, r: number): { q: number; r: number } {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export function hexDistance(q1: number, r1: number, q2: number, r2: number): number {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

/**
 * Neighbor directions in edge order: direction k shares the edge between
 * hex corners k and k+1 (corner k sits at angle 60°·k), whose outward normal
 * points at 30° + 60°·k.
 */
export const HEX_DIRS: readonly [number, number][] = [
  [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
];

/** Convert hex-local coordinates to viewport coordinates. */
export function localToScreen(
  localX: number,
  localY: number,
  transform: GridTransform,
  containerW: number,
  containerH: number,
  gRect: DOMRect,
  lift = 0,
): { x: number; y: number } {
  if (transform.project) {
    const p = transform.project(localX, localY, lift);
    return { x: p.x + gRect.left, y: p.y + gRect.top };
  }
  const relX = (localX - transform.pivotX) * transform.scale;
  const relY = (localY - transform.pivotY) * transform.scale;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: relX * cos - relY * sin + containerW / 2 + gRect.left,
    y: relX * sin + relY * cos + containerH / 2 + gRect.top,
  };
}

/** Convert container-relative coordinates to hex-local coordinates. */
export function screenToLocal(
  canvasX: number,
  canvasY: number,
  transform: GridTransform,
  containerW: number,
  containerH: number,
): { x: number; y: number } {
  if (transform.unproject) {
    const p = transform.unproject(canvasX, canvasY);
    // A ray that misses the board plane maps far off-grid so callers'
    // "is this a tile?" checks reject it.
    return p ?? { x: 1e6, y: 1e6 };
  }
  const dx = canvasX - containerW / 2;
  const dy = canvasY - containerH / 2;
  const cos = Math.cos(-transform.rotation);
  const sin = Math.sin(-transform.rotation);
  return {
    x: (dx * cos - dy * sin) / transform.scale + transform.pivotX,
    y: (dx * sin + dy * cos) / transform.scale + transform.pivotY,
  };
}
