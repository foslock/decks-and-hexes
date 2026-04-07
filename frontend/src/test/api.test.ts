import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from '../api/client';
import { makeGameState } from './fixtures';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockReset();
});

function mockJsonResponse(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

describe('API client', () => {
  describe('createGame', () => {
    it('sends correct request and returns game state', async () => {
      const state = makeGameState();
      mockJsonResponse({ game_id: 'abc', state });

      const result = await api.createGame('small', [
        { id: 'p0', name: 'Alice', archetype: 'vanguard' },
        { id: 'p1', name: 'Bob', archetype: 'swarm' },
      ]);

      expect(result.game_id).toBe('abc');
      expect(result.state.current_phase).toBe('play');
      expect(mockFetch).toHaveBeenCalledWith('/api/games', expect.objectContaining({
        method: 'POST',
      }));
    });

    it('passes seed when provided', async () => {
      mockJsonResponse({ game_id: 'abc', state: makeGameState() });

      await api.createGame('small', [{ id: 'p0', name: 'A', archetype: 'vanguard' }], 42);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.seed).toBe(42);
    });
  });

  describe('getGame', () => {
    it('fetches game state', async () => {
      const state = makeGameState();
      mockJsonResponse(state);

      const result = await api.getGame('abc');
      expect(result.id).toBe('test-game-id');
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc', expect.anything());
    });

    it('includes player_id query param', async () => {
      mockJsonResponse(makeGameState());
      await api.getGame('abc', 'p0');
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc?player_id=p0', expect.anything());
    });
  });

  describe('playCard', () => {
    it('sends play request with target', async () => {
      mockJsonResponse({ message: 'ok', state: makeGameState() });

      await api.playCard('abc', 'p0', 0, 1, 2);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.player_id).toBe('p0');
      expect(body.card_index).toBe(0);
      expect(body.target_q).toBe(1);
      expect(body.target_r).toBe(2);
    });

    it('sends play request without target', async () => {
      mockJsonResponse({ message: 'ok', state: makeGameState() });

      await api.playCard('abc', 'p0', 2);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.target_q).toBeUndefined();
    });
  });

  describe('submitPlay', () => {
    it('sends submit request', async () => {
      mockJsonResponse({ message: 'ok', state: makeGameState() });
      await api.submitPlay('abc', 'p0');
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc/submit-play', expect.anything());
    });
  });

  describe('buyCard', () => {
    it('sends buy request', async () => {
      mockJsonResponse({ message: 'ok', state: makeGameState() });
      await api.buyCard('abc', 'p0', 'neutral', 'some_card');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.source).toBe('neutral');
      expect(body.card_id).toBe('some_card');
    });
  });

  describe('rerollMarket', () => {
    it('sends reroll request', async () => {
      mockJsonResponse({ message: 'ok', state: makeGameState() });
      await api.rerollMarket('abc', 'p0');
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc/reroll', expect.anything());
    });
  });

  describe('endTurn', () => {
    it('sends end turn request', async () => {
      mockJsonResponse({ message: 'Turn ended', state: makeGameState() });
      await api.endTurn('abc', 'player_0');
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc/end-buy', expect.anything());
    });
  });

  describe('getGameLog', () => {
    it('fetches game log', async () => {
      mockJsonResponse({ game_id: 'abc', entries: [{ message: 'test', round: 1, phase: 'play', actor: null }] });
      const result = await api.getGameLog('abc');
      expect(result.entries).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc/log', expect.anything());
    });

    it('includes player_id filter', async () => {
      mockJsonResponse({ game_id: 'abc', entries: [] });
      await api.getGameLog('abc', 'p0');
      expect(mockFetch).toHaveBeenCalledWith('/api/games/abc/log?player_id=p0', expect.anything());
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      mockJsonResponse({ detail: 'Not found' }, 404);
      await expect(api.getGame('bad')).rejects.toThrow('Not found');
    });

    it('throws statusText when no detail', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('parse error')),
      });
      await expect(api.getGame('bad')).rejects.toThrow('Internal Server Error');
    });
  });
});
