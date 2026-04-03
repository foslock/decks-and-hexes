import { type ReactNode } from 'react';
import Tooltip from './Tooltip';

/**
 * Game keyword definitions. Each keyword maps to a one-sentence explanation.
 */
const KEYWORDS: Record<string, string> = {
  'Claim': 'Contest ownership of a hex tile using this card\'s power against the current defense.',
  'Defense': 'Add defense strength to a tile you own, making it harder for opponents to claim.',
  'Engine': 'Gain resources, draw cards, or trigger effects without targeting a tile.',
  'Power': 'Determines the strength of a claim; highest power wins the contested tile.',
  'Draw': 'Take additional cards from your deck into your hand.',
  'Discard': 'Forces the targeted opponent to draw fewer cards on their next turn.',
  'Upkeep': 'Costs 1 💰 per group of tiles beyond your first 4 (scales with grid size). Skipped round 1. If you can\'t pay, your most distant tiles are lost.',
  'Adjacent': 'A hex tile directly neighboring one you already own (6 possible directions).',
  'Stackable': 'This card can be played on a tile where you already have a claim this turn. Powers stack additively.',
  'Trash': 'Remove this card from the game permanently after it is played.',
  'Upgrade': 'Permanently improve a card using an upgrade credit, enhancing its stats.',
  'VP': 'Victory Points; first player to reach 20 wins the game.',
  'Re-roll': 'Shuffle and redraw your 3 archetype market cards for 2 resources.',
  'Retain': 'Keep one archetype market card across turns for 1 resource.',
  'Resources': 'Currency spent during the Buy phase to purchase cards or upgrade credits.',
  'Action': 'A slot used to play a card; each card costs 1 action to play.',
};

/** Style for keyword spans inside tooltips. */
const KEYWORD_STYLE: React.CSSProperties = {
  borderBottom: '1px dotted #888',
  cursor: 'help',
};

/**
 * Wraps recognized keywords in a text string with tooltip spans.
 * Keywords are matched case-insensitively at word boundaries.
 */
export function renderWithKeywords(text: string): ReactNode {
  if (!text) return null;

  // Build a regex matching all keywords (longest first to avoid partial matches)
  const sorted = Object.keys(KEYWORDS).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`\\b(${sorted.join('|')})\\b`, 'gi');

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const matched = match[0];
    // Find the canonical keyword (case-insensitive lookup)
    const canonical = sorted.find((k) => k.toLowerCase() === matched.toLowerCase()) || matched;
    const definition = KEYWORDS[canonical];

    parts.push(
      <Tooltip key={`${match.index}-${matched}`} content={definition}>
        <span style={KEYWORD_STYLE}>{matched}</span>
      </Tooltip>
    );

    lastIndex = pattern.lastIndex;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : text;
}

export { KEYWORDS };
