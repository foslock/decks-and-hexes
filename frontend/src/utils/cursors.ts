/**
 * The game's custom mouse cursors (gilded, from public/cursors — drawn by
 * frontend/scripts/build_cursors.py). Each is exposed as a CSS variable,
 * `--cc-cursor-<name>`, so styles say `cursor: var(--cc-cursor-target)`.
 * global.css defaults the variables to the matching system cursor until
 * `installCursors()` swaps in the images, in the best syntax this browser
 * parses (Retina-sharp image-set where it can).
 */
export const CURSORS = {
  /** The everyday pointer. */
  arrow: { hot: [3, 2], system: 'default' },
  /** Over a button or anything else you can click: a pointing gauntlet. */
  pointer: { hot: [12, 2], system: 'pointer' },
  /** Over a tile with details to show. */
  inspect: { hot: [3, 2], system: 'pointer' },
  /** Aiming a card at a tile it can be played on. */
  target: { hot: [16, 16], system: 'crosshair' },
  /** Over a card you can pick up. */
  grab: { hot: [17, 15], system: 'grab' },
  /** Holding a card, or turning the board. */
  grabbing: { hot: [17, 16], system: 'grabbing' },
} as const;

export type CursorName = keyof typeof CURSORS;

/** `cursor` value for one of the game's cursors. */
export const cursor = (name: CursorName) => `var(--cc-cursor-${name})`;

function supports(value: string): boolean {
  try {
    return typeof CSS !== 'undefined' && CSS.supports('cursor', value);
  } catch {
    return false;
  }
}

export function installCursors(root: HTMLElement = document.documentElement): void {
  const base = import.meta.env.BASE_URL ?? '/';
  for (const [name, { hot: [x, y], system }] of Object.entries(CURSORS)) {
    const one = `${base}cursors/${name}.png`;
    const two = `${base}cursors/${name}@2x.png`;
    const set = `url("${one}") 1x, url("${two}") 2x`;
    const value = [
      `image-set(${set}) ${x} ${y}, ${system}`,
      `-webkit-image-set(${set}) ${x} ${y}, ${system}`,
      `url("${one}") ${x} ${y}, ${system}`,
    ].find(supports);
    if (!value) continue;
    root.style.setProperty(`--cc-cursor-${name}`, value);
    // Warm the image so the first hover doesn't flash the system cursor.
    new Image().src = window.devicePixelRatio > 1 ? two : one;
  }
}
