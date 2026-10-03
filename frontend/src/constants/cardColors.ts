/**
 * Centralized card type color definitions.
 * All components should import from here instead of defining locally.
 *
 * Claim  = Red
 * Defense = Blue
 * Engine = Green
 * Passive = Purple
 */

export const CARD_TYPE_COLORS: Record<string, string> = {
  claim: '#a83040',
  defense: '#3a7abf',
  engine: '#2e8a3a',
  passive: '#8868a8',
};

/** Font family for card titles (loaded via Google Fonts in index.html). */
export const CARD_TITLE_FONT = "'Philosopher', serif";

/** Burnt orange color for Debt cards. */
export const DEBT_CARD_COLOR = '#9a5020';

/** Lookup with fallback for unknown card types. */
export function cardTypeColor(cardType: string): string {
  return CARD_TYPE_COLORS[cardType] || '#555';
}

/** Get the display color for a card, with special cases (e.g. Debt → burnt orange). */
export function getCardDisplayColor(card: { name: string; card_type: string }): string {
  if (card.name === 'Debt') return DEBT_CARD_COLOR;
  return CARD_TYPE_COLORS[card.card_type] || '#555';
}

/** Get the display type label for a card, with special cases (e.g. Debt → "Debt"). */
export function getCardDisplayType(card: { name: string; card_type: string }): string {
  if (card.name === 'Debt') return 'Debt';
  const TYPE_LABELS: Record<string, string> = { claim: 'Claim', defense: 'Defense', engine: 'Engine', passive: 'Passive' };
  return TYPE_LABELS[card.card_type] || card.card_type;
}

/**
 * Layered surface for compact card chips (hand cards, In Play list, compact
 * market tiles): a type-colored wash at the top, a faint top highlight and a
 * darker foot so the chip reads as a physical card rather than a label.
 * `typeColor` must be a 6-digit hex (alpha suffixes are appended).
 */
export function miniCardBackground(typeColor: string, base = '#23233a'): string {
  return [
    `linear-gradient(180deg, ${typeColor}40 0%, ${typeColor}14 40%, rgba(0,0,0,0) 62%)`,
    'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 32%, rgba(0,0,0,0.24) 100%)',
    base,
  ].join(', ');
}

/** Drop shadow + top bevel paired with miniCardBackground. */
export const MINI_CARD_SHADOW = 'inset 0 1px 0 rgba(255,255,255,0.1), 0 3px 8px rgba(0,0,0,0.45)';
