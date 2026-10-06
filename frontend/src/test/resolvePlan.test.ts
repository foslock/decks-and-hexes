import { describe, expect, it } from 'vitest';
import type { HexTile, ResolutionStep } from '../types/game';
import { buildResolvePlans, revealOrder, sortByReveal, walkClashes, type PlanCard } from '../utils/resolvePlan';
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
  it('a Siege Engine\'s claim attacks last, and the bonuses crack for it alone', () => {
    // The owner's +2 Defense card and +1 Claim: 3. The rival's 3 bounces off
    // it; the Siege Engine (2) faces 1 once the +2 cracks, and takes the tile.
    const t = tiles({ '0,0': { owner: 'own', base_defense: 0, defense_power: 0 } });
    const steps = [
      step({ outcome: 'defense_applied', claimants: [claimant('own', 0)], defender_id: 'own', winner_id: 'own', previous_owner: 'own', defense_permanent: 0, defense_temporary: 2 }),
      step({
        claimants: [claimant('me', 2), claimant('rival', 3), claimant('own', 3)], defender_power: 3,
        winner_id: 'me', previous_owner: 'own', outcome: 'claimed', defense_ignored: 2, ignored_by: ['me'],
      }),
    ];
    const cards = new Map([['0,0', [
      card('wall@0,0', 'own', 'defense', 0, 2), card('ex@0,0', 'own', 'claim', 1),
      card('siege@0,0', 'me', 'claim', 2), card('r@0,0', 'rival', 'claim', 3),
    ]]]);
    const [plan] = buildResolvePlans(steps, cards, t, 'me');
    expect(plan.perm + plan.temp).toBe(3);
    expect(plan.attacks.map(a => [a.playerId, a.clash, !!a.crack, a.value])).toEqual([
      ['rival', 'bounce', false, 3], ['me', 'break', true, 2],
    ]);
    expect(plan.winner).toBe('me');
  });

  it('no crack once a rival has broken through: the Siege Engine faces their claim', () => {
    const w = walkClashes([
      { playerId: 'rival', total: 4, beats: [], sourceQ: null, sourceR: null },
      { playerId: 'me', total: 3, beats: [], sourceQ: null, sourceR: null, ignores: true },
    ], 'own', 3, 2);
    expect(w.attacks.map(a => [a.clash, !!a.crack])).toEqual([['break', false], ['bounce', false]]);
    expect(w.holder).toBe('rival');
  });

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

  it('turns every claim on an immune tile into a dink off it, from the claimer\'s nearest tile', () => {
    const t = tiles({ '0,0': { owner: 'me' }, '2,0': { owner: 'rival' }, '3,0': { owner: 'rival' } });
    const steps = [step({ outcome: 'defense_applied', claimants: [claimant('me', 0)], previous_owner: 'me', winner_id: 'me', defense_immunity: true })];
    const cards = new Map([['0,0', [
      card('iw@0,0', 'me', 'defense'), card('r1@0,0', 'rival', 'claim', 6), card('r2@0,0', 'rival', 'claim', 3),
    ]]]);
    const [plan] = buildResolvePlans(steps, cards, t, 'me');
    expect(plan.kind).toBe('defense');
    expect(plan.immune).toBe(true);
    expect(plan.fizzles).toEqual([]);
    expect(plan.attacks).toHaveLength(1);
    const [a] = plan.attacks;
    expect(a.clash).toBe('dink');
    expect(a.total).toBe(9);
    expect(a.beats.map(b => [b.card?.key, b.add])).toEqual([['r1@0,0', 6], ['r2@0,0', 3]]);
    expect([a.sourceQ, a.sourceR]).toEqual([2, 0]);
    expect(plan.winner).toBe('me');
    expect(plan.captured).toBe(false);
  });

  it('plays Flood\'s spread first, right before the tiles it reaches', () => {
    const t = tiles({ '0,0': { owner: 'me' } });
    const flood = card('flood@0,0', 'me', 'claim', 1);
    flood.cardId = 'flood';
    const cl = (key: string) => {
      const [q, r] = key.split(',').map(Number);
      return step({ tile_key: key, q, r, winner_id: 'me', claimants: [{ ...claimant('me', 1), cards: [{ card_id: 'flood', name: 'Flood', power: 1, bonuses: [] }] }] });
    };
    const steps = [step({ tile_key: '2,2', q: 2, r: 2, winner_id: 'rival', claimants: [claimant('rival', 1)] }), cl('1,0'), cl('0,1')];
    const plans = buildResolvePlans(steps, new Map([['0,0', [flood]]]), t, 'me', [
      { type: 'flood', player_id: 'me', tile_key: '0,0', targets: ['1,0', '0,1', '-1,0'], card_id: 'flood', card_name: 'Flood' },
    ]);
    expect(plans.map(p => p.outcome === 'flood' ? 'flood' : p.tileKey)).toEqual(['2,2', 'flood', '1,0', '0,1']);
    const fp = plans[1];
    expect(fp.others.map(c => c.key)).toEqual(['flood@0,0']);
    expect(fp.focus).toBe(true);
    // The claims it lands count Flood's 1 (its card stays on the tile it floods from).
    expect(plans[2].attacks[0].beats.map(b => [b.card?.key ?? null, b.add])).toEqual([[null, 1]]);
  });

  it('names each reveal-time bonus as its own beat', () => {
    const t = tiles({ '0,0': { owner: 'rival' } });
    const amb = { ...card('amb@0,0', 'me', 'claim', 2), cardId: 'amb' };
    const dog = { ...card('dog@0,0', 'me', 'claim', 2), cardId: 'dog' };
    const steps = [step({
      winner_id: 'me', previous_owner: 'rival', claimants: [{ ...claimant('me', 7), cards: [
        { card_id: 'dog', name: 'Dog Pile', power: 2, bonuses: [] },
        { card_id: 'amb', name: 'Ambush', power: 2, bonuses: [{ source: 'Ambush', amount: 2 }, { source: 'Dog Pile', amount: 1 }] },
      ] }],
    })];
    const [plan] = buildResolvePlans(steps, new Map([['0,0', [amb, dog]]]), t, 'me');
    expect(plan.attacks[0].beats.map(b => [b.card?.key, b.add, b.label ?? null])).toEqual([
      ['dog@0,0', 2, null], ['amb@0,0', 2, null], ['amb@0,0', 2, 'Ambush'], ['amb@0,0', 1, 'Dog Pile'],
    ]);
  });

  it('plays what card effects did after their tile, and the rest from the player\'s base', () => {
    const t = tiles({ '0,0': { owner: 'rival' }, '3,0': { owner: 'me', is_base: true, base_owner: 'me' } });
    const sw = { ...card('sw@0,0', 'me', 'claim', 3), cardId: 'sw' };
    const bz = { ...card('bz@0,0', 'rival', 'claim', 2), cardId: 'bz' };
    const steps = [step({ winner_id: 'me', claimants: [claimant('me', 3), claimant('rival', 2)] })];
    const plans = buildResolvePlans(steps, new Map([['0,0', [sw, bz]]]), t, 'me', [
      { type: 'trash', player_id: 'rival', by_player_id: 'me', tile_key: '0,0', card_id: 'bz', card_name: 'Blitz', source_card: 'Spoils of War' },
      { type: 'vp', player_id: 'me', by_player_id: 'me', tile_key: null, amount: 1, card_name: 'Battle Glory' },
    ]);
    expect(plans).toHaveLength(2);
    expect(plans[0].after.map(e => e.type)).toEqual(['trash']);
    expect(plans[0].burn).toEqual(['bz@0,0']);
    expect([plans[1].outcome, plans[1].tileKey, plans[1].after.map(e => e.card_name)]).toEqual(['round', '3,0', ['Battle Glory']]);
  });
});


describe('revealOrder', () => {
  it('lines a tile\'s cards up as they turn over: the defense, then attackers weakest first', () => {
    const t = tiles({ '0,0': { owner: 'own', base_defense: 0, defense_power: 0 } });
    const steps = [
      step({ outcome: 'defense_applied', claimants: [claimant('own', 0)], defender_id: 'own', winner_id: 'own', previous_owner: 'own', defense_permanent: 0, defense_temporary: 2 }),
      step({ claimants: [claimant('strong', 5), claimant('weak', 3)], defender_power: 2, winner_id: 'strong', previous_owner: 'own', outcome: 'claimed' }),
    ];
    // In the order they were played: the strong attacker's two cards, the weak one's, then the wall.
    const played = [
      card('s1@0,0', 'strong', 'claim', 3), card('s2@0,0', 'strong', 'claim', 2),
      card('w@0,0', 'weak', 'claim', 3), card('wall@0,0', 'own', 'defense', 0, 2),
    ];
    const order = revealOrder(buildResolvePlans(steps, new Map([['0,0', played]]), t, 'strong'));
    expect(sortByReveal(played, order).map(c => c.key)).toEqual(['wall@0,0', 'w@0,0', 's1@0,0', 's2@0,0']);
  });
});
