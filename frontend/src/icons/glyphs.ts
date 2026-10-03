/**
 * Card Clash icon glyphs — hand-authored path data on a 16×16 grid.
 *
 * Design rules (keep these when adding glyphs):
 *  - viewBox is always `0 0 16 16`; ink sits roughly inside 0.6–15.4.
 *  - Minimum stroke / knockout width ≈ 1.8 units (≈1.35 px at 12 px,
 *    1.6 px at 14 px). Nothing hairline — glyphs must survive 11–12 px.
 *  - Solid silhouettes first; interior detail only as bold knockouts
 *    (even-odd sub-paths) or as an `accent` layer drawn at reduced
 *    opacity *behind* the primary layer (duotone).
 *  - Heraldic / engraved feel: flat fills, crisp corners, no gradients.
 *  - Layers draw in array order. Accent layers are listed first so the
 *    primary ink sits on top.
 *
 * This file is renderer-agnostic: the same data feeds the React `<Icon>`
 * (SVG) and the PixiJS texture cache (Canvas2D `Path2D`), so the board and
 * the DOM always show identical glyphs.
 */

export interface GlyphLayer {
  /** SVG path data in 16×16 grid units (absolute M/L/H/V/C/A/Z only). */
  d: string;
  /** Draw in the secondary tone (reduced-opacity currentColor by default). */
  accent?: boolean;
  /** Use the even-odd fill rule (needed for knockout sub-paths). */
  evenOdd?: boolean;
}

export type GlyphGroup = 'stat' | 'card' | 'board' | 'modifier' | 'zone' | 'ui' | 'sigil';

export interface GlyphDef {
  /** Human label — used for aria-label / title and the preview grid. */
  label: string;
  group: GlyphGroup;
  layers: GlyphLayer[];
}

// ── Shared sub-shapes ────────────────────────────────────────────────────

/** Heater shield silhouette (flat top). */
const SHIELD = 'M2.2 1.6 H13.8 V7.2 C13.8 10.7 11.4 13.5 8 15.2 C4.6 13.5 2.2 10.7 2.2 7.2 Z';
/** Inner right half of the shield (heraldic "per pale" split). */
const SHIELD_PALE = 'M8 3.3 H12.1 V7.2 C12.1 9.8 10.4 12 8 13.3 Z';
/** Flat-top hexagon — same orientation as the board. */
const HEX = 'M15.4 8 L11.7 14.41 L4.3 14.41 L0.6 8 L4.3 1.59 L11.7 1.59 Z';
const HEX_INNER = 'M12.7 8 L10.35 12.07 L5.65 12.07 L3.3 8 L5.65 3.93 L10.35 3.93 Z';
/** Card body with a notched bottom-right corner for a modifier sigil. */
const CARD_NOTCHED =
  'M3.5 1 H9.5 A1.5 1.5 0 0 1 11 2.5 V7.51 A4.6 4.6 0 0 0 7.51 13 H3.5 A1.5 1.5 0 0 1 2 11.5 V2.5 A1.5 1.5 0 0 1 3.5 1 Z';
/** Diagonal sword, tip up-right (blade + guard + grip). The hilt is kept
 *  compact (guard 5.9 units across, 1.8 thick) so the blade reads first. */
const SWORD =
  'M14.22 1.78 L13.34 4.85 L7.54 10.65 L8.21 11.33 L8.21 11.96 L7.57 12.60 L6.94 12.60 L5.88 11.54 L4.39 13.02 L2.98 11.61 L4.46 10.12 L3.40 9.06 L3.40 8.43 L4.04 7.79 L4.67 7.79 L5.35 8.46 L11.15 2.66 Z';
/** Square (lozenge) pommel — round pommels made the crossed pair read as crossbones. */
const SWORD_POMMEL = 'M3.19 11.40 L4.60 12.81 L3.19 14.23 L1.77 12.81 Z';
const SWORD_MIRROR =
  'M1.78 1.78 L2.66 4.85 L8.46 10.65 L7.79 11.33 L7.79 11.96 L8.43 12.60 L9.06 12.60 L10.12 11.54 L11.61 13.02 L13.02 11.61 L11.54 10.12 L12.60 9.06 L12.60 8.43 L11.96 7.79 L11.33 7.79 L10.65 8.46 L4.85 2.66 Z';
const SWORD_MIRROR_POMMEL = 'M12.81 11.40 L14.23 12.81 L12.81 14.23 L11.40 12.81 Z';
const STAR = 'M8 0.95 L9.85 6 L15.23 6.2 L11 9.52 L12.47 14.7 L8 11.7 L3.53 14.7 L5 9.52 L0.77 6.2 L6.15 6 Z';
const GEAR =
  'M13.48 8.46 L15.3 9.73 L14.38 11.94 L12.2 11.55 L11.55 12.2 L11.94 14.38 L9.73 15.3 L8.46 13.48 L7.54 13.48 L6.27 15.3 L4.06 14.38 L4.45 12.2 L3.8 11.55 L1.62 11.94 L0.7 9.73 L2.52 8.46 L2.52 7.54 L0.7 6.27 L1.62 4.06 L3.8 4.45 L4.45 3.8 L4.06 1.62 L6.27 0.7 L7.54 2.52 L8.46 2.52 L9.73 0.7 L11.94 1.62 L11.55 3.8 L12.2 4.45 L14.38 4.06 L15.3 6.27 L13.48 7.54 Z';
const HELM =
  'M2.8 7.6 C2.8 3.9 5.1 1.2 8 1.2 C10.9 1.2 13.2 3.9 13.2 7.6 V11.4 C13.2 13 12 14.2 10.6 14.8 H5.4 C4 14.2 2.8 13 2.8 11.4 Z';
const HELM_VISOR = 'M4.4 6.6 H11.6 V8.4 H8.9 V12.6 H7.1 V8.4 H4.4 Z';

/** Circle helper written out as two arcs (keeps the data plain path strings). */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
}

// ── Glyph table ──────────────────────────────────────────────────────────

export const GLYPHS = {
  // ── Core stats ──
  power: {
    label: 'Power', group: 'stat',
    layers: [{ d: SWORD }, { d: SWORD_POMMEL }],
  },
  defense: {
    label: 'Defense (this round)', group: 'stat',
    layers: [
      { d: SHIELD_PALE, accent: true },
      { d: `${SHIELD} ${SHIELD_PALE}`, evenOdd: true },
    ],
  },
  fortify: {
    label: 'Permanent defense', group: 'stat',
    layers: [
      { d: 'M8 4.7 H12.1 V7.2 C12.1 9.8 10.4 12 8 13.3 Z', accent: true },
      {
        d: 'M2.2 7.2 V1.2 H4.9 V3.1 H6.8 V1.2 H9.2 V3.1 H11.1 V1.2 H13.8 V7.2 C13.8 10.7 11.4 13.5 8 15.2 C4.6 13.5 2.2 10.7 2.2 7.2 Z M8 4.7 H12.1 V7.2 C12.1 9.8 10.4 12 8 13.3 Z',
        evenOdd: true,
      },
    ],
  },
  immune: {
    label: 'Immune', group: 'stat',
    layers: [{ d: `${SHIELD} M8 3.9 L8.95 6.75 L11.8 7.7 L8.95 8.65 L8 11.5 L7.05 8.65 L4.2 7.7 L7.05 6.75 Z`, evenOdd: true }],
  },
  resource: {
    label: 'Resources', group: 'stat',
    // Solid disc + diamond knockout. (A ring + duotone face + diamond read
    // better at 24 px but blurred into a grey dot at 11–12 px on 1× screens.)
    layers: [{ d: `${circle(8, 8, 7.3)} M8 3.5 L11 8 L8 12.5 L5 8 Z`, evenOdd: true }],
  },
  card: {
    label: 'Card', group: 'card',
    layers: [{
      d: 'M5 1.4 H11 A1.6 1.6 0 0 1 12.6 3 V13 A1.6 1.6 0 0 1 11 14.6 H5 A1.6 1.6 0 0 1 3.4 13 V3 A1.6 1.6 0 0 1 5 1.4 Z M8 4.5 L10.3 8 L8 11.5 L5.7 8 Z',
      evenOdd: true,
    }],
  },
  action: {
    label: 'Action', group: 'stat',
    layers: [{ d: 'M9.8 0.6 L3 9.2 H7.3 L6 15.4 L13 6.6 H8.7 Z' }],
  },
  vp: {
    label: 'Victory points', group: 'stat',
    layers: [{ d: STAR }],
  },
  vpOutline: {
    label: 'VP (not connected)', group: 'board',
    layers: [{
      d: `${STAR} M8 5.89 L8.65 7.66 L10.53 7.73 L9.05 8.89 L9.56 10.7 L8 9.65 L6.44 10.7 L6.95 8.89 L5.47 7.73 L7.35 7.66 Z`,
      evenOdd: true,
    }],
  },
  tile: {
    label: 'Tile', group: 'board',
    layers: [
      { d: HEX_INNER, accent: true },
      { d: `${HEX} ${HEX_INNER}`, evenOdd: true },
    ],
  },
  vpTile: {
    label: 'VP tile', group: 'board',
    layers: [{
      d: `${HEX} M8 3.85 L9.12 6.81 L12.28 6.96 L9.81 8.94 L10.65 11.99 L8 10.25 L5.35 11.99 L6.19 8.94 L3.72 6.96 L6.88 6.81 Z`,
      evenOdd: true,
    }],
  },

  // ── Card-flow (draw / discard / trash) ──
  discard: {
    label: 'Discard', group: 'card',
    layers: [
      { d: CARD_NOTCHED },
      { d: 'M8.6 10.44 L12.04 13.88 L13.88 12.04 L10.44 8.6 Z' },
      { d: 'M15.4 15.4 H10 L15.4 10 Z' },
    ],
  },
  cardAdd: {
    label: 'Add card to deck', group: 'card',
    layers: [
      { d: CARD_NOTCHED },
      { d: 'M11 8.9 H13 V11 H15.1 V13 H13 V15.1 H11 V13 H8.9 V11 H11 Z' },
    ],
  },
  trash: {
    label: 'Trash', group: 'card',
    // One card torn diagonally into two slightly separated, slightly
    // splayed halves. The tear gap is ≥1.6 units along its whole length so
    // the two pieces stay distinct at 11 px.
    layers: [
      { d: 'M8.24 1.28 L3.06 1.73 L2.38 1.98 L1.92 2.54 L1.79 3.25 L2.71 13.81 L2.96 14.49 L3.52 14.96 L4.23 15.08 L5.43 14.98 L5.73 12.74 L7.83 10.35 L6.39 8.77 L8.54 5.87 L6.88 4.11 Z' },
      { d: 'M11.74 0.92 L9.91 3.47 L11.24 5.49 L8.62 7.97 L9.76 9.78 L7.28 11.77 L6.59 13.92 L11.77 14.37 L12.48 14.24 L13.04 13.78 L13.29 13.1 L14.21 2.54 L14.08 1.82 L13.62 1.27 L12.94 1.02 Z' },
    ],
  },

  // ── Piles / zones (search effects, HUD) ──
  hand: {
    label: 'Hand', group: 'zone',
    layers: [
      { d: 'M0.96 4.94 L4.79 3.24 A1.3 1.3 0 0 1 6.51 3.89 L9.93 11.57 A1.3 1.3 0 0 1 9.27 13.28 L5.43 14.99 A1.3 1.3 0 0 1 3.71 14.33 L0.3 6.66 A1.3 1.3 0 0 1 0.96 4.94 Z', accent: true },
      { d: 'M11.21 3.24 L15.04 4.94 A1.3 1.3 0 0 1 15.7 6.66 L12.29 14.33 A1.3 1.3 0 0 1 10.57 14.99 L6.73 13.28 A1.3 1.3 0 0 1 6.07 11.57 L9.49 3.89 A1.3 1.3 0 0 1 11.21 3.24 Z', accent: true },
      { d: 'M5.9 2.2 H10.1 A1.3 1.3 0 0 1 11.4 3.5 V12.7 A1.3 1.3 0 0 1 10.1 14 H5.9 A1.3 1.3 0 0 1 4.6 12.7 V3.5 A1.3 1.3 0 0 1 5.9 2.2 Z' },
    ],
  },
  drawPile: {
    label: 'Draw pile / deck', group: 'zone',
    layers: [
      { d: 'M5.8 1 H13.2 A1.4 1.4 0 0 1 14.6 2.4 V10.2 A1.4 1.4 0 0 1 13.2 11.6 H11.8 V3.6 H4.4 V2.4 A1.4 1.4 0 0 1 5.8 1 Z' },
      { d: 'M2.8 4.6 H9.4 A1.4 1.4 0 0 1 10.8 6 V13.8 A1.4 1.4 0 0 1 9.4 15.2 H2.8 A1.4 1.4 0 0 1 1.4 13.8 V6 A1.4 1.4 0 0 1 2.8 4.6 Z' },
    ],
  },
  deckTop: {
    label: 'Top of draw pile', group: 'zone',
    layers: [
      { d: 'M6.9 0.6 H9.1 V3.6 H11.6 L8 7 L4.4 3.6 H6.9 Z' },
      { d: 'M3.6 8.2 H12.4 A1 1 0 0 1 13.4 9.2 V9.8 A1 1 0 0 1 12.4 10.8 H3.6 A1 1 0 0 1 2.6 9.8 V9.2 A1 1 0 0 1 3.6 8.2 Z' },
      { d: 'M2.2 11.8 H13.8 A1 1 0 0 1 14.8 12.8 V14.2 A1 1 0 0 1 13.8 15.2 H2.2 A1 1 0 0 1 1.2 14.2 V12.8 A1 1 0 0 1 2.2 11.8 Z' },
    ],
  },
  search: {
    label: 'Search', group: 'zone',
    layers: [
      { d: circle(6.6, 6.6, 3.6), accent: true },
      { d: `${circle(6.6, 6.6, 5.6)} ${circle(6.6, 6.6, 3.6)}`, evenOdd: true },
      { d: 'M9.14 11.26 L13.54 15.66 L15.66 13.54 L11.26 9.14 Z' },
    ],
  },

  // ── Board ──
  base: {
    label: 'Base', group: 'board',
    layers: [{ d: 'M1 15 V1.4 H2.5 V3 H3.9 V1.4 H5.4 V6.2 H10.6 V1.4 H12.1 V3 H13.5 V1.4 H15 V15 H10.2 V11.8 A2.2 2.2 0 0 0 5.8 11.8 V15 Z' }],
  },
  mountain: {
    label: 'Blocked terrain', group: 'board',
    layers: [
      { d: 'M6.4 14.8 L10.8 5.6 L15.4 14.8 Z', accent: true },
      { d: 'M0.6 14.8 L6 3.4 L11.6 14.8 Z' },
    ],
  },
  rubble: {
    label: 'Rubble', group: 'board',
    layers: [
      { d: 'M0.8 15 L1.6 10.9 L4.4 8.8 L7.4 9.8 L8.2 15 Z' },
      { d: 'M9.6 15 L9.4 11.4 L11.9 9.8 L14.6 11 L15.2 15 Z' },
      { d: 'M4.6 7.4 L5.8 4.2 L8.8 2.6 L11.6 4.2 L12 7.8 L9.4 8.6 Z' },
    ],
  },
  abandon: {
    label: 'Abandon tile', group: 'board',
    layers: [{ d: `${HEX} M4.4 6.9 H11.6 V9.1 H4.4 Z`, evenOdd: true }],
  },
  bridge: {
    label: 'Connect territories', group: 'board',
    layers: [{ d: 'M0.8 4.6 H15.2 V7 H13.6 V14 H11 V11.6 A3 3 0 0 0 5 11.6 V14 H2.4 V7 H0.8 Z' }],
  },
  anywhere: {
    label: 'Target any tile', group: 'board',
    layers: [
      { d: `${circle(8, 8, 6)} ${circle(8, 8, 4.2)}`, evenOdd: true },
      { d: 'M7.1 0.4 H8.9 V4.6 H7.1 Z M7.1 11.4 H8.9 V15.6 H7.1 Z M0.4 7.1 H4.6 V8.9 H0.4 Z M11.4 7.1 H15.6 V8.9 H11.4 Z' },
      { d: circle(8, 8, 1.3) },
    ],
  },
  range: {
    label: 'Range', group: 'board',
    layers: [
      { d: 'M3.4 7.1 H10.4 V8.9 H3.4 Z' },
      { d: 'M15.4 8 L9.4 3.2 V12.8 Z' },
      { d: 'M0.6 3.6 H3.2 L6.4 7.1 H3.8 Z M0.6 12.4 H3.2 L6.4 8.9 H3.8 Z' },
    ],
  },

  // ── Players ──
  opponent: {
    label: 'Opponent', group: 'modifier',
    layers: [{ d: `${HELM} ${HELM_VISOR}`, evenOdd: true }],
  },
  allOpponents: {
    label: 'All opponents', group: 'modifier',
    layers: [
      {
        d: 'M1.17 5.32 C1.17 2.59 2.87 0.59 5.02 0.59 C7.17 0.59 8.87 2.59 8.87 5.32 L8.87 8.14 C8.87 9.32 7.98 10.21 6.94 10.65 L3.1 10.65 C2.06 10.21 1.17 9.32 1.17 8.14 Z M2.36 4.58 L7.68 4.58 L7.68 5.92 L5.69 5.92 L5.69 9.02 L4.35 9.02 L4.35 5.92 L2.36 5.92 Z',
        accent: true, evenOdd: true,
      },
      {
        d: 'M7.17 9.92 C7.17 7.19 8.87 5.19 11.02 5.19 C13.17 5.19 14.87 7.19 14.87 9.92 L14.87 12.74 C14.87 13.92 13.98 14.81 12.94 15.25 L9.1 15.25 C8.06 14.81 7.17 13.92 7.17 12.74 Z M8.36 9.18 L13.68 9.18 L13.68 10.52 L11.69 10.52 L11.69 13.62 L10.35 13.62 L10.35 10.52 L8.36 10.52 Z',
        evenOdd: true,
      },
    ],
  },

  // ── Modifiers ──
  nextRound: {
    label: 'Next round', group: 'modifier',
    layers: [
      { d: 'M5.9 4.2 H10.1 C9.8 5.6 8.6 6.4 8 7.2 C7.4 6.4 6.2 5.6 5.9 4.2 Z', accent: true },
      { d: 'M2.8 0.8 H13.2 V2.8 H2.8 Z M2.8 13.2 H13.2 V15.2 H2.8 Z' },
      {
        d: 'M4 2.8 H12 C12 5.6 9.6 6.8 9.2 8 C9.6 9.2 12 10.4 12 13.2 H4 C4 10.4 6.4 9.2 6.8 8 C6.4 6.8 4 5.6 4 2.8 Z M5.9 4.2 H10.1 C9.8 5.6 8.6 6.4 8 7.2 C7.4 6.4 6.2 5.6 5.9 4.2 Z',
        evenOdd: true,
      },
    ],
  },
  stack: {
    label: 'Stackable', group: 'modifier',
    layers: [
      { d: 'M8 2.1 L14.8 5.9 L8 9.7 L1.2 5.9 Z' },
      { d: 'M1.2 8.5 L8 12.3 L14.8 8.5 V11.1 L8 14.9 L1.2 11.1 Z' },
    ],
  },
  ban: {
    label: 'Prohibited', group: 'modifier',
    layers: [
      { d: `${circle(8, 8, 7.1)} ${circle(8, 8, 5)}`, evenOdd: true },
      { d: 'M2.39 4.01 L11.99 13.61 L13.61 11.99 L4.01 2.39 Z' },
    ],
  },
  unique: {
    label: 'Unique', group: 'modifier',
    layers: [
      { d: 'M4.2 2.2 H11.8 L15 6.2 H1 Z', accent: true },
      { d: 'M1 7.6 H15 L8 15 Z' },
    ],
  },
  upgrade: {
    label: 'Upgrade', group: 'modifier',
    layers: [
      { d: 'M8 1 L14.2 7.2 L12.2 9.2 L8 5 L3.8 9.2 L1.8 7.2 Z' },
      { d: 'M8 7 L14.2 13.2 L12.2 15.2 L8 11 L3.8 15.2 L1.8 13.2 Z' },
    ],
  },
  debt: {
    label: 'Debt', group: 'card',
    layers: [
      {
        d: 'M4.45 8.84 A3.1 3.1 0 0 0 8.84 4.45 L6.15 1.76 A3.1 3.1 0 0 0 1.76 6.15 Z M5.83 7.46 A1.15 1.15 0 0 0 7.46 5.83 L4.77 3.14 A1.15 1.15 0 0 0 3.14 4.77 Z',
        accent: true, evenOdd: true,
      },
      {
        d: 'M9.85 14.24 A3.1 3.1 0 0 0 14.24 9.85 L11.55 7.16 A3.1 3.1 0 0 0 7.16 11.55 Z M11.23 12.86 A1.15 1.15 0 0 0 12.86 11.23 L10.17 8.54 A1.15 1.15 0 0 0 8.54 10.17 Z',
        evenOdd: true,
      },
    ],
  },
  buy: {
    label: 'Purchase', group: 'modifier',
    layers: [{
      d: 'M2.48 2.48 L7.29 2.2 L13.8 8.71 L8.71 13.8 L2.2 7.29 Z M4.08 5.53 A1.45 1.45 0 1 0 6.98 5.53 A1.45 1.45 0 1 0 4.08 5.53 Z',
      evenOdd: true,
    }],
  },
  reroll: {
    label: 'Re-roll', group: 'modifier',
    layers: [{
      d: `M4.2 1.6 H11.8 A2.6 2.6 0 0 1 14.4 4.2 V11.8 A2.6 2.6 0 0 1 11.8 14.4 H4.2 A2.6 2.6 0 0 1 1.6 11.8 V4.2 A2.6 2.6 0 0 1 4.2 1.6 Z ${circle(5, 5, 1.45)} ${circle(8, 8, 1.45)} ${circle(11, 11, 1.45)}`,
      evenOdd: true,
    }],
  },
  swap: {
    label: 'Swap piles', group: 'modifier',
    layers: [
      { d: 'M1.4 3.6 H10.4 V1 L14.6 4.6 L10.4 8.2 V5.6 H1.4 Z' },
      { d: 'M14.6 10.4 H5.6 V7.8 L1.4 11.4 L5.6 15 V12.4 H14.6 Z' },
    ],
  },
  round: {
    label: 'Round', group: 'ui',
    layers: [
      { d: circle(8, 9.2, 4.6), accent: true },
      { d: 'M6.6 0.6 H9.4 V2.4 H6.6 Z' },
      { d: `${circle(8, 9.2, 6.4)} ${circle(8, 9.2, 4.6)}`, evenOdd: true },
      { d: 'M7.1 5.4 H8.9 V8.3 H11 V10.1 H7.1 Z' },
    ],
  },
  then: {
    label: 'Then', group: 'modifier',
    layers: [{ d: 'M1.4 6.9 H9.6 V3.4 L14.8 8 L9.6 12.6 V9.1 H1.4 Z' }],
  },

  // ── UI chrome ──
  settings: {
    label: 'Settings', group: 'ui',
    layers: [{ d: `${GEAR} ${circle(8, 8, 2.5)}`, evenOdd: true }],
  },
  close: {
    label: 'Close', group: 'ui',
    layers: [
      { d: 'M2.08 3.92 L12.08 13.92 L13.92 12.08 L3.92 2.08 Z' },
      { d: 'M12.08 2.08 L2.08 12.08 L3.92 13.92 L13.92 3.92 Z' },
    ],
  },
  chevron: {
    label: 'Expand', group: 'ui',
    // Disclosure caret (points right; rotate for down / left).
    layers: [{ d: 'M5.4 1.9 L11.5 8 L5.4 14.1 L3.5 12.2 L7.7 8 L3.5 3.8 Z' }],
  },
  grip: {
    label: 'Drag to reorder', group: 'ui',
    layers: [{ d: `${circle(5.6, 3.4, 1.45)} ${circle(10.4, 3.4, 1.45)} ${circle(5.6, 8, 1.45)} ${circle(10.4, 8, 1.45)} ${circle(5.6, 12.6, 1.45)} ${circle(10.4, 12.6, 1.45)}` }],
  },
  check: {
    label: 'Done', group: 'ui',
    layers: [{ d: 'M1.6 8.4 L3.6 6.4 L6.4 9.2 L12.4 3.2 L14.4 5.2 L6.4 13.2 Z' }],
  },

  // ── Card-type sigils (art fallback, type badges) ──
  claim: {
    label: 'Claim', group: 'sigil',
    // The last layer plugs the small gap the two blades enclose above the guards.
    layers: [
      { d: SWORD_MIRROR }, { d: SWORD_MIRROR_POMMEL }, { d: SWORD }, { d: SWORD_POMMEL },
      { d: 'M8 9.95 L8.7 10.65 L8 11.35 L7.3 10.65 Z' },
    ],
  },
  engine: {
    label: 'Engine', group: 'sigil',
    layers: [
      { d: circle(8, 8, 3.5), accent: true },
      { d: `${GEAR} ${circle(8, 8, 3.5)}`, evenOdd: true },
      { d: circle(8, 8, 1.6) },
    ],
  },
  passive: {
    label: 'Passive', group: 'sigil',
    layers: [
      { d: 'M3.4 1.2 H12.6 A1.6 1.6 0 0 1 12.6 4.4 H3.4 A1.6 1.6 0 0 1 3.4 1.2 Z' },
      { d: 'M3.4 11.6 H12.6 A1.6 1.6 0 0 1 12.6 14.8 H3.4 A1.6 1.6 0 0 1 3.4 11.6 Z' },
      { d: 'M3.6 4 H12.4 V12 H3.6 Z M5.2 5.9 H10.8 V7.4 H5.2 Z M5.2 8.6 H10.8 V10.1 H5.2 Z', evenOdd: true },
    ],
  },
} as const satisfies Record<string, GlyphDef>;

export type IconName = keyof typeof GLYPHS;

export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

// ── Horizontal metrics (tight side bearings for running text) ───────────

const inkCache = new Map<IconName, [number, number]>();

/**
 * Horizontal ink extent [x0, x1] of a glyph in grid units, derived from its
 * path data (endpoints, control points and arc endpoints — a slight
 * over-estimate, which is what we want for side bearings). Used to crop the
 * viewBox so narrow glyphs (card, bolt, hourglass) don't carry 3 px of air
 * on each side in subtitles — the same idea as a font's advance width.
 */
export function glyphInkX(name: IconName): [number, number] {
  const hit = inkCache.get(name);
  if (hit) return hit;
  let x0 = Infinity;
  let x1 = -Infinity;
  const see = (x: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; };
  for (const layer of GLYPHS[name].layers) {
    const tokens = layer.d.match(/[MLHVCAZ]|-?\d*\.?\d+/g) ?? [];
    let i = 0;
    while (i < tokens.length) {
      const c = tokens[i++];
      if (c === 'M' || c === 'L') { see(+tokens[i]); i += 2; }
      else if (c === 'H') { see(+tokens[i]); i += 1; }
      else if (c === 'V') { i += 1; }
      else if (c === 'C') { see(+tokens[i]); see(+tokens[i + 2]); see(+tokens[i + 4]); i += 6; }
      else if (c === 'A') { see(+tokens[i + 5]); i += 7; }
    }
  }
  const out: [number, number] = [Math.max(0, x0), Math.min(16, x1)];
  inkCache.set(name, out);
  return out;
}

/** Words used when flattening icons into accessible text. */
export function iconSpeech(name: IconName): string {
  return GLYPHS[name].label;
}
