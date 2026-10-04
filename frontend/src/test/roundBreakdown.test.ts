import { describe, it, expect } from 'vitest';
import { yScale } from '../components/RoundBreakdownOverlay';

describe('round breakdown y-axis', () => {
  it('uses evenly spaced whole-number ticks that cover the data', () => {
    for (const max of [0, 1, 3, 5, 9, 13, 37, 120]) {
      const { yMax, step } = yScale(max);
      expect(Number.isInteger(step)).toBe(true);
      expect(step).toBeGreaterThanOrEqual(1);
      expect(yMax % step).toBe(0);
      expect(yMax).toBeGreaterThanOrEqual(max);
      // A handful of ticks: never a cramped axis, never just the baseline.
      const ticks = yMax / step + 1;
      expect(ticks).toBeGreaterThanOrEqual(3);
      expect(ticks).toBeLessThanOrEqual(6);
    }
  });

  it('does not skip values the old rounding dropped (max 5 → 0, 2, 4, 6)', () => {
    expect(yScale(5)).toEqual({ yMax: 6, step: 2 });
  });
});
