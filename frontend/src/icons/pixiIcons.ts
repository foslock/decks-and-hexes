import { CanvasSource, Container, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import { GLYPHS, glyphInkX, type IconName } from './glyphs';

/**
 * PixiJS bridge for the Card Clash icon set (used by HexGrid tile labels).
 *
 * Each glyph is rasterised ONCE per (name, size, color, outline,
 * resolution) into a small canvas via Canvas2D `Path2D` — which accepts the
 * same SVG path strings as the React <Icon> — and wrapped in a cached
 * `Texture`. Labels are Sprites (sharing those textures) plus a `Text` for
 * any number, laid out by `createLabelRow`.
 *
 *  - Canvas2D gives proper analytic anti-aliasing at 12–20 px.
 *  - Sprites sharing one texture batch into a single draw call.
 *  - The cache is module-global and outlives board rebuilds / Application
 *    re-creation. HexGrid destroys label containers with
 *    `destroy({ children: true })`; Sprite.destroy leaves its texture alone
 *    unless `texture: true` is passed — NEVER pass that for icon sprites.
 *
 * Memory: a 20 px icon at resolution 2 with a 1.5 px outline is about
 * 48×48×4 B ≈ 9 KB; the whole board vocabulary is well under 300 KB.
 */

export interface IconTextureOptions {
  /** Logical (CSS px) size of the glyph box. */
  size: number;
  /** Fill color (hex number or CSS color). Default ivory. */
  color?: number | string;
  /** Opacity of accent (duotone) layers. Default 0.42. */
  accentAlpha?: number;
  /** Device-pixel resolution. Default: ceil(devicePixelRatio) like HexGrid. */
  resolution?: number;
  /** Outline drawn behind the glyph for legibility on colored tiles. */
  outline?: { color?: number | string; width: number };
  /** Prohibition slash overlay. */
  slash?: boolean;
}

/** Board numerals: bold Philosopher, matching the DOM <Num>. */
export const NUMERAL_FONT = ['Philosopher', 'Georgia', 'serif'];

// Make sure Philosopher Bold is ready before the first board labels are
// rasterised (a Text drawn with a fallback face keeps it until rebuilt).
if (typeof document !== 'undefined' && document.fonts?.load) {
  void document.fonts.load('700 16px Philosopher').catch(() => undefined);
}

const cache = new Map<string, Texture>();

const toCss = (c: number | string): string =>
  typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : c;

const defaultResolution = () => Math.ceil((typeof window !== 'undefined' && window.devicePixelRatio) || 2);

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

/** Get (or build once) the texture for a glyph. Cheap on a hit. */
export function getIconTexture(name: IconName, opts: IconTextureOptions): Texture {
  const resolution = opts.resolution ?? defaultResolution();
  const color = toCss(opts.color ?? '#f2efe6');
  const outlineW = opts.outline?.width ?? 0;
  const outlineC = toCss(opts.outline?.color ?? 0x000000);
  const key = [name, opts.size, color, opts.accentAlpha ?? '', outlineW, outlineC, opts.slash ? 's' : '', resolution].join('|');
  const hit = cache.get(key);
  if (hit && !hit.destroyed) return hit;

  // Pad the canvas so the outline is not clipped.
  const pad = Math.ceil(outlineW + 1);
  const logical = opts.size + pad * 2;
  const pixel = Math.ceil(logical * resolution);
  const canvas = document.createElement('canvas');
  canvas.width = pixel;
  canvas.height = pixel;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(pad * resolution, pad * resolution);
  drawGlyph(ctx, name, opts.size * resolution, {
    color,
    accentAlpha: opts.accentAlpha,
    outline: outlineW > 0 ? { color: outlineC, widthPx: outlineW * resolution } : undefined,
    slash: opts.slash,
  });

  const texture = new Texture({ source: new CanvasSource({ resource: canvas, resolution }) });
  texture.label = `cc-icon:${key}`;
  cache.set(key, texture);
  return texture;
}

/** Centered sprite for a glyph (anchor 0.5). Cheap — shares the texture. */
export function createIconSprite(name: IconName, opts: IconTextureOptions): Sprite {
  const sprite = new Sprite(getIconTexture(name, opts));
  sprite.anchor.set(0.5);
  sprite.eventMode = 'none';
  return sprite;
}

/** One piece of a board label: a glyph, or a run of text (numbers/words). */
export interface LabelSegment {
  icon?: IconName;
  text?: string;
  color?: number | string;
  /** Glyph size / font size override for this segment. */
  size?: number;
  slash?: boolean;
}

export interface LabelRowOptions {
  /** Glyph size in px; numbers default to ~1.1× this. */
  size: number;
  /** Default color for segments without one. */
  color?: number | string;
  outline?: { color?: number | string; width: number };
  /** Horizontal gap between segments in px. */
  gap?: number;
  /** Where (0,0) sits on the row. Default 'center'. */
  align?: 'left' | 'center' | 'right';
  resolution?: number;
}

/**
 * Lay out glyphs and text in a row, vertically centred on y = 0, with tight
 * spacing measured from each glyph's ink (not its 16-unit box).
 */
export function createLabelRow(segments: LabelSegment[], opts: LabelRowOptions): Container {
  const row = new Container();
  row.eventMode = 'none';
  row.interactiveChildren = false;
  const resolution = opts.resolution ?? defaultResolution();
  const gap = opts.gap ?? 1;
  let cursor = 0;
  segments.forEach((seg, i) => {
    if (i > 0) cursor += gap;
    const color = seg.color ?? opts.color ?? 0xffffff;
    if (seg.icon) {
      const size = seg.size ?? opts.size;
      const sprite = createIconSprite(seg.icon, { size, color, outline: opts.outline, slash: seg.slash, resolution });
      const [x0, x1] = glyphInkX(seg.icon);
      const inkW = ((x1 - x0) / 16) * size;
      const inkCx = (((x0 + x1) / 2 - 8) / 16) * size;
      sprite.position.set(cursor + inkW / 2 - inkCx, 0);
      row.addChild(sprite);
      cursor += inkW;
    } else if (seg.text) {
      const fontSize = seg.size ?? Math.round(opts.size * 1.1);
      const label = new Text({
        text: seg.text.replace(/-/g, '−'),
        style: new TextStyle({
          fontFamily: NUMERAL_FONT,
          fontWeight: '700',
          fontSize,
          fill: color,
          stroke: opts.outline ? { color: opts.outline.color ?? 0x000000, width: opts.outline.width * 2, join: 'round' } : undefined,
        }),
        resolution,
      });
      label.anchor.set(0, 0.5);
      // Text bounds include padding for the stroke on both sides — pull the
      // run in by that much so glyph-to-number spacing matches the DOM.
      const strokePad = opts.outline ? opts.outline.width : 0;
      label.position.set(cursor - strokePad, fontSize * 0.04);
      row.addChild(label);
      cursor += label.width - strokePad * 2;
    }
  });
  const shift = opts.align === 'left' ? 0 : opts.align === 'right' ? -cursor : -cursor / 2;
  for (const child of row.children) child.x += shift;
  return row;
}

/** Icon + optional trailing text, centered on (0,0). */
export function createIconLabel(
  name: IconName,
  opts: IconTextureOptions & { text?: string; textColor?: number | string; gap?: number },
): Container {
  const segs: LabelSegment[] = [{ icon: name, color: opts.color }];
  if (opts.text) segs.push({ text: opts.text, color: opts.textColor ?? opts.color });
  return createLabelRow(segs, { size: opts.size, outline: opts.outline, gap: opts.gap, resolution: opts.resolution });
}

/** Number of cached textures (for the icon gallery / perf checks). */
export function iconTextureCacheSize(): number {
  return cache.size;
}

/** Destroy all cached textures (e.g. on hot reload or full teardown). */
export function clearIconTextureCache(): void {
  for (const t of cache.values()) t.destroy(true);
  cache.clear();
}
