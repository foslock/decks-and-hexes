import { type ReactNode } from 'react';
import Tooltip from './Tooltip';

/**
 * Game keyword definitions. Each keyword maps to a one-sentence explanation.
 */
/**
 * Canonical keyword → tooltip definition.
 * The regex builder also generates plural/singular variants automatically.
 */
const KEYWORDS: Record<string, string> = {
  'Claim': 'Contest ownership of a hex tile using this card\'s power against the current defense.',
  'Defense': 'Add defense strength to a tile you own, making it harder for opponents to claim.',
  'Engine': 'Gain resources, draw cards, or trigger effects without targeting a tile.',
  'Power': 'Determines the strength of a claim; highest power wins the contested tile.',
  'Draw': 'Take additional cards from your deck into your hand.',
  'Discard': 'Put a card from your hand into your discard pile.',
  'Upkeep': 'Costs 1 💰 per group of tiles beyond your first 4 (scales with grid size). Skipped round 1. If you can\'t pay, your most distant tiles are lost.',
  'Adjacent': 'A hex tile directly neighboring one you already own (6 possible directions).',
  'Stackable': 'This card can be played on a tile where you already have a claim this turn. Powers stack additively.',
  'Trash': 'Remove this card from your deck permanently.',
  'Upgrade': 'Permanently improve a card using an upgrade credit, enhancing its stats.',
  'VP': 'Victory Points; first player to reach the VP target wins the game.',
  'Re-roll': 'Shuffle and redraw your 3 archetype market cards for 2 resources.',
  'Retain': 'Keep one archetype market card across turns for 1 resource.',
  'Resource': 'Currency spent during the Buy phase to purchase cards or upgrade credits.',
  'Action': 'A slot used to play a card; each card costs 1 action to play.',
  'Tile': 'A hex on the board that can be claimed, defended, or scored.',
};

/**
 * Map from a matched surface form (lowercase) back to the canonical keyword.
 * Handles plurals: "actions" → "Action", "resources" → "Resource", etc.
 */
const SURFACE_TO_CANONICAL: Record<string, string> = {};
const SURFACE_FORMS: string[] = [];

for (const key of Object.keys(KEYWORDS)) {
  const lower = key.toLowerCase();
  SURFACE_TO_CANONICAL[lower] = key;
  SURFACE_FORMS.push(key);

  // Generate plural variant (keyword + "s") if it doesn't end in "s" already
  if (!lower.endsWith('s')) {
    const plural = key + 's';
    SURFACE_TO_CANONICAL[plural.toLowerCase()] = key;
    SURFACE_FORMS.push(plural);
  }
  // Generate singular variant (strip trailing "s") if it ends in "s"
  if (lower.endsWith('s') && lower.length > 2) {
    const singular = key.slice(0, -1);
    SURFACE_TO_CANONICAL[singular.toLowerCase()] = key;
    SURFACE_FORMS.push(singular);
  }
}

// Sort longest-first to avoid partial matches
SURFACE_FORMS.sort((a, b) => b.length - a.length);

/** Style for keyword spans inside tooltips. */
const KEYWORD_STYLE: React.CSSProperties = {
  borderBottom: '1px dotted #888',
  cursor: 'help',
};

/**
 * Wraps recognized keywords in a text string with tooltip spans.
 * Keywords are matched case-insensitively at word boundaries.
 */
/** Precompiled regex matching all keyword surface forms (longest first). */
const KEYWORD_PATTERN = new RegExp(
  `\\b(${SURFACE_FORMS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'gi',
);

export function renderWithKeywords(text: string): ReactNode {
  if (!text) return null;

  // Reset lastIndex in case the regex was used before
  KEYWORD_PATTERN.lastIndex = 0;

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = KEYWORD_PATTERN.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    const matched = match[0];
    // Look up canonical keyword from the surface form
    const canonical = SURFACE_TO_CANONICAL[matched.toLowerCase()] || matched;
    const definition = KEYWORDS[canonical];

    parts.push(
      <Tooltip key={`${match.index}-${matched}`} content={definition}>
        <span style={KEYWORD_STYLE}>{matched}</span>
      </Tooltip>
    );

    lastIndex = KEYWORD_PATTERN.lastIndex;
  }

  // Remaining text after last match
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? <>{parts}</> : text;
}

/** Extract unique canonical keywords found in a text string. */
export function extractKeywordsFromText(text: string): { keyword: string; definition: string }[] {
  if (!text) return [];
  KEYWORD_PATTERN.lastIndex = 0;
  const seen = new Set<string>();
  const result: { keyword: string; definition: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = KEYWORD_PATTERN.exec(text)) !== null) {
    const canonical = SURFACE_TO_CANONICAL[match[0].toLowerCase()];
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      result.push({ keyword: canonical, definition: KEYWORDS[canonical] });
    }
  }
  return result;
}

export { KEYWORDS };
