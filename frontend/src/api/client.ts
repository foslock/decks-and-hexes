import type { GameState, LobbyState } from '../types/game';

const BACKEND_HOST = import.meta.env.VITE_BACKEND_HOST;
const BASE = BACKEND_HOST ? `${window.location.protocol}//${BACKEND_HOST}/api` : '/api';

// Module-level auth token for multiplayer games
let _authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  _authToken = token;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (_authToken) {
    headers['X-Player-Token'] = _authToken;
  }
  const res = await fetch(`${BASE}${path}`, {
    headers,
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
  players: { id: string; name: string; archetype: string; is_cpu?: boolean; cpu_noise?: number }[],
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
  trashCardIndices?: number[],
  discardCardIndices?: number[],
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
      trash_card_indices: trashCardIndices,
      discard_card_indices: discardCardIndices,
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

export async function advanceResolve(
  gameId: string,
  playerId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/advance-resolve`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
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

export async function processCpuBuys(
  gameId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/process-cpu-buys`, {
    method: 'POST',
  });
}

// ── Lobby APIs ───────────────────────────────────────────

export async function createLobby(
  name: string,
  archetype: string,
): Promise<{ code: string; player_id: string; token: string; lobby: LobbyState }> {
  return request('/lobby/create', {
    method: 'POST',
    body: JSON.stringify({ name, archetype }),
  });
}

export async function joinLobby(
  code: string,
  name: string,
  archetype: string,
): Promise<{ player_id: string; token: string; lobby: LobbyState }> {
  return request(`/lobby/${code}/join`, {
    method: 'POST',
    body: JSON.stringify({ name, archetype }),
  });
}

export async function getLobby(
  code: string,
  playerId: string,
  token: string,
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}?player_id=${playerId}&token=${token}`);
}

export async function updateLobbyConfig(
  code: string,
  token: string,
  config: { grid_size?: string; speed?: string; max_players?: number; test_mode?: boolean; vp_target?: number | null },
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}/config`, {
    method: 'PATCH',
    body: JSON.stringify({ ...config, token }),
  });
}

export async function updateLobbyPlayer(
  code: string,
  playerId: string,
  token: string,
  updates: { name?: string; archetype?: string; difficulty?: string },
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}/player/${playerId}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...updates, token }),
  });
}

export async function addLocalPlayer(
  code: string,
  token: string,
  name: string,
  archetype: string,
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}/local-player`, {
    method: 'POST',
    body: JSON.stringify({ name, archetype, token }),
  });
}

export async function addCpuToLobby(
  code: string,
  token: string,
  archetype: string,
  difficulty: string = 'medium',
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}/cpu`, {
    method: 'POST',
    body: JSON.stringify({ archetype, difficulty, token }),
  });
}

export async function reorderLobbyPlayers(
  code: string,
  token: string,
  order: string[],
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}/reorder`, {
    method: 'POST',
    body: JSON.stringify({ order, token }),
  });
}

export async function removeLobbyPlayer(
  code: string,
  token: string,
  targetPlayerId: string,
): Promise<{ lobby: LobbyState }> {
  return request(`/lobby/${code}/player/${targetPlayerId}`, {
    method: 'DELETE',
    body: JSON.stringify({ token }),
  });
}

export async function closeLobby(
  code: string,
  token: string,
): Promise<{ ok: boolean }> {
  return request(`/lobby/${code}/close`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function startLobby(
  code: string,
  token: string,
): Promise<{ game_id: string; state: GameState }> {
  return request(`/lobby/${code}/start`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export async function leaveGame(
  gameId: string,
  playerId: string,
  token: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/leave`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, token }),
  });
}

export async function endGame(
  gameId: string,
  playerId: string,
  token: string,
): Promise<{ message: string }> {
  return request(`/games/${gameId}/end`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, token }),
  });
}

// ── Replay APIs ──────────────────────────────────────────

export async function replayVote(
  gameId: string,
  playerId: string,
  token: string,
): Promise<{ message: string; votes?: string[]; game_id?: string; state?: GameState }> {
  return request(`/games/${gameId}/replay-vote`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, token }),
  });
}

export async function replayExit(
  gameId: string,
  playerId: string,
  token: string,
): Promise<{ message: string }> {
  return request(`/games/${gameId}/replay-exit`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, token }),
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

export async function testDiscardCard(
  gameId: string,
  playerId: string,
  cardIndex: number,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/test/discard-card`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, card_index: cardIndex }),
  });
}

export async function testDrawCard(
  gameId: string,
  playerId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/test/draw-card`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  });
}

export async function testDiscardHand(
  gameId: string,
  playerId: string,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/test/discard-hand`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId }),
  });
}

export async function testTrashCard(
  gameId: string,
  playerId: string,
  cardIndex: number,
): Promise<{ message: string; state: GameState }> {
  return request(`/games/${gameId}/test/trash-card`, {
    method: 'POST',
    body: JSON.stringify({ player_id: playerId, card_index: cardIndex }),
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
