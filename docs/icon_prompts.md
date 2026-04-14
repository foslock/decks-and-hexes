# Card Clash — Midjourney Icon Prompt Sheet

Prompts for generating UI icons to replace emoji. All prompts are tuned for
**transparent-background output** by isolating the subject on a flat
white/light background, which makes background removal trivial.

## Generation workflow

1. Run each `/imagine` prompt below in Midjourney (v6.1).
2. Pick the variant with the cleanest isolation (no shadow bleed, no edge
   artifacts).
3. Background-remove via one of:
   - Midjourney's built-in **Erase Background** (Web UI: select image →
     Editor → Erase tool → magic-wand the white).
   - [remove.bg](https://www.remove.bg/) for batch processing.
   - Photopea / Photoshop **Select Subject** → invert → delete.
4. Save as `.png` with transparency, square crop centered on the subject.
5. Drop into `frontend/public/icons/` with the suggested filename.

## Style suffix (used by every UI icon)

```
flat vector game icon, single centered subject, bold solid silhouette, deep warm gold #c89039 with subtle inner shadow, sharp clean edges, isolated on plain white background, no surrounding objects, no text, no border, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw
```

The `--style raw` reduces MJ's tendency to add background scenery. The plain
white background makes it easy to extract via background-removal tools.

---

## UI icons (small — must read at 16–24 px)

```
# resource_coin.png — currency / resource gain (replaces 💰)
/imagine prompt: A single stylized coin viewed face-on, embossed crossed pickaxe motif on the face, clean disc shape, deep warm gold metallic with subtle inner shadow, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# action_bolt.png — action point (replaces ⚡)
/imagine prompt: A single bold lightning bolt, sharp angular zigzag silhouette, deep warm gold filled solid, slight thickness for legibility, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# delayed_hourglass.png — next-turn / delayed effect (replaces ⏰)
/imagine prompt: A simple round hourglass icon, two narrow triangular bulbs joined at the center with a single grain mid-fall, deep warm gold solid silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# card_draw.png — draw a card (replaces 🃏)
/imagine prompt: A single playing card icon with one bold curved arrow swooping out of it indicating a draw, slight tilt, rounded rectangle silhouette, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# hand.png — player hand (replaces ✋)
/imagine prompt: A stylized open palm holding a fan of three small cards, clean iconic silhouette, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# vp_star.png — victory point (replaces ★)
/imagine prompt: A single classic five-pointed star, balanced and symmetrical, deep warm gold solid with subtle inner gradient and a small gleam highlight on one point, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# hex_tile.png — board hex tile (replaces 🔷)
/imagine prompt: A single regular hexagon flat-top orientation with a subtle chamfered facet on the top edge for depth, deep warm gold solid silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# power_sword.png — claim power (replaces ⚔️)
/imagine prompt: A single upright sword viewed from the side, classic crossguard, clean tapered blade silhouette, deep warm gold metallic with a slight gleam down the blade, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# defense_shield.png — defense bonus (replaces 🛡️)
/imagine prompt: A single heater medieval kite shield viewed front-on, embossed cross or chevron motif centered, deep warm gold solid silhouette, sturdy and clear, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# trash_scissors.png — trash card from hand (replaces ✂️)
/imagine prompt: A single pair of compact closed scissors viewed at a slight angle with blades meeting at the center, deep warm gold solid metallic, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# trash_pile.png — permanent trash pile (replaces 🗑️)
/imagine prompt: A simple cylindrical waste bin viewed front-on with subtle perspective showing rim depth and a few ash motes inside, deep warm gold solid outline, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# discard_pile.png — discard pile / recycle (replaces ♻️)
/imagine prompt: Three rounded arrows chasing each other in a triangular loop forming a recycle symbol, deep warm gold solid silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# draw_pile.png — draw pile of undrawn cards (replaces 📚)
/imagine prompt: A small neat stack of three face-down cards viewed at a slight perspective with the top card squared, deep warm gold solid silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# top_of_draw.png — put on top of draw pile (replaces 📥)
/imagine prompt: A single card descending onto the top of a small tilted card stack with one short arrow above pointing down at the stack, deep warm gold solid silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# search_lens.png — search / tutor (replaces 🔎)
/imagine prompt: A single magnifying glass viewed at a slight angle with round lens slightly elliptical from perspective and short angled handle, deep warm gold solid metallic, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# target_dart.png — forced discard / targeted effect (replaces 🎯)
/imagine prompt: A simple three-ring concentric target with a single small dart hitting dead center, clean concentric circles, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# swap_arrows.png — swap / cycle (replaces 🔄)
/imagine prompt: Two curved arrows forming a horizontal oval loop chasing each other, evokes a swap symbol, deep warm gold solid silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# rubble.png — rubble card / debris (replaces 🧱)
/imagine prompt: Three small chunks of broken stone bricks piled together at varied angles, simple geometric blocks with cracked edges, deep warm gold textured silhouette, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# blocked.png — blocked terrain (replaces 🚧)
/imagine prompt: A short rectangular striped barrier with diagonal hazard stripes, sturdy clear silhouette, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# banned.png — claim ban / no entry (replaces 🚫)
/imagine prompt: A bold prohibition circle, solid ring with a thick diagonal slash through it, no inner content, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# reroll_die.png — re-roll archetype market (replaces 🎲)
/imagine prompt: A single six-sided die at slight three-quarters perspective showing three faces with pip patterns, two short motion arcs around it suggesting a roll, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# all_others.png — all other players (replaces 👥)
/imagine prompt: Three small head-and-shoulders silhouettes overlapping in a row, clean cutout style, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# shop_cart.png — buy / shop affordance (replaces 🛒)
/imagine prompt: A simple shopping cart silhouette viewed from the side with two visible wheels and a clearly defined basket, deep warm gold solid, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw

# map.png — territory / overview (replaces 🗺️)
/imagine prompt: A small unrolled treasure map with one curved dotted path and a single X mark, weathered edges, deep warm gold parchment tone, isolated on plain white background, flat vector game icon, no text, sharp edges, square composition, designed to read clearly at 16 pixels --ar 1:1 --v 6.1 --style raw
```

---

## Archetype crests (large illustrative — for HUD nameplates ~32–48 px)

These get rendered with breathing room, so the prompts are richer. They still
isolate cleanly on white for background removal.

```
# vanguard_crest.png — Vanguard archetype (Fast + Strong)
/imagine prompt: A circular heraldic crest centered on a single upright tower shield with two crossed swords behind it and short banners trailing from the swords, fierce forward-leaning energy, layered metallic gold frame around the emblem, deep crimson interior fill, dark fantasy tabletop game art, dramatic chiaroscuro lighting, painterly texture, isolated on plain white background, no text, square centered composition --ar 1:1 --v 6.1 --style raw

# swarm_crest.png — Swarm archetype (Fast + Cheap)
/imagine prompt: A circular heraldic crest centered on a stylized hive silhouette with a halo of small chitinous insectoid figures swarming around it, hexagonal motif background, layered metallic gold frame, deep emerald and sickly green interior fill, restless coordinated movement, dark fantasy tabletop game art, biopunk influences, painterly texture, isolated on plain white background, no text, square centered composition --ar 1:1 --v 6.1 --style raw

# fortress_crest.png — Fortress archetype (Cheap + Strong, defensive)
/imagine prompt: A circular heraldic crest centered on a single tall stone keep tower with stout battlements, surrounded by a solid hexagonal stone frame, layered metallic gold trim, deep slate gray interior fill, immovable monumental presence, dark fantasy tabletop game art, dramatic chiaroscuro lighting, painterly texture, isolated on plain white background, no text, square centered composition --ar 1:1 --v 6.1 --style raw
```

---

## Quick reference: filename → emoji it replaces

| File | Emoji | Where it appears |
|---|---|---|
| `resource_coin.png` | 💰 | resource gain, PlayerHud, ~35 places |
| `action_bolt.png` | ⚡ | action cost/gain, ~12 places |
| `delayed_hourglass.png` | ⏰ | next-turn bonuses, ~4 places |
| `card_draw.png` | 🃏 | draw N, deck size, ~16 places |
| `hand.png` | ✋ | search target = hand |
| `vp_star.png` | ★ | VP, PlayerHud, HowToPlay, ~15 places |
| `hex_tile.png` | 🔷 | tile count, ~9 places |
| `power_sword.png` | ⚔️ | claim power, ~9 places |
| `defense_shield.png` | 🛡️ | defense bonus, ~4 places |
| `trash_scissors.png` | ✂️ | trash from hand, ~9 places |
| `trash_pile.png` | 🗑️ | trash pile zone, ~4 places |
| `discard_pile.png` | ♻️ | discard pile zone, ~3 places |
| `draw_pile.png` | 📚 | draw pile source |
| `top_of_draw.png` | 📥 | put on top of draw |
| `search_lens.png` | 🔎 | search/tutor effects |
| `target_dart.png` | 🎯 | targeted effects, ~6 places |
| `swap_arrows.png` | 🔄 | Heady Brew swap |
| `rubble.png` | 🧱 | rubble card |
| `blocked.png` | 🚧 | abandon_and_block |
| `banned.png` | 🚫 | claim ban, ~4 places |
| `reroll_die.png` | 🎲 | free re-roll |
| `all_others.png` | 👥 | grant_actions all_others |
| `shop_cart.png` | 🛒 | shop affordances |
| `map.png` | 🗺️ | HowToPlay overview |
| `vanguard_crest.png` | (new) | HUD nameplate |
| `swarm_crest.png` | (new) | HUD nameplate |
| `fortress_crest.png` | (new) | HUD nameplate |

**Total: 27 icons** (24 UI glyphs + 3 archetype crests).

---

## Notes on transparency

Midjourney v6.1 doesn't natively output PNG with an alpha channel. The
"isolated on plain white background" wording in every prompt is the crucial
trick — it tells MJ to render the subject without scene clutter so the white
can be removed cleanly afterward.

Some MJ generations may add subtle drop shadows or ambient color around the
subject. Those typically remove fine with magic-wand tools that have a
medium tolerance setting. For tougher cases (the painterly archetype
crests), use `Select Subject` in Photoshop/Photopea rather than wand on
white.

If you want to skip post-processing entirely, the Midjourney Web UI now has
an **Editor → Erase** tool that handles it inline. After erasing the white,
download the result as a PNG.
