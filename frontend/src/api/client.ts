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
  testMode?: boolean,
  speed?: string,
): Promise<{ game_id: string; state: GameState }> {
  return request('/games', {
    method: 'POST',
    body: JSON.stringify({ grid_size: gridSize, players, seed, test_mode: testMode, speed }),
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
  extraTargets?: [number, number][],
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/play`, {
    method: 'POST',
    body: JSON.stringify({
      player_id: playerId,
      card_index: cardIndex,
      target_q: targetQ,
      target_r: targetR,
      target_player_id: targetPlayerId,
      extra_targets: extraTargets,
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

export async function upgradeCard(
  gameId: string,
  playerId: string,
  cardIndex: number,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/upgrade-card`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, card_index: cardIndex }),
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

export async function advanceUpkeep(
  gameId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/advance-upkeep`, {
    method: 'POST',
  });
}

export async function endTurn(
  gameId: string,
  playerId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/end-buy`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  });
}

// ── Test Mode APIs ────────────────────────────────────────

export async function testGiveCard(
  gameId: string,
  playerId: string,
  cardId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/test/give-card`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, card_id: cardId }),
  });
}

export async function testSetStats(
  gameId: string,
  playerId: string,
  vp?: number,
  resources?: number,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/test/set-stats`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, vp, resources }),
  });
}

export interface LogEntry {
  message: string;
  round: number;
  phase: string;
  actor: string | null;
}

export async function getGameLog(
  gameId: string,
  playerId?: string,
): Promise<{ game_id: string; entries: LogEntry[] }> {
  const params = playerId ? `?player_id=${playerId}` : '';
  return request(`/games/${gameId}/log${params}`);
}
