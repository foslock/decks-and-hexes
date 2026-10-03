import React from 'react';
import type { SubtitlePart, SubtitleToken } from './cardSubtitle';
import { subtitleToText } from './cardSubtitle';
import Icon from '../icons/Icon';
import { Num } from '../icons/Num';
import type { IconName } from '../icons/glyphs';

/**
 * Card subtitle renderer: turns the semantic tokens from buildCardSubtitle
 * into single-color glyphs + bold Philosopher fixed-width numerals, laid
 * out as one inline-flex row so glyphs and numbers share a vertical centre.
 *
 * Colors: everything inherits the caller's text color, except
 *  - VP glyphs/values: gold (red when the card's passive VP is negative)
 *  - glowing parts (granted stackable, positive VP): gold with a glow
 *  - dynamic parts (resolved from game context): bright yellow
 */

export interface SubtitleRenderOptions {
  /** Subtitle font size in px — glyphs and numerals are sized from it. */
  fontSize?: number;
  passiveVp?: number;
  /** Highlight values resolved from live game context. */
  showDynamic?: boolean;
}

const VP_GOLD = '#ffd700';
const VP_NEGATIVE = '#ff6666';
const GLOW_SHADOW = '0 0 6px rgba(255, 215, 0, 0.8), 0 0 12px rgba(255, 215, 0, 0.4)';
const DYN_COLOR = '#ffe14d';

/** Modifier glyphs drawn smaller than full-size glyphs. */
const SMALL: ReadonlySet<IconName> = new Set<IconName>(['nextRound', 'then']);

/** Does this part carry a VP value (so its numbers take the VP color)? */
const isVpPart = (tokens: SubtitleToken[]) => tokens.some(t => t.kind === 'icon' && t.name === 'vp');

function renderPart(part: SubtitlePart, index: number, opts: SubtitleRenderOptions): React.ReactNode {
  const fontSize = opts.fontSize ?? 13;
  const iconPx = Math.round(fontSize * 1.08);
  const smallPx = Math.round(iconPx * 0.78);
  const numPx = Math.round(fontSize * 1.04);
  const isDyn = !!(opts.showDynamic && part.dynamic);
  const glow = !!part.glow;
  const vpColor = opts.passiveVp !== undefined && opts.passiveVp < 0 ? VP_NEGATIVE : VP_GOLD;
  const partColor = glow ? VP_GOLD : isDyn ? DYN_COLOR : isVpPart(part.tokens) ? vpColor : undefined;

  return (
    <React.Fragment key={index}>
      {index > 0 && (
        <span aria-hidden style={{ margin: '0 0.18em', opacity: 0.65, fontWeight: 700, lineHeight: 1 }}>·</span>
      )}
      <span
        className={isDyn ? 'dynamic-value' : undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 1,
          color: partColor,
          textShadow: glow ? GLOW_SHADOW : undefined,
          fontWeight: glow || isDyn ? 700 : undefined,
        }}
      >
        {part.tokens.map((t, k) => {
          if (t.kind === 'icon') {
            const small = SMALL.has(t.name);
            return (
              <Icon
                key={k}
                name={t.name}
                slash={t.slash}
                size={small ? smallPx : iconPx}
                trim
                tooltip={false}
                style={{
                  margin: t.name === 'then' ? '0 0.1em' : undefined,
                  opacity: t.name === 'then' ? 0.7 : undefined,
                  filter: glow ? 'drop-shadow(0 0 3px rgba(255, 215, 0, 0.8))' : undefined,
                }}
              />
            );
          }
          if (t.kind === 'num') return <Num key={k} value={t.text} size={numPx} />;
          return <span key={k} style={{ whiteSpace: 'pre', lineHeight: 1, opacity: /^[\s·,()/]+$/.test(t.text) ? 0.75 : undefined }}>{t.text}</span>;
        })}
      </span>
    </React.Fragment>
  );
}

/**
 * Render a full subtitle line. The wrapper carries a plain-language
 * aria-label ("power 3, +1 card, +1 action").
 */
export function renderSubtitle(parts: SubtitlePart[], opts: SubtitleRenderOptions = {}): React.ReactNode {
  if (parts.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={subtitleToText(parts)}
      style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap', verticalAlign: 'middle', lineHeight: 1.15 }}
    >
      {parts.map((part, i) => renderPart(part, i, opts))}
    </span>
  );
}
