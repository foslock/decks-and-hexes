import { describe, expect, it } from 'vitest';
import type { HexTile, ResolutionStep } from '../types/game';
import { buildResolvePlans, walkClashes, type PlanCard } from '../utils/resolvePlan';
import { makeTile } from './fixtures';

const tiles = (over: Record<string, Partial<HexTile>> = {}): Record<string, HexTile> => {
  const t: Record<string, HexTile> = {};
  for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) t[`${q},${r}`] = makeTile(q, r);
  for (const [k, o] of Object.entries(over)) t[k] = { ...t[k], ...o };
  return t;
};
const card = (key: string, playerId: string, cardType: string, power = 0, defense = 0): PlanCard =>
  ({ key, playerId, cardType, power, defense });
const step = (s: Partial<ResolutionStep>): ResolutionStep => ({
  tile_key: '0,0', q: 0, r: 0, contested: false, claimants: [], defender_id: null, defender_power: 0,
  winner_id: null, previous_owner: null, outcome: 'claimed', ...s,
});
const claimant = (player_id: string, power: number) => ({ player_id, power, source_q: 1, source_r: 0 });

describe('walkClashes', () => {
  it('climbs from the weakest attacker; the strongest takes the tile', () => {
    const w = walkClashes([
      { playerId: 'b', total: 2, beats: [], sourceQ: null, sourceR: null },
      { playerId: 'c', total: 4, beats: [], sourceQ: null, sourceR: null },
    ], 'a', 1);
    expect(w.attacks.map(a => [a.clash, a.holder, a.value])).toEqual([['break', 'b', 2], ['break', 'c', 4]]);
    expect(w.holder).toBe('c');
  });

  it('ties go to a neutral tile\'s attacker, to an owner, and to nobody between attackers', () => {
    const solo = (owner: string | null) => walkClashes([{ playerId: 'x', total: 2, beats: [], sourceQ: null, sourceR: null }], owner, 2);
    expect(solo(null).attacks[0].clash).toBe('break');
    expect(solo('a').attacks[0].clash).toBe('bounce');
    const tie = walkClashes([
      { playerId: 'b', total: 3, beats: [], sourceQ: null, sourceR: null },
      { playerId: 'c', total: 3, beats: [], sourceQ: null, sourceR: null },
    ], 'a', 1);
    expect(tie.attacks.map(a => a.clash)).toEqual(['break', 'stalemate']);
    expect(tie.stalemate).toBe(true);
    expect(tie.holder).toBe('a');
  });
});

describe('buildResolvePlans', () => {
  it('builds the defense from Defense cards and the owner\'s own claims, then the attack', () => {
    const t = tiles({ '0,0': { owner: 'me', base_defense: 0, defense_power: 0 } });
    const steps = [
      step({ outcome: 'defense_applied', claimants: [claimant('me', 0)], defender_id: 'me', winner_id: 'me', previous_owner: 'me', defense_permanent: 0, defense_temporary: 2 }),
      step({ claimants: [claimant('me', 3), claimant('rival', 2)], defender_power: 3, winner_id: 'me', previous_owner: 'me', outcome: 'defended' }),
    ];
    const cards = new Map([['0,0', [
      card('wall@0,0', 'me', 'defense', 0, 2), card('ex@0,0', 'me', 'claim', 1),
      card('r1@0,0', 'rival', 'claim', 1), card('r2@0,0', 'rival', 'claim', 1),
    ]]]);
    const [plan] = buildResolvePlans(steps, cards, t, 'me');
    expect(plan.kind).toBe('clash');
    expect(plan.focus).toBe(true);
    expect(plan.defenseBeats.map(b => [b.card?.key, b.add, b.temp])).toEqual([['wall@0,0', 2, true], ['ex@0,0', 1, true]]);
    expect(plan.perm + plan.temp).toBe(3);
    expect(plan.attacks).toHaveLength(1);
    expect(plan.attacks[0].beats.map(b => b.add)).toEqual([1, 1]);
    expect(plan.attacks[0].clash).toBe('bounce');
    expect(plan.captured).toBe(false);
    expect(plan.winner).toBe('me');
  });

  it('a card\'s share never overshoots; the last card absorbs the rest', () => {
    const steps = [step({ claimants: [claimant('x', 3)], winner_id: 'x' })];
    const cards = new Map([['0,0', [card('a@0,0', 'x', 'claim', 2), card('b@0,0', 'x', 'claim', 2)]]]);
    const [plan] = buildResolvePlans(steps, cards, tiles(), 'me');
    expect(plan.attacks[0].beats.map(b => b.add)).toEqual([2, 1]);
    expect(plan.captured).toBe(true);
    expect(plan.winner).toBe('x');
  });

  it('a neutral tile\'s intrinsic defense counts, and holds against weaker claims', () => {
    const t = tiles({ '0,0': { base_defense: 2, defense_power: 2, is_vp: true } });
    const steps = [step({ claimants: [claimant('x', 1)], defender_power: 2, outcome: 'defense_held' })];
    const [plan] = buildResolvePlans(steps, new Map(), t, 'me');
    expect(plan.perm).toBe(2);
    expect(plan.attacks[0].clash).toBe('bounce');
    expect(plan.winner).toBe(null);
    expect(plan.captured).toBe(false);
  });

  it('attackers tying on top leave the tile with its owner', () => {
    const t = tiles({ '0,0': { owner: 'a' } });
    const steps = [step({ claimants: [claimant('b', 3), claimant('c', 3)], previous_owner: 'a', outcome: 'tie' })];
    const [plan] = buildResolvePlans(steps, new Map(), t, 'me');
    expect(plan.attacks.map(a => a.clash)).toEqual(['break', 'stalemate']);
    expect(plan.winner).toBe('a');
    expect(plan.captured).toBe(false);
  });

  it('closes in only on tiles that involve you', () => {
    const t = tiles({ '1,0': { owner: 'me' } });
    const near = step({ tile_key: '0,0', claimants: [claimant('x', 1)], winner_id: 'x' });
    const far = step({ tile_key: '3,-3', q: 3, r: -3, claimants: [claimant('x', 1)], winner_id: 'x' });
    const plans = buildResolvePlans([near, far], new Map(), t, 'me');
    expect(plans.map(p => p.focus)).toEqual([true, false]);
  });

  it('runs post-claim effects last', () => {
    const steps = [
      step({ tile_key: '1,0', q: 1, r: 0, outcome: 'auto_claim', claimants: [claimant('x', 0)], winner_id: 'x' }),
      step({ claimants: [claimant('x', 1)], winner_id: 'x' }),
    ];
    const plans = buildResolvePlans(steps, new Map(), tiles(), 'me');
    expect(plans.map(p => p.kind)).toEqual(['clash', 'effect']);
    expect(plans[1].mainStep).toBe(0);
  });

  it('claims with no say (an immune tile) fizzle', () => {
    const t = tiles({ '0,0': { owner: 'me' } });
    const steps = [step({ outcome: 'defense_applied', claimants: [claimant('me', 0)], previous_owner: 'me', winner_id: 'me', defense_immunity: true })];
    const cards = new Map([['0,0', [card('iw@0,0', 'me', 'defense'), card('r@0,0', 'rival', 'claim', 3)]]]);
    const [plan] = buildResolvePlans(steps, cards, t, 'me');
    expect(plan.kind).toBe('defense');
    expect(plan.immune).toBe(true);
    expect(plan.fizzles.map(c => c.key)).toEqual(['r@0,0']);
  });
});
