import { useState, useMemo, useCallback, useRef } from 'react';
import type { GameState } from '../types/game';
import HexGrid from './HexGrid';
import PlayerHud from './PlayerHud';
import CardHand from './CardHand';
import MarketPanel from './MarketPanel';
import GameLog from './GameLog';
import SettingsPanel from './SettingsPanel';
import { useAnimated } from './SettingsContext';
import * as api from '../api/client';

// Hex geometry constants (must match HexGrid.tsx)
const HEX_SIZE = 32;

interface GameScreenProps {
  gameState: GameState;
  onStateUpdate: (state: GameState) => void;
}

function pixelToAxial(px: number, py: number): { q: number; r: number } {
  const q = ((2 / 3) * px) / HEX_SIZE;
  const r = ((-1 / 3) * px + (Math.sqrt(3) / 3) * py) / HEX_SIZE;
  // Round to nearest hex
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(-q - r);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - (-q - r));
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

export default function GameScreen({ gameState, onStateUpdate }: GameScreenProps) {
  const animated = useAnimated();
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);

  const activePlayerId = gameState.player_order[activePlayerIndex];
  const activePlayer = gameState.players[activePlayerId];
  const phase = gameState.current_phase;

  // Compute which tiles are adjacent to the active player's territory
  const adjacentTiles = useMemo(() => {
    const adj = new Set<string>();
    if (!activePlayer || !gameState.grid) return adj;

    const tiles = gameState.grid.tiles;
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

    for (const [, tile] of Object.entries(tiles)) {
      if (tile.owner === activePlayerId) {
        for (const [dq, dr] of directions) {
          const nk = `${tile.q + dq},${tile.r + dr}`;
          const neighbor = tiles[nk];
          if (neighbor && !neighbor.is_blocked && neighbor.owner !== activePlayerId) {
            adj.add(nk);
          }
        }
      }
    }
    return adj;
  }, [gameState.grid, activePlayerId, activePlayer]);

  const playCardAtTile = useCallback(async (cardIndex: number, q: number, r: number) => {
    if (phase !== 'plan' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    try {
      setError(null);
      const result = await api.playCard(gameState.id, activePlayerId, cardIndex, q, r);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
      setSelectedTile(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [phase, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

  const playCardNoTarget = useCallback(async (cardIndex: number) => {
    if (phase !== 'plan' || !activePlayer) return;
    try {
      setError(null);
      const result = await api.playCard(gameState.id, activePlayerId, cardIndex);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [phase, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

  // Convert screen coords from card drag to hex grid coords
  const handleDragPlay = useCallback((cardIndex: number, screenX: number, screenY: number) => {
    if (!gridContainerRef.current || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Non-targeting cards (engine): just release anywhere on the board
    if (card.card_type === 'engine') {
      const rect = gridContainerRef.current.getBoundingClientRect();
      if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
        playCardNoTarget(cardIndex);
      }
      return;
    }

    // Targeting cards (claim/defense): convert to hex coords
    const rect = gridContainerRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const relX = screenX - centerX;
    const relY = screenY - centerY;
    const { q, r } = pixelToAxial(relX, relY);
    playCardAtTile(cardIndex, q, r);
  }, [activePlayer, playCardAtTile, playCardNoTarget]);

  const handleTileClick = useCallback(async (q: number, r: number) => {
    if (phase !== 'plan' || !activePlayer || selectedCardIndex === null) {
      setSelectedTile(`${q},${r}`);
      return;
    }

    const card = activePlayer.hand[selectedCardIndex];
    if (!card) return;

    if (card.card_type === 'claim' || card.card_type === 'defense') {
      await playCardAtTile(selectedCardIndex, q, r);
    }
  }, [phase, activePlayer, selectedCardIndex, playCardAtTile]);

  const handlePlayEngine = useCallback(async () => {
    if (selectedCardIndex === null) return;
    await playCardNoTarget(selectedCardIndex);
  }, [selectedCardIndex, playCardNoTarget]);

  const handleSubmitPlan = useCallback(async () => {
    try {
      setError(null);
      const result = await api.submitPlan(gameState.id, activePlayerId);
      onStateUpdate(result.state);
      const nextIndex = gameState.player_order.findIndex(
        (pid, i) => i !== activePlayerIndex && !gameState.players[pid].has_submitted_plan,
      );
      if (nextIndex >= 0) setActivePlayerIndex(nextIndex);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate]);

  const handleBuyArchetype = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'archetype', cardId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleBuyNeutral = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'neutral', cardId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleBuyUpgrade = useCallback(async () => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'upgrade');
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleReroll = useCallback(async () => {
    try {
      setError(null);
      const result = await api.rerollMarket(gameState.id, activePlayerId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleEndTurn = useCallback(async () => {
    try {
      setError(null);
      const result = await api.endTurn(gameState.id);
      onStateUpdate(result.state);
      setActivePlayerIndex(0);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, onStateUpdate]);

  const handleSwitchPlayer = useCallback((index: number) => {
    setActivePlayerIndex(index);
    setSelectedCardIndex(null);
    setSelectedTile(null);
    setError(null);
  }, []);

  const selectedCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] : null;

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#1a1a2e', color: '#fff' }}>
      {/* Left panel: players + log + settings */}
      <div style={{ width: 260, padding: 12, borderRight: '1px solid #333', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
            Round {gameState.current_round} · Phase: {phase.replace(/_/g, ' ').toUpperCase()}
          </div>
          {gameState.winner && (
            <div style={{
              padding: 8, background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold',
              transition: animated ? 'all 0.3s' : 'none',
            }}>
              🏆 {gameState.players[gameState.winner]?.name} wins!
            </div>
          )}
        </div>

        {/* Player tabs */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>PLAYERS (click to switch)</div>
          {gameState.player_order.map((pid, i) => (
            <div key={pid} onClick={() => handleSwitchPlayer(i)} style={{ cursor: 'pointer', marginBottom: 6 }}>
              <PlayerHud
                player={gameState.players[pid]}
                isActive={i === activePlayerIndex}
                isCurrent={i === activePlayerIndex}
              />
            </div>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0 }}>
          <GameLog entries={gameState.log} />
        </div>

        <SettingsPanel />
      </div>

      {/* Center: hex grid */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div ref={gridContainerRef} style={{ flex: 1, position: 'relative' }}>
          {gameState.grid && (
            <HexGrid
              tiles={gameState.grid.tiles}
              selectedTile={selectedTile}
              onTileClick={handleTileClick}
              highlightTiles={phase === 'plan' && selectedCard?.card_type === 'claim' ? adjacentTiles : undefined}
            />
          )}
        </div>

        {/* Bottom panel: hand + actions */}
        <div style={{ padding: 12, borderTop: '1px solid #333', maxHeight: '35vh', overflowY: 'auto' }}>
          {error && (
            <div style={{
              color: '#ff4a4a', fontSize: 13, marginBottom: 8,
              padding: '4px 8px', background: '#ff4a4a22', borderRadius: 4,
              transition: animated ? 'opacity 0.2s' : 'none',
            }}>
              {error}
            </div>
          )}

          {phase === 'plan' && activePlayer && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, color: '#aaa' }}>
                  {activePlayer.name}'s turn — drag a card onto the board, or select + click
                </span>
                {selectedCard?.card_type === 'engine' && (
                  <button
                    onClick={handlePlayEngine}
                    style={{
                      padding: '4px 12px',
                      background: '#4a9eff',
                      border: 'none',
                      borderRadius: 4,
                      color: '#fff',
                      cursor: 'pointer',
                      fontSize: 13,
                    }}
                  >
                    Play {selectedCard.name}
                  </button>
                )}
                <button
                  onClick={handleSubmitPlan}
                  style={{
                    marginLeft: 'auto',
                    padding: '6px 16px',
                    background: '#4aff6a',
                    border: 'none',
                    borderRadius: 4,
                    color: '#000',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  Submit Plan ✓
                </button>
              </div>
              <CardHand
                cards={activePlayer.hand}
                selectedIndex={selectedCardIndex}
                onSelect={setSelectedCardIndex}
                onDragPlay={handleDragPlay}
                disabled={activePlayer.has_submitted_plan}
              />
            </div>
          )}

          {phase === 'buy' && activePlayer && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#aaa' }}>
                  {activePlayer.name}'s Buy Phase — 💰 {activePlayer.resources} resources
                </span>
                <button
                  onClick={handleEndTurn}
                  style={{
                    marginLeft: 'auto',
                    padding: '6px 16px',
                    background: '#ff8844',
                    border: 'none',
                    borderRadius: 4,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                  }}
                >
                  End Turn →
                </button>
              </div>
              <MarketPanel
                archetypeMarket={activePlayer.archetype_market}
                neutralMarket={gameState.neutral_market}
                playerResources={activePlayer.resources}
                onBuyArchetype={handleBuyArchetype}
                onBuyNeutral={handleBuyNeutral}
                onBuyUpgrade={handleBuyUpgrade}
                onReroll={handleReroll}
                disabled={false}
              />
            </div>
          )}

          {phase === 'reveal' && (
            <div style={{ color: '#aaa', fontSize: 14 }}>
              Resolving claims and effects...
            </div>
          )}

          {phase === 'game_over' && (
            <div style={{ textAlign: 'center', padding: 20 }}>
              <h2>Game Over!</h2>
              {gameState.winner && (
                <p>{gameState.players[gameState.winner]?.name} wins with{' '}
                  {gameState.players[gameState.winner]?.vp} VP!</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
