import { useId, type CSSProperties } from 'react';
import { GLYPHS, glyphInkX, type IconName } from './glyphs';

export interface IconProps {
  name: IconName;
  /** Pixel size (number) or any CSS length. Defaults to `1em` so the icon
   *  scales with surrounding text. Prefer integer px for crisp edges. */
  size?: number | string;
  /** Explicit color. Icons are single-color: by default they paint with
   *  `currentColor`, i.e. the surrounding text color. */
  color?: string;
  /** Overlay a prohibition slash (e.g. "ignores defense", "no claims"). */
  slash?: boolean;
  /** Crop the box horizontally to the glyph's ink plus this side bearing
   *  (grid units; `true` = 0.6). Use in running text so narrow glyphs
   *  don't add air — like a font's advance width. Height is unchanged. */
  trim?: boolean | number;
  /** Accessible label. When omitted the glyph's own label is used unless
   *  `decorative` is set (then the icon is hidden from assistive tech). */
  title?: string;
  /** Hide from assistive tech — use when adjacent text already says it. */
  decorative?: boolean;
  /** Render a native hover tooltip (`<title>`) with the label. Default true;
   *  turn off inside dense readouts (card subtitles) that have their own
   *  hover behaviour — the aria-label is kept either way. */
  tooltip?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * Secondary (duotone) layer style — the same color at reduced opacity.
 * Override per-context with --cc-icon-accent-opacity (default 0.42).
 */
const ACCENT_STYLE: CSSProperties = {
  fillOpacity: 'var(--cc-icon-accent-opacity, 0.42)' as unknown as number,
};

/** Band removed from the glyph under the slash so the slash reads cleanly. */
const SLASH_GAP = 'M-1.49 1.49 L14.51 17.49 L17.49 14.51 L1.49 -1.49 Z';
const SLASH_BAR = 'M1.33 2.67 L13.33 14.67 L14.67 13.33 L2.67 1.33 Z';

/**
 * Card Clash icon. Renders a hand-authored 16×16 glyph as inline SVG in a
 * single color (currentColor unless `color` is given).
 *
 *   <Icon name="power" size={12} />
 *   <Icon name="defense" slash title="Ignores defense" />
 */
export default function Icon({
  name,
  size = '1em',
  color,
  slash = false,
  trim = false,
  title,
  decorative = false,
  tooltip = true,
  className,
  style,
}: IconProps) {
  const uid = useId();
  const glyph = GLYPHS[name];
  const label = decorative ? undefined : (title ?? glyph.label);
  const maskId = `cci-${uid.replace(/:/g, '')}`;
  const dim = typeof size === 'number' ? `${size}px` : size;
  let viewBox = '0 0 16 16';
  let width = dim;
  if (trim !== false) {
    const sb = trim === true ? 0.6 : trim;
    const [x0, x1] = glyphInkX(name);
    const vx = Math.max(-1, x0 - sb);
    const vw = Math.min(17, x1 + sb) - vx;
    viewBox = `${vx.toFixed(2)} 0 ${vw.toFixed(2)} 16`;
    width = typeof size === 'number' ? `${(size * vw) / 16}px` : `calc(${dim} * ${(vw / 16).toFixed(4)})`;
  }

  return (
    <svg
      viewBox={viewBox}
      width={width}
      height={dim}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      style={{
        display: 'inline-block',
        flexShrink: 0,
        overflow: 'visible',
        color,
        fill: 'currentColor',
        ...style,
      }}
    >
      {label && tooltip && <title>{label}</title>}
      {slash && (
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="20" height="20">
            <rect x="-2" y="-2" width="20" height="20" fill="#fff" />
            <path d={SLASH_GAP} fill="#000" />
          </mask>
        </defs>
      )}
      <g mask={slash ? `url(#${maskId})` : undefined}>
        {glyph.layers.map((layer, i) => (
          <path
            key={i}
            d={layer.d}
            fillRule={'evenOdd' in layer && layer.evenOdd ? 'evenodd' : undefined}
            style={'accent' in layer && layer.accent ? ACCENT_STYLE : undefined}
          />
        ))}
      </g>
      {slash && <path d={SLASH_BAR} />}
    </svg>
  );
}
