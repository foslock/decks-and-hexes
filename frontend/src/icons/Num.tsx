import type { CSSProperties, ReactNode } from 'react';
import Icon from './Icon';
import type { IconName } from './glyphs';

/**
 * Number typography for every icon + value readout (card subtitles, HUD,
 * costs, overlays): bold Philosopher, lining, fixed-width digits.
 *
 * Philosopher ships proportional figures only (`tnum` is a no-op), so
 * fixed width is done by setting each digit in its own centred cell of
 * DIGIT_CELL. The widest Philosopher Bold digit ("0") is 0.61 em; a
 * slightly narrower cell keeps "1" from floating while the widest digits
 * overhang their cell imperceptibly.
 */
export const NUMERAL_FAMILY = "'Philosopher', Georgia, serif";
const DIGIT_CELL = '0.56em';
/** Philosopher's figures sit slightly high in their em box — nudge so they
 *  centre on an adjacent glyph's vertical middle. */
const OPTICAL_NUDGE = '0.04em';

export interface NumProps {
  value: string | number;
  /** Font size in px (or CSS length). Defaults to the inherited size. */
  size?: number | string;
  color?: string;
  style?: CSSProperties;
  className?: string;
}

/** A numeric value — "+2", "3", "2/4", "≤3", "×5", "5/20", or a lone sign. */
export function Num({ value, size, color, style, className }: NumProps) {
  const text = String(value).replace(/-/g, '−');
  return (
    <span
      className={className}
      style={{
        fontFamily: NUMERAL_FAMILY,
        fontWeight: 700,
        fontSize: size,
        fontVariantNumeric: 'lining-nums tabular-nums',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        position: 'relative',
        top: OPTICAL_NUDGE,
        color,
        ...style,
      }}
    >
      {Array.from(text).map((ch, i) =>
        ch >= '0' && ch <= '9'
          ? <span key={i} style={{ display: 'inline-block', width: DIGIT_CELL, textAlign: 'center' }}>{ch}</span>
          : ch,
      )}
    </span>
  );
}

export interface IconValueProps {
  icon: IconName;
  value?: ReactNode;
  /** Base font size in px; the glyph is sized from it (×1.08). */
  size?: number;
  /** Glyph before the value (stats: "sword 3") or after it (costs: "4 coin"). */
  iconFirst?: boolean;
  color?: string;
  slash?: boolean;
  /** Accessible / hover label for the glyph. */
  title?: string;
  decorative?: boolean;
  gap?: number;
  style?: CSSProperties;
  className?: string;
}

/**
 * Glyph + number as one vertically centred unit. Numbers render through
 * <Num>; any other node (e.g. a word) is placed as-is.
 */
export function IconValue({
  icon, value, size = 13, iconFirst = true, color, slash, title, decorative, gap = 2, style, className,
}: IconValueProps) {
  const glyph = (
    <Icon
      name={icon}
      size={Math.round(size * 1.08)}
      trim
      slash={slash}
      title={title}
      decorative={decorative}
    />
  );
  const val = value === undefined || value === null || value === ''
    ? null
    : (typeof value === 'number' || typeof value === 'string')
      ? <Num value={value} size={Math.round(size * 1.06)} />
      : value;
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap, verticalAlign: 'middle', lineHeight: 1, color, ...style }}
    >
      {iconFirst ? <>{glyph}{val}</> : <>{val}{glyph}</>}
    </span>
  );
}

/** Buy cost: "4 (coin)". `null` cost renders an em dash. */
export function CostLabel({ cost, size = 13, color, style, suffix }: {
  cost: number | null | undefined; size?: number; color?: string; style?: CSSProperties; suffix?: string;
}) {
  if (cost === null || cost === undefined) return <span style={{ color, ...style }}>{'—'}</span>;
  return (
    <IconValue
      icon="resource"
      value={`${cost}${suffix ?? ''}`}
      size={size}
      iconFirst={false}
      gap={1}
      color={color}
      title={`${cost} resources`}
      style={style}
    />
  );
}
