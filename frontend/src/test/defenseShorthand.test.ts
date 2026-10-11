import { describe, expect, it } from 'vitest';
import { buildCardSubtitle, type SubtitlePart } from '../components/cardSubtitle';
import { GLYPHS } from '../icons/glyphs';
import { makeCard } from './fixtures';

/** The first stat-line part, as `{icon}` / text pieces. */
function firstPart(parts: SubtitlePart[]): string {
  return parts[0].tokens.map(t => (t.kind === 'icon' ? `{${t.name}}` : t.text)).join('');
}

describe('defense shorthand', () => {
  it('shows a this-round defense as the plus shield and a bare number', () => {
    const card = makeCard({ card_type: 'defense', defense_bonus: 2, effects: [] });
    expect(firstPart(buildCardSubtitle(card))).toBe('{defense}2');
  });

  it('shows a permanent increase as the chevron shield', () => {
    const card = makeCard({
      card_type: 'defense', defense_bonus: 2,
      effects: [{ type: 'permanent_defense', condition: 'always', value: 2 }],
    });
    expect(firstPart(buildCardSubtitle(card))).toBe('{fortify}2');
  });

  it('shows immunity as the diamond shield, with no word', () => {
    const card = makeCard({
      card_type: 'defense',
      effects: [{ type: 'tile_immunity', condition: 'always', value: 0 }],
    });
    expect(firstPart(buildCardSubtitle(card))).toBe('{immune}');
    const two = makeCard({ ...card, defense_target_count: 2 });
    expect(firstPart(buildCardSubtitle(two))).toBe('{immune} · 2{tile}');
  });

  it('never puts a plus beside a shield', () => {
    const nest = makeCard({
      card_type: 'defense', defense_bonus: 0,
      effects: [{ type: 'defense_per_adjacent', condition: 'always', value: 1 }],
    });
    expect(firstPart(buildCardSubtitle(nest))).toBe('{defense}1/{tile}');
    for (const card of [nest, makeCard({ card_type: 'defense', defense_bonus: 3, defense_target_count: 2, effects: [] })]) {
      expect(firstPart(buildCardSubtitle(card))).not.toMatch(/\}\+|Immune/);
    }
  });

  it('draws the three shields with different knockouts', () => {
    const d = ['defense', 'fortify', 'immune'].map(n => GLYPHS[n as keyof typeof GLYPHS].layers.map(l => l.d).join(' '));
    expect(new Set(d).size).toBe(3);
  });
});
