import { useState, useCallback, useEffect, useRef } from 'react';
import type { GameState, LobbyState } from './types/game';
import { SettingsProvider } from './components/SettingsContext';
import SetupScreen from './components/SetupScreen';
import GameScreen from './components/GameScreen';
import LobbyScreen from './components/LobbyScreen';
import VpPathPreview from './components/VpPathPreview';
import { useWebSocket } from './hooks/useWebSocket';
import * as api from './api/client';

// Check for ?preview= query parameter
const urlParams = new URLSearchParams(window.location.search);
const previewMode = urlParams.get('preview');

// Session storage keys
const SS_LOBBY = 'cardclash_lobby';

type AppScreen =
  | { type: 'home' }
  | { type: 'lobby'; code: string; playerId: string; token: string; isHost: boolean; lobby: LobbyState }
  | { type: 'game'; gameId: string; playerId: string; token: string; isMultiplayer: boolean; lobbyCode?: string; isHost?: boolean; localPlayerIds?: string[] };

function loadSession(): AppScreen | null {
  try {
    const raw = sessionStorage.getItem(SS_LOBBY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.type === 'lobby' || data.type === 'game') return data;
  } catch { /* ignore */ }
  return null;
}

function saveSession(screen: AppScreen | null) {
  if (screen && screen.type !== 'home') {
    sessionStorage.setItem(SS_LOBBY, JSON.stringify(screen));
  } else {
    sessionStorage.removeItem(SS_LOBBY);
  }
}

export default function App() {
  const [error, setError] = useState<string | null>(null);

  // Multiplayer state machine — restore from session storage on mount
  const [screen, setScreen] = useState<AppScreen>(() => {
    const saved = loadSession();
    if (saved) {
      // Restore auth token if we have one
      if ('token' in saved && saved.token) {
        api.setAuthToken(saved.token);
      }
      return saved;
    }
    return { type: 'home' };
  });
  const [multiplayerGameState, setMultiplayerGameState] = useState<GameState | null>(null);
  const [replayVotes, setReplayVotes] = useState<Set<string>>(new Set());
  const [replayDisabled, setReplayDisabled] = useState(false);
  // Track if this session was restored from storage (skip intro on reconnect)
  const [isReconnect, setIsReconnect] = useState(() => !!loadSession());

  // WebSocket for multiplayer game (not lobby — lobby manages its own)
  const gameLobbyCode = screen.type === 'game' && screen.isMultiplayer ? (screen.lobbyCode ?? null) : null;
  const wsPlayerId = screen.type === 'game' && screen.isMultiplayer ? screen.playerId : null;
  const wsToken = screen.type === 'game' && screen.isMultiplayer ? screen.token : null;

  const { lastMessage: gameWsMessage } = useWebSocket(
    gameLobbyCode,
    wsPlayerId,
    wsToken,
  );

  // Handle WebSocket game state updates
  useEffect(() => {
    if (!gameWsMessage || screen.type !== 'game' || !screen.isMultiplayer) return;
    console.log('[App] game WS effect:', gameWsMessage.type, 'screen:', screen.type, 'gameId:', screen.gameId);

    if (gameWsMessage.type === 'game_state') {
      setMultiplayerGameState(gameWsMessage.state as unknown as GameState);
    } else if (gameWsMessage.type === 'game_ended') {
      // Verify this game_ended is for our current game by checking the game_id if present,
      // or at minimum that we're still in a game screen (guard against stale WS messages)
      const msgGameId = gameWsMessage.game_id as string | undefined;
      if (msgGameId && msgGameId !== screen.gameId) {
        console.warn('[App] game_ended IGNORED — stale message for', msgGameId, 'but current game is', screen.gameId);
        return;
      }
      console.log('[App] game_ended → going home');
      setScreen({ type: 'home' });
      setMultiplayerGameState(null);
      setReplayVotes(new Set());
      setReplayDisabled(false);
      saveSession(null);
    } else if (gameWsMessage.type === 'game_start') {
      // Replay restart — new game created with same players
      const newGameId = gameWsMessage.game_id as string;
      const newState = gameWsMessage.state as unknown as GameState;
      setMultiplayerGameState(newState);
      setReplayVotes(new Set());
      setReplayDisabled(false);
      setIsReconnect(false);
      if (screen.type === 'game') {
        setScreen({
          ...screen,
          gameId: newGameId,
        });
      }
    } else if (gameWsMessage.type === 'replay_vote') {
      const votes = (gameWsMessage.votes as string[]) || [];
      setReplayVotes(new Set(votes));
    } else if (gameWsMessage.type === 'replay_disabled') {
      setReplayDisabled(true);
    }
  }, [gameWsMessage, screen]);

  // Save screen to session storage
  useEffect(() => {
    saveSession(screen);
  }, [screen]);

  // Reconnection: if we restored a game screen from session but have no game state, fetch it
  const reconnectAttempted = useRef(false);
  useEffect(() => {
    if (reconnectAttempted.current) return;
    if (screen.type === 'game' && screen.isMultiplayer && !multiplayerGameState) {
      reconnectAttempted.current = true;
      console.log('[App] reconnect: fetching game state for', screen.gameId);
      api.getGame(screen.gameId, screen.playerId)
        .then((state) => setMultiplayerGameState(state))
        .catch(() => {
          // Game no longer exists — return to home
          console.log('[App] reconnect FAILED → going home');
          setScreen({ type: 'home' });
          api.setAuthToken(null);
          saveSession(null);
        });
    } else if (screen.type === 'lobby') {
      reconnectAttempted.current = true;
      // Lobby reconnection — WebSocket will reconnect automatically via LobbyScreen
      // Just verify the lobby still exists
      api.getLobby(screen.code, screen.playerId, screen.token)
        .catch(() => {
          setScreen({ type: 'home' });
          api.setAuthToken(null);
          saveSession(null);
        });
    }
  }, []); // Only run once on mount

  // ── Multiplayer flow ─────────────────────────────────────

  const handleCreateLobby = useCallback(async () => {
    try {
      setError(null);
      const result = await api.createLobby('Player 1', 'vanguard');  // First player is always #1
      api.setAuthToken(result.token);
      const lobbyScreen: AppScreen = {
        type: 'lobby',
        code: result.code,
        playerId: result.player_id,
        token: result.token,
        isHost: true,
        lobby: result.lobby,
      };
      setScreen(lobbyScreen);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleJoinLobby = useCallback(async (code: string) => {
    setError(null);
    const result = await api.joinLobby(code.toUpperCase(), 'Player', 'vanguard');
    api.setAuthToken(result.token);
    const lobbyScreen: AppScreen = {
      type: 'lobby',
      code: code.toUpperCase(),
      playerId: result.player_id,
      token: result.token,
      isHost: false,
      lobby: result.lobby,
    };
    setScreen(lobbyScreen);
  }, []);

  const handleGameStart = useCallback((gameId: string, state: GameState, localPlayerIds?: string[]) => {
    console.log('[App] handleGameStart called, screen.type:', screen.type, 'gameId:', gameId);
    if (screen.type !== 'lobby') {
      console.warn('[App] handleGameStart SKIPPED — screen is not lobby, it is:', screen.type);
      return;
    }
    setMultiplayerGameState(state);
    setIsReconnect(false); // New game from lobby — show intro
    const gameScreen: AppScreen = {
      type: 'game',
      gameId,
      playerId: screen.playerId,
      token: screen.token,
      isMultiplayer: true,
      lobbyCode: screen.code,
      isHost: screen.isHost,
      localPlayerIds,
    };
    setScreen(gameScreen);
  }, [screen]);

  const handleLeaveLobby = useCallback(() => {
    setScreen({ type: 'home' });
    api.setAuthToken(null);
    saveSession(null);
  }, []);

  const handleLeaveGame = useCallback(() => {
    console.log('[App] handleLeaveGame → going home');
    setScreen({ type: 'home' });
    setMultiplayerGameState(null);
    setReplayVotes(new Set());
    setReplayDisabled(false);
    api.setAuthToken(null);
    saveSession(null);
  }, []);

  const handleMultiplayerStateUpdate = useCallback((state: GameState) => {
    setMultiplayerGameState(state);
  }, []);

  // Preview modes (accessible via ?preview=vp-paths)
  if (previewMode === 'vp-paths') {
    return (
      <SettingsProvider>
        <VpPathPreview />
      </SettingsProvider>
    );
  }

  // ── Render ───────────────────────────────────────────────
  console.log('[App] render — screen:', screen.type, 'hasGameState:', !!multiplayerGameState);

  // Lobby
  if (screen.type === 'lobby') {
    return (
      <SettingsProvider>
        <LobbyScreen
          lobbyCode={screen.code}
          playerId={screen.playerId}
          token={screen.token}
          isHost={screen.isHost}
          initialLobby={screen.lobby}
          onGameStart={handleGameStart}
          onLeave={handleLeaveLobby}
        />
      </SettingsProvider>
    );
  }

  // Game in progress
  if (screen.type === 'game' && screen.isMultiplayer) {
    if (!multiplayerGameState) {
      // Brief loading state while game state is being set — prevents flashing home screen
      return (
        <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ color: '#666', fontSize: 14 }}>Loading game…</div>
        </div>
      );
    }
    return (
      <SettingsProvider>
        <GameScreen
          gameState={multiplayerGameState}
          onStateUpdate={handleMultiplayerStateUpdate}
          playerId={screen.playerId}
          token={screen.token}
          isMultiplayer={true}
          localPlayerIds={screen.localPlayerIds}
          isHost={
            (() => { try { const s = JSON.parse(sessionStorage.getItem(SS_LOBBY) || '{}'); return s.isHost; } catch { return false; } })()
          }
          onLeaveGame={handleLeaveGame}
          skipIntro={isReconnect}
          replayVotes={replayVotes}
          replayDisabled={replayDisabled}
          onReplayVotesUpdate={setReplayVotes}
        />
      </SettingsProvider>
    );
  }

  // Home screen
  return (
    <SettingsProvider>
      <div style={{ background: '#1a1a2e', color: '#fff', minHeight: '100vh' }}>
        <SetupScreen
          onCreateLobby={handleCreateLobby}
          onJoinLobby={handleJoinLobby}
        />
        {error && (
          <div style={{ textAlign: 'center', color: '#ff4a4a', padding: 12 }}>{error}</div>
        )}
      </div>
    </SettingsProvider>
  );
}
