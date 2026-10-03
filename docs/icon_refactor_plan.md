# Icon System

Card Clash uses no emoji. Every game symbol is a hand-authored, single-color glyph from `frontend/src/icons/`. The same path data renders as inline SVG in the DOM and as cached textures on the PixiJS board.

- **Gallery (dev):** `http://localhost:5173/?preview=icons`. It shows every glyph at 11–24 px on dark and light backgrounds, a 1×/2× pixel loupe, number samples, every card's hand-chip subtitle, and a live Pixi board sample.
- **Guards:**
  - `frontend/src/test/noEmoji.test.ts` fails on any emoji, pictograph, dingbat or Braille "icon" in `src/`, `public/` or `index.html`. It catches literal characters, HTML entities (`&#9733;`) and JS escapes (`\u{1F916}`).
  - `backend/tests/test_no_emoji.py` does the same for `backend/app/**/*.py`, including `\U0001F…` escapes, and for `data/*.yaml`.
  - Plain typography (→ ← × ≤ · —) is allowed in both.

## Files

| File | Role |
|---|---|
| `icons/glyphs.ts` | `GLYPHS` table: path data on a 16×16 grid, label, group. Also exports `glyphInkX()` for horizontal ink metrics. |
| `icons/Icon.tsx` | `<Icon name size color slash trim title decorative tooltip />` renders inline SVG in `currentColor`. |
| `icons/Num.tsx` | `<Num>` (bold Philosopher, fixed-width lining digits), `<IconValue>` (glyph + number unit), `<CostLabel>`. |
| `icons/pixiIcons.ts` | `getIconTexture()` (cached), `createIconSprite()`, `createLabelRow()` for board labels, `drawGlyph()`. |
| `components/cardSubtitle.ts` | `buildCardSubtitle()` emits semantic tokens `{icon \| num \| text}`. `parseSubtitle()` and `subtitleToText()` live here too. |
| `components/SubtitlePartRenderer.tsx` | `renderSubtitle(parts, { fontSize, passiveVp, showDynamic })` is the one subtitle renderer. |

## Rules

- **Single color.** Icons paint with `currentColor`. Duotone `accent` layers are the same color at 42% opacity, adjustable with `--cc-icon-accent-opacity`.
- **Semantic colors that remain** are ones the UI already used for meaning:
  - VP is gold (red when negative).
  - Glowing values are gold; dynamic values are yellow.
  - The cost coin is gold.
  - On the board, this-round defense and immunity are blue and permanent defense is white.
- **Numbers.**
  - Face: bold Philosopher with lining figures.
  - Fixed width: Philosopher has no `tnum`, so each digit sits in a 0.56 em cell.
  - Layout: numbers are centered on the glyph's vertical middle (inline-flex), about 1 px from the glyph, in the glyph's color.
  - Order: signed deltas lead their glyph (**+2** coin); unsigned stats follow it (sword **3**).
- **Running text.** Pass `trim` so the SVG box hugs the glyph's ink, like a font's advance width. Subtitles do this already.
- **Accessibility.**
  - Icons get `role="img"` and an `aria-label` (the glyph label, or `title`).
  - Pass `decorative` when adjacent text already says it.
  - Subtitle rows carry one plain-language `aria-label` ("power 3, +1 card, +1 action").
  - Icon-only buttons keep an `aria-label` or `title`.

## Glyphs

| Glyph | Meaning (former emoji) |
|---|---|
| `power` | Claim power (⚔) |
| `defense` | Defense this round (🛡 +N) |
| `fortify` | Permanent defense (🛡↑N) |
| `immune` | Immunity, always shown with the word "Immune" (🛡+∞) |
| `resource` | Resources / cost (💰) |
| `action` | Action (⚡) |
| `vp` / `vpOutline` | VP, and a disconnected VP tile (★ ☆ ⭐) |
| `card` | Draw a card (🃏) |
| `discard` | Discard, and the discard pile (🃏↘ ♻) |
| `cardAdd` | Add a card to a deck (↓🃏) |
| `trash` | Trash, shown as a card ripped in half. Covers trash N, trash-on-use and the trash pile (✂ 🗑) |
| `debt` | Debt / "per Debt card" |
| `hand`, `drawPile`, `deckTop`, `search` | Zones and search effects (✋ 📚 📥 🔎) |
| `tile`, `vpTile`, `abandon`, `bridge` | Tiles (🔷, ★🔷, 🔷↘, 🔷→🔷) |
| `base`, `mountain`, `rubble` | Base, blocked terrain, rubble (🏰 ⛰ 🚧 🧱 🪨) |
| `anywhere` | Claim any tile, no adjacency (🎯 after power) |
| `range` | Claim range (🏹) |
| `opponent` / `allOpponents` | Targets an opponent / all others (🎯 prefix, 👥, ↑ "gives") |
| `nextRound` | Next-round modifier, drawn small (⏳) |
| `stack` | Stackable (↑) |
| `unique` | Unique (subtitles and card trait pill) |
| `ban` and the `slash` prop | Prohibited: `{!defense}` ignores defense, `{!power}` no claims, `{!buy}` cannot buy (🚫) |
| `buy`, `reroll`, `swap`, `then`, `upgrade` | Purchase, re-roll, swap piles, "then" arrow, upgrade (🛒 🎲 🔄 → ✦) |
| `round`, `settings`, `close`, `check`, `chevron`, `grip` | UI chrome (⏱ ⚙ ✕ ✓ ▶▾ ⠿) |
| `claim`, `engine`, `passive` | Card-type sigils, used for the art fallback (defense uses `defense`) |

## Subtitle authoring syntax

`buildCardSubtitle` writes compact strings that `parseSubtitle()` turns into tokens:

- `{name}` is a glyph, and `{!name}` is the glyph with a prohibition slash.
- Numbers (`3`, `+2`, `2/4`, `≤3`, `×5`) become `num` tokens.
- Everything else becomes `text`.

```ts
parts.push(p(`{power}${card.power}${stackIcon}${targetAnyIcon}`)); // "⚔3↑" → sword 3 stack
parts.push(p(`+${card.resource_gain}{resource}`));                 // +2 coin
parts.push(p(`{opponent}-${card.forced_discard}{card}`));          // helm −1 card
parts.push(p('{immune}Immune'));                                    // glyph + word
```

An unknown `{name}` renders literally, so it gets noticed.

## Board labels (Pixi)

```ts
createLabelRow([{ icon: 'fortify' }, { text: '2' }, { text: '+3', color: 0x66ccff }],
               { size: 14, color: 0xffffff, outline: { color: 0x000000, width: 1.5 } });
```

- **Textures are cached and shared.** Each texture is built once per (glyph, size, color, outline, resolution) and shared by every tile and every rebuild.
- **HexGrid teardown is safe.** It destroys label containers with `destroy({ children: true })`, which never destroys sprite textures. Never pass `texture: true` for icon sprites.
- **Numbers** are a Philosopher `Text` with the same outline.

## Adding a glyph

1. **Draw it** on the 16×16 grid in `GLYPHS` (`icons/glyphs.ts`), keeping ink within about 0.6–15.4.
   - Keep strokes and knockouts at least 1.8 units wide so nothing hairline turns to mush at 11–12 px.
   - Use `evenOdd: true` for knockout sub-paths and `accent: true` for a duotone layer. Accent layers are listed first.
   - Absolute `M L H V C A Z` commands only, since Canvas `Path2D` and the ink metrics parse them.
2. **Give it a `label`** (used for aria-labels and tooltips) and a `group` (used by the gallery).
3. **Check it** in the gallery's pixel loupe at 11 px on a 1× display.
4. **Use it** with `<Icon name="…" />` in the DOM, `{name}` in subtitles, or a `LabelSegment` in Pixi.

App icons (`public/favicon*`, `icon-*.png`, `apple-touch-icon.png`) are the `claim` sigil in gold on the indigo panel color, drawn with an over/under seam between the blades.
