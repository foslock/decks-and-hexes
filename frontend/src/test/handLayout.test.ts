import { describe, expect, it } from 'vitest';
import { handSizing, layoutHand, nearestSlot, reconcileHandOrder, stripAt } from '../components/hand/handLayout';
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

  it('glows Chatter once playing it would be the 3rd card this round', () => {
    const chatter = makeCard({
      name: 'Chatter', card_type: 'engine', draw_cards: 1, action_return: 1,
      effects: [{ type: 'conditional_draw', value: 1, upgraded_value: 2, condition: 'if_cards_played_this_round_gte', condition_threshold: 3 }],
    });
    expect(isCardEmpowered(chatter, { playedCardNames: [] })).toBe(false);
    expect(isCardEmpowered(chatter, { playedCardNames: ['Explore'] })).toBe(false);
    expect(isCardEmpowered(chatter, { playedCardNames: ['Explore', 'Gather'] })).toBe(true);
    expect(isCardEmpowered(chatter, { playedCardNames: ['Explore', 'Gather', 'Rabble'] })).toBe(true);
  });

  it('glows every bonus that depends on the turn so far, only when it would apply', () => {
    const eff = (type: string, condition: string, value: number, extra: object = {}) => ({ type, condition, value, ...extra });
    // Mobilize: +1 action per other card played (max 3).
    const mobilize = makeCard({ name: 'Mobilize', card_type: 'engine', effects: [eff('actions_per_cards_played', 'always', 1, { metadata: { max: 3 } })] });
    expect(isCardEmpowered(mobilize, { playedCardNames: [] })).toBe(false);
    expect(isCardEmpowered(mobilize, { playedCardNames: ['Explore'] })).toBe(true);
    // Spyglass: +1 action if your hand after its draw is 3 or fewer.
    const spyglass = makeCard({ name: 'Spyglass', card_type: 'engine', draw_cards: 1, effects: [eff('conditional_action', 'hand_size_lte', 1, { condition_threshold: 3 })] });
    expect(isCardEmpowered(spyglass, { handSize: 5 })).toBe(false);
    expect(isCardEmpowered(spyglass, { handSize: 3 })).toBe(true);
    // Scavenge: +1 action if playing it spends your last action.
    const scavenge = makeCard({ name: 'Scavenge', card_type: 'engine', action_cost: 1, resource_gain: 2, effects: [eff('grant_actions', 'zero_actions', 1)] });
    expect(isCardEmpowered(scavenge, { actionsLeft: 3 })).toBe(false);
    expect(isCardEmpowered(scavenge, { actionsLeft: 1 })).toBe(true);
    // Commander: next-round draw once a Claim has been played.
    const commander = makeCard({ name: 'Commander', card_type: 'engine', action_return: 1, effects: [eff('conditional_draw_next_round', 'if_played_claim_this_turn', 1)] });
    expect(isCardEmpowered(commander, { hasPlayedClaimThisRound: false })).toBe(false);
    expect(isCardEmpowered(commander, { hasPlayedClaimThisRound: true })).toBe(true);
    // Toll Road: draws per connected VP tile.
    const tollRoad = makeCard({ name: 'Toll Road', card_type: 'engine', effects: [eff('draw_per_connected_vp', 'always', 2)] });
    expect(isCardEmpowered(tollRoad, { vpHexCount: 0 })).toBe(false);
    expect(isCardEmpowered(tollRoad, { vpHexCount: 1 })).toBe(true);
    // Resilience: +3 resources while you hold the fewest tiles.
    const resilience = makeCard({ name: 'Resilience', card_type: 'engine', action_return: 1, effects: [eff('gain_resources', 'fewest_tiles', 3)] });
    expect(isCardEmpowered(resilience, { hasFewestTiles: false })).toBe(false);
    expect(isCardEmpowered(resilience, { hasFewestTiles: true })).toBe(true);
    // Rabble+: +1 power per other Rabble played.
    const rabblePlus = makeCard({ name: 'Rabble+', card_type: 'claim', power: 1, is_upgraded: true, effects: [eff('power_per_same_name', 'always', 1, { metadata: { upgraded_only: true } })] });
    expect(isCardEmpowered(rabblePlus, { playedCardNames: ['Explore'] })).toBe(false);
    expect(isCardEmpowered(rabblePlus, { playedCardNames: ['Rabble'] })).toBe(true);
    // Dividends: only above its minimum of 1.
    const dividends = makeCard({ name: 'Dividends', card_type: 'engine', effects: [eff('resource_scaling', 'always', 2)] });
    expect(isCardEmpowered(dividends, { resourcesHeld: 2 })).toBe(false);
    expect(isCardEmpowered(dividends, { resourcesHeld: 6 })).toBe(true);
    // Coordinated Push / Dog Pile: stacking bonuses once there's a Claim out to stack on.
    const push = makeCard({ name: 'Coordinated Push', card_type: 'claim', power: 3, stackable: true, effects: [eff('grant_actions_if_stacked', 'always', 1)] });
    expect(isCardEmpowered(push, { hasPlayedClaimThisRound: false })).toBe(false);
    expect(isCardEmpowered(push, { hasPlayedClaimThisRound: true })).toBe(true);
    const dogPile = makeCard({ name: 'Dog Pile', card_type: 'claim', power: 1, stackable: true, effects: [eff('stacking_power_bonus', 'always', 1)] });
    expect(isCardEmpowered(dogPile, { hasPlayedClaimThisRound: false })).toBe(false);
    expect(isCardEmpowered(dogPile, { hasPlayedClaimThisRound: true })).toBe(true);
  });

  it('glows cards granted Stackable', () => {
    expect(isCardEmpowered(makeCard({ granted_stackable: true }), {})).toBe(true);
  });
});

describe('reconcileHandOrder', () => {
  const set = (...ids: string[]) => new Set(ids);

  it('puts drawn cards on the right, even ones that sat in the hand before', () => {
    // "a" was in an earlier hand (its id is still remembered) and comes back
    // in the middle of the server's hand order.
    expect(reconcileHandOrder(['a', 'b', 'c'], set('b', 'c'), ['b', 'a', 'c', 'd'], set())).toEqual(['b', 'c', 'a', 'd']);
  });

  it('keeps the player\'s arrangement and drops cards that left', () => {
    expect(reconcileHandOrder(['c', 'a', 'b'], set('a', 'b', 'c'), ['a', 'b'], set())).toEqual(['a', 'b']);
  });

  it('keeps the slot of a card in play so an undo slides it back', () => {
    const played = reconcileHandOrder(['a', 'b', 'c'], set('a', 'b', 'c'), ['a', 'c'], set('b'));
    expect(played).toEqual(['a', 'b', 'c']);
    expect(reconcileHandOrder(played, set('a', 'c', 'b'), ['a', 'c', 'b'], set())).toEqual(['a', 'b', 'c']);
  });
});
