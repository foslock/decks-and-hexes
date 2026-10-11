import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GameState, HexTile, SoloArchetypeCampaign, SoloCampaigns, SoloGameInfo, SoloObjective } from '../types/game';
import {
  campaignProgress, chooseCampaign, frontier, loadProgress, markShown, overworldTiles, recordClear, roadChain,
  saveProgress, spotState, territoryKeys,
} from '../components/solo/soloProgress';
import SoloObjectiveHud from '../components/solo/SoloObjectiveHud';
import { baseRotation } from '../components/solo/SoloMapPreview';
import { makeTile } from './fixtures';

/** Castle at 0,0; spot 1 two steps east, spot 2 two more north-east. */
const OW: SoloCampaigns['overworld'] = {
  tiles: Object.fromEntries(
    ['0,0', '1,0', '2,0', '3,-1', '4,-2', '0,1', '-1,0', '-2,1'].map(k => {
      const [q, r] = k.split(',').map(Number);
      return [k, { q, r, blocked: k === '-1,0' }];
    }),
  ),
};
const CAMP: Pick<SoloArchetypeCampaign, 'castle' | 'spots' | 'soon' | 'segments'> = {
  castle: '0,0',
  spots: ['2,0', '4,-2'],
  soon: [],
  segments: [['1,0', '2,0'], ['3,-1', '4,-2']],
};
const IDS = ['first', 'second'];

describe('solo progress storage', () => {
  beforeEach(() => localStorage.clear());

  it('keeps each campaign separately, with the best round', () => {
    expect(loadProgress()).toEqual({ campaigns: {} });
    recordClear('swarm', 'first', 7, 100);
    recordClear('swarm', 'first', 5, 200);
    recordClear('swarm', 'first', 9, 300);
    recordClear('fortress', 'shared', 8, 400);
    const p = loadProgress();
    expect(campaignProgress(p, 'swarm').cleared.first).toEqual({ round: 5, at: 100 });
    // A level shared by two campaigns is cleared in each separately.
    expect(campaignProgress(p, 'vanguard').cleared.shared).toBeUndefined();
    expect(campaignProgress(p, 'fortress').cleared.shared?.round).toBe(8);
    markShown('swarm', 1);
    expect(campaignProgress(loadProgress(), 'swarm').shown).toBe(1);
    expect(campaignProgress(loadProgress(), 'fortress').shown).toBe(0);
    chooseCampaign('fortress');
    expect(loadProgress().last).toBe('fortress');
  });

  it('starts over from a save made before the campaigns', () => {
    localStorage.setItem('cardclash_solo_progress', JSON.stringify({ cleared: { landfall: { round: 6 } }, shown: 1 }));
    expect(loadProgress()).toEqual({ campaigns: {}, last: undefined });
  });

  it('survives corrupt data and storage that throws', () => {
    localStorage.setItem('cardclash_solo_progress', '{not json');
    expect(loadProgress().campaigns).toEqual({});
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadProgress()).toEqual({ campaigns: {} });
    expect(() => saveProgress({ campaigns: {} })).not.toThrow();
    expect(() => recordClear('swarm', 'first', 3)).not.toThrow();
    expect(() => chooseCampaign('swarm')).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe('unlocking along the road', () => {
  it('opens a level once every level before it is cleared', () => {
    const none = { cleared: {}, shown: 0 };
    expect(frontier(IDS, none)).toBe(0);
    expect(IDS.map((_, i) => spotState(i, IDS, none))).toEqual(['open', 'locked']);
    const one = { cleared: { first: { round: 4, at: 0 } }, shown: 0 };
    expect(frontier(IDS, one)).toBe(1);
    expect(IDS.map((_, i) => spotState(i, IDS, one))).toEqual(['cleared', 'open']);
    // A spot past the last level is "coming soon".
    expect(spotState(2, IDS, one)).toBe('soon');
    // Clearing out of order (an old save) unlocks nothing past the gap.
    const gap = { cleared: { second: { round: 4, at: 0 } }, shown: 0 };
    expect(frontier(IDS, gap)).toBe(0);
  });

  it('grows the territory along the road to the next spot', () => {
    expect(territoryKeys(CAMP, 0)).toEqual(['0,0', '1,0']);
    expect(territoryKeys(CAMP, 1)).toEqual(['0,0', '1,0', '2,0', '3,-1']);
    expect(territoryKeys(CAMP, 2)).toEqual(['0,0', '1,0', '2,0', '3,-1', '4,-2']);
    expect(roadChain(CAMP, 1)).toEqual(territoryKeys(CAMP, 1));
  });

  it('shows one campaign on the overworld: its castle, its towns, your land', () => {
    const tiles = overworldTiles(OW, CAMP, territoryKeys(CAMP, 1));
    expect(tiles['0,0']).toMatchObject({ is_base: true, owner: 'player_0', base_owner: 'player_0' });
    expect(tiles['2,0']).toMatchObject({ is_vp: true, owner: 'player_0' });
    expect(tiles['4,-2']).toMatchObject({ is_vp: true, owner: null });
    expect(tiles['-2,1']).toMatchObject({ is_vp: false, is_base: false, owner: null });  // not this campaign's
    expect(tiles['-1,0'].is_blocked).toBe(true);
  });
});

describe('map preview', () => {
  it('turns the board so your base is at the bottom', () => {
    const tiles: Record<string, HexTile> = {};
    for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) if (Math.abs(q + r) <= 2) tiles[`${q},${r}`] = makeTile(q, r);
    tiles['0,2'] = { ...tiles['0,2'], is_base: true, base_owner: 'me' };
    tiles['0,-2'] = { ...tiles['0,-2'], is_base: true, base_owner: 'them' };
    expect(baseRotation(tiles, 'me')).toBeCloseTo(0);
    expect(Math.abs(baseRotation(tiles, 'them'))).toBeCloseTo(Math.PI);
  });
});

describe('SoloObjectiveHud', () => {
  afterEach(() => localStorage.clear());

  const objective = (over: Partial<SoloObjective> = {}): SoloObjective => ({
    type: 'territory', rounds: 8, vp: null, tiles: 30, share: 0.5, land: 58, count: null, connected: false,
    defense: null, raids_allowed: 0, tiles_lost_max: null, bot_vp: null,
    goal: 'Hold more than half the land (30 of 58 tiles)', headline: 'Hold more than half the land', text: '', ...over,
  });
  const solo = (over: Partial<SoloGameInfo> = {}): SoloGameInfo => ({
    level_id: 'first', level_title: 'Open Range', campaign: 'swarm', player_id: 'player_0',
    objective: objective(),
    debt: true, market: 'fixed', pack: { shared_card_ids: [], archetype_card_ids: {}, fixed: true },
    result: null, reason: null,
    progress: { value: 12, target: 30, unit: 'tiles', met: false, failed: false, detail: null },
    ...over,
  });

  it('shows the goal, progress and rounds left', () => {
    const state = { current_round: 3, solo: solo() } as unknown as GameState;
    render(<SoloObjectiveHud gameState={state} />);
    expect(screen.getByText('Open Range')).toBeTruthy();
    expect(screen.getByText(/Hold more than half the land/)).toBeTruthy();
    expect(screen.getByText(/12\/30/)).toBeTruthy();
    expect(screen.getByText(/6 rounds left/)).toBeTruthy();
  });

  it('marks the last round and a rival VP target', () => {
    const state = {
      current_round: 8,
      solo: solo({ objective: objective({ type: 'vp', vp: 9, bot_vp: 11, goal: 'Reach 9 VP', headline: 'Reach 9 VP' }) }),
    } as unknown as GameState;
    render(<SoloObjectiveHud gameState={state} />);
    expect(screen.getByText(/Last round/)).toBeTruthy();
    expect(screen.getByText(/rivals win at 11 VP/)).toBeTruthy();
  });

  it('says when a level has no time limit', () => {
    const state = {
      current_round: 14,
      solo: solo({ objective: objective({ type: 'raid', rounds: null, bot_vp: 15, goal: "Raid both rivals' bases", headline: "Raid both rivals' bases" }) }),
    } as unknown as GameState;
    render(<SoloObjectiveHud gameState={state} />);
    expect(screen.getByText(/No time limit/)).toBeTruthy();
    expect(screen.queryByText(/rounds left|Last round/)).toBeNull();
    expect(screen.getByText(/rivals win at 15 VP/)).toBeTruthy();
  });

  it('shows how a hold-out is going', () => {
    const state = {
      current_round: 4,
      solo: solo({
        objective: objective({
          type: 'survive', rounds: 10, tiles_lost_max: 3, goal: 'Hold out to the end of round 10', headline: 'Hold out for 10 rounds',
        }),
        progress: { value: 3, target: 10, unit: 'rounds held', met: false, failed: false, detail: 'base unraided · 1 of 3 tiles lost' },
      }),
    } as unknown as GameState;
    render(<SoloObjectiveHud gameState={state} />);
    expect(screen.getByText('Hold out for 10 rounds')).toBeTruthy();
    expect(screen.getByText(/3\/10/)).toBeTruthy();
    expect(screen.getByText('base unraided · 1 of 3 tiles lost')).toBeTruthy();
  });
});
