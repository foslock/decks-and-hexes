import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { GameState, Card } from '../types/game';
import HexGrid, { type GridTransform } from './HexGrid';
import PlayerHud from './PlayerHud';
import CardHand from './CardHand';
import CardDetail from './CardDetail';
import MarketPanel from './MarketPanel';
import GameLog from './GameLog';
import FullGameLog from './FullGameLog';
import SettingsPanel from './SettingsPanel';
import { useAnimated } from './SettingsContext';
import { IrreversibleButton } from './Tooltip';
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
  const [draggingCardIndex, setDraggingCardIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailCard, setDetailCard] = useState<Card | null>(null);
  const [showFullLog, setShowFullLog] = useState(false);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const gridTransformRef = useRef<GridTransform | null>(null);

  // Auto-dismiss error toast after 4 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error]);

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

    // Targeting cards (claim/defense): convert screen → canvas → hex-local → axial
    const rect = gridContainerRef.current.getBoundingClientRect();
    const canvasX = screenX - rect.left;
    const canvasY = screenY - rect.top;
    const transform = gridTransformRef.current;
    if (!transform) return;
    const localX = (canvasX - transform.offsetX) / transform.scale;
    const localY = (canvasY - transform.offsetY) / transform.scale;
    const { q, r } = pixelToAxial(localX, localY);

    // Validate claim card restrictions
    if (card.card_type === 'claim') {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (tile && !tile.owner && tile.base_defense > card.power) {
        setError(`${card.name} (power ${card.power}) is too weak to capture this tile (defense ${tile.base_defense})`);
        return;
      }
      if (tile && tile.owner && card.unoccupied_only) {
        setError(`${card.name} can only target unoccupied tiles`);
        return;
      }
    }

    playCardAtTile(cardIndex, q, r);
  }, [activePlayer, gameState.grid, playCardAtTile, playCardNoTarget]);

  const handleTileClick = useCallback(async (q: number, r: number) => {
    if (phase !== 'plan' || !activePlayer || selectedCardIndex === null) {
      return;
    }

    const card = activePlayer.hand[selectedCardIndex];
    if (!card) return;

    if (card.card_type === 'claim' || card.card_type === 'defense') {
      // Validate claim card restrictions
      if (card.card_type === 'claim') {
        const tileKey = `${q},${r}`;
        const tile = gameState.grid?.tiles[tileKey];
        if (tile && !tile.owner && tile.base_defense > card.power) {
          setError(`${card.name} (power ${card.power}) is too weak to capture this tile (defense ${tile.base_defense})`);
          return;
        }
        if (tile && tile.owner && card.unoccupied_only) {
          setError(`${card.name} can only target unoccupied tiles`);
          return;
        }
      }
      await playCardAtTile(selectedCardIndex, q, r);
    }
  }, [phase, activePlayer, selectedCardIndex, gameState.grid, playCardAtTile]);

  const handlePlayEngine = useCallback(async () => {
    if (selectedCardIndex === null) return;
    await playCardNoTarget(selectedCardIndex);
  }, [selectedCardIndex, playCardNoTarget]);

  const handleSubmitPlan = useCallback(async () => {
    // Warn if player still has cards and unused actions (and hasn't hit the cap)
    if (activePlayer) {
      const hasCardsLeft = activePlayer.hand.length > 0;
      const actionsLeft = activePlayer.actions_available - activePlayer.actions_used;
      const atCap = activePlayer.actions_used >= 6;
      if (hasCardsLeft && actionsLeft > 0 && !atCap) {
        const ok = window.confirm(
          `${activePlayer.name} still has ${activePlayer.hand.length} card(s) in hand and ${actionsLeft} action(s) remaining. Submit plan anyway?`
        );
        if (!ok) return;
      }
    }
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
  }, [gameState, activePlayer, activePlayerId, activePlayerIndex, onStateUpdate]);

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
    setError(null);
  }, []);

  const selectedCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] : null;

  // Filter adjacent tiles to only those a given claim card can actually capture
  const getValidClaimTiles = useCallback((card: Card | null | undefined): Set<string> => {
    if (!card || card.card_type !== 'claim') return adjacentTiles;
    const valid = new Set<string>();
    const tiles = gameState.grid?.tiles;
    if (!tiles) return valid;
    for (const key of adjacentTiles) {
      const tile = tiles[key];
      // Exclude neutral tiles with base_defense higher than card power
      if (tile && !tile.owner && tile.base_defense > card.power) continue;
      // Exclude owned tiles for unoccupied_only cards (e.g. Explore)
      if (tile && tile.owner && card.unoccupied_only) continue;
      valid.add(key);
    }
    return valid;
  }, [adjacentTiles, gameState.grid?.tiles]);

  const playerInfo = useMemo(() => {
    const info: Record<string, { name: string; archetype: string }> = {};
    for (const [pid, p] of Object.entries(gameState.players)) {
      info[pid] = { name: p.name, archetype: p.archetype };
    }
    return info;
  }, [gameState.players]);

  // Build planned action icons map for the active player
  const plannedActions = useMemo(() => {
    if (!activePlayer?.planned_actions) return undefined;
    const map = new Map<string, { type: string; power: number }>();
    for (const action of activePlayer.planned_actions) {
      if (action.target_q != null && action.target_r != null) {
        const key = `${action.target_q},${action.target_r}`;
        const type = action.card.card_type;
        const power = type === 'defense' ? action.card.defense_bonus : action.card.power;
        map.set(key, { type, power });
      }
    }
    return map.size > 0 ? map : undefined;
  }, [activePlayer?.planned_actions]);

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

        <button
          onClick={() => setShowFullLog(true)}
          style={{
            width: '100%',
            padding: '6px 0',
            margin: '8px 0',
            background: '#2a2a3e',
            border: '1px solid #444',
            borderRadius: 4,
            color: '#aaa',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Full Game Log
        </button>

        <SettingsPanel />
      </div>

      {/* Center: hex grid + overlays */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div ref={gridContainerRef} style={{ flex: 1, position: 'relative' }}>
          {gameState.grid && (
            <HexGrid
              tiles={gameState.grid.tiles}
              onTileClick={handleTileClick}
              highlightTiles={
                phase === 'plan' && (
                  selectedCard?.card_type === 'claim' ||
                  (draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'claim')
                ) ? getValidClaimTiles(
                  selectedCard?.card_type === 'claim' ? selectedCard :
                  draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] : null
                ) : undefined
              }
              borderTiles={phase === 'plan' ? adjacentTiles : undefined}
              playerInfo={playerInfo}
              transformRef={gridTransformRef}
              activePlayerId={phase === 'plan' ? activePlayerId : undefined}
              plannedActions={phase === 'plan' ? plannedActions : undefined}
            />
          )}

          {/* Toasts — floating above the hand panel */}
          <div style={{ position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, zIndex: 20, pointerEvents: 'none' }}>
            {phase === 'plan' && activePlayer && !activePlayer.has_submitted_plan && (
              <div style={{
                fontSize: 12,
                padding: '4px 14px',
                background: '#ffffff11',
                border: '1px solid #ffffff22',
                borderRadius: 6,
                color: '#888',
                whiteSpace: 'nowrap',
              }}>
                {activePlayer.name}'s turn — drag a card onto the board, or select + click
              </div>
            )}
            {error && (
              <div style={{
                fontSize: 13,
                padding: '6px 16px',
                background: '#ff4a4a22',
                border: '1px solid #ff4a4a55',
                borderRadius: 6,
                color: '#ff4a4a',
                whiteSpace: 'nowrap',
              }}>
                {error}
              </div>
            )}
          </div>

          {/* Action buttons — floating bottom-right of board */}
          <div style={{ position: 'absolute', bottom: 12, right: 12, display: 'flex', gap: 8, zIndex: 20 }}>
            {phase === 'plan' && activePlayer && selectedCard?.card_type === 'engine' && (
              <IrreversibleButton
                onClick={handlePlayEngine}
                tooltip="Playing a card uses an action and cannot be undone."
                style={{
                  padding: '6px 14px',
                  background: '#4a9eff',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                Play {selectedCard.name}
              </IrreversibleButton>
            )}
            {phase === 'plan' && activePlayer && (() => {
              const hasCardsLeft = activePlayer.hand.length > 0;
              const actionsLeft = activePlayer.actions_available - activePlayer.actions_used;
              const atCap = activePlayer.actions_used >= 6;
              const canStillPlay = hasCardsLeft && actionsLeft > 0 && !atCap;
              return (
                <IrreversibleButton
                  onClick={handleSubmitPlan}
                  tooltip={canStillPlay
                    ? "You still have cards and actions remaining. Are you sure?"
                    : "Submitting locks your plan for this round. You cannot change it after."
                  }
                  style={{
                    padding: '6px 16px',
                    background: canStillPlay ? '#ff8844' : '#2a9a3e',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                >
                  Submit Plan{canStillPlay ? '' : ' ✓'}
                </IrreversibleButton>
              );
            })()}
            {phase === 'buy' && activePlayer && (
              <IrreversibleButton
                onClick={handleEndTurn}
                tooltip="Ending the turn advances to the next round. Any unspent resources carry over."
                style={{
                  padding: '6px 16px',
                  background: '#ff8844',
                  border: 'none',
                  borderRadius: 6,
                  color: '#fff',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                }}
              >
                End Turn →
              </IrreversibleButton>
            )}
          </div>
        </div>

        {/* Bottom panel: hand / market */}
        <div style={{ padding: '8px 12px', borderTop: '1px solid #333', maxHeight: '30vh', overflowY: 'auto' }}>
          {phase === 'plan' && activePlayer && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <CardHand
                cards={activePlayer.hand}
                selectedIndex={selectedCardIndex}
                onSelect={setSelectedCardIndex}
                onDragPlay={handleDragPlay}
                onCardDetail={setDetailCard}
                onDragStart={setDraggingCardIndex}
                onDragEnd={() => setDraggingCardIndex(null)}
                disabled={activePlayer.has_submitted_plan}
              />
            </div>
          )}

          {phase === 'buy' && activePlayer && (
            <div>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 6, textAlign: 'center' }}>
                {activePlayer.name}'s Buy Phase — 💰 {activePlayer.resources} resources
              </div>
              <MarketPanel
                archetypeMarket={activePlayer.archetype_market}
                neutralMarket={gameState.neutral_market}
                playerResources={activePlayer.resources}
                onBuyArchetype={handleBuyArchetype}
                onBuyNeutral={handleBuyNeutral}
                onBuyUpgrade={handleBuyUpgrade}
                onReroll={handleReroll}
                onCardDetail={setDetailCard}
                disabled={false}
              />
            </div>
          )}

          {phase === 'reveal' && (
            <div style={{ color: '#aaa', fontSize: 14, textAlign: 'center' }}>
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

      {/* Card detail modal */}
      {detailCard && (
        <CardDetail card={detailCard} onClose={() => setDetailCard(null)} />
      )}

      {/* Full game log modal */}
      {showFullLog && (
        <FullGameLog
          gameId={gameState.id}
          playerId={activePlayerId}
          onClose={() => setShowFullLog(false)}
        />
      )}
    </div>
  );
}
