import { useState } from 'react';
import type { GameState } from './types/game';
import { SettingsProvider } from './components/SettingsContext';
import SetupScreen from './components/SetupScreen';
import GameScreen from './components/GameScreen';
import VpPathPreview from './components/VpPathPreview';
import * as api from './api/client';

// Check for ?preview= query parameter
const urlParams = new URLSearchParams(window.location.search);
const previewMode = urlParams.get('preview');

export default function App() {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async (config: {
    gridSize: string;
    players: { id: string; name: string; archetype: string }[];
    testMode?: boolean;
    speed?: string;
  }) => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.createGame(config.gridSize, config.players, undefined, config.testMode, config.speed);
      setGameState(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Preview modes (accessible via ?preview=vp-paths)
  if (previewMode === 'vp-paths') {
    return (
      <SettingsProvider>
        <VpPathPreview />
      </SettingsProvider>
    );
  }

  return (
    <SettingsProvider>
      {!gameState ? (
        <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100vh' }}>
          <SetupScreen onStart={handleStart} />
          {loading && (
            <div style={{ textAlign: 'center', color: '#aaa' }}>Creating game...</div>
          )}
          {error && (
            <div style={{ textAlign: 'center', color: '#ff4a4a', padding: 12 }}>{error}</div>
          )}
        </div>
      ) : (
        <GameScreen gameState={gameState} onStateUpdate={setGameState} />
      )}
    </SettingsProvider>
  );
}
