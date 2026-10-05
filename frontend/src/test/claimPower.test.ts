import { describe, expect, it } from 'vitest';
import type { Card, HexTile } from '../types/game';
import { intrinsicClaimPower, stackingBonus, type ClaimPowerContext } from '../utils/claimPower';
import { makeCard, makeTile } from './fixtures';

type Eff = NonNullable<Card['effects']>[number];
const eff = (type: string, value: number, condition = 'always', extra: Partial<Eff> = {}): Eff => ({ type, value, condition, ...extra });
const claim = (power: number, effects: Eff[] = [], overrides: Partial<Card> = {}) =>
  makeCard({ id: `c${Math.random()}`, name: 'Test Claim', card_type: 'claim', power, effects, ...overrides });

/** A row of tiles q = 0..5 on r = 0, with a few owned by "me". */
function board(extra: Record<string, Partial<HexTile>> = {}): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -1; q <= 5; q++) for (let r = -1; r <= 1; r++) tiles[`${q},${r}`] = makeTile(q, r);
  for (const k of ['0,0', '1,0', '2,-1']) tiles[k] = { ...tiles[k], owner: 'me' };
  for (const [k, o] of Object.entries(extra)) tiles[k] = { ...tiles[k], ...o };
  return tiles;
}
const ctx = (overrides: Partial<ClaimPowerContext> = {}): ClaimPowerContext => ({
  tiles: board(), playerId: 'me', handSize: 5, played: [], ...overrides,
});

describe('intrinsicClaimPower', () => {
  it('is the printed power when nothing applies', () => {
    expect(intrinsicClaimPower(claim(3), '2,0', ctx())).toBe(3);
  });

  it('scales with tiles owned (Mob Rule) or replaces power (Locust Swarm)', () => {
    const tiles = board({ '3,0': { owner: 'me' }, '4,0': { owner: 'me' }, '5,0': { owner: 'me' } }); // 6 owned
    expect(intrinsicClaimPower(claim(1, [eff('power_per_tiles_owned', 3)]), '2,0', ctx({ tiles }))).toBe(3);
    expect(intrinsicClaimPower(claim(1, [eff('power_per_tiles_owned', 2, 'always', { metadata: { replaces_base_power: true } })]), '2,0', ctx({ tiles }))).toBe(3);
  });

  it('counts other cards in hand (Strength in Numbers)', () => {
    expect(intrinsicClaimPower(claim(0, [eff('power_modifier', 1, 'cards_in_hand')]), '2,0', ctx({ handSize: 4 }))).toBe(4);
  });

  it('counts same-name cards already played (Rabble+)', () => {
    const rabble = claim(1, [eff('power_per_same_name', 1)], { name: 'Rabble+' });
    const played = [makeCard({ id: 'r1', name: 'Rabble', card_type: 'claim' }), makeCard({ id: 'r2', name: 'Rabble+', card_type: 'claim' })];
    expect(intrinsicClaimPower(rabble, '2,0', ctx({ played }))).toBe(3);
  });

  it('only sees a defense *bonus*, not intrinsic VP-hex defense (Battering Ram)', () => {
    const ram = claim(2, [eff('power_modifier', 2, 'if_target_has_defense')]);
    const tiles = board({ '2,0': { base_defense: 2, defense_power: 2 }, '3,0': { base_defense: 2, defense_power: 3 } });
    expect(intrinsicClaimPower(ram, '2,0', ctx({ tiles }))).toBe(2);
    expect(intrinsicClaimPower(ram, '3,0', ctx({ tiles }))).toBe(4);
  });

  it('adds per adjacent owned tile (Overwhelm) and reads the target tile', () => {
    const overwhelm = claim(1, [eff('power_modifier', 1, 'if_adjacent_owned_gte', { condition_threshold: 1, metadata: { per_tile: true } })]);
    // 1,-1 touches 0,0 · 1,0 · 2,-1 — all mine.
    expect(intrinsicClaimPower(overwhelm, '1,-1', ctx())).toBe(4);
    expect(intrinsicClaimPower(overwhelm, '5,0', ctx())).toBe(1);
  });

  it('counts an opponent-owned target as contested (Ambush)', () => {
    const ambush = claim(2, [eff('power_modifier', 2, 'if_contested')]);
    const tiles = board({ '2,0': { owner: 'rival' } });
    expect(intrinsicClaimPower(ambush, '2,0', ctx({ tiles }))).toBe(4);
    expect(intrinsicClaimPower(ambush, '3,0', ctx({ tiles }))).toBe(2);
  });

  it('adds Strike Team\'s bonus only once another Claim is played', () => {
    const strike = claim(2, [eff('power_modifier', 2, 'if_played_claim_this_turn')]);
    expect(intrinsicClaimPower(strike, '2,0', ctx())).toBe(2);
    expect(intrinsicClaimPower(strike, '2,0', ctx({ played: [claim(1)] }))).toBe(4);
  });
});

describe('stackingBonus', () => {
  it('gives each claim the others\' stacking bonus', () => {
    const dog = claim(1, [eff('stacking_power_bonus', 1)]);
    expect(stackingBonus([dog])).toBe(0);
    expect(stackingBonus([dog, claim(2)])).toBe(1);
    expect(stackingBonus([dog, claim(2), claim(1)])).toBe(2);
  });
});
