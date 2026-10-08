import { describe, it, expect } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider } from '../components/SettingsContext';
import CardHand from '../components/CardHand';
import { makeCard } from './fixtures';

function WithSettings({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}

const explore = (id: string, upgraded = false) => makeCard({
  id, definition_id: 'neutral_explore', name: upgraded ? 'Explore+' : 'Explore', name_upgraded: 'Explore+',
  card_type: 'claim', power: upgraded ? 1 : 0, is_upgraded: upgraded,
  description: upgraded ? 'Claim: Power 1. Draw 1 card.' : 'Claim: Power 0 on any adjacent unoccupied tile.',
  upgrade_description: 'Claim: Power 1. Draw 1 card.', upgraded_stats: { power: 1, draw_cards: 1 },
});

/** Hover a hand card (the pointer above the resting band picks the card under it). */
const hover = (container: HTMLElement, displayIdx: number) => {
  const el = container.querySelector(`[data-hand-card][data-display-idx="${displayIdx}"]`)!;
  fireEvent.pointerMove(el, { clientX: 0, clientY: -500 });
};

describe('Upgrade preview on hover', () => {
  it('belongs to the card whose badge was hovered, not its place in the hand', () => {
    const props = { playerId: 'p0', selectedIndex: null, onSelect: () => {}, onDragPlay: () => {}, disabled: false, deckSize: 0, discardCount: 0, discardCards: [], deckCards: [], isPlayPhase: true };
    const a = explore('e1'), b = explore('e2');
    const { container, rerender } = render(<WithSettings><CardHand {...props} cards={[a, b]} upgradeCreditsAvailable={1} /></WithSettings>);
    act(() => { hover(container, 0); });
    const badge = container.querySelector('[data-upgrade-badge]');
    expect(badge).toBeTruthy();
    // Hovering the badge previews the upgrade…
    act(() => { fireEvent.pointerEnter(badge!); });
    expect(container.textContent).toContain('Draw 1 card');
    // …the card upgrades (its badge goes, no pointerleave) and is played.
    rerender(<WithSettings><CardHand {...props} cards={[explore('e1', true), b]} upgradeCreditsAvailable={0} /></WithSettings>);
    rerender(<WithSettings><CardHand {...props} cards={[b]} upgradeCreditsAvailable={0} /></WithSettings>);
    // The other Explore, now in the first place, shows as itself.
    act(() => { hover(container, 0); });
    expect(container.querySelector('[data-hand-card][data-display-idx="0"]')).toBeTruthy();
    expect(container.textContent).not.toContain('Draw 1 card');
    expect(container.textContent).toContain('adjacent unoccupied');
  });
});
