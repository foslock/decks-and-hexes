import { Fragment, type CSSProperties, type ReactNode } from 'react';
import Icon from '../icons/Icon';

/** Gold of the upgraded-card arrow. */
export const UPGRADE_MARK_COLOR = '#ffcf45';

/**
 * Upgraded cards are named "Blitz+" by the engine. The UI shows the base
 * name led by a thick gold arrow instead, so an upgraded card is spotted by
 * the first glyph of its title (which stays visible when hand cards overlap).
 */
export function splitUpgradeMark(name: string): { base: string; upgraded: boolean } {
  const upgraded = /\+\s*$/.test(name);
  return { base: upgraded ? name.replace(/\s*\+\s*$/, '') : name, upgraded };
}

/** A card's name for plain-text contexts (errors, aria labels): no "+". */
export function plainCardName(name: string): string {
  return splitUpgradeMark(name).base;
}

/** The arrow that leads an upgraded card's name. Sized to the text. */
export function UpgradeMark({ size = '0.92em', style }: { size?: number | string; style?: CSSProperties }) {
  return (
    <Icon
      name="upgraded"
      size={size}
      color={UPGRADE_MARK_COLOR}
      title="Upgraded"
      tooltip={false}
      trim
      style={{
        marginRight: '0.22em',
        verticalAlign: '-0.08em',
        filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.75)) drop-shadow(0 0 3px rgba(255, 190, 40, 0.45))',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

/**
 * A card's display name: the arrow (when upgraded) then the base name.
 * Pass the card's `name`; `upgraded` overrides the trailing-"+" detection
 * (e.g. a card flagged is_upgraded whose name has no "+").
 */
export default function CardName({ name, upgraded, markSize }: {
  name: string;
  upgraded?: boolean;
  markSize?: number | string;
}) {
  const split = splitUpgradeMark(name);
  const isUp = upgraded ?? split.upgraded;
  return (
    <>
      {isUp && <UpgradeMark size={markSize} />}
      {split.base}
    </>
  );
}

/**
 * Render free text (game log lines, effect messages) with every upgraded
 * card name ("Blitz+") swapped for the arrow + base name. `pattern` matches
 * base names; see cardCatalog's upgradedNamePattern.
 */
export function renderUpgradedNames(text: string, pattern: RegExp | null): ReactNode {
  if (!pattern || !text.includes('+')) return text;
  pattern.lastIndex = 0;
  const parts: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<Fragment key={m.index}><UpgradeMark />{m[1]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return text;
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
