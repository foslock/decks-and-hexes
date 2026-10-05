import type { Card } from '../types/game';

// Player colors — mutable, populated from game state on game start.
// Fallback defaults used if game state hasn't been loaded yet.
export const PLAYER_COLORS: Record<string, number> = {
  player_0: 0xe6194b,
  player_1: 0x3cb44b,
  player_2: 0xffe119,
  player_3: 0x4363d8,
  player_4: 0xf58231,
  player_5: 0x911eb4,
};

/** Convert a CSS hex color string (#rrggbb) to a numeric 0xRRGGBB value. */
export function cssHexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

/** Update PLAYER_COLORS from the game state's player color assignments. */
export function syncPlayerColors(players: Record<string, { color?: string }>): void {
  for (const [pid, p] of Object.entries(players)) {
    if (p.color) {
      PLAYER_COLORS[pid] = cssHexToNumber(p.color);
    }
  }
}

export interface PlannedActionIcon {
  type: string;  // 'claim' | 'defense' | 'engine' | 'abandon'
  power: number;
  name: string;
  card: Card;
  /** All individual cards played on this tile (for multi-card hover preview) */
  allCards: { card: Card; effectivePower?: number }[];
  /** Permanent defense power from cards with permanent_defense effects */
  permanentDefPower: number;
  /** Temporary defense power from other defense/claim cards */
  tempDefPower: number;
}

export interface ClaimChevron {
  targetQ: number;
  targetR: number;
  sourceQ: number;
  sourceR: number;
  color: number;
  alpha: number;
}

export interface VpPath {
  /** Hex coords from VP tile (index 0) to base tile (last index) */
  points: [number, number][];
  /** Player color (will be lightened for the line) */
  color: number;
  /** Overall opacity 0–1 (for fade in/out) */
  alpha: number;
  /** Player who owns this path */
  playerId: string;
  /** If true, this path's connection is broken and it's fading out quickly */
  breaking?: boolean;
  /** If true, render at steady alpha/width without breathing pulse */
  noPulse?: boolean;
}

export interface PlayerInfo {
  name: string;
  archetype: string;
}

/**
 * Total stacking power bonus across a stack of claim cards on a single tile.
 * Mirrors the backend `_stacking_power_bonus`: each claim with a
 * `stacking_power_bonus` effect (e.g. Dog Pile) grants its value to every
 * OTHER claim on the tile, so the total added to the tile's combined power
 * is `value × (N − 1)` summed across all such cards.
 */
export function computeStackingPowerBonus(claimCards: Card[]): number {
  if (claimCards.length < 2) return 0;
  let totalVal = 0;
  for (const c of claimCards) {
    if (!c.effects) continue;
    for (const eff of c.effects) {
      if (eff.type !== 'stacking_power_bonus') continue;
      const v = c.is_upgraded && eff.upgraded_value != null ? eff.upgraded_value : (eff.value ?? 0);
      totalVal += v;
    }
  }
  return totalVal * (claimCards.length - 1);
}

/** A 2D point in hex-local pixel space (see utils/hexGeometry). */
export interface LocalPoint { x: number; y: number }

/** Hex-shaped fortification ring that rises around a raided base. */
export interface FxFortifyRing {
  /** 0 → 1 rise-in progress. */
  setProgress(t: number): void;
  /** Brief white-hot flash (a ram impact or a held defense). */
  flash(strength?: number): void;
  /** Blow the ring apart into tumbling stone shards. */
  shatter(): void;
  setAlpha(alpha: number): void;
  destroy(): void;
}

/**
 * Board effects the resolve choreography (TileResolver) drives. All
 * positions are in hex-local pixel space so callers never touch the camera.
 */
export interface BoardFx {
  createFortifyRing(q: number, r: number): FxFortifyRing;
  /** Bright spark burst (contest clash, wedge collision). */
  sparks(x: number, y: number, color: number, count?: number, power?: number): void;
  /** Dust / debris puff at ground level. */
  dust(x: number, y: number, count?: number, power?: number): void;
  /** Expanding ring across the ground. */
  shockwave(x: number, y: number, color: number, radius?: number, durationMs?: number): void;
  /** Column of light + motes (consecrate, capture, defense applied). */
  pillar(x: number, y: number, color: number, durationMs?: number): void;
  /** Shake the camera. */
  shake(strength: number, durationMs?: number): void;
  /** Jolt the structure (castle / walls) standing on a tile. */
  jolt(q: number, r: number, strength?: number): void;
  /** A tile changes hands: a flash, sparks and a ring in the new owner's color. */
  captureBurst(q: number, r: number, color: number, big?: boolean): void;
  /** Duration multiplier for board-driven transitions (0 = instant). */
  setSpeed(mult: number): void;
}
