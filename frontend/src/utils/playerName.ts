// Persistence for the local player's chosen display name across games.
const PLAYER_NAME_KEY = 'cardclash_player_name';

export function getSavedPlayerName(): string | null {
  try {
    const raw = localStorage.getItem(PLAYER_NAME_KEY);
    const trimmed = raw?.trim();
    return trimmed ? trimmed.slice(0, 12) : null;
  } catch { return null; }
}

export function savePlayerName(name: string): void {
  const trimmed = name.trim().slice(0, 12);
  try {
    if (trimmed) {
      localStorage.setItem(PLAYER_NAME_KEY, trimmed);
    } else {
      localStorage.removeItem(PLAYER_NAME_KEY);
    }
  } catch { /* ignore quota / disabled storage */ }
}
