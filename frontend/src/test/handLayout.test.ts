import { describe, expect, it } from 'vitest';
import { handSizing, layoutHand, nearestSlot, stripAt } from '../components/hand/handLayout';
import { splitUpgradeMark } from '../components/CardName';
import { isCardEmpowered } from '../components/cardEmpowered';
import { makeCard } from './fixtures';

const sizing = { rest: 0.7, hover: 1 };

describe('layoutHand', () => {
  it('sets cards side by side when they fit', () => {
    const { poses, restW } = layoutHand({ count: 3, width: 1200, height: 100, sizing });
    expect(poses[1].x - poses[0].x).toBeGreaterThan(restW);
  });

  it('overlaps cards (later ones on top) when the hand is crowded', () => {
    const { poses, restW } = layoutHand({ count: 10, width: 700, height: 100, sizing });
    const spacing = poses[1].x - poses[0].x;
    expect(spacing).toBeLessThan(restW);
    expect(poses[9].z).toBeGreaterThan(poses[0].z);
    // The fanned hand stays inside the container.
    expect(poses[0].x - restW / 2).toBeGreaterThanOrEqual(-0.5);
    expect(poses[9].x + restW / 2).toBeLessThanOrEqual(700.5);
  });

  it('raises the hovered card straight, at full size, on top, and nudges neighbors aside', () => {
    const rest = layoutHand({ count: 5, width: 700, height: 100, sizing });
    const hov = layoutHand({ count: 5, width: 700, height: 100, sizing, hovered: 2 });
    expect(hov.poses[2].scale).toBe(1);
    expect(hov.poses[2].rot).toBe(0);
    expect(hov.poses[2].z).toBeGreaterThan(Math.max(...hov.poses.filter((_, i) => i !== 2).map(p => p.z)));
    expect(hov.poses[2].y).toBeLessThan(rest.poses[2].y);
    expect(hov.poses[1].x).toBeLessThan(rest.poses[1].x);
    expect(hov.poses[3].x).toBeGreaterThan(rest.poses[3].x);
  });

  it('maps pointer x to the card whose visible strip it is over', () => {
    const { strips, poses } = layoutHand({ count: 4, width: 500, height: 100, sizing });
    expect(stripAt(strips, poses[0].x - 10)).toBe(0);
    expect(stripAt(strips, poses[3].x)).toBe(3);
    expect(stripAt(strips, -50)).toBeNull();
    expect(nearestSlot(poses, poses[2].x + 3)).toBe(2);
  });

  it('keeps the hovered card on screen on short viewports', () => {
    const s = handSizing(800, 500);
    expect(308 * s.hover).toBeLessThanOrEqual(500);
    expect(s.hover).toBeGreaterThanOrEqual(s.rest);
  });
});

describe('splitUpgradeMark', () => {
  it('strips the trailing + of upgraded names', () => {
    expect(splitUpgradeMark('War Tithe+')).toEqual({ base: 'War Tithe', upgraded: true });
    expect(splitUpgradeMark('Blitz')).toEqual({ base: 'Blitz', upgraded: false });
  });
});

describe('isCardEmpowered', () => {
  it('glows Claims while a War Banner buff is waiting', () => {
    const claim = makeCard({ card_type: 'claim', power: 2 });
    expect(isCardEmpowered(claim, {}, 2)).toBe(true);
    expect(isCardEmpowered(claim, {}, 0)).toBe(false);
  });

  it('glows cards whose stats scale with the board', () => {
    const mob = makeCard({
      card_type: 'claim', power: 0,
      effects: [{ type: 'power_per_tiles_owned', condition: '', value: 3, metadata: { replaces_base_power: true } }],
    });
    expect(isCardEmpowered(mob, { tileCount: 9 })).toBe(true);
    expect(isCardEmpowered(mob, { tileCount: 1 })).toBe(false);
  });

  it('glows cards granted Stackable', () => {
    expect(isCardEmpowered(makeCard({ granted_stackable: true }), {})).toBe(true);
  });
});
