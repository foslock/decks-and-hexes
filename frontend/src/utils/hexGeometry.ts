import type { GridTransform } from '../components/HexGrid';

// Hex geometry constants (must match HexGrid.tsx)
export const HEX_SIZE = 32;

export function axialToPixel(q: number, r: number): { x: number; y: number } {
  const x = HEX_SIZE * (3 / 2) * q;
  const y = HEX_SIZE * (Math.sqrt(3) / 2 * q + Math.sqrt(3) * r);
  return { x, y };
}

/** Convert hex-local coordinates to screen coordinates, accounting for grid rotation. */
export function localToScreen(
  localX: number,
  localY: number,
  transform: GridTransform,
  containerW: number,
  containerH: number,
  gRect: DOMRect,
): { x: number; y: number } {
  const relX = (localX - transform.pivotX) * transform.scale;
  const relY = (localY - transform.pivotY) * transform.scale;
  const cos = Math.cos(transform.rotation);
  const sin = Math.sin(transform.rotation);
  return {
    x: relX * cos - relY * sin + containerW / 2 + gRect.left,
    y: relX * sin + relY * cos + containerH / 2 + gRect.top,
  };
}
