import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import ResourceCounter, { shareGain, splitCoins, useShownResources, type ResourceCounterHandle } from '../components/ResourceCounter';

function Shown({ id, fallback }: { id: string; fallback: number }) {
  return <span data-testid="shown">{useShownResources(id, fallback)}</span>;
}

const noSources = () => [];

describe('resource coins', () => {
  it('splits a gain into at most 10 coins that add up to it', () => {
    expect(splitCoins(2)).toEqual([1, 1]);
    expect(splitCoins(10)).toHaveLength(10);
    const big = splitCoins(23);
    expect(big).toHaveLength(10);
    expect(big.reduce((a, b) => a + b, 0)).toBe(23);
  });

  it('shares a gain between sources by weight without losing any', () => {
    const p = { x: 0, y: 0 };
    expect(shareGain(5, [{ point: p, weight: 3 }, { point: p, weight: 2 }])).toEqual([3, 2]);
    const s = shareGain(7, [{ point: p }, { point: p }, { point: p }]);
    expect(s.reduce((a, b) => a + b, 0)).toBe(7);
  });
});

describe('ResourceCounter', () => {
  it('shows the bank, and "N resources" on hover', () => {
    render(<ResourceCounter value={4} playerId="p0" speed={1} visible sourcesForGain={noSources} />);
    const counter = screen.getByRole('button', { name: '4 resources' });
    expect(counter).toHaveTextContent('4');
    fireEvent.pointerEnter(counter, { pointerType: 'mouse' });
    expect(counter).toHaveAttribute('aria-expanded', 'true');
    expect(counter).toHaveTextContent('resources');
  });

  it('floats +X for a gain and −X for a spend, and the ID card follows', async () => {
    const ref = createRef<ResourceCounterHandle>();
    const { rerender } = render(<>
      <ResourceCounter ref={ref} value={3} playerId="p0" speed={1} visible sourcesForGain={noSources} />
      <Shown id="p0" fallback={-1} />
    </>);
    expect(screen.getByTestId('shown')).toHaveTextContent('3');

    // A played Gather: its source is named before the new state arrives.
    await act(async () => {
      ref.current!.expect({ from: () => ({ x: 10, y: 10 }) });
      rerender(<>
        <ResourceCounter ref={ref} value={5} playerId="p0" speed={1} visible sourcesForGain={noSources} />
        <Shown id="p0" fallback={-1} />
      </>);
    });
    // (No layout in jsdom, so the coins count straight away.)
    expect(screen.getByRole('button', { name: '5 resources' })).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByTestId('shown')).toHaveTextContent('5');

    // A purchase nobody announced.
    await act(async () => {
      rerender(<>
        <ResourceCounter ref={ref} value={2} playerId="p0" speed={1} visible sourcesForGain={noSources} />
        <Shown id="p0" fallback={-1} />
      </>);
    });
    expect(screen.getByRole('button', { name: '2 resources' })).toBeInTheDocument();
    expect(screen.getByText('−3')).toBeInTheDocument();
    expect(screen.getByTestId('shown')).toHaveTextContent('2');
  });

  it('switching players resets without a float', async () => {
    const { rerender } = render(<ResourceCounter value={3} playerId="p0" speed={1} visible sourcesForGain={noSources} />);
    await act(async () => {
      rerender(<ResourceCounter value={9} playerId="p1" speed={1} visible sourcesForGain={noSources} />);
    });
    expect(screen.getByRole('button', { name: '9 resources' })).toBeInTheDocument();
    expect(screen.queryByText('+6')).not.toBeInTheDocument();
  });
});
