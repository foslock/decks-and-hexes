import { GLYPHS, type IconName } from './glyphs';

/**
 * Canvas 2D rasteriser for the Card Clash icon set. `Path2D` accepts the
 * same SVG path strings as the React <Icon>, so DOM canvases (the icon
 * gallery's pixel loupe) can draw glyphs identically.
 */

const SLASH_GAP = 'M-1.49 1.49 L14.51 17.49 L17.49 14.51 L1.49 -1.49 Z';
const SLASH_BAR = 'M1.33 2.67 L13.33 14.67 L14.67 13.33 L2.67 1.33 Z';

/** Path2D objects are immutable — parse each path string once. */
const pathCache = new Map<string, Path2D>();
function path(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

/**
 * Draw a glyph into a 2D context. The context should already be translated
 * so (0,0) is the top-left of the glyph box; `px` is the box size in device
 * pixels. Exposed so DOM canvases (e.g. the icon gallery) can reuse it.
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  name: IconName,
  px: number,
  opts: { color: string; accentAlpha?: number; outline?: { color: string; widthPx: number }; slash?: boolean },
): void {
  const glyph = GLYPHS[name];
  const k = px / 16;
  ctx.save();
  ctx.scale(k, k);

  if (opts.outline && opts.outline.widthPx > 0) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = opts.outline.color;
    ctx.fillStyle = opts.outline.color;
    ctx.lineWidth = (opts.outline.widthPx * 2) / k;
    for (const layer of glyph.layers) {
      const p = path(layer.d);
      ctx.stroke(p);
      ctx.fill(p, 'nonzero'); // fill knockouts too so the outline reads as a halo
    }
    if (opts.slash) ctx.stroke(path(SLASH_BAR));
    ctx.restore();
  }

  ctx.fillStyle = opts.color;
  for (const layer of glyph.layers) {
    const isAccent = 'accent' in layer && layer.accent;
    ctx.globalAlpha = isAccent ? (opts.accentAlpha ?? 0.42) : 1;
    ctx.fill(path(layer.d), 'evenOdd' in layer && layer.evenOdd ? 'evenodd' : 'nonzero');
  }
  ctx.globalAlpha = 1;

  if (opts.slash) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(path(SLASH_GAP));
    ctx.globalCompositeOperation = 'source-over';
    if (opts.outline && opts.outline.widthPx > 0) {
      ctx.strokeStyle = opts.outline.color;
      ctx.lineWidth = (opts.outline.widthPx * 2) / k;
      ctx.lineJoin = 'round';
      ctx.stroke(path(SLASH_BAR));
    }
    ctx.fill(path(SLASH_BAR));
  }
  ctx.restore();
}

