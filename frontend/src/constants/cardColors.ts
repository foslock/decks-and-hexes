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
  claim: '#e04050',
  defense: '#4a9eff',
  engine: '#3bb44b',
  passive: '#aa88cc',
};

/** Lookup with fallback for unknown card types. */
export function cardTypeColor(cardType: string): string {
  return CARD_TYPE_COLORS[cardType] || '#555';
}
