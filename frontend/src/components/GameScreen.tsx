import { useState, useMemo, useCallback } from 'react';
import type { GameState, Card } from '../types/game';
import HexGrid from './HexGrid';
import PlayerHud from './PlayerHud';
import CardHand from './CardHand';
import MarketPanel from './MarketPanel';
import GameLog from './GameLog';
import * as api from '../api/client';

interface GameScreenProps {
  gameState: GameState;
  onStateUpdate: (state: GameState) => void;
}

export default function GameScreen({ gameState, onStateUpdate }: GameScreenProps) {
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [selectedTile, setSelectedTile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activePlayerId = gameState.player_order[activePlayerIndex];
  const activePlayer = gameState.players[activePlayerId];
  const phase = gameState.current_phase;

  // Compute which tiles are adjacent to the active player's territory
  const adjacentTiles = useMemo(() => {
    const adj = new Set<string>();
    if (!activePlayer || !gameState.grid) return adj;

    const tiles = gameState.grid.tiles;
    const directions = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

    for (const [key, tile] of Object.entries(tiles)) {
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

  const handleTileClick = useCallback(async (q: number, r: number) => {
    if (phase !== 'plan' || !activePlayer || selectedCardIndex === null) {
      setSelectedTile(`${q},${r}`);
      return;
    }

    const card = activePlayer.hand[selectedCardIndex];
    if (!card) return;

    // For claim cards, play onto the clicked tile
    if (card.card_type === 'claim') {
      try {
        setError(null);
        const result = await api.playCard(
          gameState.id, activePlayerId, selectedCardIndex, q, r,
        );
        onStateUpdate(result.state);
        setSelectedCardIndex(null);
        setSelectedTile(null);
      } catch (e: any) {
        setError(e.message);
      }
    } else if (card.card_type === 'defense') {
      // Defense cards target own tiles
      try {
        setError(null);
        const result = await api.playCard(
          gameState.id, activePlayerId, selectedCardIndex, q, r,
        );
        onStateUpdate(result.state);
        setSelectedCardIndex(null);
      } catch (e: any) {
        setError(e.message);
      }
    }
  }, [phase, activePlayer, selectedCardIndex, gameState.id, activePlayerId, onStateUpdate]);

  const handlePlayEngine = useCallback(async () => {
    if (selectedCardIndex === null || !activePlayer) return;
    const card = activePlayer.hand[selectedCardIndex];
    if (!card || card.card_type !== 'engine') return;

    try {
      setError(null);
      const result = await api.playCard(
        gameState.id, activePlayerId, selectedCardIndex,
      );
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [selectedCardIndex, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

  const handleSubmitPlan = useCallback(async () => {
    try {
      setError(null);
      const result = await api.submitPlan(gameState.id, activePlayerId);
      onStateUpdate(result.state);
      // Switch to next player who hasn't submitted
      const nextIndex = gameState.player_order.findIndex(
        (pid, i) => i !== activePlayerIndex && !gameState.players[pid].has_submitted_plan,
      );
      if (nextIndex >= 0) {
        setActivePlayerIndex(nextIndex);
      }
      setSelectedCardIndex(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate]);

  const handleBuyArchetype = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'archetype', cardId);
      onStateUpdate(result.state);
    } catch (e: any) {
      setError(e.message);
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleBuyNeutral = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'neutral', cardId);
      onStateUpdate(result.state);
    } catch (e: any) {
      setError(e.message);
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleBuyUpgrade = useCallback(async () => {
    try {
      setError(null);
      const result = await api.buyCard(gameState.id, activePlayerId, 'upgrade');
      onStateUpdate(result.state);
    } catch (e: any) {
      setError(e.message);
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleReroll = useCallback(async () => {
    try {
      setError(null);
      const result = await api.rerollMarket(gameState.id, activePlayerId);
      onStateUpdate(result.state);
    } catch (e: any) {
      setError(e.message);
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleEndTurn = useCallback(async () => {
    try {
      setError(null);
      const result = await api.endTurn(gameState.id);
      onStateUpdate(result.state);
      setActivePlayerIndex(0);
      setSelectedCardIndex(null);
    } catch (e: any) {
      setError(e.message);
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
      {/* Left panel: players + log */}
      <div style={{ width: 260, padding: 12, borderRight: '1px solid #333', overflowY: 'auto' }}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>
            Round {gameState.current_round} · Phase: {phase.replace(/_/g, ' ').toUpperCase()}
          </div>
          {gameState.winner && (
            <div style={{ padding: 8, background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold' }}>
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

        <GameLog entries={gameState.log} />
      </div>

      {/* Center: hex grid */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, position: 'relative' }}>
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
            <div style={{ color: '#ff4a4a', fontSize: 13, marginBottom: 8, padding: '4px 8px', background: '#ff4a4a22', borderRadius: 4 }}>
              {error}
            </div>
          )}

          {phase === 'plan' && activePlayer && (
            <div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: '#aaa' }}>
                  {activePlayer.name}'s turn — select a card, then click a tile
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
