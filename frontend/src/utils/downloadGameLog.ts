import { getGameLog } from '../api/client';

/**
 * Fetches the structured game log for a game and triggers a browser download
 * as a JSON file. Works mid-game (captures state at time of request).
 */
export async function downloadGameLog(gameId: string, playerId?: string): Promise<void> {
  const data = await getGameLog(gameId, playerId);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `card-clash-game-${gameId}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Delay revocation so the click has time to register in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
