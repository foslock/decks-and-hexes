import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import UpgradeCreditCounter from '../components/UpgradeCreditCounter';

describe('UpgradeCreditCounter', () => {
  it('shows the credits, and "N upgrade credits" on hover', () => {
    render(<UpgradeCreditCounter value={2} playerId="p0" visible />);
    const counter = screen.getByRole('button', { name: '2 upgrade credits' });
    expect(counter).toHaveTextContent('2');
    fireEvent.pointerEnter(counter, { pointerType: 'mouse' });
    expect(counter).toHaveAttribute('aria-expanded', 'true');
    expect(counter).toHaveTextContent('upgrade credits');
  });

  it('is folded away while you hold none', () => {
    render(<UpgradeCreditCounter value={0} playerId="p0" visible />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('floats −1 for a spend, then folds away once the last one is gone', async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<UpgradeCreditCounter value={1} playerId="p0" visible />);
      await act(async () => { rerender(<UpgradeCreditCounter value={0} playerId="p0" visible />); });
      expect(screen.getByText('−1')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '0 upgrade credits' })).toBeInTheDocument();
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(screen.queryByText('−1')).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('floats +1 for a purchase; switching players resets without one', async () => {
    const { rerender } = render(<UpgradeCreditCounter value={0} playerId="p0" visible />);
    await act(async () => { rerender(<UpgradeCreditCounter value={1} playerId="p0" visible />); });
    expect(screen.getByText('+1')).toBeInTheDocument();
    await act(async () => { rerender(<UpgradeCreditCounter value={4} playerId="p1" visible />); });
    expect(screen.getByRole('button', { name: '4 upgrade credits' })).toBeInTheDocument();
    expect(screen.queryByText('+3')).not.toBeInTheDocument();
  });
});
