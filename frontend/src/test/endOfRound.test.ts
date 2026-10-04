import { describe, expect, it } from 'vitest';
import { roundEndDiscardsHand } from '../utils/endOfRound';
import { makeGameState } from './fixtures';

describe('roundEndDiscardsHand', () => {
  const buy = makeGameState({ current_phase: 'buy', current_round: 4 });

  it('is true when the buy phase ends with cards in hand', () => {
    expect(roundEndDiscardsHand(buy, { ...buy, current_phase: 'upkeep', current_round: 5 }, 'player_0')).toBe(true);
    expect(roundEndDiscardsHand(buy, { ...buy, current_phase: 'game_over' }, 'player_0')).toBe(true);
  });

  it('is false mid-buy, outside the buy phase, or with an empty hand', () => {
    expect(roundEndDiscardsHand(buy, { ...buy, players_done_buying: ['player_1'] }, 'player_0')).toBe(false);
    const play = { ...buy, current_phase: 'play' };
    expect(roundEndDiscardsHand(play, { ...play, current_round: 5 }, 'player_0')).toBe(false);
    const empty = { ...buy, players: { ...buy.players, player_0: { ...buy.players.player_0, hand: [] } } };
    expect(roundEndDiscardsHand(empty, { ...empty, current_phase: 'upkeep', current_round: 5 }, 'player_0')).toBe(false);
  });
});
