import { describe, it, expect } from 'vitest';
import { makeGameState, makePlayer, makeCard, makeTile } from './fixtures';
import type { GameState, Player, Card, HexTile } from '../types/game';

describe('Type contracts', () => {
  describe('GameState', () => {
    it('has required fields', () => {
      const state: GameState = makeGameState();
      expect(state.id).toBeDefined();
      expect(state.grid).toBeDefined();
      expect(state.players).toBeDefined();
      expect(state.player_order).toBeDefined();
      expect(state.current_phase).toBeDefined();
      expect(state.current_round).toBeDefined();
      expect(state.neutral_market).toBeDefined();
      expect(state.log).toBeDefined();
    });

    it('grid contains tiles', () => {
      const state = makeGameState();
      expect(Object.keys(state.grid.tiles).length).toBeGreaterThan(0);
    });

    it('player_order matches player keys', () => {
      const state = makeGameState();
      for (const pid of state.player_order) {
        expect(state.players[pid]).toBeDefined();
      }
    });
  });

  describe('Player', () => {
    it('has hand as array of cards', () => {
      const player: Player = makePlayer();
      expect(Array.isArray(player.hand)).toBe(true);
      for (const card of player.hand) {
        expect(card.id).toBeDefined();
        expect(card.name).toBeDefined();
      }
    });

    it('tracks action usage', () => {
      const player = makePlayer({ actions_used: 2, actions_available: 4 });
      expect(player.actions_available - player.actions_used).toBe(2);
    });
  });

  describe('Card', () => {
    it('claim card has power', () => {
      const card: Card = makeCard({ card_type: 'claim', power: 3 });
      expect(card.power).toBe(3);
    });

    it('engine card has resource gain', () => {
      const card: Card = makeCard({ card_type: 'engine', resource_gain: 2 });
      expect(card.resource_gain).toBe(2);
    });

    it('defense card has defense bonus', () => {
      const card: Card = makeCard({ card_type: 'defense', defense_bonus: 3 });
      expect(card.defense_bonus).toBe(3);
    });
  });

  describe('HexTile', () => {
    it('has coordinates', () => {
      const tile: HexTile = makeTile(2, -1);
      expect(tile.q).toBe(2);
      expect(tile.r).toBe(-1);
    });

    it('blocked tiles have no owner', () => {
      const tile = makeTile(0, 0, { is_blocked: true });
      expect(tile.owner).toBeNull();
    });

    it('VP tiles are identifiable', () => {
      const tile = makeTile(1, 0, { is_vp: true });
      expect(tile.is_vp).toBe(true);
    });
  });
});
