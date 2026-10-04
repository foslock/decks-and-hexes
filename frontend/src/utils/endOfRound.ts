import type { GameState } from '../types/game';

/**
 * True when `next` is the state after the round ended under `prev` (buy phase
 * over, next round or game over) and the player still held cards, which
 * should animate into their discard pile before `next` is shown.
 *
 * In lobby games the next round reaches the client over the WebSocket, often
 * before the End Turn response, so this is checked on every incoming state
 * rather than in the End Turn handler.
 */
export function roundEndDiscardsHand(prev: GameState, next: GameState, playerId: string | undefined): boolean {
  if (!playerId || prev.id !== next.id || prev.current_phase !== 'buy') return false;
  if (next.current_phase === 'buy' && next.current_round === prev.current_round) return false;
  return (prev.players[playerId]?.hand.length ?? 0) > 0;
}
