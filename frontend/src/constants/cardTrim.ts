import type { Card } from '../types/game';

/**
 * Card "trim": the metallic frame around a full card, tiered by buy cost the
 * way a trading card's foil follows its rarity. Starters and tokens get plain
 * iron; the dearer the card, the richer the metal.
 */
export type TrimTier = 'iron' | 'bronze' | 'silver' | 'gold' | 'mythic';

/** Gradient stops for each metal, light → dark → light so it reads as polished. */
export const TRIM_METALS: Record<TrimTier, string[]> = {
  iron: ['#7f848f', '#3a3e47', '#8f949e', '#272a31', '#646973'],
  bronze: ['#ffdcb8', '#c0814a', '#f2c99e', '#7f4a20', '#dda06c'],
  silver: ['#f7f8fa', '#b9c0ca', '#fbfcfd', '#8c95a1', '#e3e7ec'],
  gold: ['#fff3c4', '#e2ae45', '#fff6d6', '#b4801f', '#f5d47a'],
  mythic: ['#ffe4c9', '#ff7a36', '#fff2e3', '#c03a12', '#ffb877'],
};

/** Ink colour that reads on each metal (ribbon text, coin numerals). */
export const TRIM_INK: Record<TrimTier, string> = {
  iron: '#16161f',
  bronze: '#2b1606',
  silver: '#1b1e26',
  gold: '#2a1d05',
  mythic: '#2e0c00',
};

export function cardTrimTier(card: Pick<Card, 'buy_cost' | 'starter'>): TrimTier {
  const cost = card.buy_cost;
  if (card.starter || cost == null) return 'iron';
  if (cost <= 3) return 'bronze';
  if (cost <= 5) return 'silver';
  if (cost <= 7) return 'gold';
  return 'mythic';
}

/** A polished-metal linear gradient for a trim tier. */
export function metalGradient(tier: TrimTier, angle = 135): string {
  const stops = TRIM_METALS[tier];
  return `linear-gradient(${angle}deg, ${stops.map((c, i) => `${c} ${Math.round((i / (stops.length - 1)) * 100)}%`).join(', ')})`;
}

/** Blend two #rrggbb colours (t = 0 → a, 1 → b). */
export function mixHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1, 7), 16);
  const pb = parseInt(b.slice(1, 7), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const m = (s: number) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t);
  return `#${((1 << 24) | (m(16) << 16) | (m(8) << 8) | m(0)).toString(16).slice(1)}`;
}
