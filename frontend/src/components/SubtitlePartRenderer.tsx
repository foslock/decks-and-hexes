import React from 'react';
import type { SubtitlePart } from './cardSubtitle';

/**
 * Renders a SubtitlePart with inline ★ coloring (gold/red for VP parts).
 * Dynamic parts get bold yellow styling. Stars are always individually colored.
 */
export function renderSubtitleText(
  text: string,
  vpColor: string = '#ffd700',
): React.ReactNode {
  // Split around ★ to color only the star
  const segments = text.split('★');
  if (segments.length === 1) return text;
  return (
    <>
      {segments.map((seg, i) => (
        <React.Fragment key={i}>
          {seg}
          {i < segments.length - 1 && <span style={{ color: vpColor }}>★</span>}
        </React.Fragment>
      ))}
    </>
  );
}

/**
 * Render a subtitle part with proper star coloring and dynamic styling.
 */
export function renderSubtitlePart(
  part: SubtitlePart,
  index: number,
  opts?: { passiveVp?: number; showDynamic?: boolean },
): React.ReactNode {
  const vpColor = opts?.passiveVp !== undefined && opts.passiveVp < 0 ? '#ff6666' : '#ffd700';
  const hasStar = part.text.includes('★');
  const isDyn = opts?.showDynamic && part.dynamic;

  const style: React.CSSProperties | undefined = hasStar
    ? undefined  // stars are colored inline
    : isDyn
      ? { color: '#ffe14d', fontWeight: 'bold' }
      : undefined;

  const className = isDyn && !hasStar ? 'dynamic-value' : undefined;

  return (
    <span key={index} className={className} style={style}>
      {index > 0 ? ' · ' : ''}
      {hasStar ? renderSubtitleText(part.text, vpColor) : part.text}
    </span>
  );
}
