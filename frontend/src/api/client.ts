import type { GameState } from '../types/game';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail || res.statusText);
  }
  return res.json();
}

export async function createGame(
  gridSize: string,
  players: { id: string; name: string; archetype: string }[],
  seed?: number,
): Promise<{ game_id: string; state: GameState }> {
  return request('/games', {
    method: 'POST',
    body: JSON.stringify({ grid_size: gridSize, players, seed }),
  });
}

export async function getGame(gameId: string, playerId?: string): Promise<GameState> {
  const params = playerId ? `?player_id=${playerId}` : '';
  return request(`/games/${gameId}${params}`);
}

export async function playCard(
  gameId: string,
  playerId: string,
  cardIndex: number,
  targetQ?: number,
  targetR?: number,
  targetPlayerId?: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/play`, {
    method: 'POST',
    body: JSON.stringify({
      player_id: playerId,
      card_index: cardIndex,
      target_q: targetQ,
      target_r: targetR,
      target_player_id: targetPlayerId,
    }),
  });
}

export async function submitPlan(
  gameId: string,
  playerId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/submit-plan`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  });
}

export async function buyCard(
  gameId: string,
  playerId: string,
  source: string,
  cardId?: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/buy`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, source, card_id: cardId }),
  });
}

export async function rerollMarket(
  gameId: string,
  playerId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/reroll`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  });
}

export async function endTurn(
  gameId: string,
): Promise<{ state: GameState }> {
  return request(`/games/${gameId}/end-turn`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
