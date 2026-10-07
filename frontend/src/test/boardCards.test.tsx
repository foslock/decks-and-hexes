import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider } from '../components/SettingsContext';
import { TileCardStack, EngineQueue, fanOffset, tileSlots, type BoardCardEntry } from '../components/BoardCards';
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

  it('piles a player\'s stacked face-down cards in one slot until they spread', () => {
    const down = (id: string, pid: string, stacked = true): BoardCardEntry => ({ ...entry(id, 'Blitz', pid), faceDown: true, stacked });
    const mine = entry('m', 'Explore', 'p0');
    // Two rivals: p1 with three cards (a pile), p2 with one (nothing to pile).
    const all = [mine, down('a', 'p1'), down('b', 'p1'), down('c', 'p1'), down('d', 'p2')];
    const lay = tileSlots(all);
    expect(lay.slots).toBe(3);
    expect(lay.slot).toEqual([0, 1, 1, 1, 2]);
    expect(lay.depth).toEqual([0, 0, 1, 2, 0]);
    expect(lay.pile).toEqual([1, 3, 3, 3, 1]);
    // Spread out (still face down), each card has its own slot again.
    const spread = all.map(e => ({ ...e, stacked: false }));
    expect(tileSlots(spread).slot).toEqual([0, 1, 2, 3, 4]);
    // The pile shows its count, and sits under the cards out on their own.
    const { container, rerender } = render(<WithSettings><TileCardStack entries={all} scale={0.25} onOpen={() => {}} /></WithSettings>);
    expect(container.querySelector('.cc-tile-pile-count')?.textContent).toBe('×3');
    const z = (id: string) => Number(container.querySelector<HTMLElement>(`[data-board-card="${id}@1,2"]`)!.style.zIndex);
    expect(Math.max(z('a'), z('b'), z('c'))).toBeLessThan(Math.min(z('m'), z('d')));
    expect(z('a')).toBeGreaterThan(z('b'));
    rerender(<WithSettings><TileCardStack entries={spread} scale={0.25} onOpen={() => {}} /></WithSettings>);
    expect(container.querySelector('.cc-tile-pile-count')).toBeNull();
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

  it('stays still (no zoom, no open) while the resolve plays', () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const { container } = render(<WithSettings><TileCardStack entries={[entry('a', 'Explore')]} scale={0.25} still onOpen={onOpen} /></WithSettings>);
    const card = container.querySelector('[data-board-card]')!;
    fireEvent.pointerEnter(card, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(document.body.querySelectorAll('[style*="z-index: 20000"]').length).toBe(0);
    fireEvent.click(card);
    expect(onOpen).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps an opponent\'s face-down card hidden until it turns over', () => {
    const onOpen = vi.fn();
    const mine = entry('a', 'Explore', 'p0');
    const theirs: BoardCardEntry = { ...entry('b', 'Dog Pile', 'p1'), faceDown: true };
    const stack = (e: BoardCardEntry[]) => <WithSettings><TileCardStack entries={e} scale={0.25} onOpen={onOpen} /></WithSettings>;
    const { container, rerender } = render(stack([mine, theirs]));
    const cards = container.querySelectorAll('[data-board-card]');
    expect(cards[1].querySelector('[data-face-down]')).not.toBeNull();
    expect(cards[0].querySelector('[data-face-down]')).toBeNull();
    // Face down: nothing to open; opening the tile leaves it out.
    fireEvent.click(cards[1]);
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(cards[0]);
    expect(onOpen).toHaveBeenCalledWith([mine], 0);
    // Its tile resolves: it turns face up.
    rerender(stack([mine, { ...theirs, faceDown: false }]));
    expect(container.querySelector('[data-face-down]')).toBeNull();
  });

  it('rings revealed cards, and every card on a shared tile, in its player\'s color (fading in)', async () => {
    const shared = [entry('a', 'Explore', 'player_0'), entry('b', 'Gather', 'player_1')];
    const { container, unmount } = render(<WithSettings><TileCardStack entries={shared} scale={0.25} onOpen={() => {}} /></WithSettings>);
    const cards = container.querySelectorAll<HTMLElement>('[data-board-card-body]');
    // The glow isn't there the moment a card lands: it fades in after.
    expect(cards[0].style.boxShadow).toBe('');
    await waitFor(() => expect(cards[0].style.boxShadow).toContain('#e6194b'));
    expect(cards[1].style.boxShadow).toContain('#3cb44b');
    unmount();

    // Your own planned cards (not attributed) carry no ring…
    const solo = [entry('c', 'Explore', 'player_0'), entry('d', 'Rabble', 'player_0')];
    const { container: c2, unmount: u2 } = render(<WithSettings><TileCardStack entries={solo} scale={0.25} onOpen={() => {}} /></WithSettings>);
    c2.querySelectorAll<HTMLElement>('[data-board-card-body]').forEach(el => expect(el.style.boxShadow).toBe(''));
    u2();

    // …revealed cards do, all the way round.
    const revealed = [{ ...entry('e', 'Explore', 'player_1'), playerName: 'Xander' }];
    const { container: c3 } = render(<WithSettings><TileCardStack entries={revealed} scale={0.25} onOpen={() => {}} /></WithSettings>);
    await waitFor(() => expect(c3.querySelector<HTMLElement>('[data-board-card-body]')!.style.boxShadow).toContain('0 0 0 2px #3cb44b'));
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

  it('while a card is aimed at a tile: the pointer goes through, and the pile fades only when the pointer comes near', async () => {
    const { container } = render(<WithSettings><TileCardStack entries={[entry('a', 'Explore')]} scale={0.25} passThrough onOpen={() => {}} /></WithSettings>);
    const stack = container.querySelector<HTMLElement>('.cc-tile-stack')!;
    expect(stack.style.pointerEvents).toBe('none');
    // (jsdom boxes sit at 0,0 with no size.) Pointer far away: still readable.
    const moveTo = async (x: number, y: number) => {
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
        await new Promise(r => setTimeout(r, 200));
      });
    };
    await moveTo(600, 600);
    expect(Number(stack.style.opacity)).toBe(0.8);
    // Hovering doesn't bring it up to full; coming near fades it out of the way.
    await moveTo(20, 20);
    expect(Number(stack.style.opacity)).toBeLessThan(0.4);
    await moveTo(600, 600);
    expect(Number(stack.style.opacity)).toBe(0.8);
  });

  it('opens the hover zoom only after the pointer rests on the card', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<WithSettings><TileCardStack entries={[entry('a', 'Explore')]} scale={0.25} onOpen={() => {}} /></WithSettings>);
      const card = container.querySelector<HTMLElement>('[data-board-card]')!;
      const zoomCount = () => document.querySelectorAll('body > div[style*="z-index: 20000"]').length;
      // A sweep across the card on the way to a tile: no zoom.
      fireEvent.pointerEnter(card, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(100); });
      fireEvent.pointerLeave(card, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(400); });
      expect(zoomCount()).toBe(0);
      // Resting on it: the zoom opens.
      fireEvent.pointerEnter(card, { pointerType: 'mouse' });
      act(() => { vi.advanceTimersByTime(300); });
      expect(zoomCount()).toBe(1);
      fireEvent.pointerLeave(card, { pointerType: 'mouse' });
      expect(zoomCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
