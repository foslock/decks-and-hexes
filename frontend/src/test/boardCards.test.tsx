import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider } from '../components/SettingsContext';
import { TileCardStack, EngineQueue, fanOffset, type BoardCardEntry } from '../components/BoardCards';
import { makeCard } from './fixtures';

function WithSettings({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}

const entry = (id: string, name: string, playerId = 'p0'): BoardCardEntry => ({
  key: `${id}@1,2`, card: makeCard({ id, name }), playerId,
});

describe('board cards', () => {
  it('lays cards that share a tile side by side without overlap', () => {
    const s = 0.25;
    const w = 220 * s;
    for (let n = 2; n <= 4; n++) {
      for (let i = 1; i < n; i++) {
        expect(fanOffset(i, n, s) - fanOffset(i - 1, n, s)).toBeGreaterThanOrEqual(w);
      }
      // Centered over the tile.
      expect(fanOffset(0, n, s) + fanOffset(n - 1, n, s)).toBeCloseTo(0);
    }
  });

  it('opens every card on a tile when one is clicked', () => {
    const onOpen = vi.fn();
    const entries = [entry('a', 'Coordinated Push'), entry('b', 'Dog Pile', 'p1')];
    const { container } = render(<WithSettings><TileCardStack entries={entries} scale={0.25} onOpen={onOpen} /></WithSettings>);
    const cards = container.querySelectorAll('[data-board-card]');
    expect(cards.length).toBe(2);
    fireEvent.click(cards[1]);
    expect(onOpen).toHaveBeenCalledWith(entries, 1);
  });

  it('rings each card in its player\'s color only when players share a tile', () => {
    const shared = [entry('a', 'Explore', 'player_0'), entry('b', 'Gather', 'player_1')];
    const { container, unmount } = render(<WithSettings><TileCardStack entries={shared} scale={0.25} onOpen={() => {}} /></WithSettings>);
    const cards = container.querySelectorAll<HTMLElement>('[data-board-card]');
    expect(cards[0].style.boxShadow).toContain('#e6194b');
    expect(cards[1].style.boxShadow).toContain('#3cb44b');
    unmount();

    const solo = [entry('c', 'Explore', 'player_0'), entry('d', 'Rabble', 'player_0')];
    const { container: c2 } = render(<WithSettings><TileCardStack entries={solo} scale={0.25} onOpen={() => {}} /></WithSettings>);
    c2.querySelectorAll<HTMLElement>('[data-board-card]').forEach(el => expect(el.style.boxShadow).toBe(''));
  });

  it('keeps tile cards see-through until hovered, opened or resolving', () => {
    const entries = [entry('a', 'Explore')];
    const stackOf = (c: HTMLElement) => c.querySelector<HTMLElement>('.cc-tile-stack')!;
    const { container, rerender } = render(<WithSettings><TileCardStack entries={entries} scale={0.25} onOpen={() => {}} /></WithSettings>);
    const stack = stackOf(container);
    expect(Number(stack.style.opacity)).toBeLessThan(1);
    fireEvent.pointerEnter(stack);
    expect(stack.style.opacity).toBe('1');
    fireEvent.pointerLeave(stack);
    expect(Number(stack.style.opacity)).toBeLessThan(1);

    rerender(<WithSettings><TileCardStack entries={entries} scale={0.25} open onOpen={() => {}} /></WithSettings>);
    expect(stackOf(container).style.opacity).toBe('1');
    rerender(<WithSettings><TileCardStack entries={entries} scale={0.25} focus onOpen={() => {}} /></WithSettings>);
    expect(stackOf(container).style.opacity).toBe('1');
  });

  it('grows a resolving card in step with its box', () => {
    const { container } = render(<WithSettings><TileCardStack entries={[entry('a', 'Explore')]} scale={0.25} focus onOpen={() => {}} /></WithSettings>);
    const card = container.querySelector<HTMLElement>('[data-board-card]')!;
    const face = card.querySelector<HTMLElement>('[style*="scale("]')!;
    // The face's scale eases with the same timing as the card box's size.
    expect(face.style.transition).toContain('transform 0.25s ease');
    expect(card.style.transition).toContain('width 0.25s ease');
  });

  it('lists played engine cards with a count', () => {
    render(<WithSettings><EngineQueue entries={[entry('g', 'Gather'), entry('h', 'Tithe')]} onOpen={() => {}} /></WithSettings>);
    expect(screen.getByText(/Played/)).toHaveTextContent('Played (2)');
    expect(screen.getByText('Gather')).toBeInTheDocument();
    expect(screen.getByText('Tithe')).toBeInTheDocument();
  });
});
