import { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import type { GameState, Card, ResolutionStep, PlayerEffect, CursorPosition, SharedPurchaseEvent, PendingSearch, SearchSelection, SearchZoneTarget } from '../types/game';
import GameBoard, { type BoardControls, type BoardFx, type PlannedActionIcon, type ClaimChevron, type VpPath, PLAYER_COLORS, syncPlayerColors, computeStackingPowerBonus } from './GameBoard';
import PlayerHud from './PlayerHud';
import ResourceCounter, { type ResourceCounterHandle, type ResourceSource } from './ResourceCounter';
import CardHand, { CardViewPopup, type PlayTarget, type DragTargetInfo, type UndoReturn, type IncomingDiscard } from './CardHand';
import CardBrowser from './CardBrowser';
import ShopOverlay, { PurchaseFlyAnimation } from './ShopOverlay';
import PileSearchModal from './PileSearchModal';
import PileSearchFlyAnimation, { type SearchFlight } from './PileSearchFlyAnimation';
import FullGameLog from './FullGameLog';
import SettingsPanel from './SettingsPanel';
import PhaseBanner from './PhaseBanner';
import ResolveOverlay from './ResolveOverlay';
import PlayerEffectPopups from './PlayerEffectPopups';
import GameIntroOverlay from './GameIntroOverlay';
import GameOverOverlay from './GameOverOverlay';
import { useAnimated, useAnimationMode, useAnimationOff, useAnimationSpeed, useResolveSpeed } from './SettingsContext';
import Tooltip, { IrreversibleButton, HoldToSubmitButton, type HoldToSubmitHandle } from './Tooltip';
import * as api from '../api/client';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import { buildCardSubtitle, type CardSubtitleContext, type SubtitlePart } from './cardSubtitle';
import { plainCardName } from './CardName';
import CompactCardFace from './CompactCardFace';
import { TileCardStack, EngineQueue, CardDetailOverlay, boardCardScale, fanOffset, QUEUE_CARD_SCALE, type BoardCardEntry } from './BoardCards';
import FlightCard, { type Flight } from './hand/FlightCard';
import TrashBurn from './hand/TrashBurn';
import { discardTopSpin } from './hand/CardPile';
import { CARD_H, CARD_W, PILE_SCALE, PILE_TILT, easeInOut, elementCenter, flightKeyframes, poseTransform, type Pose } from './hand/cardMotion';
import { handSizing, handStripHeight, REST_VISIBLE } from './hand/handLayout';
import Icon from '../icons/Icon';
import { IconValue, Num } from '../icons/Num';
import { useSound } from '../audio/useSound';
import { useCardZoom } from './CardZoomContext';
import { computeVpBreakdown, computeTileBasedVp } from '../utils/vpBreakdown';
import { preloadCardImages } from '../utils/cardImagePreload';
import { preloadCatalogArt, useCardCatalog } from '../cardCatalog';

/** Check if an engine card needs an opponent target (forced discard or inject rubble). */
function needsOpponentTarget(card: Card): boolean {
  const isUpgraded = card.is_upgraded;
  const grantsActionsToOpponent = card.effects?.some(e => {
    if (e.type !== 'grant_actions_next_turn' || e.target !== 'chosen_player') return false;
    const val = isUpgraded && e.upgraded_value != null ? e.upgraded_value : e.value;
    return val > 0;
  }) ?? false;
  return (card.forced_discard > 0) ||
    (card.effects?.some(e => e.type === 'inject_rubble') ?? false) ||
    grantsActionsToOpponent;
}

/**
 * Compute effective power for a card still in hand, accounting for dynamic
 * modifiers (hand-size scaling, tile-count scaling, and Strike Team's
 * if_played_claim_this_turn bonus).  Returns a copy of the card with `power`
 * overridden if applicable.  Used only for the drag/hover preview — once a
 * card is played, the backend snapshots effective_power on the PlannedAction
 * and the frontend uses that instead.
 */
function withEffectivePower(
  card: Card,
  handSize: number,
  tileCount: number,
  hasPlayedClaim: boolean = false,
): Card {
  if (!card.effects) return card;
  const isUpgraded = card.is_upgraded;

  let strikeTeamBonus = 0;
  for (const eff of card.effects) {
    if (eff.type === 'power_per_tiles_owned') {
      const divisor = (isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value) || 3;
      const scaledPow = Math.floor(tileCount / divisor);
      const totalPow = eff.metadata?.replaces_base_power ? scaledPow : card.power + scaledPow;
      return { ...card, power: totalPow + strikeTeamBonus };
    }
    if (eff.type === 'power_modifier' && eff.condition === 'cards_in_hand') {
      const ev = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
      return { ...card, power: Math.max(0, handSize - 1) + ev + strikeTeamBonus };
    }
    if (
      eff.type === 'power_modifier' &&
      eff.condition === 'if_played_claim_this_turn' &&
      hasPlayedClaim
    ) {
      strikeTeamBonus +=
        isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : eff.value;
    }
  }

  if (strikeTeamBonus > 0) return { ...card, power: card.power + strikeTeamBonus };
  return card;
}

/**
 * Compute the effective claim power for a card targeting a specific tile.
 * Handles all dynamic power sources used by the validation paths:
 *   - power_per_tiles_owned (Mob Rule, Power in Numbers)
 *   - power_modifier with condition cards_in_hand (Strength in Numbers)
 *   - power_modifier with condition if_target_neutral (Pioneer, etc.)
 *   - power_modifier with condition if_adjacent_owned_gte (Encirclement, etc.)
 * Mirrors the backend `effects.compute_effective_power` for the conditions
 * the frontend can determine before play.  Pass the player's current hand
 * size and owned-tile count to drive scaling effects.
 */
function computeClaimPowerOnTile(
  card: Card,
  tile: import('../types/game').HexTile,
  tiles: Record<string, import('../types/game').HexTile>,
  activePlayerId: string,
  handSize: number,
  ownedTileCount: number,
  claimBuffBonus: number = 0,
  hasPlayedClaim: boolean = false,
): number {
  // Start from base power, then apply tile-count / hand-size scaling that
  // doesn't depend on the target tile (and Strike Team's played-claim bonus).
  let power = withEffectivePower(card, handSize, ownedTileCount, hasPlayedClaim).power;
  // War Banner: preview the +power bonus the next Claim will consume.
  power += claimBuffBonus;
  if (!card.effects) return power;
  const isUpgraded = card.is_upgraded;
  for (const eff of card.effects) {
    if (eff.type !== 'power_modifier') continue;
    const mod = isUpgraded && eff.upgraded_value != null ? eff.upgraded_value : (eff.value ?? 0);
    if (eff.condition === 'if_target_neutral' && !tile.owner) power += mod;
    // Road Builder: bonus when the tile joins two of your disconnected groups
    if (eff.condition === 'if_bridges_territory' && tileBridgesTerritory(tile, tiles, activePlayerId)) power += mod;
    if (eff.condition === 'if_adjacent_owned_gte') {
      const threshold = eff.condition_threshold ?? 3;
      let adjOwned = 0;
      for (const [dq, dr] of HEX_DIRS) {
        const nk = `${tile.q + dq},${tile.r + dr}`;
        if (tiles[nk]?.owner === activePlayerId) adjOwned++;
      }
      if (eff.metadata?.per_tile) {
        power += mod * adjOwned;
      } else if (adjOwned >= threshold) {
        power += mod;
      }
    }
  }
  return power;
}

/**
 * True if claiming `tile` would connect two or more currently disconnected
 * groups of `playerId`'s tiles (mirrors backend `tile_bridges_territory`).
 */
function tileBridgesTerritory(
  tile: import('../types/game').HexTile,
  tiles: Record<string, import('../types/game').HexTile>,
  playerId: string,
): boolean {
  const owned = new Set(Object.keys(tiles).filter(k => tiles[k].owner === playerId));
  const starts: string[] = [];
  for (const [dq, dr] of HEX_DIRS) {
    const nk = `${tile.q + dq},${tile.r + dr}`;
    if (owned.has(nk)) starts.push(nk);
  }
  if (starts.length < 2) return false;
  const visited = new Set<string>();
  let groups = 0;
  for (const start of starts) {
    if (visited.has(start)) continue;
    if (++groups >= 2) return true;
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const [cq, cr] = queue.pop()!.split(',').map(Number);
      for (const [dq, dr] of HEX_DIRS) {
        const nk = `${cq + dq},${cr + dr}`;
        if (!visited.has(nk) && owned.has(nk)) {
          visited.add(nk);
          queue.push(nk);
        }
      }
    }
  }
  return false;
}

/**
 * Returns true if a claim card with the given effective power can capture the
 * target tile under the validation rules:
 *   - Siege Engine / Conqueror (`ignore_defense` effect): only strips temporary
 *     round bonuses; base + permanent defense still count.
 *   - Neutral tiles: power must be >= the tile's effective defense.
 *   - Other-player tiles: power must be STRICTLY GREATER than the tile's
 *     effective defense (defender wins ties at resolution).
 * Uses `defense_power`, the live total of base + permanent + temporary defense.
 */
function canClaimCaptureTile(
  card: Card,
  tile: import('../types/game').HexTile,
  effectivePower: number,
): boolean {
  const ignoresDefense = card.effects?.some(e => e.type === 'ignore_defense');
  const effectiveDefense = ignoresDefense
    ? tile.base_defense + tile.permanent_defense_bonus
    : tile.defense_power;
  if (!tile.owner) return effectivePower >= effectiveDefense;
  return effectivePower > effectiveDefense;
}

// Hex geometry helpers moved to `../utils/hexGeometry` so sibling components
// (and animation preview tooling) can import them without pulling the entire
// GameScreen dependency tree. Re-exported here for existing callers.
import { HEX_SIZE, axialToPixel, localToScreen, screenToLocal, type GridTransform } from '../utils/hexGeometry';
import { chevronSource, findNearestOwnedTile } from '../utils/resolveChevrons';
export { HEX_SIZE, axialToPixel, localToScreen };

interface GameScreenProps {
  gameState: GameState;
  onStateUpdate: (state: GameState) => void;
  playerId?: string;       // multiplayer: this player's ID
  token?: string;          // multiplayer: auth token
  isMultiplayer?: boolean;
  isHost?: boolean;
  onLeaveGame?: () => void;
  skipIntro?: boolean;     // skip intro overlay + draw animation (e.g. reconnection)
  removedFromLobby?: boolean;  // player was kicked from lobby while viewing game over
  wsSend?: (data: object) => void;  // WebSocket send for cursor broadcasting
  wsMessage?: { type: string; [key: string]: unknown } | null;  // WS messages for cursor/purchase events
}

/** A played card on the board during the reveal (every player's), until it
 *  flies home: to its owner's discard pile or ID card, or burns if trashed. */
interface RevealCard extends BoardCardEntry {
  tileKey: string | null;
  /** A multi-target card shows on each tile; only its primary copy flies home. */
  primary: boolean;
  trash: boolean;
}

type BoardFlightKind = 'toDiscard' | 'toPlayer' | 'fade';

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

/** Check if a card requires the player to choose cards to trash or discard from hand. */
function getCardChoiceRequirement(card: Card): {
  effectType: 'self_trash' | 'trash_gain_buy_cost' | 'self_discard';
  minCards: number;
  maxCards: number;
  label: string;
} | null {
  if (!card.effects) return null;
  for (const effect of card.effects) {
    if (effect.type === 'self_trash' || effect.type === 'trash_gain_buy_cost' || effect.type === 'trash_gain_power') {
      // trash_gain_power (Arms Dealer) always trashes exactly 1; others use effect value
      const count = effect.type === 'trash_gain_power'
        ? 1
        : (card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value);
      // Trashing is always optional — player can decline (but forfeits the bonus)
      return {
        effectType: effect.type as 'self_trash' | 'trash_gain_buy_cost',
        minCards: 0,
        maxCards: count,
        label: 'Trash',
      };
    }
    if (effect.type === 'self_discard') {
      // If the card also draws cards, discard is normally deferred (draw first,
      // then pick discard) — UNLESS the effect is flagged discard_first
      // (Caravan+), in which case we prompt before the draw.
      const discardFirst = Boolean(effect.metadata?.discard_first);
      if (card.draw_cards > 0 && !discardFirst) return null;
      const count = card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value;
      // Discarding is required if there are cards in hand
      return {
        effectType: 'self_discard',
        minCards: count,
        maxCards: count,
        label: 'Discard',
      };
    }
    if (effect.type === 'cycle') {
      const discardCount = (effect.metadata?.discard as number) ?? 2;
      return {
        effectType: 'self_discard' as const,
        minCards: discardCount,
        maxCards: discardCount,
        label: 'Discard',
      };
    }
    if (effect.type === 'mandatory_self_trash') {
      const count = card.is_upgraded && effect.upgraded_value != null ? effect.upgraded_value : effect.value;
      return {
        effectType: 'self_trash' as const,
        minCards: count,
        maxCards: count,
        label: 'Trash',
      };
    }
  }
  return null;
}

/**
 * Build a synthetic PendingSearch for a tutor card BEFORE it's played,
 * using the active player's current pile state. The human UI gates the play
 * on this modal and commits the selections with the card play (atomic).
 *
 * Matches the backend's `_handle_search_zone` logic (effect_resolver.py):
 * filter source pile, clamp count/min to pile size.
 *
 * Returns null if the card has no search_zone effect or the source pile
 * has zero eligible cards (the card wouldn't be playable anyway).
 */
function buildPrePlaySearch(
  card: Card,
  source_pile: { discard: Card[]; deck_cards: Card[]; trash: Card[] },
): PendingSearch | null {
  const eff = card.effects?.find((e: any) => e.type === 'search_zone');
  if (!eff) return null;

  const meta = (eff.metadata ?? {}) as Record<string, unknown>;
  const source = String(meta.source ?? 'discard') as PendingSearch['source'];
  const rawTargets = Array.isArray(meta.targets) ? (meta.targets as unknown[]) : ['hand'];
  const allowed_targets = rawTargets.map((t) => String(t)) as SearchZoneTarget[];
  const card_filter = (typeof meta.filter === 'object' && meta.filter !== null)
    ? (meta.filter as PendingSearch['card_filter'])
    : null;

  const srcList: Card[] =
    source === 'discard' ? source_pile.discard
      : source === 'draw' ? source_pile.deck_cards
        : source === 'trash' ? source_pile.trash
          : [];

  // Apply filter (card_type / name only — mirrors backend `matches_card_filter`)
  const filtered = srcList.filter((c) => {
    if (!card_filter) return true;
    if (card_filter.card_type && c.card_type.toLowerCase() !== card_filter.card_type.toLowerCase()) return false;
    if (card_filter.name && c.name !== card_filter.name) return false;
    return true;
  });

  const baseValue = eff.value ?? 0;
  const upgradedValue = eff.upgraded_value;
  const rawCount = card.is_upgraded && upgradedValue != null ? upgradedValue : baseValue;

  // Draw-pile peek is capped to "top N" (matches backend _handle_search_zone).
  // The card text default is "look at the top N cards" — peeking the entire
  // draw pile would leak information the effect doesn't grant. Two metadata
  // overrides: `peek_all: true` shows the entire pile (Foresight); `peek: N`
  // sets a custom peek depth. Defaults to the pick count.
  const peekAll = source === 'draw' && !!meta.peek_all;
  let eligible = filtered;
  if (source === 'draw' && !peekAll) {
    const peekRaw = meta.peek;
    const peek = peekRaw != null ? Number(peekRaw) : rawCount;
    eligible = filtered.slice(0, peek);
  }

  if (eligible.length === 0) return null;

  const rawMin = meta.min != null ? Number(meta.min) : rawCount;
  const count = Math.min(rawCount, eligible.length);
  const min_count = Math.max(0, Math.min(rawMin, count));

  return {
    source,
    count,
    min_count,
    allowed_targets,
    card_filter,
    snapshot_card_ids: eligible.map((c) => c.id),
    peek_all: peekAll,
  };
}

const HEX_DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Count VP tiles owned by a player that are connected to their base through owned territory. */
function countConnectedVpTiles(
  tiles: Record<string, import('../types/game').HexTile>,
  playerId: string,
): number {
  // BFS from base tiles through owned territory
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) {
      visited.add(key);
      queue.push(key);
    }
  }
  let count = 0;
  while (queue.length > 0) {
    const key = queue.shift()!;
    const tile = tiles[key];
    if (tile.is_vp) count++;
    for (const [dq, dr] of HEX_DIRS) {
      const nk = `${tile.q + dq},${tile.r + dr}`;
      if (visited.has(nk)) continue;
      const neighbor = tiles[nk];
      if (!neighbor || neighbor.owner !== playerId) continue;
      visited.add(nk);
      queue.push(nk);
    }
  }
  return count;
}

/** BFS from each VP tile owned by a player to their base, through owned territory.
 *  Deduplicates: if a VP tile is already a waypoint on a longer path, its standalone path is omitted. */
function computePlayerVpPaths(
  tiles: Record<string, import('../types/game').HexTile>,
  playerId: string,
  color: number,
): VpPath[] {
  // Find base tile keys
  const baseKeys = new Set<string>();
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_base && tile.owner === playerId) baseKeys.add(key);
  }
  if (baseKeys.size === 0) return [];

  // Find VP tiles owned by this player
  const vpTiles: { q: number; r: number; key: string }[] = [];
  for (const [key, tile] of Object.entries(tiles)) {
    if (tile.is_vp && tile.owner === playerId) {
      vpTiles.push({ q: tile.q, r: tile.r, key });
    }
  }
  if (vpTiles.length === 0) return [];

  // Compute path for each VP tile
  const allPaths: { vpKey: string; points: [number, number][] }[] = [];
  for (const vp of vpTiles) {
    const queue: { key: string; q: number; r: number; path: [number, number][] }[] = [
      { key: vp.key, q: vp.q, r: vp.r, path: [[vp.q, vp.r]] },
    ];
    const visited = new Set<string>([vp.key]);
    let foundPath: [number, number][] | null = null;

    while (queue.length > 0 && !foundPath) {
      const current = queue.shift()!;
      for (const [dq, dr] of HEX_DIRS) {
        const nq = current.q + dq;
        const nr = current.r + dr;
        const nk = `${nq},${nr}`;
        if (visited.has(nk)) continue;
        const neighbor = tiles[nk];
        if (!neighbor || neighbor.owner !== playerId) continue;
        visited.add(nk);
        const newPath: [number, number][] = [...current.path, [nq, nr]];
        if (baseKeys.has(nk)) {
          foundPath = newPath;
          break;
        }
        queue.push({ key: nk, q: nq, r: nr, path: newPath });
      }
    }

    if (foundPath) {
      allPaths.push({ vpKey: vp.key, points: foundPath });
    }
  }

  // Sort longest first, then remove paths whose VP tile is already a waypoint on a longer path
  allPaths.sort((a, b) => b.points.length - a.points.length);
  const coveredVpKeys = new Set<string>();
  const vpKeySet = new Set(vpTiles.map(v => v.key));
  const result: VpPath[] = [];

  for (const p of allPaths) {
    if (coveredVpKeys.has(p.vpKey)) continue; // already covered by a longer path
    result.push({ points: p.points, color, alpha: 0, playerId });
    // Mark any VP tiles that appear as waypoints in this path (excluding the start)
    for (let i = 1; i < p.points.length; i++) {
      const wk = `${p.points[i][0]},${p.points[i][1]}`;
      if (vpKeySet.has(wk)) coveredVpKeys.add(wk);
    }
  }

  return result;
}

const PHASE_PILL_ORDER = ['upkeep', 'play', 'reveal', 'buy'] as const;
const PHASE_PILL_COLORS: Record<string, string> = { upkeep: '#555', play: '#2a6e3e', reveal: '#4a2a6e', buy: '#2a4a6e' };
const PHASE_PILL_LABELS: Record<string, string> = { upkeep: 'Upkeep', play: 'Play', reveal: 'Resolve', buy: 'Buy' };

function PhaseIndicatorPill({ phase }: { phase: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  return (
    <>
      <span
        onPointerEnter={(e) => setRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
        onPointerLeave={() => setRect(null)}
        style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 999,
          background: `linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0) 60%), ${PHASE_PILL_COLORS[phase] ?? '#333'}`,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.25), 0 0 10px ${(PHASE_PILL_COLORS[phase] ?? '#333')}55`,
          color: '#fff', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 1, cursor: 'help',
          textShadow: '0 1px 1px rgba(0,0,0,0.4)',
        }}
      >
        {PHASE_PILL_LABELS[phase] ?? phase.replace(/_/g, ' ')}
      </span>
      {rect && createPortal(
        <div style={{
          position: 'fixed',
          left: rect.left,
          top: rect.bottom + 6,
          display: 'flex', alignItems: 'center', gap: 4,
          background: '#111122', border: '1px solid #555', borderRadius: 6,
          padding: '6px 10px', whiteSpace: 'nowrap', zIndex: 20000,
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)', pointerEvents: 'none',
        }}>
          {PHASE_PILL_ORDER.map((p, i) => {
            const isCurrent = phase === p;
            return (
              <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && <Icon name="then" size={9} decorative style={{ color: '#555' }} />}
                <span style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 4,
                  background: isCurrent ? (PHASE_PILL_COLORS[p] ?? '#333') : 'transparent',
                  border: isCurrent ? 'none' : '1px solid #444',
                  color: isCurrent ? '#fff' : '#777',
                  fontWeight: isCurrent ? 'bold' : 'normal',
                  textTransform: 'uppercase',
                }}>
                  {PHASE_PILL_LABELS[p]}
                </span>
              </span>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

/** Round at which Debt cards start being distributed. */
const DEBT_START_ROUND = 5;

/** Parse the game log to find who received a Debt card this round. */
function findDebtRecipientFromLog(gameState: GameState): { id: string; name: string } | null {
  const log = gameState.log;
  for (let i = log.length - 1; i >= 0; i--) {
    const match = log[i].match(/^(.+) receives a Debt card/);
    if (match) {
      const name = match[1];
      const entry = Object.entries(gameState.players).find(([, p]) => p.name === name);
      if (entry) return { id: entry[0], name };
      return null;
    }
    // Stop at round boundary to avoid matching previous rounds
    if (log[i].startsWith('=== Round')) break;
  }
  return null;
}

/** Scale factor for the flying debt card (relative to CARD_FULL_WIDTH × CARD_FULL_MIN_HEIGHT). */
const DEBT_FLY_SCALE = 0.45;
const DEBT_FLY_CARD_W = CARD_FULL_WIDTH * DEBT_FLY_SCALE;
const DEBT_FLY_CARD_H = CARD_FULL_MIN_HEIGHT * DEBT_FLY_SCALE;

/** A representative Debt card object for rendering in CardFull. */
const DEBT_CARD_OBJ: Card = {
  id: 'debt_fly',
  definition_id: 'neutral_debt',
  name: 'Debt',
  archetype: 'shared',
  card_type: 'engine',
  power: 0,
  resource_gain: -3,
  action_return: 0,
  action_cost: 1,
  timing: 'immediate',
  buy_cost: null,
  is_upgraded: false,
  trash_on_use: true,
  trash_immune: true,
  stackable: false,
  forced_discard: 0,
  draw_cards: 0,
  defense_bonus: 0,
  adjacency_required: false,
  claim_range: 0,
  unoccupied_only: false,
  multi_target_count: 0,
  defense_target_count: 0,
  flood: false,
  target_own_tile: false,
  passive_vp: 0,
  description: `Pay 3 resources to trash this card. One is given to the VP leader at the beginning of each round, starting round ${DEBT_START_ROUND}.`,
  starter: false,
  effects: [],
};

/** Animated card that flies from screen center to a target element.
 * Reused by Debt (upkeep delivery) and create_cards_to_discard
 * (Hatching Grounds, Master Engineer). */
function CardFlyToTargetAnimation({
  card,
  targetRect,
  onComplete,
  speed = 1,
  glow = 'rgba(204, 102, 34, 0.5)',
  delayMs = 0,
  holdMs = 0,
  spread = false,
}: {
  card: Card;
  targetRect: DOMRect;
  onComplete: () => void;
  speed?: number;
  glow?: string;
  delayMs?: number;
  /** Milliseconds to pause in the center (with a glowing outline) before flying. Scales with `speed`. */
  holdMs?: number;
  /** When true, add a small random X/Y offset so batched flights fan out instead of stacking. */
  spread?: boolean;
}) {
  const [stage, setStage] = useState<'wait' | 'mount' | 'grow' | 'hold' | 'fly'>(delayMs > 0 ? 'wait' : 'mount');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Random jitter values, stable for the lifetime of this animation instance
  const jitterRef = useRef({
    startRot: (Math.random() - 0.5) * 6,    // ±3° initial wobble
    growRot: (Math.random() - 0.5) * 10,     // ±5° during grow
    flyRot: (Math.random() - 0.5) * 30 + (Math.random() > 0.5 ? 15 : -15), // 15-30° spin during fly
    // Small horizontal/vertical spread so stacked flights fan out slightly
    // in the center (only applied when holdMs > 0, so Debt is unaffected)
    spreadX: (Math.random() - 0.5) * 90,
    spreadY: (Math.random() - 0.5) * 30,
  });

  const spreadX = spread ? jitterRef.current.spreadX : 0;
  const spreadY = spread ? jitterRef.current.spreadY : 0;
  const startX = window.innerWidth / 2 - DEBT_FLY_CARD_W / 2 + spreadX;
  const startY = window.innerHeight / 2 - DEBT_FLY_CARD_H - 60 + spreadY;

  const targetX = targetRect.left + targetRect.width / 2 - DEBT_FLY_CARD_W / 2;
  const targetY = targetRect.top + targetRect.height / 2 - DEBT_FLY_CARD_H / 2;

  const growMs = Math.round(350 * speed);
  const scaledHoldMs = Math.round(holdMs * speed);
  const flyMs = Math.round(660 * speed);

  // wait → mount (stagger delay for batched flights)
  useEffect(() => {
    if (stage !== 'wait') return;
    const t = setTimeout(() => setStage('mount'), delayMs);
    return () => clearTimeout(t);
  }, [stage, delayMs]);

  // mount → grow (double-rAF to ensure initial paint)
  useEffect(() => {
    if (stage !== 'mount') return;
    const raf = requestAnimationFrame(() => {
      requestAnimationFrame(() => setStage('grow'));
    });
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  // grow → hold (or fly directly if no hold)
  useEffect(() => {
    if (stage !== 'grow') return;
    const t = setTimeout(() => setStage(scaledHoldMs > 0 ? 'hold' : 'fly'), growMs);
    return () => clearTimeout(t);
  }, [stage, growMs, scaledHoldMs]);

  // hold → fly
  useEffect(() => {
    if (stage !== 'hold') return;
    const t = setTimeout(() => setStage('fly'), scaledHoldMs);
    return () => clearTimeout(t);
  }, [stage, scaledHoldMs]);

  // fly → complete
  useEffect(() => {
    if (stage !== 'fly') return;
    const t = setTimeout(() => onCompleteRef.current(), flyMs);
    return () => clearTimeout(t);
  }, [stage, flyMs]);

  const j = jitterRef.current;
  let left: number, top: number, scale: number, rotate: number, opacity: number, transition: string;
  switch (stage) {
    case 'wait':
      left = startX; top = startY;
      scale = 1; rotate = j.startRot; opacity = 0;
      transition = 'none';
      break;
    case 'mount':
      left = startX; top = startY;
      scale = 1; rotate = j.startRot; opacity = 1;
      transition = 'none';
      break;
    case 'grow':
      left = startX; top = startY;
      scale = 1.15; rotate = j.growRot; opacity = 1;
      transition = `all ${growMs}ms ease-out`;
      break;
    case 'hold':
      left = startX; top = startY;
      scale = 1.15; rotate = j.growRot; opacity = 1;
      transition = 'none';
      break;
    case 'fly': {
      const fadeDelay = Math.round(flyMs * 0.95);
      const fadeDur = flyMs - fadeDelay;
      left = targetX; top = targetY;
      scale = 0.55; rotate = j.flyRot; opacity = 0;
      transition = `left ${flyMs}ms ease-in, top ${flyMs}ms ease-in, transform ${flyMs}ms ease-in, opacity ${fadeDur}ms ease-in ${fadeDelay}ms`;
      break;
    }
  }

  // During the hold stage, add a pulsing bright outline so the player can
  // recognize the card before it flies away.
  const isHolding = stage === 'hold';
  const dropShadow = isHolding
    ? `drop-shadow(0 0 14px ${glow}) drop-shadow(0 0 28px ${glow})`
    : `drop-shadow(0 4px 20px ${glow})`;

  return createPortal(
    <>
      {isHolding && (
        <style>{`
          @keyframes cardFlyHoldPulse {
            0%, 100% { filter: drop-shadow(0 0 10px ${glow}) drop-shadow(0 0 20px ${glow}); }
            50%      { filter: drop-shadow(0 0 18px ${glow}) drop-shadow(0 0 36px ${glow}); }
          }
        `}</style>
      )}
      <div style={{
        position: 'fixed',
        left, top,
        width: DEBT_FLY_CARD_W,
        height: DEBT_FLY_CARD_H,
        transform: `scale(${scale}) rotate(${rotate}deg)`,
        opacity,
        transition,
        zIndex: 31000,
        pointerEvents: 'none',
        filter: dropShadow,
        animation: isHolding
          ? `cardFlyHoldPulse ${Math.max(400, scaledHoldMs)}ms ease-in-out infinite`
          : undefined,
      }}>
        <div style={{
          transform: `scale(${DEBT_FLY_SCALE})`,
          transformOrigin: 'top left',
        }}>
          <CardFull card={card} />
        </div>
      </div>
    </>,
    document.body
  );
}

/** Thin wrapper: flies the Debt card to a target element (used at upkeep). */
function DebtCardFlyAnimation({
  targetRect,
  onComplete,
  speed = 1,
}: {
  targetRect: DOMRect;
  onComplete: () => void;
  speed?: number;
}) {
  return (
    <CardFlyToTargetAnimation
      card={DEBT_CARD_OBJ}
      targetRect={targetRect}
      onComplete={onComplete}
      speed={speed}
      glow="rgba(204, 102, 34, 0.5)"
      holdMs={800}
    />
  );
}

/** Shared glass panel look for the floating in-game HUD. */
const HUD_PANEL_STYLE: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 45%), rgba(12, 12, 30, 0.9)',
  border: '1px solid rgba(232, 196, 106, 0.16)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 24px rgba(0,0,0,0.45)',
};

type ActionButtonVariant = 'warn' | 'go' | 'muted' | 'danger' | 'slate' | 'info';
const ACTION_BUTTON_FILLS: Record<ActionButtonVariant, { bg: string; border: string; color: string }> = {
  warn: { bg: 'linear-gradient(180deg, #ffb46e 0%, #f08a3c 52%, #c8601c 100%)', border: '#ffcb94', color: '#fff' },
  go: { bg: 'linear-gradient(180deg, #6ee495 0%, #2fa356 52%, #1d7a3c 100%)', border: '#9cf3b8', color: '#fff' },
  muted: { bg: 'linear-gradient(180deg, #4b4b68 0%, #36364e 100%)', border: 'rgba(255,255,255,0.14)', color: '#b9b8cc' },
  danger: { bg: 'linear-gradient(180deg, #ff7a7a 0%, #e04545 52%, #b02a2a 100%)', border: '#ffaaaa', color: '#fff' },
  slate: { bg: 'linear-gradient(180deg, #a3a3b8 0%, #77778e 100%)', border: '#c9c9d9', color: '#fff' },
  info: { bg: 'linear-gradient(180deg, #7cbcff 0%, #4a9eff 52%, #2d74d0 100%)', border: '#a9d3ff', color: '#fff' },
};

/** Embossed, display-font style shared by the phase action buttons
 *  (Submit Play, Done Buying, Done Reviewing, Confirm/Cancel). */
function actionButtonStyle(variant: ActionButtonVariant, size: 'lg' | 'sm' = 'lg'): React.CSSProperties {
  const f = ACTION_BUTTON_FILLS[variant];
  return {
    padding: size === 'lg' ? '10px 24px' : '6px 16px',
    background: f.bg,
    border: `1px solid ${f.border}`,
    borderRadius: 10,
    color: f.color,
    fontFamily: 'var(--cc-font-display)',
    fontWeight: 900,
    letterSpacing: '0.05em',
    fontSize: size === 'lg' ? 17 : 13,
    lineHeight: '1.2',
    textShadow: variant === 'muted' ? 'none' : '0 1px 2px rgba(0,0,0,0.45)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.45)',
  };
}

/** Glass button used in the top-right HUD bar (Cards / Deck / Shop / gear). */
const HUD_BUTTON_STYLE: React.CSSProperties = {
  padding: '7px 14px',
  background: 'linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02)), rgba(18, 18, 40, 0.93)',
  border: '1px solid rgba(232, 196, 106, 0.28)',
  borderColor: 'rgba(232, 196, 106, 0.28)',
  borderRadius: 9,
  color: 'var(--cc-text)',
  fontSize: 13,
  fontWeight: 'bold',
  letterSpacing: 0.3,
  cursor: 'pointer',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07), 0 4px 12px rgba(0,0,0,0.4)',
};

/** Default table backdrop: a soft spotlight behind the board, a vignette
 *  toward the edges, and a faint hex lattice for texture. */
const GAME_BACKDROP = [
  'radial-gradient(ellipse 70% 60% at 50% 46%, rgba(64, 72, 140, 0.32) 0%, rgba(30, 30, 70, 0.12) 45%, rgba(0, 0, 0, 0) 70%)',
  'radial-gradient(ellipse at 50% 50%, rgba(0, 0, 0, 0) 55%, rgba(0, 0, 8, 0.55) 100%)',
  `url("data:image/svg+xml,${encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='56' height='97' viewBox='0 0 56 97'>" +
    "<path d='M28 0 L56 16 L56 48 L28 64 L0 48 L0 16 Z M28 64 L28 97' fill='none' stroke='rgba(255,255,255,0.025)' stroke-width='1'/></svg>",
  )}")`,
  'linear-gradient(180deg, #121230 0%, #0c0c20 100%)',
].join(', ');

export default function GameScreen({ gameState, onStateUpdate, playerId: mpPlayerId, token: mpToken, isMultiplayer, isHost: mpIsHost, onLeaveGame, skipIntro: skipIntroProp, removedFromLobby, wsSend, wsMessage }: GameScreenProps) {
  // Sync player colors from game state into the shared PLAYER_COLORS map
  syncPlayerColors(gameState.players);
  const animated = useAnimated();
  const animationMode = useAnimationMode();
  const animationOff = useAnimationOff();
  const animSpeed = useAnimationSpeed();
  /** The reveal + resolution sequence runs a touch slower on Normal. */
  const resolveSpeed = useResolveSpeed();
  const sound = useSound();
  const { showZoom, zoomedCard } = useCardZoom();
  // Helper: find the first human player index
  const firstHumanIndex = gameState.player_order.findIndex(
    pid => !gameState.players[pid]?.is_cpu,
  );
  // In multiplayer, active player is always the local player
  const mpPlayerIndex = mpPlayerId ? gameState.player_order.indexOf(mpPlayerId) : -1;
  const activePlayerIndex = isMultiplayer && mpPlayerIndex >= 0 ? mpPlayerIndex : Math.max(0, firstHumanIndex);
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [hoveredCardIndex, setHoveredCardIndex] = useState<number | null>(null);
  const [draggingCardIndex, setDraggingCardIndex] = useState<number | null>(null);
  /** Effective drag cursor position (CardHand applies a touch-input vertical
   *  offset). Drives the HexGrid hover highlight so it stays synced with the
   *  drop hex computed from the same coordinates. */
  const [dragHoverPos, setDragHoverPos] = useState<{ clientX: number; clientY: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showUpgradePreview, setShowUpgradePreview] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const [showDeckViewer, setShowDeckViewer] = useState(false);
  const [showShopOverlay, setShowShopOverlay] = useState(false);
  const showShopOverlayRef = useRef(showShopOverlay);
  showShopOverlayRef.current = showShopOverlay;
  const cardCatalog = useCardCatalog();
  /** An opponent's purchase with no shop tile on screen to fly from (set
   *  once the board-flight helpers exist, below). */
  const popPurchaseRef = useRef<(playerId: string, card: Card, index: number) => void>(() => {});
  const [otherCursors, setOtherCursors] = useState<Record<string, CursorPosition>>({});
  const [neutralPurchaseEvents, setSharedPurchaseEvents] = useState<SharedPurchaseEvent[]>([]);
  // Your own purchases, waiting to fly into your discard pile (held while the shop is open)
  const [incomingDiscards, setIncomingDiscards] = useState<IncomingDiscard[]>([]);
  const [cursorClicks, setCursorClicks] = useState<Record<string, number>>({}); // player_id -> timestamp
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const [cardPackDefs, setCardPackDefs] = useState<{ id: string; name: string; shared_card_ids: string[] | null; archetype_card_ids: Record<string, string[]> | null }[]>([]);
  const [discardingAll, setDiscardingAll] = useState(false);
  const [lastPlayedTarget, setLastPlayedTarget] = useState<PlayTarget | null>(null);
  /** Temporarily stores drag release position/velocity so executePlayCard can include it in lastPlayedTarget */
  const dragReleaseRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [trashedCardIds, setTrashedCardIds] = useState<Set<string>>(new Set());
  // Floating action icons that animate on card play
  const [floatingActions, setFloatingActions] = useState<{ id: number; offsetX: number; offsetY: number; type: 'spend' | 'gain'; amount: number }[]>([]);
  const floatingActionIdRef = useRef(0);
  // Test mode state
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [testShuffleAnim, setTestShuffleAnim] = useState(false);
  const [testCardId, setTestCardId] = useState('');
  const [testVp, setTestVp] = useState('');
  const [testResources, setTestResources] = useState('');
  const [testRound, setTestRound] = useState('');
  const [testDrawCount, setTestDrawCount] = useState('1');
  const [testActions, setTestActions] = useState('');
  // Multi-tile selection mode
  const [multiTileTargets, setMultiTileTargets] = useState<[number, number][]>([]);
  const [multiTileCardIndex, setMultiTileCardIndex] = useState<number | null>(null);
  const [multiTilePrimaryTarget, setMultiTilePrimaryTarget] = useState<[number, number] | null>(null);
  // Clear multi-tile mode when selected card changes away from the multi-tile card
  useEffect(() => {
    if (multiTileCardIndex !== null && selectedCardIndex !== multiTileCardIndex) {
      setMultiTileCardIndex(null);
      setMultiTilePrimaryTarget(null);
      setMultiTileTargets([]);
    }
  }, [selectedCardIndex, multiTileCardIndex]);

  // Deselect any in-hand card when leaving the Play phase
  useEffect(() => {
    if (gameState.current_phase !== 'play') {
      setSelectedCardIndex(null);
      setMultiTileCardIndex(null);
      setMultiTilePrimaryTarget(null);
      setMultiTileTargets([]);
    }
  }, [gameState.current_phase]);

  // Trash/discard selection mode (for cards like Thin the Herd, Consolidate, Reduce)
  const [trashMode, setTrashMode] = useState<{
    cardIndex: number;
    targetQ?: number;
    targetR?: number;
    targetPlayerId?: string;
    extraTargets?: [number, number][];
    effectType: 'self_trash' | 'trash_gain_buy_cost' | 'self_discard';
    minCards: number;
    maxCards: number;
    label: string;  // "Trash" or "Discard"
    pendingDiscard?: boolean;  // true when resolving a deferred discard (not during card play)
  } | null>(null);
  const [trashSelectedIndices, setTrashSelectedIndices] = useState<Set<number>>(new Set());

  // Pile search (SEARCH_ZONE / tutor) state. Two modes:
  //   - prePlaySearchMode: card hasn't been played yet. The modal is shown
  //     using a synthetic PendingSearch derived from current state. Confirming
  //     commits the play AND the search atomically. Cancelling leaves the
  //     card in hand (no API call).
  //   - server-driven pending_search (activePlayer.pending_search): legacy /
  //     reconnection path. Same modal rendered, but confirm calls
  //     submitSearch against the already-pending state on the server.
  const [prePlaySearchMode, setPrePlaySearchMode] = useState<{
    cardIndex: number;
    targetQ?: number;
    targetR?: number;
    targetPlayerId?: string;
    extraTargets?: [number, number][];
    pending: PendingSearch;
  } | null>(null);
  const [searchFlights, setSearchFlights] = useState<SearchFlight[] | null>(null);
  // When true, the player has confirmed a search; suppresses the modal while
  // the fly animation plays. Cleared after submitSearchCommit runs.
  const [searchAnimating, setSearchAnimating] = useState(false);
  // Card IDs that the tutor UI just flew into the hand — passed to CardHand
  // so it doesn't re-animate them as if they were drawn from the deck.
  const [searchSuppressedHandIds, setSearchSuppressedHandIds] = useState<Set<string>>(() => new Set());
  // True for the brief window between submitting a tutor commit and the
  // resulting state arriving. Tells CardHand to skip its shuffle-detection
  // heuristic, which would otherwise misfire on the discard-pile shrinkage
  // caused by tutor moves (e.g. discard → hand or discard → top of draw).
  const [tutorCommitInFlight, setTutorCommitInFlight] = useState(false);
  // Intro overlay state — skip on reconnection or when animations are off
  const skipIntro = skipIntroProp || animationOff;
  const [showIntro, setShowIntro] = useState(!skipIntro);
  // Intro sequence after overlay: 'overlay' → 'hud_fadein' → 'grid_build' → 'draw' → 'done'
  const [introSequence, setIntroSequence] = useState<'overlay' | 'hud_fadein' | 'grid_build' | 'draw' | 'done'>(skipIntro ? 'done' : 'overlay');
  // HUD visibility (fades in during intro)
  const [hudVisible, setHudVisible] = useState(skipIntro ? true : false);
  // Whether the hand area has faded in and is ready for draw animations
  const [introHandReady, setIntroHandReady] = useState(skipIntro);
  // Grid build-from-center progress (0→1 during intro, undefined after)
  const [gridBuildProgress, setGridBuildProgress] = useState<number | undefined>(skipIntro ? undefined : 0);
  // Banner label override (for "Begin!" on first turn)
  const [bannerLabelOverride, setBannerLabelOverride] = useState<string | null>(null);
  // Game over state
  const [showGameOver, setShowGameOver] = useState(false);
  // Settings gear dropdown state
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  // Player panel expand-on-hover
  const [playerPanelExpanded, setPlayerPanelExpanded] = useState(false);
  // Engine cards played this round wait in a queue under the player's ID card
  const inPlayContainerRef = useRef<HTMLDivElement>(null);
  const playerPanelRef = useRef<HTMLDivElement>(null);
  // Played cards stay hidden on the board until their flight from the hand lands
  const [arrivingIds, setArrivingIds] = useState<Set<string>>(() => new Set());
  // Reveal: every player's played cards over their tiles, flying home as each tile resolves
  const [revealCards, setRevealCards] = useState<RevealCard[] | null>(null);
  const revealCardsRef = useRef<RevealCard[] | null>(null);
  revealCardsRef.current = revealCards;
  const [revealFocusTile, setRevealFocusTile] = useState<string | null>(null);
  const [boardFlights, setBoardFlights] = useState<Flight<BoardFlightKind>[]>([]);
  const [boardBurns, setBoardBurns] = useState<{ key: string; card: Card; pose: Pose }[]>([]);
  const boardFlightSeq = useRef(0);
  /** Set up the reveal's board cards (assigned below; called from the phase effect). */
  const beginRevealRef = useRef<(state: GameState) => void>(() => {});
  // Hold the discard count while revealed cards fly to the discard pile; +1 per landing
  const [discardCountOverride, setDiscardCountOverride] = useState<number | null>(null);
  // Purchase pill hover preview
  const [purchaseHover, setPurchaseHover] = useState<{ card: import('../types/game').Card; rect: DOMRect } | null>(null);
  const [purchaseHoverVisible, setPurchaseHoverVisible] = useState(false);
  // Phase banner state
  const [phaseBanner, setPhaseBanner] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0);
  const [interactionBlocked, setInteractionBlocked] = useState(false);
  const [submitButtonVisible, setSubmitButtonVisible] = useState(false);
  const [buyButtonVisible, setBuyButtonVisible] = useState(false);
  // Debt card fly animation state
  const [bannerHoldUntilRelease, setBannerHoldUntilRelease] = useState(false);
  const [debtFlyTarget, setDebtFlyTarget] = useState<DOMRect | null>(null);
  const [forcePlayerPanelExpanded, setForcePlayerPanelExpanded] = useState(false);
  const debtFlyPendingRef = useRef<string | null>(null);
  // Hatching Grounds / Master Engineer: center-screen card flights toward the discard pile
  const [createdCardFlights, setCreatedCardFlights] = useState<{
    id: number;
    card: Card;
    targetRect: DOMRect;
    delayMs: number;
    glow: string;
  }[]>([]);
  const createdCardFlightIdRef = useRef(0);
  // Tracks which (create_cards_to_discard) effect entries have already spawned
  // flights, keyed by a stable signature. Prevents re-triggering on re-renders
  // or duplicate game-state updates.
  const spawnedCreatedFlightKeysRef = useRef<Set<string>>(new Set());
  // Test mode: override debt recipient for animation testing
  const testDebtRecipientRef = useRef<{ id: string; name: string } | null>(null);
  const testDebtBannerRef = useRef(false); // true when banner is from test "Give Debt" button
  const submitPlayRef = useRef<HoldToSubmitHandle>(null);
  // Errors float just above the top of the resting hand (which rises out of
  // its bottom strip) — and on phones, where the toast spans the screen, above
  // the actions / Submit row too — and fade after a few seconds.
  const handSizes = handSizing(window.innerWidth, window.innerHeight);
  const errorToastBottom = Math.round(Math.max(handStripHeight(handSizes), CARD_H * handSizes.rest * REST_VISIBLE))
    + 14 + (window.innerWidth < 640 ? 58 : 0);

  // The board draws on under the hand panel (the water runs to the screen
  // edge) but frames the island above the resting hand cards.
  const [handPanelH, setHandPanelH] = useState(0);
  const handPanelRo = useRef<ResizeObserver | null>(null);
  const handPanelRef = useCallback((el: HTMLDivElement | null) => {
    handPanelRo.current?.disconnect();
    handPanelRo.current = null;
    if (!el) return;
    const measure = () => setHandPanelH(Math.round(el.getBoundingClientRect().height));
    measure();
    handPanelRo.current = new ResizeObserver(measure);
    handPanelRo.current.observe(el);
  }, []);
  const boardViewInset = handPanelH > 0 ? Math.round(Math.max(handPanelH, CARD_H * handSizes.rest * REST_VISIBLE)) : 0;
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error]);
  // The bank counter beside the action counter (coins fly into it).
  const resourceCounterRef = useRef<ResourceCounterHandle>(null);
  /** My cards that pay out resources at resolution (their tiles are where
   *  those coins fly from when the resolve finishes). */
  const resolveResourceSourcesRef = useRef<{ tileKey: string | null; weight: number }[] | null>(null);
  // "actions left" label beside the action counter: shown on hover, or for a
  // few seconds after a tap on touch screens.
  const [actionsLabelOpen, setActionsLabelOpen] = useState(false);
  const actionsPointerRef = useRef<string>('mouse');
  const actionsLabelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionsLabelOpenRef = useRef(actionsLabelOpen);
  actionsLabelOpenRef.current = actionsLabelOpen;
  const toggleActionsLabel = useCallback(() => {
    if (actionsLabelTimerRef.current) clearTimeout(actionsLabelTimerRef.current);
    actionsLabelTimerRef.current = null;
    const next = !actionsLabelOpenRef.current;
    setActionsLabelOpen(next);
    if (next) actionsLabelTimerRef.current = setTimeout(() => setActionsLabelOpen(false), 3000);
  }, []);
  useEffect(() => () => { if (actionsLabelTimerRef.current) clearTimeout(actionsLabelTimerRef.current); }, []);
  const endTurnRef = useRef<HoldToSubmitHandle>(null);
  // Responsive: stack top-right buttons vertically when screen is narrow
  const [narrowTop, setNarrowTop] = useState(() => window.innerWidth < 700);
  useEffect(() => {
    const check = () => setNarrowTop(window.innerWidth < 700);
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);
  // Fetch card pack definitions (once) for CardBrowser filtering
  useEffect(() => {
    fetch(`${api.BASE}/card-packs`)
      .then(r => r.json())
      .then((d: { packs: typeof cardPackDefs }) => setCardPackDefs(d.packs))
      .catch(() => {});
  }, []);
  // Detect mobile browser — disable double-tap shortcuts
  const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  // Start empty so the first phase always triggers a banner (upkeep → play chain)
  const prevPhaseRef = useRef<string>('');
  // Track previous tiles for resolve animation (needed for multiplayer WebSocket updates)
  const prevTilesRef = useRef(gameState.grid.tiles);
  // Track previous player stats so we can freeze VP/resources during resolve animations
  const prevPlayersRef = useRef(gameState.players);
  // Card-only VP per player captured at resolve start; tile VP recomputed per step
  const preResolveCardVpRef = useRef<Record<string, number>>({});
  // Visual order of the active player's hand (indices into activePlayer.hand), kept in sync via CardHand's onOrderChange
  const handVisualOrderRef = useRef<number[]>([]);
  // Review phase state (between resolve animations and buy phase)
  const handleDoneReviewingRef = useRef<(() => void) | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewButtonVisible, setReviewButtonVisible] = useState(false);
  const [reviewCountdown, setReviewCountdown] = useState<number | null>(null);
  const revealedActionsRef = useRef<Record<string, import('../types/game').PlannedAction[]> | null>(null);
  const [reviewHoveredTile, setReviewHoveredTile] = useState<string | null>(null);
  const [reviewTilePopupPos, setReviewTilePopupPos] = useState<{ x: number; y: number } | null>(null);
  // Play-phase tile hover, used to pulse the War Banner in the In-Play list
  // that originated the buff consumed by the Claim planned on the hovered tile.
  const [playHoveredTileKey, setPlayHoveredTileKey] = useState<string | null>(null);
  const [reviewHoveredPlayer, setReviewHoveredPlayer] = useState<string | null>(null);
  /** The tile whose board cards were last clicked open (solid while open). */
  const [openCardsTile, setOpenCardsTile] = useState<string | null>(null);
  const [detailCards, setDetailCards] = useState<{ card: Card; subtitleParts?: SubtitlePart[]; playerId?: string; playerName?: string }[] | null>(null);
  const playerRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Resolve animation state
  const [resolving, setResolving] = useState(false);
  // Delay showing the Done Reviewing button until after resolve animations settle
  useEffect(() => {
    if (reviewing && !resolving) {
      const t = setTimeout(() => setReviewButtonVisible(true), 600);
      return () => clearTimeout(t);
    }
    setReviewButtonVisible(false);
  }, [reviewing, resolving]);
  const [resolutionSteps, setResolutionSteps] = useState<ResolutionStep[]>([]);
  const [resolveDisplayState, setResolveDisplayState] = useState<GameState | null>(null);
  // (resolveFinishedStateRef removed — server holds state at REVEAL, client calls advanceResolve when done)
  const [gridRect, setGridRect] = useState<DOMRect | null>(null);
  const [gridTransformSnapshot, setGridTransformSnapshot] = useState<GridTransform | null>(null);
  const [gridRectSnapshot, setGridRectSnapshot] = useState<DOMRect | null>(null);
  const pendingStateRef = useRef<GameState | null>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const gridTransformRef = useRef<GridTransform | null>(null);
  const boardFxRef = useRef<BoardFx | null>(null);
  const boardControlsRef = useRef<BoardControls | null>(null);
  // Chevron reveal state (resolve phase pre-animation)
  const [chevronRevealPhase, setChevronRevealPhase] = useState(false);
  const [chevronAlpha, setChevronAlpha] = useState(0);
  // Chevron fade-out during resolution (per-step)
  const [resolvedUpToStep, setResolvedUpToStep] = useState(-1);
  const [currentStepFade, setCurrentStepFade] = useState(1);
  // Cache resolve chevron sources so they don't shift as tiles change owners
  const resolveChevronCacheRef = useRef<{ targetQ: number; targetR: number; sourceQ: number; sourceR: number; color: number; stepIndex: number }[]>([]);
  const [bannerSubtitle, setBannerSubtitle] = useState<string | null>(null);
  // VP path animation state
  const [vpPaths, setVpPaths] = useState<VpPath[]>([]);
  const [vpPathPhase, setVpPathPhase] = useState<'off' | 'fading_in' | 'visible' | 'fading_out'>('off');
  const vpPathFadeStartRef = useRef(0); // timestamp when current fade started
  const vpPathFadeStartAlphaRef = useRef(0); // alpha at start of fade-out
  // Client-side resolve log entries (VP path disruptions, etc.)
  const [resolveLogEntries, setResolveLogEntries] = useState<string[]>([]);
  // Player effect popups (shown over base tiles after resolve steps).
  //
  // Lifecycle:
  //   - Set when the reveal/resolve flow produces popup effects (the popups'
  //     own intro animation runs on mount).
  //   - Persist through the entire reveal phase, including the post-Done-Reviewing
  //     wait in multiplayer — players want to keep glancing at them while other
  //     players are still reviewing.
  //   - Cleared by the effect below the moment the game phase transitions
  //     away from `reveal` (typically → `buy`). PlayerEffectPopups then plays
  //     its own fade-out when `effects` goes empty.
  const [activePlayerEffects, setActivePlayerEffects] = useState<PlayerEffect[]>([]);

  // Auto-dismiss error toast after 4 seconds
  useEffect(() => {
    if (!error) return;
    sound.invalidAction();
    const timer = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(timer);
  }, [error, sound]);

  const activePlayerId = gameState.player_order[activePlayerIndex];
  const activePlayerIdRef = useRef(activePlayerId);
  activePlayerIdRef.current = activePlayerId;
  /** My base tile (where resources with no card of their own fly in from). */
  const myBaseKey = useMemo(
    () => Object.entries(gameState.grid.tiles).find(([, t]) => t.is_base && t.base_owner === activePlayerId)?.[0] ?? null,
    [gameState.grid.tiles, activePlayerId],
  );
  const myBaseKeyRef = useRef(myBaseKey);
  myBaseKeyRef.current = myBaseKey;
  /** Where resources gained outside a card play come from: the tiles of my
   *  cards that paid out at resolution, otherwise my base. */
  const resourceSourcesForGain = useCallback((): ResourceSource[] => {
    const tile = (key: string) => {
      const transform = gridTransformRef.current;
      const gRect = gridContainerRef.current?.getBoundingClientRect();
      if (!transform || !gRect) return null;
      const [q, r] = key.split(',').map(Number);
      const local = axialToPixel(q, r);
      // A little above the ground, so coins rise off the castle.
      return localToScreen(local.x, local.y, transform, gRect.width, gRect.height, gRect, 0.3);
    };
    // Last resort (no board yet): my ID card's bank.
    const idCard = () => {
      const el = document.querySelector(`[data-hud-resources="${activePlayerIdRef.current}"]`)
        ?? playerPanelRef.current;
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    };
    const base = () => (myBaseKeyRef.current ? tile(myBaseKeyRef.current) : null) ?? idCard();
    const pending = resolveResourceSourcesRef.current;
    resolveResourceSourcesRef.current = null;
    const out: ResourceSource[] = [];
    for (const p of pending ?? []) {
      const point = (p.tileKey ? tile(p.tileKey) : null) ?? base();
      if (point) out.push({ point, weight: p.weight });
    }
    if (out.length) return out;
    const p = base();
    return p ? [{ point: p }] : [];
  }, []);
  const activePlayer = gameState.players[activePlayerId];
  const phase = gameState.current_phase;

  // Chime when the local player's VP goes up (tracked per player so a
  // hot-seat seat switch doesn't count as a gain).
  const lastVpRef = useRef<{ pid: string; vp: number } | null>(null);
  useEffect(() => {
    const vp = activePlayer?.vp;
    if (vp === undefined) return;
    const last = lastVpRef.current;
    if (last && last.pid === activePlayerId && vp > last.vp) sound.vpGain();
    lastVpRef.current = { pid: activePlayerId, vp };
  }, [activePlayer?.vp, activePlayerId, sound]);

  // Warm card art the player is about to hover: their hand, deck, discard
  // and both markets load at high priority; the rest of the catalog trickles
  // in during idle time (see utils/cardImagePreload).
  const visibleCardIdsKey = useMemo(() => {
    const ids = new Set<string>();
    const add = (c?: Card | null) => { if (c?.definition_id) ids.add(c.definition_id); };
    activePlayer?.hand?.forEach(add);
    activePlayer?.deck_cards?.forEach(add);
    activePlayer?.discard?.forEach(add);
    activePlayer?.archetype_market?.forEach(add);
    gameState.shared_market?.forEach(s => add(s.card));
    return [...ids].sort().join('|');
  }, [activePlayer, gameState.shared_market]);
  useEffect(() => {
    if (!visibleCardIdsKey) return;
    preloadCardImages(visibleCardIdsKey.split('|'), 'high');
  }, [visibleCardIdsKey]);
  useEffect(() => {
    preloadCatalogArt(activePlayer?.archetype);
  }, [activePlayer?.archetype]);

  // Clear player-effect popups once the game phase leaves `reveal` (usually
  // → `buy`). This covers both the single-player immediate-transition path
  // and the multiplayer case where the phase change arrives later via
  // WebSocket after other players finish reviewing. PlayerEffectPopups runs
  // its own fade-out animation when the prop goes empty.
  useEffect(() => {
    if (phase !== 'reveal' && activePlayerEffects.length > 0) {
      setActivePlayerEffects([]);
    }
  }, [phase, activePlayerEffects.length]);

  // Names of Unique cards the active player currently owns (draw pile + hand + discard).
  // Trashed cards do NOT count, so they can be re-purchased after trashing.
  const ownedUniqueCardNames = useMemo(() => {
    const s = new Set<string>();
    if (!activePlayer) return s;
    for (const c of activePlayer.hand) if (c.unique) s.add(c.name);
    for (const c of activePlayer.deck_cards) if (c.unique) s.add(c.name);
    for (const c of activePlayer.discard) if (c.unique) s.add(c.name);
    return s;
  }, [activePlayer]);

  // True when the player can't afford any buy-phase action: no purchasable
  // archetype or shared card, no upgrade credit, no re-roll. Used to drop the
  // hold requirement on Done Buying and flip its color to green — they have
  // genuinely nothing else to do. Mirrors the affordability checks in
  // ShopOverlay so the button stays in sync with visible buy options.
  const cannotAffordAnyBuyOption = useMemo(() => {
    if (!activePlayer) return false;
    const resources = activePlayer.resources;
    const buyLocked = !!activePlayer.buy_locked;
    const freeRerolls = activePlayer.free_rerolls ?? 0;
    // Re-roll (1 resource or free; unaffected by buy_locked).
    if (freeRerolls > 0) return false;
    if (resources >= 1) return false;
    // Upgrade credit (5 resources, blocked by buy_locked).
    if (!buyLocked && resources >= 5) return false;
    if (!buyLocked) {
      // Archetype market.
      for (const card of activePlayer.archetype_market) {
        const eff = activePlayer.effective_buy_costs?.[card.id] ?? card.buy_cost;
        if (eff === null || eff === undefined) continue;
        if (card.unique && ownedUniqueCardNames.has(card.name)) continue;
        if (resources >= eff) return false;
      }
      // Shared market — respect remaining stock, per-round 1-copy limit,
      // selling-out claim, and unique ownership.
      const myBoughtSharedIds = new Set<string>();
      const myPurchases = gameState.buy_phase_purchases?.[activePlayerId];
      if (myPurchases) {
        for (const p of myPurchases) {
          if (p.source === 'shared') myBoughtSharedIds.add(p.card_id);
        }
      }
      for (const stack of gameState.shared_market) {
        if (stack.remaining <= 0) continue;
        if (myBoughtSharedIds.has(stack.card.id)) continue;
        if (stack.selling_out && stack.selling_out_bought_by?.includes(activePlayerId)) continue;
        if (stack.card.unique && ownedUniqueCardNames.has(stack.card.name)) continue;
        const eff = activePlayer.effective_buy_costs?.[stack.card.id] ?? stack.card.buy_cost;
        if (eff === null || eff === undefined) continue;
        if (resources >= eff) return false;
      }
    }
    return true;
  }, [activePlayer, ownedUniqueCardNames, gameState.shared_market, gameState.buy_phase_purchases, activePlayerId]);
  // True once the player has submitted their plays for the round
  const playSubmitted = !!activePlayer?.has_submitted_play;

  // Grid rotation — starts oriented so active player's base is at the top
  const computeBaseRotation = useCallback((playerId: string): number => {
    const tileList = Object.values(gameState.grid.tiles);
    if (tileList.length === 0) return 0;
    // Compute grid center
    let cx = 0, cy = 0;
    for (const tile of tileList) {
      const p = axialToPixel(tile.q, tile.r);
      cx += p.x;
      cy += p.y;
    }
    cx /= tileList.length;
    cy /= tileList.length;
    // Find the player's base tile
    for (const tile of tileList) {
      if (tile.is_base && tile.base_owner === playerId) {
        const p = axialToPixel(tile.q, tile.r);
        const baseAngle = Math.atan2(p.y - cy, p.x - cx);
        // Target: base at upper-left (-5PI/6 ≈ -150°) with pointy-top offset (+PI/6)
        // Raw rotation = targetAngle - baseAngle
        const raw = -5 * Math.PI / 6 + Math.PI / 6 - baseAngle;
        // Snap to nearest 30° (PI/6) increment so hex rows stay perfectly aligned
        const step = Math.PI / 6;
        return Math.round(raw / step) * step;
      }
    }
    return 0;
  }, [gameState.grid.tiles]);
  const [gridRotation, setGridRotation] = useState(() => computeBaseRotation(gameState.player_order[activePlayerIndex]));
  const handleRotateGrid = useCallback(() => {
    setGridRotation(prev => prev + Math.PI / 6); // +30 degrees clockwise
  }, []);
  const handleRotateGridReverse = useCallback(() => {
    setGridRotation(prev => prev - Math.PI / 6); // -30 degrees counter-clockwise
  }, []);

  // "Drag a card" hint — shown once per round if no card played after 5s in play phase
  const [showDragHint, setShowDragHint] = useState(false);
  const playedTargetlessRef = useRef(false);

  // Reset targetless tracking each round
  useEffect(() => {
    playedTargetlessRef.current = false;
  }, [gameState.current_round]);

  // Show drag hint when a non-targeting engine card is selected and can be played
  useEffect(() => {
    if (phase !== 'play' || !activePlayer || playSubmitted || resolving || phaseBanner || showIntro || introSequence !== 'done') {
      setShowDragHint(false);
      return;
    }
    if (selectedCardIndex === null) {
      setShowDragHint(false);
      return;
    }
    const card = activePlayer.hand[selectedCardIndex];
    if (!card) { setShowDragHint(false); return; }
    // Only for non-targeting cards (engine without target, or non-claim/defense)
    const isTargetless = card.card_type === 'engine' && !needsOpponentTarget(card) && !card.target_own_tile;
    if (!isTargetless) { setShowDragHint(false); return; }
    // Don't show if already played a targetless card this round
    if (playedTargetlessRef.current) { setShowDragHint(false); return; }
    // Check player has actions remaining
    const actionsUsed = activePlayer.planned_actions?.length ?? 0;
    if (actionsUsed >= activePlayer.actions_available) { setShowDragHint(false); return; }
    setShowDragHint(true);
  }, [phase, activePlayer, resolving, phaseBanner, showIntro, introSequence, selectedCardIndex]);

  // Build subtitle context for dynamic card value resolution
  const subtitleContext: CardSubtitleContext = useMemo(() => {
    // Count Debt cards in hand + draw pile + discard (not trash)
    const debtCount = [...activePlayer.hand, ...activePlayer.deck_cards, ...activePlayer.discard]
      .filter(c => c.name === 'Debt').length;
    // Names of cards already played this round (for conditional_action_return)
    const playedCardNames = activePlayer.planned_actions?.map(a => a.card.name) ?? [];
    // Strike Team: whether any Claim has already been played this round
    const hasPlayedClaimThisRound = (activePlayer.planned_actions ?? [])
      .some(a => a.card.card_type === 'claim');
    return {
      claimsWonLastRound: activePlayer.claims_won_last_round,
      tileCount: activePlayer.tile_count,
      handSize: activePlayer.hand.length,
      defenseCardsInHand: activePlayer.hand.filter(c => c.card_type === 'defense').length,
      // Watchful Keep: only defense *bonuses* count (above intrinsic base/VP-hex defense)
      tilesWithDefenseOwned: gameState.grid
        ? Object.values(gameState.grid.tiles).filter(t =>
            t.owner === activePlayerId && (t.defense_power > t.base_defense || t.permanent_defense_bonus > 0)
          ).length
        : 0,
      trashCount: activePlayer.trash?.length ?? 0,
      totalDeckCards: activePlayer.deck_size + activePlayer.hand.length + activePlayer.discard_count,
      resourcesHeld: activePlayer.resources,
      tilesLostLastRound: activePlayer.tiles_lost_last_round,
      tilesCapturedFromOpponentsLastRound: activePlayer.tiles_captured_from_opponents_last_round,
      vpHexCount: gameState.grid ? countConnectedVpTiles(gameState.grid.tiles, activePlayerId) : 0,
      debtCount,
      playedCardNames,
      hasPlayedClaimThisRound,
    };
  }, [activePlayer.claims_won_last_round, activePlayer.tiles_lost_last_round, activePlayer.tile_count, activePlayer.hand, activePlayer.trash, activePlayer.deck_size, activePlayer.deck_cards, activePlayer.discard, activePlayer.discard_count, activePlayer.resources, gameState.grid?.tiles, activePlayerId, activePlayer.planned_actions]);

  // Context for played/revealed cards: power is already frozen on card.power, skip re-resolution
  const frozenSubtitleContext: CardSubtitleContext = useMemo(() => ({
    ...subtitleContext,
    powerFrozen: true,
  }), [subtitleContext]);

  // Restore discard mode on reconnect/refresh if player has a pending discard
  useEffect(() => {
    if (!activePlayer || activePlayer.pending_discard <= 0) return;
    if (trashMode) return;
    const required = Math.min(activePlayer.pending_discard, activePlayer.hand.length);
    if (required <= 0) return;
    setTrashMode({
      cardIndex: -1,
      effectType: 'self_discard',
      minCards: required,
      maxCards: required,
      label: 'Discard',
      pendingDiscard: true,
    });
    setTrashSelectedIndices(new Set());
    setSelectedCardIndex(null);
  }, [activePlayer?.pending_discard]); // eslint-disable-line react-hooks/exhaustive-deps

  // Card lookup maps for purchase hover previews. We index by both per-instance
  // `id` and stable `definition_id` so purchase records (which may have been
  // recorded under either) resolve without falling back to display names.
  const { cardById, cardByDefinition } = useMemo(() => {
    const byId = new Map<string, import('../types/game').Card>();
    const byDef = new Map<string, import('../types/game').Card>();
    const register = (c: import('../types/game').Card) => {
      byId.set(c.id, c);
      if (c.definition_id) byDef.set(c.definition_id, c);
    };
    for (const stack of gameState.shared_market) register(stack.card);
    for (const p of Object.values(gameState.players)) {
      for (const c of p.hand) register(c);
      for (const c of p.discard) register(c);
      for (const c of p.deck_cards) register(c);
      for (const c of p.archetype_market) register(c);
      for (const c of p.trash ?? []) register(c);
    }
    return { cardById: byId, cardByDefinition: byDef };
  }, [gameState.shared_market, gameState.players]);

  // Enrich purchase records with card_type for pill border colors
  const enrichPurchases = useCallback((purchases?: Array<{ card_id: string; definition_id?: string; card_name: string; source: string; cost: number }>) => {
    if (!purchases) return undefined;
    return purchases.map(p => {
      const card = cardById.get(p.card_id)
        ?? (p.definition_id ? cardByDefinition.get(p.definition_id) : undefined);
      return { ...p, card_type: card?.card_type };
    });
  }, [cardById, cardByDefinition]);

  const handlePurchaseHover = useCallback((e: React.MouseEvent, cardId: string, definitionId?: string) => {
    const card = cardById.get(cardId)
      ?? (definitionId ? cardByDefinition.get(definitionId) : undefined);
    if (!card) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPurchaseHoverVisible(false);
    setPurchaseHover({ card, rect });
  }, [cardById, cardByDefinition]);

  const handlePurchaseLeave = useCallback(() => {
    setPurchaseHover(null);
    setPurchaseHoverVisible(false);
  }, []);

  // Delayed fade-in for purchase hover preview (matches shop behavior)
  useEffect(() => {
    if (!purchaseHover) return;
    const timer = setTimeout(() => setPurchaseHoverVisible(true), 150);
    return () => clearTimeout(timer);
  }, [purchaseHover]);

  // Clear purchase hover when leaving buy phase
  useEffect(() => {
    if (phase !== 'buy') {
      setPurchaseHover(null);
      setPurchaseHoverVisible(false);
    }
  }, [phase]);


  // Close settings dropdown on outside click
  useEffect(() => {
    if (!settingsExpanded) return;
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsExpanded(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [settingsExpanded]);

  // Show game over overlay when winner is set
  useEffect(() => {
    if (gameState.winner && !showGameOver) {
      // Small delay so the final state update renders first
      const t = setTimeout(() => setShowGameOver(true), 500);
      return () => clearTimeout(t);
    }
  }, [gameState.winner, showGameOver]);

  // Replay restart: when game ID changes (new game), reset overlays and show intro
  const prevGameIdRef = useRef(gameState.id);
  useEffect(() => {
    if (gameState.id !== prevGameIdRef.current) {
      prevGameIdRef.current = gameState.id;
      setShowGameOver(false);
      setShowIntro(true);
      setIntroSequence('overlay');
    }
  }, [gameState.id]);

  // Capture revealed_actions when game state includes them (REVEAL phase)
  useEffect(() => {
    if (gameState.revealed_actions) {
      revealedActionsRef.current = gameState.revealed_actions;
    }
  }, [gameState.revealed_actions]);

  // The state to feed to HexGrid during resolve animations (shows incremental tile changes)
  const displayState = resolveDisplayState ?? gameState;

  // Phase change detection → show phase banner or trigger resolve animation
  // useLayoutEffect so resolveDisplayState is set before browser paint (avoids flash of post-resolve tiles)
  useLayoutEffect(() => {
    const prev = prevPhaseRef.current;
    const oldTiles = prevTilesRef.current;
    const oldPlayers = prevPlayersRef.current;
    if (prev === phase) {
      // Phase unchanged — still update tiles/players snapshot for future diffs
      prevTilesRef.current = gameState.grid.tiles;
      prevPlayersRef.current = gameState.players;
      return;
    }
    // Don't show banner during intro overlay or intro animation sequence
    if (showIntro || introSequence !== 'done') return;
    // Don't show banner if currently resolving (resolve has its own banner flow)
    if (resolving) return;
    // Don't trigger if a banner is already active (e.g. reveal→buy chain).
    // IMPORTANT: don't update prevPhaseRef or prevTilesRef here — we need
    // to re-detect this phase change once the current banner completes.
    if (phaseBanner) return;
    // Commit: we're handling this phase transition now
    prevPhaseRef.current = phase;
    if (phase !== 'reveal') resolveResourceSourcesRef.current = null;
    prevTilesRef.current = gameState.grid.tiles;
    prevPlayersRef.current = gameState.players;

    // play → reveal: set up resolve animation
    if (prev === 'play' && phase === 'reveal') {
      // My cards that pay out resources as they resolve: when the resolve
      // finishes, those coins fly in from their tiles.
      resolveResourceSourcesRef.current = (gameState.players[activePlayerId]?.planned_actions ?? [])
        .filter(a => a.card.timing === 'on_resolution'
          && ((a.effective_resource_gain ?? a.card.resource_gain) > 0
            || !!a.card.effects?.some(e => e.type.includes('resource') && e.type !== 'resource_drain' && e.type !== 'play_resource_cost')))
        .map(a => ({
          tileKey: a.target_q != null && a.target_r != null ? `${a.target_q},${a.target_r}` : null,
          weight: Math.max(1, a.effective_resource_gain ?? a.card.resource_gain ?? 1),
        }));
      // Immediately freeze the grid AND player stats at pre-resolve state so
      // players can't see updated VP/resources until animations have played out.
      const preResolveState: GameState = {
        ...gameState,
        grid: { ...gameState.grid, tiles: { ...oldTiles } },
        players: { ...oldPlayers },
      };
      // Capture each player's card-only VP so tile VP can be recomputed per step
      const cardVpMap: Record<string, number> = {};
      for (const pid of gameState.player_order) {
        const { tileCount, bonusTiles } = computeTileBasedVp(oldTiles, pid);
        cardVpMap[pid] = Math.max(0, (oldPlayers[pid]?.vp ?? 0) - tileCount - bonusTiles);
      }
      preResolveCardVpRef.current = cardVpMap;
      setResolveDisplayState(preResolveState);

      // Full reveal setup (banner, chevrons, VP paths, resolve overlay)
      const doRevealSetup = () => {
        const steps = gameState.resolution_steps;
        const hasSteps = steps && steps.length > 0;
        // Everyone's played cards turn face up over their tiles.
        beginRevealRef.current(gameState);

        if (hasSteps && !animationOff) {
          setSelectedCardIndex(null);
          // Rewrite each claimant's source_q/source_r using PRE-RESOLVE tile
          // ownership. The backend fills these fields while stepping through
          // resolution, so by step N the "closest owned tile" for a player
          // may be one they won EARLIER in the same turn. For animation
          // purposes (chevron source, wedge approach direction) we want the
          // arrow to originate from tiles the player actually held going
          // into the turn — tiles won this turn must not count.
          const rewritten = steps.map(s => ({
            ...s,
            claimants: s.claimants.map(c => {
              // auto_claim (e.g. Breakthrough) originates from the tile the
              // card was played on, not a pre-existing owned tile. The backend
              // sets source_q/source_r to that played-on tile — preserve it.
              if (s.outcome === 'auto_claim') {
                return c;
              }
              const src = findNearestOwnedTile(s.q, s.r, oldTiles, c.player_id);
              return {
                ...c,
                source_q: src?.q ?? null,
                source_r: src?.r ?? null,
              };
            }),
          }));
          setResolutionSteps(rewritten);
          setGridTransformSnapshot(gridTransformRef.current);
          setGridRectSnapshot(gridContainerRef.current?.getBoundingClientRect() ?? null);
          setResolving(true);
          setInteractionBlocked(true);
          setBannerSubtitle('Battle & Expand');
          setPhaseBanner('reveal');
          // Pre-compute chevron sources using pre-resolve tile state
          const cachedChevrons: typeof resolveChevronCacheRef.current = [];
          for (let i = 0; i < steps.length; i++) {
            const step: ResolutionStep = steps[i];
            if (step.outcome === 'defense_applied') continue;
            const targetKey = `${step.q},${step.r}`;
            for (const claimant of step.claimants) {
              // Skip chevron for players claiming a tile they already own
              // (defensive play) — no directional arrow needed.
              if (oldTiles[targetKey]?.owner === claimant.player_id) continue;
              const color = PLAYER_COLORS[claimant.player_id] ?? 0xffffff;
              // Nearest pre-resolve tile (base for long-range claims); a
              // Breakthrough spill-over advances from its played-on tile.
              const source = chevronSource(step, claimant, oldTiles);
              if (!source) continue;
              cachedChevrons.push({
                targetQ: step.q, targetR: step.r,
                sourceQ: source.q, sourceR: source.r,
                color, stepIndex: i,
              });
            }
          }
          resolveChevronCacheRef.current = cachedChevrons;
          setChevronAlpha(0);
          setChevronRevealPhase(true);
          // Initialize VP paths for all players
          setResolveLogEntries([]);
          const allVpPaths: VpPath[] = [];
          for (const pid of gameState.player_order) {
            const color = PLAYER_COLORS[pid] ?? 0xffffff;
            allVpPaths.push(...computePlayerVpPaths(oldTiles, pid, color).map(p => ({ ...p, noPulse: true })));
          }
          if (allVpPaths.length > 0) {
            setVpPaths(allVpPaths);
            setVpPathPhase('fading_in');
          }
        } else {
          // No claim steps or animations off — show reveal banner briefly, then transition to buy
          // Clear the pre-resolve freeze so the grid shows post-resolve state
          if (!animationOff) setTimeout(() => flyRevealCardsRef.current(() => true, 80), 1300 * resolveSpeed);
          setResolveDisplayState(null);
          setInteractionBlocked(true);
          setBannerSubtitle('Battle & Expand');
          setPhaseBanner('reveal');
        }
      };

      doRevealSetup();
      return;
    }

    // Show banners for main phases (all animation modes including off)
    const bannerPhases = ['upkeep', 'play', 'buy'];
    if (bannerPhases.includes(phase)) {
      // Set subtitle per phase
      if (phase === 'upkeep') {
        const maxRounds = gameState.max_rounds ?? 20;
        setBannerLabelOverride(`Round ${gameState.current_round} of ${maxRounds}`);
        if (gameState.current_round < DEBT_START_ROUND) {
          const roundsUntil = DEBT_START_ROUND - gameState.current_round;
          setBannerSubtitle(`${roundsUntil} round${roundsUntil > 1 ? 's' : ''} until Debt is given to leader`);
          setBannerHoldUntilRelease(false);
        } else {
          const recipient = findDebtRecipientFromLog(gameState);
          setBannerSubtitle(recipient ? `Debt given to ${recipient.name}` : 'Debt given to leader');
          // Hold banner for debt card fly animation (unless animations off)
          setBannerHoldUntilRelease(!animationOff);
        }
      } else if (phase === 'play') {
        setBannerSubtitle(null);
      } else if (phase === 'buy') {
        setBannerSubtitle('Grow Your Deck');
      } else {
        setBannerSubtitle(null);
      }
      setPhaseBanner(phase);
      setInteractionBlocked(true);
    }
  }, [phase, animationOff, resolving, phaseBanner, gameState, showIntro, introSequence, activePlayerId, onStateUpdate]);

  // Submit button fade-in: hide when phase changes, fade in after banner clears
  useEffect(() => {
    if (phase === 'play' && !phaseBanner && !resolving && !showIntro) {
      // Banner just cleared — trigger fade-in after a brief delay
      const timer = setTimeout(() => setSubmitButtonVisible(true), 50);
      return () => clearTimeout(timer);
    }
    setSubmitButtonVisible(false);
  }, [phase, phaseBanner, resolving, showIntro]);

  // Buy button fade-in: hide when phase changes, fade in after banner clears
  useEffect(() => {
    if (phase === 'buy' && !phaseBanner && !resolving) {
      const timer = setTimeout(() => setBuyButtonVisible(true), 50);
      return () => clearTimeout(timer);
    }
    setBuyButtonVisible(false);
  }, [phase, phaseBanner, resolving]);

  // Chevron reveal animation: once the reveal banner clears, fade in all claim
  // chevrons (with every played card face up over its tile) before the
  // resolve overlay starts.
  const revealHoldMs = revealCards && revealCards.length > 0 ? 1100 : 300;
  useEffect(() => {
    if (!chevronRevealPhase || phaseBanner) return;
    const duration = Math.round(1500 * resolveSpeed);

    if (duration === 0) {
      setChevronAlpha(1);
      setChevronRevealPhase(false);
      return;
    }

    const startTime = performance.now();
    const intervalId = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out for smooth fade-in
      const eased = 1 - Math.pow(1 - progress, 2);
      setChevronAlpha(eased);

      if (progress >= 1) {
        clearInterval(intervalId);
        // Pause at full visibility (longer when cards were revealed, so
        // players can see what landed where), then resolve.
        setTimeout(() => setChevronRevealPhase(false), Math.round(revealHoldMs * (resolveSpeed || 1)));
      }
    }, 50);

    return () => clearInterval(intervalId);
  // revealHoldMs is read once when the fade starts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chevronRevealPhase, animationMode, phaseBanner]);

  // Chevron fade-out during resolution step animation
  useEffect(() => {
    if (resolvedUpToStep < 0) return;
    const duration = Math.round(1000 * resolveSpeed);

    if (duration === 0) {
      setCurrentStepFade(0);
      return;
    }

    const startTime = performance.now();
    setCurrentStepFade(1);
    const intervalId = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      setCurrentStepFade(1 - progress);
      if (progress >= 1) clearInterval(intervalId);
    }, 50);

    return () => clearInterval(intervalId);
  }, [resolvedUpToStep, animationMode]);

  // VP path fade-in animation
  useEffect(() => {
    if (vpPathPhase !== 'fading_in') return;
    const duration = Math.round(800 * resolveSpeed);
    if (duration === 0) {
      setVpPaths(prev => prev.map(p => ({ ...p, alpha: 1 })));
      setVpPathPhase('visible');
      return;
    }
    vpPathFadeStartRef.current = performance.now();
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - vpPathFadeStartRef.current) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 2); // ease-out
      setVpPaths(prev => prev.map(p => ({ ...p, alpha: eased })));
      if (progress >= 1) {
        clearInterval(id);
        setVpPathPhase('visible');
      }
    }, 50);
    return () => clearInterval(id);
  }, [vpPathPhase, animationMode]);

  // VP path fade-out animation
  useEffect(() => {
    if (vpPathPhase !== 'fading_out') return;
    const duration = Math.round(500 * resolveSpeed);
    if (duration === 0) {
      setVpPaths([]);
      setVpPathPhase('off');
      return;
    }
    const startAlpha = vpPathFadeStartAlphaRef.current;
    vpPathFadeStartRef.current = performance.now();
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - vpPathFadeStartRef.current) / duration, 1);
      setVpPaths(prev => {
        if (progress >= 1) return [];
        return prev.map(p => ({ ...p, alpha: startAlpha * (1 - progress) }));
      });
      if (progress >= 1) {
        clearInterval(id);
        setVpPathPhase('off');
      }
    }, 50);
    return () => clearInterval(id);
  }, [vpPathPhase, animationMode]);

  // VP path breaking animation — quickly fade out individual broken paths
  const breakingCount = vpPaths.filter(p => p.breaking && p.alpha > 0).length;
  useEffect(() => {
    if (breakingCount === 0) return;
    const duration = 300;
    const startTime = performance.now();
    const startAlphas = vpPaths.map(p => p.alpha);
    const id = setInterval(() => {
      const progress = Math.min((performance.now() - startTime) / duration, 1);
      setVpPaths(prev => prev.map((p, i) => {
        if (!p.breaking) return p;
        return { ...p, alpha: Math.max(0, startAlphas[i] * (1 - progress)) };
      }));
      if (progress >= 1) clearInterval(id);
    }, 30);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [breakingCount]);

  // Show VP paths for ALL players during all phases EXCEPT reveal.
  // During reveal, the resolve flow (doRevealSetup → handleResolveComplete)
  // manages VP paths itself: it freezes the pre-resolve set, then refreshes
  // them with the post-resolve tile state once the animation finishes.
  // Without the explicit phase gate this effect would briefly flash the
  // updated VP roads the moment the new state arrives — before `resolving`
  // is even set to true.
  useEffect(() => {
    if (resolving || phase === 'reveal') return;
    const tiles = gameState.grid?.tiles;
    if (!tiles) return;
    const allPaths: VpPath[] = [];
    for (const pid of gameState.player_order) {
      const color = PLAYER_COLORS[pid] ?? 0xffffff;
      const playerPaths = computePlayerVpPaths(tiles, pid, color);
      allPaths.push(...playerPaths);
    }
    if (allPaths.length > 0) {
      setVpPaths(allPaths);
      setVpPathPhase('fading_in');
    } else {
      setVpPaths([]);
      setVpPathPhase('off');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, gameState.grid?.tiles, resolving]);

  // Compute which VP tiles are connected to their owner's base (for star rendering)
  const connectedVpTiles = useMemo(() => {
    const tiles = displayState.grid?.tiles;
    if (!tiles) return new Set<string>();

    const connected = new Set<string>();
    const playerIds = gameState.player_order;

    for (const pid of playerIds) {
      // Find base tiles for this player
      const baseKeys: string[] = [];
      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.is_base && tile.owner === pid) baseKeys.push(key);
      }
      if (baseKeys.length === 0) continue;

      // BFS from base tiles through owned territory
      const reachable = new Set<string>(baseKeys);
      const queue = [...baseKeys];

      while (queue.length > 0) {
        const key = queue.shift()!;
        const tile = tiles[key];
        if (!tile) continue;
        for (const [dq, dr] of HEX_DIRS) {
          const nk = `${tile.q + dq},${tile.r + dr}`;
          if (reachable.has(nk)) continue;
          const neighbor = tiles[nk];
          if (!neighbor || neighbor.owner !== pid) continue;
          reachable.add(nk);
          queue.push(nk);
        }
      }

      // Mark reachable VP tiles as connected
      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.is_vp && tile.owner === pid && reachable.has(key)) {
          connected.add(key);
        }
      }
    }

    return connected;
  }, [displayState.grid?.tiles, gameState.player_order]);

  // Ref tracking latest resolve display tiles (for VP path recomputation in applyResolveStep)
  const resolveDisplayTilesRef = useRef<Record<string, import('../types/game').HexTile> | null>(null);
  useEffect(() => {
    resolveDisplayTilesRef.current = resolveDisplayState?.grid?.tiles ?? null;
  }, [resolveDisplayState]);

  // Keep grid rect up to date for resolve overlay positioning
  useEffect(() => {
    const el = gridContainerRef.current;
    if (!el) return;
    const update = () => setGridRect(el.getBoundingClientRect());
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-open shop when entering buy phase (only for reconnection or animations-off).
  // During normal flow, shop opening is handled by handleBannerComplete or the buyer-change effect.
  // Use a ref to skip the first render after a phase change (the banner effect needs time to set up).
  // shopAutoOpenedRef prevents re-opening the shop on subsequent state updates (e.g. other players finishing).
  const buyPhaseStableRef = useRef(phase === 'buy');
  const shopAutoOpenedRef = useRef(false);
  useEffect(() => {
    if (phase === 'buy') {
      if (buyPhaseStableRef.current && !shopAutoOpenedRef.current && !resolving && !phaseBanner && !interactionBlocked && activePlayerEffects.length === 0
          && !gameState.players_done_buying.includes(activePlayerId)) {
        setShowShopOverlay(true);
        shopAutoOpenedRef.current = true;
      }
      // Mark as stable on next tick so subsequent renders can open the shop
      const timer = setTimeout(() => { buyPhaseStableRef.current = true; }, 0);
      return () => clearTimeout(timer);
    } else {
      buyPhaseStableRef.current = false;
      shopAutoOpenedRef.current = false;
    }
  }, [phase, resolving, phaseBanner, interactionBlocked, activePlayerEffects, activePlayerId, gameState.players_done_buying]);

  // Auto-enter review mode when reconnecting into REVEAL phase (resolve animations already happened)
  const revealStableRef = useRef(phase === 'reveal');
  useEffect(() => {
    if (phase === 'reveal') {
      if (revealStableRef.current && !resolving && !reviewing && !phaseBanner && !showIntro) {
        setReviewing(true);
        setInteractionBlocked(false);
      }
      const timer = setTimeout(() => { revealStableRef.current = true; }, 0);
      return () => clearTimeout(timer);
    } else {
      revealStableRef.current = false;
      // Clear review mode when leaving reveal phase (e.g. WebSocket pushed buy phase)
      if (reviewing) setReviewing(false);
    }
  }, [phase, resolving, reviewing, phaseBanner, showIntro]);

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

  /** Actually send the play-card API call (after any trash/discard selection is complete). */
  const executePlayCard = useCallback(async (
    cardIndex: number,
    q?: number, r?: number,
    extraTargets?: [number, number][],
    targetPlayerId?: string,
    trashIndices?: number[],
    discardIndices?: number[],
    searchSelections?: SearchSelection[],
  ) => {
    if (phase !== 'play' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;
    setTrashedCardIds(new Set());

    // Track which cards are being trashed for tear animation
    const trashing = new Set<string>();
    if (card.trash_on_use) trashing.add(card.id);
    if (trashIndices) {
      // trashIndices are post-removal indices (after played card popped) — map back to hand
      for (const ti of trashIndices) {
        const adjustedIdx = ti >= cardIndex ? ti + 1 : ti;
        const tc = activePlayer.hand[adjustedIdx];
        if (tc) trashing.add(tc.id);
      }
    }
    if (trashing.size > 0) {
      setTrashedCardIds(trashing);
      sound.cardTrash();
    }

    // Compute screen position for card animation
    const drag = dragReleaseRef.current;
    dragReleaseRef.current = null;
    // The played card's board copy appears once its flight lands on it.
    if (animated) {
      setArrivingIds(prev => new Set(prev).add(card.id));
      setTimeout(() => setArrivingIds(prev => {
        if (!prev.has(card.id)) return prev;
        const next = new Set(prev);
        next.delete(card.id);
        return next;
      }), Math.round(520 * animSpeed) + 40);
    }
    const anchor = q != null && r != null ? boardControlsRef.current?.tileAnchor(`${q},${r}`) : null;
    /** Where the played card lands (coins it earns fly from here). */
    let landing: { x: number; y: number } | null = null;
    if (q != null && r != null && anchor) {
      // Fly onto the tile's card stack, into the slot it will take in the fan.
      const key = `${q},${r}`;
      const onTile = activePlayer.planned_actions.filter(a =>
        (a.target_q === q && a.target_r === r) || a.extra_targets?.some(([eq, er]) => `${eq},${er}` === key)).length;
      const n = onTile + 1;
      const sc = boardCardScale(anchor.zoom);
      landing = { x: anchor.x + fanOffset(n - 1, n, sc), y: anchor.below ? anchor.y + (CARD_H * sc) / 2 : anchor.y - (CARD_H * sc) / 2 };
      setLastPlayedTarget({
        cardId: card.id,
        screenX: anchor.x + fanOffset(n - 1, n, sc),
        screenY: anchor.below ? anchor.y + (CARD_H * sc) / 2 : anchor.y - (CARD_H * sc) / 2,
        landScale: sc,
        ...(drag ? { dragX: drag.x, dragY: drag.y, dragVelocityX: drag.vx, dragVelocityY: drag.vy } : {}),
      });
    } else if (q != null && r != null) {
      const transform = gridTransformRef.current;
      const gRect = gridContainerRef.current?.getBoundingClientRect();
      if (transform && gRect) {
        const local = axialToPixel(q, r);
        const containerW = gRect.width;
        const containerH = gRect.height;
        const screen = localToScreen(local.x, local.y, transform, containerW, containerH, gRect);
        const screenX = screen.x;
        const screenY = screen.y;
        landing = { x: screenX, y: screenY };
        setLastPlayedTarget({
          cardId: card.id, screenX, screenY,
          ...(drag ? { dragX: drag.x, dragY: drag.y, dragVelocityX: drag.vx, dragVelocityY: drag.vy } : {}),
        });
      }
    } else {
      // Non-targeting card (engine) — fly into the next slot of the queue under the ID card
      const queued = activePlayer.planned_actions.filter(a => a.target_q == null).length;
      const slotW = CARD_W * QUEUE_CARD_SCALE;
      const slotH = CARD_H * QUEUE_CARD_SCALE;
      const queueRect = inPlayContainerRef.current?.getBoundingClientRect();
      const panelRect = playerPanelRef.current?.getBoundingClientRect();
      // Queue panel: 6px padding, a 15px title, 3 cards per row with 6px gaps.
      const originX = queueRect ? queueRect.left : panelRect ? panelRect.left + 6 : null;
      const originY = queueRect ? queueRect.top + 15 : panelRect ? panelRect.bottom + 6 + 6 + 15 : null;
      if (originX != null && originY != null) {
        landing = { x: originX + (queued % 3) * (slotW + 6) + slotW / 2, y: originY + Math.floor(queued / 3) * (slotH + 6) + slotH / 2 };
      }
      setLastPlayedTarget({
        cardId: card.id,
        screenX: originX != null ? originX + (queued % 3) * (slotW + 6) + slotW / 2 : null,
        screenY: originY != null ? originY + Math.floor(queued / 3) * (slotH + 6) + slotH / 2 : null,
        landScale: originX != null ? QUEUE_CARD_SCALE : undefined,
        ...(drag ? { dragX: drag.x, dragY: drag.y, dragVelocityX: drag.vx, dragVelocityY: drag.vy } : {}),
      });
    }

    // Resources the card earns fly from where it lands into the bank, as it
    // lands (the new state may come by socket before the response does).
    resourceCounterRef.current?.expect({
      from: () => landing,
      launchAt: performance.now() + (animated ? Math.round(520 * animSpeed) + 60 : 0),
    });

    try {
      setError(null);
      const result = await api.playCard(
        gameState.id, activePlayerId, cardIndex,
        q, r, targetPlayerId, extraTargets,
        trashIndices, discardIndices, searchSelections,
      );
      // Spawn floating action icon — card costs N actions
      {
        const id = ++floatingActionIdRef.current;
        const offsetX = (Math.random() - 0.5) * 24;
        const offsetY = (Math.random() - 0.5) * 8;
        setFloatingActions(prev => [...prev, { id, offsetX, offsetY, type: 'spend' as const, amount: card.action_cost }]);
        setTimeout(() => setFloatingActions(prev => prev.filter(a => a.id !== id)), 900);
      }
      // Spawn floating "+action" icons if the card grants actions back
      const actionsGained = card.action_return ?? 0;
      for (let i = 0; i < actionsGained; i++) {
        const id = ++floatingActionIdRef.current;
        const offsetX = (Math.random() - 0.5) * 24;
        const offsetY = (Math.random() - 0.5) * 8;
        const delay = 250 + i * 150;
        setTimeout(() => {
          setFloatingActions(prev => [...prev, { id, offsetX, offsetY, type: 'gain' as const, amount: 1 }]);
          setTimeout(() => setFloatingActions(prev => prev.filter(a => a.id !== id)), 900);
        }, delay);
      }
      onStateUpdate(result.state);
      // Check for deferred discard (e.g. Regroup: draw first, then pick discard)
      const updatedPlayer = result.state.players[activePlayerId];
      if (updatedPlayer && updatedPlayer.pending_discard > 0) {
        setTrashMode({
          cardIndex: -1, // card already played — no card to exclude
          effectType: 'self_discard',
          minCards: Math.min(updatedPlayer.pending_discard, updatedPlayer.hand.length),
          maxCards: Math.min(updatedPlayer.pending_discard, updatedPlayer.hand.length),
          label: 'Discard',
          pendingDiscard: true,
        });
        setTrashSelectedIndices(new Set());
        setSelectedCardIndex(null);
      } else {
        // Auto-select the next card in hand (card to the right, or left if
        // last) — on desktop only. On touch screens a selected card lifts and
        // shows its tooltips over the board, so after a play the hand rests
        // until the player picks the next card themselves.
        const newHand = updatedPlayer?.hand;
        if (newHand && newHand.length > 0 && !isMobile) {
          const visualOrder = handVisualOrderRef.current;
          const oldHandLength = newHand.length + 1;
          if (visualOrder.length === oldHandLength) {
            const visualPos = visualOrder.indexOf(cardIndex);
            if (visualPos !== -1) {
              // Pick the right neighbor, or left neighbor if this was the rightmost card
              const targetVisualPos = visualPos < oldHandLength - 1 ? visualPos : visualPos - 1;
              const oldIdx = visualOrder[targetVisualPos];
              // Adjust for the removed card shifting all higher indices down by 1
              setSelectedCardIndex(oldIdx > cardIndex ? oldIdx - 1 : oldIdx);
            } else {
              setSelectedCardIndex(Math.min(cardIndex, newHand.length - 1));
            }
          } else {
            setSelectedCardIndex(Math.min(cardIndex, newHand.length - 1));
          }
        } else {
          setSelectedCardIndex(null);
        }
        setTrashMode(null);
        setTrashSelectedIndices(new Set());
      }
      setMultiTileTargets([]);
      setMultiTileCardIndex(null);
      setMultiTilePrimaryTarget(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [phase, activePlayer, gameState.id, activePlayerId, onStateUpdate]);

  /** Enter trash/discard selection mode if the card requires it, otherwise play immediately. */
  /**
   * If the card has a SEARCH_ZONE (tutor) effect, route the play through the
   * appropriate pre-play search flow.
   *
   * Two paths:
   *   1. Partial draw peeks (top N) — commit the play to the backend
   *      IMMEDIATELY (no selections yet). The backend sets pending_search
   *      and the modal opens via the server-driven path. Refreshing the
   *      page can't bypass it: pending_search is on the server, the modal
   *      will re-open, and the play has already cost an action.
   *   2. All others (discard/trash/whole-pile peek) — pre-play mode: show
   *      the modal locally without touching the backend. Cancel keeps the
   *      card in hand. The information shown either is already public
   *      (discard/trash) or only reveals the SET (peek_all) which the
   *      player could already infer, so refreshing-to-cancel is harmless.
   *
   * Returns true if search mode was entered (caller should skip executePlayCard).
   */
  const maybeEnterPileSearchMode = useCallback(async (
    cardIndex: number,
    targetQ?: number, targetR?: number,
    extraTargets?: [number, number][],
    targetPlayerId?: string,
  ): Promise<boolean> => {
    if (!activePlayer) return false;
    const card = activePlayer.hand[cardIndex];
    if (!card) return false;
    const pending = buildPrePlaySearch(card, {
      discard: activePlayer.discard ?? [],
      deck_cards: activePlayer.deck_cards ?? [],
      trash: activePlayer.trash ?? [],
    });
    if (!pending) return false;

    const isPartialDrawPeek = pending.source === 'draw' && !pending.peek_all;
    if (isPartialDrawPeek) {
      // Server-commit-first path: play the card with no selections; backend
      // sets pending_search; modal opens via the server-driven render.
      setSelectedCardIndex(null);
      await executePlayCard(cardIndex, targetQ, targetR, extraTargets, targetPlayerId);
      return true;
    }

    // Local pre-play path: show modal immediately, commit on confirm.
    setPrePlaySearchMode({
      cardIndex, targetQ, targetR, targetPlayerId, extraTargets,
      pending,
    });
    setSelectedCardIndex(null);
    return true;
  }, [activePlayer, executePlayCard]);

  const maybeEnterTrashMode = useCallback((
    cardIndex: number,
    choiceReq: ReturnType<typeof getCardChoiceRequirement>,
    targetQ?: number, targetR?: number,
    extraTargets?: [number, number][],
    targetPlayerId?: string,
  ) => {
    if (!choiceReq || !activePlayer) return false;
    // Cap maxCards to number of other cards in hand (exclude the played card)
    const otherCardsCount = activePlayer.hand.length - 1;
    const maxCards = Math.min(choiceReq.maxCards, otherCardsCount);
    const minCards = Math.min(choiceReq.minCards, otherCardsCount);
    if (maxCards <= 0 && minCards <= 0) return false;  // no cards to choose from
    setTrashMode({
      cardIndex,
      targetQ, targetR,
      targetPlayerId,
      extraTargets,
      effectType: choiceReq.effectType,
      minCards,
      maxCards,
      label: choiceReq.label,
    });
    setTrashSelectedIndices(new Set());
    setSelectedCardIndex(null);
    return true;
  }, [activePlayer]);

  const playCardAtTile = useCallback(async (cardIndex: number, q: number, r: number, extraTargets?: [number, number][], targetPlayerId?: string) => {
    if (phase !== 'play' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Global claim ban (Snowy Holiday)
    if (card.card_type === 'claim' && gameState.claim_ban_rounds && gameState.claim_ban_rounds > 0) {
      setError('Claim cards are banned this round (Snowy Holiday)');
      return;
    }

    // Play resource cost (e.g. Mercenary)
    const playCostEff = card.effects?.find((e: any) => e.type === 'play_resource_cost');
    if (playCostEff) {
      const cost = (card.is_upgraded && playCostEff.upgraded_value != null) ? playCostEff.upgraded_value : playCostEff.value;
      if ((activePlayer.resources ?? 0) < cost) {
        setError(`Need ${cost} resources to play ${plainCardName(card.name)}`);
        return;
      }
    }

    // Action cost check (heavy cards cost 2 actions)
    const actionCost = card.action_cost ?? 1;
    if (actionCost > 1) {
      const actionsLeft = activePlayer.actions_available - activePlayer.actions_used;
      if (actionsLeft < actionCost) {
        setError(`Need ${actionCost} actions to play ${plainCardName(card.name)}`);
        return;
      }
    }

    // Validate the tile is a legal target before entering any card choice UI (e.g. Demon Pact trash selection).
    // This prevents the player from selecting trash cards only to have the play rejected.
    const tileKey = `${q},${r}`;
    const tile = gameState.grid?.tiles[tileKey];
    if (!tile || tile.is_blocked) {
      setError(`${plainCardName(card.name)} cannot target that tile`);
      return;
    }
    if (card.card_type === 'claim') {
      // Check adjacency/range requirement
      if (card.adjacency_required !== false) {
        const range = card.claim_range || 1;
        const tiles = gameState.grid?.tiles ?? {};
        const inRange = Object.values(tiles).some(t =>
          t.owner === activePlayerId &&
          (Math.abs(t.q - q) + Math.abs(t.r - r) + Math.abs(t.q + t.r - q - r)) / 2 <= range
        );
        if (!inRange) {
          const rangeDesc = range > 1 ? `within ${range} tiles of` : 'adjacent to';
          setError(`${plainCardName(card.name)} must target a tile ${rangeDesc} one you own`);
          return;
        }
      }
      // Check unoccupied_only
      if (card.unoccupied_only && tile.owner) {
        setError(`${plainCardName(card.name)} can only target unoccupied tiles`);
        return;
      }
      // Stacking: a stackable new card may always land on a tile with
      // prior claims. A non-stackable new card is blocked only if some
      // prior planned claim on the tile (primary or extra) is also
      // non-stackable — prior stackable claims don't lock the tile.
      if (!card.stackable && activePlayer.planned_actions?.some(a => {
        if (a.card.card_type !== 'claim') return false;
        if (a.card.stackable) return false;
        if (a.target_q === q && a.target_r === r) return true;
        return a.extra_targets?.some(([eq, er]) => eq === q && er === r) ?? false;
      })) {
        setError(`That tile already has a non-stackable claim this round`);
        return;
      }
    }

    // Check if card needs trash/discard choice
    const choiceReq = getCardChoiceRequirement(card);
    if (choiceReq && maybeEnterTrashMode(cardIndex, choiceReq, q, r, extraTargets, targetPlayerId)) {
      return;
    }

    // Tutor / search_zone cards: show the selection modal before committing.
    // The play and the search resolve atomically on confirm.
    if (await maybeEnterPileSearchMode(cardIndex, q, r, extraTargets, targetPlayerId)) {
      return;
    }

    await executePlayCard(cardIndex, q, r, extraTargets, targetPlayerId);
  }, [phase, activePlayer, executePlayCard, maybeEnterTrashMode, maybeEnterPileSearchMode, gameState.grid?.tiles, activePlayerId]);

  const playCardNoTarget = useCallback(async (cardIndex: number) => {
    if (phase !== 'play' || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Check if card needs trash/discard choice
    const choiceReq = getCardChoiceRequirement(card);
    if (choiceReq && maybeEnterTrashMode(cardIndex, choiceReq)) {
      return;
    }

    // Tutor / search_zone cards: show the selection modal before committing.
    if (await maybeEnterPileSearchMode(cardIndex)) {
      return;
    }

    playedTargetlessRef.current = true;
    await executePlayCard(cardIndex);
  }, [phase, activePlayer, executePlayCard, maybeEnterTrashMode, maybeEnterPileSearchMode]);

  // Convert screen coords from card drag to hex grid coords
  const handleDragPlay = useCallback((cardIndex: number, screenX: number, screenY: number, dragVelocityX?: number, dragVelocityY?: number) => {
    if (!gridContainerRef.current || !activePlayer) return;
    const card = activePlayer.hand[cardIndex];
    if (!card) return;

    // Any drag attempt means the player understands the mechanic — dismiss the hint
    setShowDragHint(false);

    // Store drag release info so executePlayCard can pass it to the departing animation
    dragReleaseRef.current = { x: screenX, y: screenY, vx: dragVelocityX ?? 0, vy: dragVelocityY ?? 0 };

    // Player-targeting engine cards (e.g. Sabotage, Infestation): must drop on an opponent's tile
    if (card.card_type === 'engine' && needsOpponentTarget(card)) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      const canvasX = screenX - rect.left;
      const canvasY = screenY - rect.top;
      const transform = gridTransformRef.current;
      if (!transform) return;
      const local = screenToLocal(canvasX, canvasY, transform, rect.width, rect.height);
      const { q, r } = pixelToAxial(local.x, local.y);
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || !tile.owner || tile.owner === activePlayerId) {
        setError(`${plainCardName(card.name)} must target an opponent's tile`);
        return;
      }
      playCardAtTile(cardIndex, q, r, undefined, tile.owner);
      return;
    }

    // Engine cards targeting own tiles (Exodus, Scorched Retreat): must drop on own non-base tile
    if (card.card_type === 'engine' && card.target_own_tile) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      const canvasX = screenX - rect.left;
      const canvasY = screenY - rect.top;
      const transform = gridTransformRef.current;
      if (!transform) return;
      const local = screenToLocal(canvasX, canvasY, transform, rect.width, rect.height);
      const { q, r } = pixelToAxial(local.x, local.y);
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.owner !== activePlayerId) {
        setError(`${plainCardName(card.name)} must target a tile you own`);
        return;
      }
      if (tile.is_base) {
        setError(`${plainCardName(card.name)} cannot target a base tile`);
        return;
      }
      // Consecrate: must target a connected VP tile
      if (card.effects?.some(e => e.type === 'enhance_vp_tile')) {
        if (!tile.is_vp) {
          setError(`${plainCardName(card.name)} must target a VP tile`);
          return;
        }
        const tileKey2 = `${q},${r}`;
        if (!connectedVpTiles.has(tileKey2)) {
          setError(`${plainCardName(card.name)} must target a VP tile connected to your base`);
          return;
        }
      }
      playCardAtTile(cardIndex, q, r);
      return;
    }

    // Non-targeting cards (engine): release anywhere roughly over the board
    if (card.card_type === 'engine') {
      const rect = gridContainerRef.current.getBoundingClientRect();
      // Generous 60px tolerance so slight overshoots still register
      const tolerance = 60;
      if (screenX >= rect.left - tolerance && screenX <= rect.right + tolerance && screenY >= rect.top - tolerance && screenY <= rect.bottom + tolerance) {
        playCardNoTarget(cardIndex);
      }
      return;
    }

    // Targeting cards (claim/defense): convert screen → canvas → hex-local → axial
    const rect = gridContainerRef.current.getBoundingClientRect();
    // Generous tolerance — accept drops slightly outside the grid container
    const tolerance = 60;
    const clampedX = Math.max(rect.left, Math.min(rect.right, screenX));
    const clampedY = Math.max(rect.top, Math.min(rect.bottom, screenY));
    // Only clamp if within tolerance; if way outside, let it fall through
    const effectiveX = (screenX >= rect.left - tolerance && screenX <= rect.right + tolerance) ? clampedX : screenX;
    const effectiveY = (screenY >= rect.top - tolerance && screenY <= rect.bottom + tolerance) ? clampedY : screenY;
    const canvasX = effectiveX - rect.left;
    const canvasY = effectiveY - rect.top;
    const transform = gridTransformRef.current;
    if (!transform) return;
    const local = screenToLocal(canvasX, canvasY, transform, rect.width, rect.height);
    const { q, r } = pixelToAxial(local.x, local.y);

    // Verify the resolved hex actually exists on the grid
    const resolvedKey = `${q},${r}`;
    if (!gameState.grid?.tiles[resolvedKey]) return;

    // Validate defense card restrictions — must target own tile
    if (card.card_type === 'defense') {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (tile && tile.owner !== activePlayerId) {
        setError(`${plainCardName(card.name)} must target a tile you own`);
        return;
      }
    }

    // Validate claim card restrictions (more specific error messages)
    if (card.card_type === 'claim' && !card.target_own_tile) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (tile && tile.owner && card.unoccupied_only) {
        setError(`${plainCardName(card.name)} can only target unoccupied tiles`);
        return;
      }
    }

    // Multi-target card (Surge, Hive Mind, etc.): enter multi-target selection mode on drag
    if (card.multi_target_count > 0) {
      // Reject primary tile if it isn't a legal claim target — same rules
      // the player sees as the highlighted set on the grid.
      { const { strong, weak } = getValidClaimTiles(card);
      if (!strong.has(resolvedKey) && !weak.has(resolvedKey)) {
        setError(`${plainCardName(card.name)} cannot target this tile`);
        return;
      } }
      setMultiTileCardIndex(cardIndex);
      setMultiTilePrimaryTarget([q, r]);
      setMultiTileTargets([]);
      setSelectedCardIndex(cardIndex);
      return;
    }

    // Multi-tile defense card (Bulwark, etc.): enter multi-target selection mode
    if (card.card_type === 'defense' && (card.defense_target_count ?? 1) > 1) {
      setMultiTileCardIndex(cardIndex);
      setMultiTilePrimaryTarget([q, r]);
      setMultiTileTargets([]);
      setSelectedCardIndex(cardIndex);
      return;
    }

    playCardAtTile(cardIndex, q, r);
  }, [activePlayer, gameState.grid, playCardAtTile, playCardNoTarget]);

  // Helper: find the tile key for a player's base tile
  const findBaseKey = useCallback((playerId: string): string | null => {
    for (const tile of Object.values(gameState.grid.tiles)) {
      if (tile.is_base && tile.base_owner === playerId) return `${tile.q},${tile.r}`;
    }
    return null;
  }, [gameState.grid.tiles]);

  // Helper: resolve an action's display tile key (tile target, or target player's base)
  const actionTileKey = useCallback((action: import('../types/game').PlannedAction): string | null => {
    if (action.target_q != null && action.target_r != null) return `${action.target_q},${action.target_r}`;
    if (action.target_player_id) return findBaseKey(action.target_player_id);
    return null;
  }, [findBaseKey]);

  const handleTileClick = useCallback(async (q: number, r: number, shiftKey?: boolean) => {

    // Test mode: shift+click cycles tile ownership (none → p0 → p1 → ... → none)
    if (shiftKey && gameState.test_mode) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.is_blocked || tile.is_base) return;
      const playerOrder = gameState.player_order;
      const currentOwnerIdx = tile.owner ? playerOrder.indexOf(tile.owner) : -1;
      const nextIdx = currentOwnerIdx + 1;
      const nextOwner = nextIdx < playerOrder.length ? playerOrder[nextIdx] : null;
      try {
        const resp = await api.testSetTileOwner(gameState.id, q, r, nextOwner);
        onStateUpdate(resp.state);
      } catch { /* ignore */ }
      return;
    }

    // Review mode: clicking a tile with revealed actions opens full-card overlay
    if (reviewing && revealedActionsRef.current) {
      const clickedKey = `${q},${r}`;
      const entries: { playerId: string; playerName: string; card: Card }[] = [];
      for (const [pid, playerActions] of Object.entries(revealedActionsRef.current)) {
        const name = gameState.players[pid]?.name ?? pid;
        for (const action of playerActions) {
          const isPrimary = actionTileKey(action) === clickedKey;
          const isExtra = action.extra_targets?.some(([eq, er]: [number, number]) => `${eq},${er}` === clickedKey);
          if (isPrimary || isExtra) {
            entries.push({ playerId: pid, playerName: name, card: action.card });
          }
        }
      }
      if (entries.length === 1) {
        setReviewHoveredTile(null);
        showZoom(entries[0].card);
      } else if (entries.length > 1) {
        setReviewHoveredTile(null);
        setDetailCards(entries);
      }
      return;
    }

    if (phase !== 'play' || !activePlayer) return;

    // Multi-target mode (Surge, Hive Mind, or multi-tile Defense): adding extra targets
    if (multiTileCardIndex !== null && multiTilePrimaryTarget) {
      const tileKey = `${q},${r}`;
      // Clicking primary target: deselect it by shifting the first extra target to primary
      if (multiTilePrimaryTarget[0] === q && multiTilePrimaryTarget[1] === r) {
        if (multiTileTargets.length > 0) {
          setMultiTilePrimaryTarget(multiTileTargets[0]);
          setMultiTileTargets(prev => prev.slice(1));
        } else {
          // No extra targets — cancel multi-target mode entirely
          setMultiTileCardIndex(null);
          setMultiTilePrimaryTarget(null);
          setMultiTileTargets([]);
          setSelectedCardIndex(null);
        }
        return;
      }
      // Clicking an already-selected extra target deselects it
      const existingIdx = multiTileTargets.findIndex(([tq, tr]) => tq === q && tr === r);
      if (existingIdx !== -1) {
        setMultiTileTargets(prev => prev.filter((_, i) => i !== existingIdx));
        return;
      }

      const multiTileCard = activePlayer.hand[multiTileCardIndex];
      const isDefenseMulti = multiTileCard?.card_type === 'defense' && (multiTileCard?.defense_target_count ?? 1) > 1;

      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.is_blocked) return;

      // Reject any tile that isn't actually a legal target for this card —
      // matches the highlighted set the player can see on the grid.
      if (isDefenseMulti) {
        // Defense multi-target: must select own non-blocked tiles
        if (tile.owner !== activePlayerId) return;
      } else {
        // Claim multi-target (Surge, Hive Mind): must satisfy all claim restrictions
        // (adjacency, defense, immunity, occupancy, etc.)
        if (multiTileCard) { const { strong, weak } = getValidClaimTiles(multiTileCard); if (!strong.has(tileKey) && !weak.has(tileKey)) return; }
        // Every target must be adjacent to at least one already-selected target.
        const selectedKeys = new Set<string>();
        if (multiTilePrimaryTarget) {
          selectedKeys.add(`${multiTilePrimaryTarget[0]},${multiTilePrimaryTarget[1]}`);
        }
        for (const [tq, tr] of multiTileTargets) selectedKeys.add(`${tq},${tr}`);
        if (selectedKeys.size > 0) {
          const isAdj = HEX_DIRS.some(([dq, dr]) => selectedKeys.has(`${q + dq},${r + dr}`));
          if (!isAdj) {
            setError(`${multiTileCard?.name ?? 'Card'} targets must be adjacent to each other`);
            return;
          }
        }
      }

      if (isDefenseMulti) {
        const maxExtra = (multiTileCard?.defense_target_count ?? 1) - 1;
        if (multiTileTargets.length >= maxExtra) {
          // At max: drop oldest, add new
          setMultiTileTargets(prev => [...prev.slice(1), [q, r]]);
          sound.tileSelect();
          return;
        }
      } else {
        const maxExtra = multiTileCard?.multi_target_count ?? 0;
        if (multiTileTargets.length >= maxExtra) {
          setMultiTileTargets(prev => [...prev.slice(1), [q, r]]);
          sound.tileSelect();
          return;
        }
      }
      setMultiTileTargets(prev => [...prev, [q, r]]);
      sound.tileSelect();
      return;
    }

    if (selectedCardIndex === null) return;

    const card = activePlayer.hand[selectedCardIndex];
    if (!card) return;

    // Any play attempt means the player understands the mechanic — dismiss the hint
    setShowDragHint(false);

    // Player-targeting engine cards (e.g. Sabotage, Infestation): click an opponent's tile
    if (card.card_type === 'engine' && needsOpponentTarget(card)) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || !tile.owner || tile.owner === activePlayerId) {
        setError(`${plainCardName(card.name)} must target an opponent's tile`);
        return;
      }
      sound.tileSelect();
      await playCardAtTile(selectedCardIndex, q, r, undefined, tile.owner);
      return;
    }

    // Engine cards targeting own tiles (Exodus, Scorched Retreat): click own non-base tile
    if (card.card_type === 'engine' && card.target_own_tile) {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];
      if (!tile || tile.owner !== activePlayerId) {
        setError(`${plainCardName(card.name)} must target a tile you own`);
        return;
      }
      if (tile.is_base) {
        setError(`${plainCardName(card.name)} cannot target a base tile`);
        return;
      }
      // Consecrate: must target a connected VP tile
      if (card.effects?.some(e => e.type === 'enhance_vp_tile')) {
        if (!tile.is_vp) {
          setError(`${plainCardName(card.name)} must target a VP tile`);
          return;
        }
        const tileKey2 = `${q},${r}`;
        if (!connectedVpTiles.has(tileKey2)) {
          setError(`${plainCardName(card.name)} must target a VP tile connected to your base`);
          return;
        }
      }
      sound.tileSelect();
      await playCardAtTile(selectedCardIndex, q, r);
      return;
    }

    if (card.card_type === 'claim' || card.card_type === 'defense') {
      const tileKey = `${q},${r}`;
      const tile = gameState.grid?.tiles[tileKey];

      // Validate defense card restrictions — must target own tile
      if (card.card_type === 'defense') {
        if (tile && tile.owner !== activePlayerId) {
          setError(`${plainCardName(card.name)} must target a tile you own`);
          return;
        }
      }

      // Validate claim card restrictions
      if (card.card_type === 'claim') {
        if (!card.target_own_tile) {
          if (tile && tile.owner && card.unoccupied_only) {
            setError(`${plainCardName(card.name)} can only target unoccupied tiles`);
            return;
          }
        }

        // Multi-target card (Surge, Hive Mind, etc.): enter multi-target selection mode
        if (card.multi_target_count > 0) {
          { const { strong, weak } = getValidClaimTiles(card);
          if (!strong.has(tileKey) && !weak.has(tileKey)) {
            setError(`${plainCardName(card.name)} cannot target this tile`);
            return;
          } }
          setMultiTileCardIndex(selectedCardIndex);
          setMultiTilePrimaryTarget([q, r]);
          setMultiTileTargets([]);
          return;
        }
      }

      // Multi-tile defense card: enter multi-target selection mode
      if (card.card_type === 'defense' && (card.defense_target_count ?? 1) > 1) {
        setMultiTileCardIndex(selectedCardIndex);
        setMultiTilePrimaryTarget([q, r]);
        setMultiTileTargets([]);
        return;
      }

      sound.tileSelect();
      await playCardAtTile(selectedCardIndex, q, r);
    }
  }, [phase, activePlayer, selectedCardIndex, gameState.grid, playCardAtTile, multiTileCardIndex, multiTilePrimaryTarget, multiTileTargets, activePlayerId, reviewing, gameState.players, actionTileKey, sound]);

  const handlePlayEngine = useCallback(async () => {
    if (selectedCardIndex === null) return;
    await playCardNoTarget(selectedCardIndex);
  }, [selectedCardIndex, playCardNoTarget]);

  // Confirm multi-tile target selection
  const handleConfirmMultiTile = useCallback(async () => {
    if (multiTileCardIndex === null || !multiTilePrimaryTarget) return;
    await playCardAtTile(multiTileCardIndex, multiTilePrimaryTarget[0], multiTilePrimaryTarget[1], multiTileTargets);
  }, [multiTileCardIndex, multiTilePrimaryTarget, multiTileTargets, playCardAtTile]);

  const handleCancelMultiTile = useCallback(() => {
    setMultiTileCardIndex(null);
    setMultiTilePrimaryTarget(null);
    setMultiTileTargets([]);
  }, []);

  // Confirm trash/discard selection
  const handleConfirmTrash = useCallback(async () => {
    if (!trashMode || !activePlayer) return;
    const { cardIndex, targetQ, targetR, extraTargets, targetPlayerId, effectType } = trashMode;

    // Pending discard (deferred from card play, e.g. Regroup) — use separate API
    if (trashMode.pendingDiscard) {
      const indices = [...trashSelectedIndices].sort((a, b) => a - b);
      try {
        setError(null);
        const result = await api.submitDiscard(gameState.id, activePlayerId, indices);
        onStateUpdate(result.state);
        setTrashMode(null);
        setTrashSelectedIndices(new Set());
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    // Convert selected hand indices to post-removal indices (after played card is popped)
    const adjustedIndices = [...trashSelectedIndices]
      .map(i => (i > cardIndex ? i - 1 : i))
      .sort((a, b) => a - b);

    const isDiscard = effectType === 'self_discard';
    await executePlayCard(
      cardIndex, targetQ, targetR, extraTargets, targetPlayerId,
      isDiscard ? undefined : adjustedIndices,
      isDiscard ? adjustedIndices : undefined,
    );
  }, [trashMode, trashSelectedIndices, activePlayer, executePlayCard, gameState.id, activePlayerId, onStateUpdate]);

  const handleCancelTrash = useCallback(() => {
    setTrashMode(null);
    setTrashSelectedIndices(new Set());
  }, []);

  const handleTrashToggle = useCallback((cardIndex: number) => {
    if (!trashMode) return;
    setTrashSelectedIndices(prev => {
      const next = new Set(prev);
      if (next.has(cardIndex)) {
        next.delete(cardIndex);
      } else {
        // At capacity: evict the least recently selected card (first in Set insertion order)
        if (next.size >= trashMode.maxCards) {
          const oldest = next.values().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        next.add(cardIndex);
      }
      return next;
    });
  }, [trashMode]);

  // ── Pile search (SEARCH_ZONE / tutor) handlers ──
  //
  // Flow:
  //   1. Backend sets `pending_search` on the active player after playing a
  //      tutor card. The modal appears (see bottom of render).
  //   2. Player picks cards + destinations, clicks Confirm. We capture the
  //      card DOM rects from the modal, resolve target zone rects on the
  //      HUD, and hand a list of `SearchFlight` to PileSearchFlyAnimation.
  //   3. While the animation runs, `searchAnimating` suppresses the modal
  //      so the cards aren't hidden behind an opaque overlay.
  //   4. On animation complete, we POST /submit-search. The state update
  //      clears `pending_search` server-side and the fly state resets.
  const resolveSearchTargetRect = useCallback((target: SearchZoneTarget): DOMRect | null => {
    if (target === 'trash') return null; // tear-in-place — no rect needed
    const selector =
      target === 'hand'
        ? '[data-hand-zone]'
        : target === 'top_of_draw'
          ? '[data-draw-pile]'
          : '[data-discard-pile]';
    const el = document.querySelector<HTMLElement>(selector);
    return el ? el.getBoundingClientRect() : null;
  }, []);

  // Effective pending state: pre-play mode (card not yet played) takes
  // precedence over server-driven pending_search (legacy / reconnection path).
  const effectivePending = prePlaySearchMode?.pending ?? activePlayer?.pending_search ?? null;
  const pileSearchSourceCards = useMemo<Card[]>(() => {
    if (!effectivePending) return [];
    const src = effectivePending.source;
    if (src === 'discard') return activePlayer?.discard ?? [];
    if (src === 'draw') return activePlayer?.deck_cards ?? [];
    if (src === 'trash') return activePlayer?.trash ?? [];
    return [];
  }, [effectivePending, activePlayer?.discard, activePlayer?.deck_cards, activePlayer?.trash]);

  // Ref used to defer the actual play-card API call until the fly animation
  // completes. In pre-play mode we capture card + selections here; in
  // server-driven mode we capture just the selections.
  const searchCommitRef = useRef<{
    mode: 'pre_play';
    cardIndex: number;
    targetQ?: number;
    targetR?: number;
    targetPlayerId?: string;
    extraTargets?: [number, number][];
    selections: SearchSelection[];
  } | {
    mode: 'server_pending';
    selections: SearchSelection[];
  } | null>(null);

  const submitSearchCommit = useCallback(async () => {
    const commit = searchCommitRef.current;
    searchCommitRef.current = null;
    if (!commit) return;
    // Mark any hand-targeted cards as "already visually present" so the hand
    // doesn't re-animate them as freshly-drawn when the backend state arrives.
    // Also flag a tutor-commit window so CardHand's shuffle-detection
    // heuristic doesn't misfire on the discard pile shrinking (which it
    // would otherwise treat as a reshuffle when the draw pile is empty).
    // Both flags clear after ~1s — enough time for the state update + render.
    const handIds = new Set(
      commit.selections.filter((s) => s.target === 'hand').map((s) => s.card_id)
    );
    if (commit.selections.length > 0) {
      setTutorCommitInFlight(true);
    }
    if (handIds.size > 0) {
      setSearchSuppressedHandIds((prev) => new Set([...prev, ...handIds]));
    }
    setTimeout(() => {
      setTutorCommitInFlight(false);
      if (handIds.size > 0) {
        setSearchSuppressedHandIds((prev) => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          for (const id of handIds) next.delete(id);
          return next;
        });
      }
    }, 1000);
    try {
      setError(null);
      if (commit.mode === 'pre_play') {
        // Atomic card play + search resolution
        await executePlayCard(
          commit.cardIndex, commit.targetQ, commit.targetR,
          commit.extraTargets, commit.targetPlayerId,
          undefined, undefined, commit.selections,
        );
      } else {
        const result = await api.submitSearch(gameState.id, activePlayerId, commit.selections);
        onStateUpdate(result.state);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [activePlayerId, executePlayCard, gameState.id, onStateUpdate]);

  const handlePileSearchConfirm = useCallback(
    (selections: SearchSelection[], sourceRects: Map<string, DOMRect>) => {
      if (!effectivePending) return;

      const isPrePlay = !!prePlaySearchMode;
      const commit: NonNullable<typeof searchCommitRef.current> = isPrePlay
        ? {
          mode: 'pre_play',
          cardIndex: prePlaySearchMode!.cardIndex,
          targetQ: prePlaySearchMode!.targetQ,
          targetR: prePlaySearchMode!.targetR,
          targetPlayerId: prePlaySearchMode!.targetPlayerId,
          extraTargets: prePlaySearchMode!.extraTargets,
          selections,
        }
        : { mode: 'server_pending', selections };

      searchCommitRef.current = commit;
      // Close the modal immediately so the fly animation isn't obscured.
      setPrePlaySearchMode(null);

      // Empty selections (declined) — skip animation, submit immediately.
      if (selections.length === 0) {
        submitSearchCommit();
        return;
      }

      // Build flights. If the card isn't in the source list (shouldn't
      // happen), we skip — still fires API call.
      const cardById = new Map<string, Card>();
      for (const c of pileSearchSourceCards) {
        cardById.set(c.id, c);
      }
      const flights: SearchFlight[] = selections
        .map((sel) => {
          const card = cardById.get(sel.card_id);
          const sourceRect = sourceRects.get(sel.card_id);
          if (!card || !sourceRect) return null;
          return {
            card,
            sourceRect,
            targetKind: sel.target,
            targetRect: resolveSearchTargetRect(sel.target),
          } satisfies SearchFlight;
        })
        .filter((f): f is SearchFlight => f !== null);

      if (!animated || flights.length === 0) {
        submitSearchCommit();
        return;
      }

      setSearchAnimating(true);
      setSearchFlights(flights);
    },
    [effectivePending, prePlaySearchMode, pileSearchSourceCards, animated, resolveSearchTargetRect, submitSearchCommit]
  );

  const handlePileSearchCancel = useCallback(() => {
    // Pre-play: just close the modal. The card stays in hand, nothing sent
    // to the backend. This is always allowed (min_count is a suggestion only
    // when the player already opted in by playing the card).
    if (prePlaySearchMode) {
      setPrePlaySearchMode(null);
      return;
    }
    // Server-driven: cancel only works when min_count == 0 (optional).
    if (!activePlayer?.pending_search) return;
    if (activePlayer.pending_search.min_count !== 0) return;
    searchCommitRef.current = { mode: 'server_pending', selections: [] };
    submitSearchCommit();
  }, [prePlaySearchMode, activePlayer?.pending_search, submitSearchCommit]);

  const handlePileSearchFlyComplete = useCallback(() => {
    setSearchFlights(null);
    void (async () => {
      try {
        await submitSearchCommit();
      } finally {
        setSearchAnimating(false);
      }
    })();
  }, [submitSearchCommit]);

  const handleSubmitPlay = useCallback(async () => {
    try {
      setError(null);

      // Submit to server immediately; played cards stay on the board until the reveal
      const result = await api.submitPlay(gameState.id, activePlayerId);

      // Apply state immediately — useLayoutEffect handles play→reveal transition
      onStateUpdate(result.state);

      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, onStateUpdate]);

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
      const result = await api.buyCard(gameState.id, activePlayerId, 'shared', cardId);
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

  const handleUpgradeCard = useCallback(async (cardIndex: number) => {
    try {
      setError(null);
      const result = await api.upgradeCard(gameState.id, activePlayerId, cardIndex);
      sound.upgradeCard();
      onStateUpdate(result.state);
      // Upgrade button unmounts once the card is upgraded (no more preview),
      // so its onMouseLeave never fires. Clear the preview state manually —
      // otherwise `showUpgradePreview` stays true and keeps the HexGrid
      // `paused` prop true forever, freezing the board's render loop.
      setShowUpgradePreview(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate, sound]);

  const handleReroll = useCallback(async () => {
    try {
      setError(null);
      const result = await api.rerollMarket(gameState.id, activePlayerId);
      sound.coinSpend();
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate, sound]);

  const handleEndTurn = useCallback(async () => {
    try {
      setError(null);
      const result = await api.endTurn(gameState.id, activePlayerId);
      const allDone = result.state.current_phase !== 'buy';

      if (allDone) {
        // All players ended turn — game advanced to next round
        if (animationMode !== 'off' && activePlayer && activePlayer.hand.length > 0) {
          pendingStateRef.current = result.state;
          setDiscardingAll(true);
        } else {
          onStateUpdate(result.state);
          setSelectedCardIndex(null);
        }
      } else {
        // Not all players done — stay on local player (waiting for others)
        onStateUpdate(result.state);
        setSelectedCardIndex(null);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState, activePlayerId, activePlayerIndex, onStateUpdate, animationMode, activePlayer]);

  // Concurrent buy phase: trigger CPU buys once when buy phase starts.
  // Uses a ref for the timer so dependency-array re-runs don't cancel it.
  const cpuBuyTriggeredRef = useRef(false);
  const cpuBuyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (gameState.current_phase !== 'buy') {
      cpuBuyTriggeredRef.current = false;
      if (cpuBuyTimerRef.current) { clearTimeout(cpuBuyTimerRef.current); cpuBuyTimerRef.current = null; }
      return;
    }
    if (cpuBuyTriggeredRef.current) return;
    // Check if any CPU players need to buy
    const hasPendingCpu = gameState.player_order.some(pid => {
      const p = gameState.players[pid];
      return p?.is_cpu && !p.has_left && !gameState.players_done_buying.includes(pid);
    });
    if (!hasPendingCpu) return;
    cpuBuyTriggeredRef.current = true;
    cpuBuyTimerRef.current = setTimeout(async () => {
      cpuBuyTimerRef.current = null;
      try {
        const result = await api.processCpuBuys(gameState.id);
        onStateUpdate(result.state);
      } catch (err) {
        console.warn('CPU buy trigger failed, will retry on next state update', err);
        // Allow retry on next state update (e.g. after human buys)
        cpuBuyTriggeredRef.current = false;
      }
    }, 500);
  }, [gameState.current_phase, gameState.id, gameState.players, gameState.player_order, gameState.players_done_buying, onStateUpdate]);

  // Handle WebSocket cursor and click events from other players
  useEffect(() => {
    if (!wsMessage || !isMultiplayer) return;
    if (wsMessage.type === 'cursor_update') {
      const pid = wsMessage.player_id as string;
      setOtherCursors(prev => ({
        ...prev,
        [pid]: {
          player_id: pid,
          player_name: wsMessage.player_name as string,
          player_color: wsMessage.player_color as string,
          hovered_card_id: wsMessage.hovered_card_id as string | null,
          source: wsMessage.source as string | null,
        },
      }));
    } else if (wsMessage.type === 'cursor_click') {
      const pid = wsMessage.player_id as string;
      setCursorClicks(prev => ({ ...prev, [pid]: Date.now() }));
    }
  }, [wsMessage, isMultiplayer]);

  /** Screen rect of a shop tile's card face — a bought card lifts off from it. */
  const shopCardRect = (cardId: string): IncomingDiscard['from'] => {
    const slot = document.querySelector(`[data-card-id="${CSS.escape(cardId)}"]`);
    const r = (slot?.querySelector('[data-compact-card]') ?? slot)?.getBoundingClientRect();
    return r && r.width > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : undefined;
  };

  // Detect purchases via buy_phase_purchases state diff
  const prevBuyPhasePurchasesRef = useRef<Record<string, Array<{ card_id: string; definition_id?: string; card_name: string; source: string; cost: number }>>>({});
  const prevArchMarketRef = useRef<Card[] | null>(null);
  useEffect(() => {
    if (gameState.current_phase !== 'buy') {
      prevBuyPhasePurchasesRef.current = {};
      prevArchMarketRef.current = null;
      return;
    }
    // Initialize archetype market snapshot on first run
    if (!prevArchMarketRef.current) {
      const ap = gameState.players[activePlayerId];
      if (ap) prevArchMarketRef.current = ap.archetype_market;
    }
    const prev = prevBuyPhasePurchasesRef.current;
    const current = gameState.buy_phase_purchases;
    // Find new purchases. Mine fly from the shop tile to my discard pile.
    // Opponents' shared buys fly from the shop tile to their ID card while my
    // shop is open; otherwise (and for their archetype buys, which have no
    // tile in my shop) the card pops up beside their ID card.
    for (const [pid, purchases] of Object.entries(current)) {
      const prevCount = prev[pid]?.length ?? 0;
      const newPurchases = purchases.slice(prevCount);
      const isSelf = pid === activePlayerId;
      for (const [n, p] of newPurchases.entries()) {
        if (p.source === 'shared') {
          const player = gameState.players[pid];
          const stack = gameState.shared_market.find(
            s => s.card.id === p.card_id
              || (!!p.definition_id && s.card.definition_id === p.definition_id),
          );
          if (!stack) continue;
          if (isSelf) {
            const key = `buy-${pid}-${prevCount + newPurchases.indexOf(p)}`;
            const from = shopCardRect(stack.card.id);
            setIncomingDiscards(prev => [...prev, { key, card: stack.card, from }]);
            continue;
          }
          if (!showShopOverlayRef.current) {
            popPurchaseRef.current(pid, stack.card, n);
            continue;
          }
          setSharedPurchaseEvents(evts => [...evts, {
            player_id: pid,
            player_name: player?.name ?? pid,
            player_color: player?.color ?? '#666',
            card_id: p.card_id,
            card_name: p.card_name,
            card: stack.card,
            isSelf,
          }]);
        } else if (p.source === 'archetype' && !isSelf) {
          const card = cardCatalog.getCardByName(p.card_name);
          if (card) popPurchaseRef.current(pid, card, n);
        } else if (p.source === 'archetype' && isSelf) {
          // Find the card in the previous archetype market (it's been removed after purchase)
          const card = prevArchMarketRef.current?.find(
            c => c.id === p.card_id
              || (!!p.definition_id && c.definition_id === p.definition_id),
          );
          if (!card) continue;
          const key = `buy-${pid}-${prevCount + newPurchases.indexOf(p)}`;
          const from = shopCardRect(card.id);
          setIncomingDiscards(prev => [...prev, { key, card, from }]);
        }
      }
    }
    prevBuyPhasePurchasesRef.current = current;
    // Snapshot archetype market for next diff (card is removed after purchase)
    const ap = gameState.players[activePlayerId];
    if (ap) prevArchMarketRef.current = ap.archetype_market;
  }, [gameState.buy_phase_purchases, gameState.current_phase, gameState.players, activePlayerId]);

  // Clear cursors when leaving buy phase
  useEffect(() => {
    if (gameState.current_phase !== 'buy') {
      setOtherCursors({});
      setSharedPurchaseEvents([]);
      setCursorClicks({});
    }
  }, [gameState.current_phase]);

  // Callback for ShopOverlay to broadcast hover changes
  const handleShopCardHoverChange = useCallback((cardId: string | null, source: string | null) => {
    if (wsSend && isMultiplayer && gameState.current_phase === 'buy') {
      wsSend({ type: 'cursor_update', hovered_card_id: cardId, source });
    }
  }, [wsSend, isMultiplayer, gameState.current_phase]);


  // Submit Play button state
  const submitHasCardsLeft = activePlayer ? activePlayer.hand.length > 0 : false;
  const submitActionsLeft = activePlayer ? activePlayer.actions_available - activePlayer.actions_used : 0;
  const submitCanStillPlay = submitHasCardsLeft && submitActionsLeft > 0;

  // Keyboard shortcuts: Escape, C/D/S, 1-9, Enter (with hold support)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Disable shortcuts when intro sequence or game-over overlay is active
      if (showIntro || introSequence !== 'done' || showGameOver) return;

      // Escape: close the topmost overlay
      if (e.key === 'Escape') {
        if (showCardBrowser) { setShowCardBrowser(false); return; }
        if (showDeckViewer) { setShowDeckViewer(false); return; }
        if (showShopOverlay) { setShowShopOverlay(false); return; }
        if (showFullLog) { setShowFullLog(false); return; }
        if (selectedCardIndex !== null) { setSelectedCardIndex(null); return; }
        return;
      }

      // Tab: cycle through cards in hand during Play phase (follows visual order)
      if (e.key === 'Tab') {
        e.preventDefault();
        if (
          phase === 'play' && activePlayer && !playSubmitted &&
          !interactionBlocked && !resolving && activePlayer.hand.length > 0 &&
          multiTileCardIndex === null && !trashMode
        ) {
          const len = activePlayer.hand.length;
          const visualOrder = handVisualOrderRef.current;
          const useVisual = visualOrder.length === len;
          setSelectedCardIndex(prev => {
            // Find current visual position
            const curVisualPos = prev === null ? -1
              : useVisual ? visualOrder.indexOf(prev)
              : prev;
            let nextVisualPos: number;
            if (e.shiftKey) {
              nextVisualPos = curVisualPos <= 0 ? len - 1 : curVisualPos - 1;
            } else {
              nextVisualPos = curVisualPos >= len - 1 ? 0 : curVisualPos + 1;
            }
            return useVisual ? visualOrder[nextVisualPos] : nextVisualPos;
          });
        }
        return;
      }

      // Ignore remaining shortcuts if typing in an input or textarea
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // C/D/S: toggle Cards/Deck/Shop overlays
      const key = e.key.toLowerCase();
      if (key === 'c') { setShowCardBrowser(p => { if (!p) { setShowDeckViewer(false); setShowShopOverlay(false); } return !p; }); return; }
      if (key === 'd') { setShowDeckViewer(p => { if (!p) { setShowShopOverlay(false); setShowCardBrowser(false); } return !p; }); return; }
      if (key === 's' && !e.ctrlKey && !e.metaKey) { setShowShopOverlay(p => { if (!p) { setShowDeckViewer(false); setShowCardBrowser(false); } return !p; }); return; }

      // R key: rotate grid 30° clockwise (only when no popover is open and not resolving)
      if (key === 'r' && !showShopOverlay && !showCardBrowser && !showDeckViewer && !showFullLog && !showUpgradePreview && !resolving) {
        if (e.shiftKey) {
          handleRotateGridReverse();
        } else {
          handleRotateGrid();
        }
        return;
      }

      // T: toggle the tilted 3D view; V: reset the camera
      if ((key === 't' || key === 'v') && !e.ctrlKey && !e.metaKey && !showShopOverlay && !showCardBrowser && !showDeckViewer && !showFullLog && !showUpgradePreview) {
        if (key === 't') boardControlsRef.current?.toggleTilt();
        else boardControlsRef.current?.resetView();
        return;
      }

      // Enter key: play engine card, done reviewing, or hold-to-submit/end-turn
      if (e.key === 'Enter') {
        if (e.repeat) return; // prevent repeated keydown from re-triggering
        e.preventDefault();

        // Close any open overlays so the underlying action is visible
        if (showCardBrowser) setShowCardBrowser(false);
        if (showDeckViewer) setShowDeckViewer(false);
        if (showShopOverlay) setShowShopOverlay(false);
        if (showFullLog) setShowFullLog(false);
        if (showUpgradePreview) setShowUpgradePreview(false);

        // Priority 0: Done reviewing
        if (reviewButtonVisible) {
          handleDoneReviewingRef.current?.();
          return;
        }

        // Priority 0.25: Confirm Trash/Discard selection when at max
        if (phase === 'play' && trashMode && trashSelectedIndices.size === trashMode.maxCards && trashMode.maxCards > 0) {
          handleConfirmTrash();
          return;
        }

        // Priority 0.5: Confirm multi-tile selection when full
        if (
          phase === 'play' && activePlayer && !resolving &&
          multiTileCardIndex !== null && multiTilePrimaryTarget
        ) {
          const multiTileCard = activePlayer.hand[multiTileCardIndex];
          const isDefenseMulti = multiTileCard?.card_type === 'defense' && (multiTileCard?.defense_target_count ?? 1) > 1;
          const maxTotal = isDefenseMulti
            ? (multiTileCard?.defense_target_count ?? 1)
            : 1 + (multiTileCard?.multi_target_count ?? 0);
          if (1 + multiTileTargets.length >= maxTotal) {
            handleConfirmMultiTile();
            return;
          }
        }

        // Priority 1: Play selected engine card (only non-targeting engines).
        // Debt is excluded — it costs 3 resources to trash, so accidentally
        // pressing Enter while it's selected would silently burn an action
        // and potentially fail. Force the player to use double-click.
        if (
          phase === 'play' && activePlayer && !resolving &&
          selectedCardIndex !== null && multiTileCardIndex === null && !trashMode
        ) {
          const card = activePlayer.hand[selectedCardIndex];
          if (card?.card_type === 'engine' && card.name !== 'Debt' && !needsOpponentTarget(card) && !card.target_own_tile) {
            handlePlayEngine();
            return;
          }
        }

        // Priority 2: Submit Play (only when no Play Card button is available)
        if (
          phase === 'play' && activePlayer && !playSubmitted &&
          !resolving && activePlayerEffects.length === 0 &&
          multiTileCardIndex === null && !trashMode
        ) {
          const hasPlayableEngine = selectedCardIndex !== null && (() => {
            const c = activePlayer.hand[selectedCardIndex];
            return !!c && c.card_type === 'engine' && c.name !== 'Debt' && !needsOpponentTarget(c) && !c.target_own_tile;
          })();
          if (!hasPlayableEngine) {
            if (submitCanStillPlay) {
              submitPlayRef.current?.startKeyboardHold();
            } else {
              handleSubmitPlay();
            }
            return;
          }
        }

        // Priority 3: End Turn (always requires hold)
        if (
          phase === 'buy' && activePlayer && !resolving &&
          !phaseBanner && activePlayerEffects.length === 0 &&
          !activePlayer.has_ended_turn
        ) {
          endTurnRef.current?.startKeyboardHold();
          return;
        }
        return;
      }

      // 1-9, 0: select card by visual position (0 = 10th card)
      if (!/^[0-9]$/.test(e.key)) return;
      if (!activePlayer) return;
      const handLength = activePlayer.hand.length;
      if (handLength === 0) return;
      const visualPos = e.key === '0' ? 9 : parseInt(e.key, 10) - 1;
      if (visualPos >= handLength) return;
      const visualOrder = handVisualOrderRef.current;
      const cardIndex = visualOrder.length === handLength ? visualOrder[visualPos] : visualPos;

      if (trashMode) {
        handleTrashToggle(cardIndex);
      } else if (phase === 'play' && !playSubmitted && !interactionBlocked) {
        setSelectedCardIndex(prev => prev === cardIndex ? null : cardIndex);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        submitPlayRef.current?.stopKeyboardHold();
        endTurnRef.current?.stopKeyboardHold();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [activePlayer, phase, playSubmitted, interactionBlocked, trashMode, trashSelectedIndices, handleTrashToggle, handleConfirmTrash, selectedCardIndex, multiTileCardIndex, multiTileTargets, multiTilePrimaryTarget, handleConfirmMultiTile, resolving, reviewing, reviewButtonVisible, handlePlayEngine, showCardBrowser, showDeckViewer, showShopOverlay, showFullLog, showUpgradePreview, activePlayerEffects, submitCanStillPlay, handleSubmitPlay, phaseBanner, showIntro, introSequence, showGameOver, handleRotateGrid, handleRotateGridReverse]);

  const handleDiscardAllComplete = useCallback(() => {
    setDiscardingAll(false);
    if (pendingStateRef.current) {
      onStateUpdate(pendingStateRef.current);
      pendingStateRef.current = null;
    }
    setSelectedCardIndex(null);
  }, [onStateUpdate]);

  // Intro overlay dismissed — start shuffle → draw → play banner sequence
  const handleIntroReady = useCallback(() => {
    setShowIntro(false);
    if (animationOff) {
      setIntroSequence('done');
      setHudVisible(true);
      setGridBuildProgress(undefined);
      return;
    }
    // Start HUD fade-in sequence
    setIntroSequence('hud_fadein');
    setInteractionBlocked(true);
  }, [animationOff]);

  // Intro sequence: hud_fadein → grid_build → draw → "Begin!" banner
  useEffect(() => {
    if (introSequence === 'hud_fadein') {
      // Fade in HUD elements over 2.5s, then start grid build
      setHudVisible(true);
      const duration = Math.round(2500 * animSpeed) || 1000;
      const timer = setTimeout(() => setIntroSequence('grid_build'), duration);
      return () => clearTimeout(timer);
    }
    if (introSequence === 'grid_build') {
      // Animate grid build from center over ~1.5s, then start card draw
      const buildDuration = Math.round(1500 * animSpeed) || 600;
      const startTime = performance.now();
      let raf: number;
      const tick = () => {
        const elapsed = performance.now() - startTime;
        const p = Math.min(1, elapsed / buildDuration);
        setGridBuildProgress(p);
        if (p < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          setGridBuildProgress(undefined); // fully built, no more prop
          setIntroSequence('draw');
        }
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    }
    if (introSequence === 'draw') {
      // First let the hand area fade in, then pass cards to trigger draw animations.
      const fadeDuration = 800;
      const fadeTimer = setTimeout(() => setIntroHandReady(true), fadeDuration);
      // Wait for fade + all cards to finish their staggered draw animation, then
      // mark intro done. The phase effect will detect upkeep and show banners.
      const handSize = activePlayer?.hand.length ?? 0;
      const drawDuration = fadeDuration + handSize * 500 + 500;
      const timer = setTimeout(() => {
        sound.beginJingle();
        setIntroSequence('done');
      }, drawDuration);
      return () => { clearTimeout(fadeTimer); clearTimeout(timer); };
    }
  }, [introSequence, animated, activePlayer, gameState, animSpeed]);

  // When intro sequence completes, unblock interaction
  useEffect(() => {
    if (introSequence === 'done') {
      setInteractionBlocked(false);
    }
  }, [introSequence]);

  // Transition from resolve to buy phase (called after effects popup or directly)
  // If deferredState is provided, apply it now (was held back during effects popup)
  // Enter review mode — player can hover tiles/players to see what was played
  const enterReviewMode = useCallback(() => {
    setReviewing(true);
    setPhaseBanner(null);
    setInteractionBlocked(false);
    setReviewHoveredTile(null);
    setReviewHoveredPlayer(null);
    setDetailCards(null);
  }, []);

  // Advance through resolve to buy phase, then show the buy banner.
  // Note: we intentionally do NOT clear `activePlayerEffects` here. The popups
  // should remain visible while the player waits for other players to finish
  // reviewing (multiplayer) so the player can keep referencing them. A
  // dedicated effect below clears the popups once the game phase actually
  // transitions away from `reveal`.
  const advanceAndShowBuy = useCallback(() => {
    api.advanceResolve(gameState.id, activePlayerId).then(result => {
      onStateUpdate(result.state);
      prevPhaseRef.current = result.state.current_phase;
      if (result.state.current_phase === 'buy') {
        // Transitioned to BUY — show banner then open shop on completion
        setBannerSubtitle('Grow Your Deck');
        setPhaseBanner('buy');
        setBannerKey(k => k + 1);
        setInteractionBlocked(true);
      } else {
        // Still in REVEAL — waiting for other players in multiplayer.
        // Clear banner/interaction block; WebSocket will deliver BUY state
        // and the phase change effect will show the buy banner then.
        setPhaseBanner(null);
        setInteractionBlocked(false);
      }
    }).catch(() => {
      // Already acknowledged — clear state and let WebSocket handle transition
      setPhaseBanner(null);
      setInteractionBlocked(false);
    });
  }, [gameState.id, activePlayerId, animationOff, onStateUpdate]);

  // "Done Reviewing" clicked — acknowledge this player's resolve, then advance to buy
  const handleDoneReviewing = useCallback(() => {
    setReviewHoveredTile(null);
    setReviewHoveredPlayer(null);
    setReviewing(false);
    revealedActionsRef.current = null;
    advanceAndShowBuy();
  }, [advanceAndShowBuy]);
  handleDoneReviewingRef.current = handleDoneReviewing;

  // Review countdown: 30s auto-accept timer when "Done Reviewing" button is visible
  const reviewButtonActive = reviewButtonVisible && !activePlayer?.has_acknowledged_resolve;
  useEffect(() => {
    if (reviewButtonActive) {
      setReviewCountdown(30);
    } else {
      setReviewCountdown(null);
    }
  }, [reviewButtonActive]);

  useEffect(() => {
    if (reviewCountdown === null || reviewCountdown <= 0) return;
    const timer = setTimeout(() => setReviewCountdown(c => c !== null ? c - 1 : null), 1000);
    return () => clearTimeout(timer);
  }, [reviewCountdown]);

  useEffect(() => {
    if (reviewCountdown === 0) {
      handleDoneReviewingRef.current?.();
    }
  }, [reviewCountdown]);

  // Phase banner completed
  const handleBannerComplete = useCallback(() => {
    setBannerLabelOverride(null);
    // Reset debt animation state
    setDebtFlyTarget(null);
    setForcePlayerPanelExpanded(false);
    setBannerHoldUntilRelease(false);
    debtFlyPendingRef.current = null;
    const bannerPhase = phaseBanner;

    // Upkeep banner finished → advance to PLAY via API, then show PLAY banner
    if (bannerPhase === 'upkeep') {
      // Test mode "Give Debt" button — just dismiss the banner, don't call API
      if (testDebtBannerRef.current) {
        testDebtBannerRef.current = false;
        setPhaseBanner(null);
        setInteractionBlocked(false);
        return;
      }
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
        // Chain into the play banner — sync ref so phase effect doesn't re-trigger
        prevPhaseRef.current = result.state.current_phase;
        setBannerSubtitle(null);
        setPhaseBanner('play');
        setBannerKey(k => k + 1);
      }).catch(() => {
        setPhaseBanner(null);
        setInteractionBlocked(false);
      });
      return;
    }

    if (bannerPhase === 'reveal' && !resolving) {
      // Reveal banner finished but no resolution steps to animate —
      // show player effects if any, then enter review mode.

      // Show player effect popups if any (e.g. Sabotage forced discards)
      const effects = gameState.player_effects;
      if (effects && effects.length > 0 && !animationOff) {
        // Show effects first, then enter review mode after they complete
        setPhaseBanner(null);
        setInteractionBlocked(true);
        setActivePlayerEffects(effects);
        const targetCounts: Record<string, number> = {};
        for (const e of effects) targetCounts[e.target_player_id] = (targetCounts[e.target_player_id] ?? 0) + 1;
        const maxStack = Math.max(...Object.values(targetCounts));
        // Popups handle their own intro+settle+stack timeline internally and
        // persist until `activePlayerEffects` is cleared. Enter review mode
        // right after the intro animation + a short buffer so the player can
        // read the stack and press Done Reviewing to dismiss.
        const introDuration = 650 + (maxStack - 1) * 300 + 400;
        setTimeout(() => {
          enterReviewMode();
        }, introDuration);
        return;
      }

      // No effects — enter review mode directly
      enterReviewMode();
      return;
    }

    // If the actual game phase is still upkeep (e.g. after intro "Begin!" banner),
    // auto-advance through upkeep to reach play phase
    if (phase === 'upkeep' && bannerPhase !== 'upkeep') {
      api.advanceUpkeep(gameState.id).then(result => {
        onStateUpdate(result.state);
        prevPhaseRef.current = result.state.current_phase;
        setBannerSubtitle(null);
        setPhaseBanner('play');
        setBannerKey(k => k + 1);
      }).catch(() => {
        setPhaseBanner(null);
        setInteractionBlocked(false);
      });
      return;
    }

    setPhaseBanner(null);
    // Sync phase ref so the phase change effect doesn't re-trigger for this phase
    prevPhaseRef.current = phase;
    // If resolving, don't unblock interactions yet — resolve overlay will do that
    if (!resolving) {
      setInteractionBlocked(false);
      // Auto-open shop after buy banner completes if active player hasn't finished buying
      if (bannerPhase === 'buy' && !gameState.players_done_buying.includes(activePlayerId)) {
        setShowShopOverlay(true);
      }
    }
  }, [resolving, phaseBanner, phase, onStateUpdate, animationOff, enterReviewMode, gameState, activePlayerId]);

  // Debt fly animation complete — release banner hold, collapse panel after short delay
  const handleDebtFlyComplete = useCallback(() => {
    setDebtFlyTarget(null);
    setBannerHoldUntilRelease(false);
    debtFlyPendingRef.current = null;
    // Collapse player panel after a brief delay so the user sees the target highlight
    setTimeout(() => setForcePlayerPanelExpanded(false), 400);
  }, []);

  // Effect: after panel expands, measure target player row and start flying
  useEffect(() => {
    const pid = debtFlyPendingRef.current;
    if (!pid || !forcePlayerPanelExpanded) return;
    // Wait for panel expansion CSS transition (200ms) + render buffer
    const t = setTimeout(() => {
      const row = playerRowRefs.current.get(pid);
      if (row?.isConnected) {
        setDebtFlyTarget(row.getBoundingClientRect());
      } else {
        // Fallback: release banner without animation
        setBannerHoldUntilRelease(false);
      }
      debtFlyPendingRef.current = null;
    }, 300);
    return () => clearTimeout(t);
  }, [forcePlayerPanelExpanded]);

  // Hatching Grounds / Master Engineer: spawn card flights for any new
  // create_cards_to_discard player_effects targeting the active player.
  // Fires during Play phase (effects cleared at REVEAL start).
  useEffect(() => {
    if (animationOff) return;
    const effects = gameState.player_effects;
    if (!effects || effects.length === 0) return;
    const discardEl = document.querySelector('[data-discard-pile]');
    if (!discardEl) return;
    const targetRect = discardEl.getBoundingClientRect();

    const newFlights: typeof createdCardFlights = [];
    for (let i = 0; i < effects.length; i++) {
      const effect = effects[i];
      if (effect.effect_type !== 'create_cards_to_discard') continue;
      if (effect.target_player_id !== activePlayerId) continue;
      if (!effect.added_card || !effect.added_card_count) continue;
      const key = `${i}:${effect.source_player_id}:${effect.card_name}:${effect.added_card_name}:${effect.added_card_count}`;
      if (spawnedCreatedFlightKeysRef.current.has(key)) continue;
      spawnedCreatedFlightKeysRef.current.add(key);

      const archetype = effect.added_card.archetype;
      const glow =
        archetype === 'swarm' ? 'rgba(106, 200, 120, 0.55)' :
        archetype === 'fortress' ? 'rgba(120, 155, 220, 0.55)' :
        archetype === 'vanguard' ? 'rgba(220, 110, 90, 0.55)' :
        'rgba(204, 204, 204, 0.5)';
      for (let c = 0; c < effect.added_card_count; c++) {
        const id = ++createdCardFlightIdRef.current;
        newFlights.push({
          id,
          card: effect.added_card,
          targetRect,
          delayMs: c * 120,
          glow,
        });
      }
    }
    if (newFlights.length > 0) {
      setCreatedCardFlights(prev => [...prev, ...newFlights]);
    }
    // Intentional: createdCardFlights excluded — spawning reads the ref set, not state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.player_effects, activePlayerId, animationOff]);

  // Drop spawned-flight keys when player_effects is cleared (REVEAL start)
  // so a future round's effects can re-spawn correctly.
  useEffect(() => {
    if (!gameState.player_effects || gameState.player_effects.length === 0) {
      spawnedCreatedFlightKeysRef.current.clear();
    }
  }, [gameState.player_effects]);

  const handleCreatedCardFlightComplete = useCallback((id: number) => {
    setCreatedCardFlights(prev => prev.filter(f => f.id !== id));
  }, []);

  // Phase banner midpoint — start debt card fly animation if applicable
  const handleBannerMidpoint = useCallback(() => {
    if (phaseBanner !== 'upkeep') return;
    if (animationOff) return;

    // Use test override if available, otherwise parse game log
    const recipient = testDebtRecipientRef.current ?? (
      gameState.current_round >= DEBT_START_ROUND ? findDebtRecipientFromLog(gameState) : null
    );
    testDebtRecipientRef.current = null; // consume the override
    if (!recipient) return;

    const isActive = recipient.id === activePlayerId;

    if (isActive) {
      // Target discard pile button (always visible in CardHand)
      const discardEl = document.querySelector('[data-discard-pile]');
      if (discardEl) {
        setDebtFlyTarget(discardEl.getBoundingClientRect());
      } else {
        setBannerHoldUntilRelease(false);
      }
    } else {
      // Target player card in sidebar — may need to expand panel first
      // Check isConnected because stale refs linger in the Map after panel collapses
      const existingRow = playerRowRefs.current.get(recipient.id);
      if (existingRow?.isConnected) {
        setDebtFlyTarget(existingRow.getBoundingClientRect());
      } else {
        // Force-expand player panel, then an effect will start the animation
        setForcePlayerPanelExpanded(true);
        debtFlyPendingRef.current = recipient.id;
      }
    }
  }, [phaseBanner, gameState, activePlayerId, animationOff]);

  // Resolve animation completed — advance resolve and move to buy phase
  const handleResolveComplete = useCallback(() => {
    // Cards with no resolution step of their own (e.g. Sabotage on an
    // opponent's tile) go home now.
    flyRevealCardsRef.current(() => true, 80);
    setRevealFocusTile(null);
    setResolving(false);
    setResolutionSteps([]);
    setResolveDisplayState(null);
    setResolvedUpToStep(-1);
    setCurrentStepFade(1);
    resolveChevronCacheRef.current = [];
    // Recompute VP paths for all players after resolve and clear resolve log
    const postResolveTiles = gameState.grid?.tiles;
    if (postResolveTiles) {
      const allPaths: VpPath[] = [];
      for (const pid of gameState.player_order) {
        const color = PLAYER_COLORS[pid] ?? 0xffffff;
        allPaths.push(...computePlayerVpPaths(postResolveTiles, pid, color));
      }
      if (allPaths.length > 0) {
        setVpPaths(allPaths);
        setVpPathPhase('fading_in');
      } else {
        setVpPaths([]);
        setVpPathPhase('off');
      }
    }
    setResolveLogEntries([]);

    // Show player effect popups if any (e.g. Sabotage forced discards)
    const effects = gameState.player_effects;
    if (effects && effects.length > 0 && !animationOff) {
      // Show effects first, then enter review mode after they complete
      setInteractionBlocked(true);
      setActivePlayerEffects(effects);
      const targetCounts: Record<string, number> = {};
      for (const e of effects) targetCounts[e.target_player_id] = (targetCounts[e.target_player_id] ?? 0) + 1;
      const maxStack = Math.max(...Object.values(targetCounts));
      const totalDuration = 2500 + (maxStack - 1) * 300;
      setTimeout(() => {
        enterReviewMode();
      }, totalDuration);
    } else {
      // No effects — enter review mode
      enterReviewMode();
    }
  }, [animationOff, vpPaths, enterReviewMode, gameState]);

  // Called by ResolveOverlay as each step begins — update the displayed tile state & fade chevrons
  const applyResolveStep = useCallback((stepIdx: number) => {
    const step = resolutionSteps[stepIdx];
    if (!step) return;
    // Start fading chevrons for this step's tile
    setResolvedUpToStep(stepIdx);
    setCurrentStepFade(1);
    setResolveDisplayState(prev => {
      if (!prev?.grid) return prev;
      const newTiles = { ...prev.grid.tiles };
      const tile = newTiles[step.tile_key];
      // Base tiles never change ownership on a successful claim — the raid
      // generates Rubble/Spoils via player_effect popups instead. Preserve
      // the base tile's color during the resolve animation.
      if (tile && step.winner_id && (step.outcome === 'claimed' || step.outcome === 'auto_claim') && !tile.is_base) {
        newTiles[step.tile_key] = {
          ...tile,
          owner: step.winner_id,
        };
      }
      // Consecrate: update tile VP value so stars re-render
      if (tile && step.outcome === 'consecrate' && step.vp_value != null) {
        newTiles[step.tile_key] = {
          ...tile,
          vp_value: step.vp_value,
        };
      }
      // Defense applied: update tile defense values so labels re-render
      if (tile && step.outcome === 'defense_applied') {
        const permDef = step.defense_permanent ?? 0;
        const tempDef = step.defense_temporary ?? 0;
        newTiles[step.tile_key] = {
          ...tile,
          defense_power: permDef + tempDef,
          permanent_defense_bonus: permDef - tile.base_defense,
          ...(step.defense_immunity ? { immune: true } : {}),
        };
      }

      // Move resolved claim cards from planned_actions → discard for each claimant
      const newPlayers = { ...prev.players };
      for (const claimant of step.claimants) {
        const player = newPlayers[claimant.player_id];
        if (!player) continue;
        const actionIdx = player.planned_actions.findIndex(a =>
          a.card.card_type === 'claim' && a.target_q === step.q && a.target_r === step.r
        );
        if (actionIdx >= 0) {
          const action = player.planned_actions[actionIdx];
          const newPlanned = [...player.planned_actions];
          newPlanned.splice(actionIdx, 1);
          const newDiscard = [...player.discard, action.card];
          newPlayers[claimant.player_id] = {
            ...player,
            planned_actions: newPlanned,
            discard: newDiscard,
            discard_count: player.discard_count + 1,
          };
        }
      }

      // Recompute tile-based VP for any player who gained or lost a tile this step
      if (step.outcome === 'claimed' || step.outcome === 'auto_claim' || step.outcome === 'consecrate') {
        const affectedPids = new Set<string>();
        if (step.winner_id) affectedPids.add(step.winner_id);
        if (step.previous_owner) affectedPids.add(step.previous_owner);
        for (const pid of affectedPids) {
          const cardVp = preResolveCardVpRef.current[pid] ?? 0;
          const { tileCount, bonusTiles } = computeTileBasedVp(newTiles, pid);
          const player = newPlayers[pid];
          if (player) {
            newPlayers[pid] = { ...player, vp: tileCount + bonusTiles + cardVp };
          }
        }
      }

      return { ...prev, grid: { ...prev.grid, tiles: newTiles }, players: newPlayers };
    });

    // Recompute VP paths affected by this tile change.
    // Base tiles never change hands on a raid, so their VP paths are intact.
    const stepTile = resolveDisplayTilesRef.current?.[step.tile_key];
    if (step.outcome === 'claimed' && step.winner_id && step.previous_owner && !stepTile?.is_base) {
      const lostTileKey = step.tile_key;
      const loserId = step.previous_owner;

      // Build the post-step tile map for path recomputation
      const prevTiles = resolveDisplayTilesRef.current;
      let tilesAfterStep: Record<string, import('../types/game').HexTile> | null = null;
      if (prevTiles) {
        tilesAfterStep = { ...prevTiles };
        const t = tilesAfterStep[step.tile_key];
        if (t) {
          tilesAfterStep[step.tile_key] = { ...t, owner: step.winner_id };
        }
      }

      const winnerId = step.winner_id;
      const winnerName = gameState.players[winnerId]?.name ?? winnerId;
      const loserName = gameState.players[loserId]?.name ?? loserId;

      setVpPaths(prev => {
        let changed = false;
        const broken: string[] = [];
        const next = prev.map(p => {
          if (p.breaking || p.playerId !== loserId) return p;
          const onPath = p.points.some(([q, r]) => `${q},${r}` === lostTileKey);
          if (!onPath) return p;
          changed = true;

          // If the VP tile itself was captured, path is gone
          const vpQ = p.points[0][0];
          const vpR = p.points[0][1];
          const vpKey = `${vpQ},${vpR}`;
          if (tilesAfterStep && tilesAfterStep[vpKey]?.owner !== loserId) {
            broken.push(vpKey);
            return { ...p, breaking: true };
          }

          // Try to find an alternate route through updated tiles
          if (tilesAfterStep) {
            const color = PLAYER_COLORS[loserId] ?? 0xffffff;
            const newPaths = computePlayerVpPaths(tilesAfterStep, loserId, color);
            const replacement = newPaths.find(np =>
              np.points[0][0] === vpQ && np.points[0][1] === vpR
            );
            if (replacement) {
              // Reroute to the new shortest path (keep noPulse for resolve)
              return { ...p, points: replacement.points, noPulse: true };
            }
          }

          // No alternate path — connection is broken
          broken.push(vpKey);
          return { ...p, breaking: true };
        });

        // Log VP path disruptions
        if (broken.length > 0) {
          setResolveLogEntries(prev => [
            ...prev,
            `${winnerName} disrupted ${loserName}'s VP bonus path${broken.length > 1 ? 's' : ''} at ${lostTileKey}`,
          ]);
        }

        return changed ? next : prev;
      });
    }
  }, [resolutionSteps, gameState.players]);

  // ── Test mode handlers ──────────────────────────────────────
  const handleTestGiveCard = useCallback(async (cardId: string) => {
    try {
      setError(null);
      const result = await api.testGiveCard(gameState.id, activePlayerId, cardId);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestSetStats = useCallback(async (vp?: number, resources?: number, actions?: number) => {
    try {
      setError(null);
      const result = await api.testSetStats(gameState.id, activePlayerId, vp, resources, actions);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestSetRound = useCallback(async (round: number) => {
    try {
      setError(null);
      const result = await api.testSetRound(gameState.id, round);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, onStateUpdate]);

  const handleTestDiscardCard = useCallback(async (cardIndex: number) => {
    try {
      setError(null);
      const result = await api.testDiscardCard(gameState.id, activePlayerId, cardIndex);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestTrashCard = useCallback(async (cardIndex: number) => {
    try {
      setError(null);
      const card = activePlayer?.hand[cardIndex];
      if (card) setTrashedCardIds(new Set([card.id]));
      const result = await api.testTrashCard(gameState.id, activePlayerId, cardIndex);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate, activePlayer]);

  const handleTestDrawCard = useCallback(async (count: number = 1) => {
    try {
      setError(null);
      const result = await api.testDrawCard(gameState.id, activePlayerId, count);
      onStateUpdate(result.state);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  const handleTestDiscardHand = useCallback(async () => {
    try {
      setError(null);
      const result = await api.testDiscardHand(gameState.id, activePlayerId);
      onStateUpdate(result.state);
      setSelectedCardIndex(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, activePlayerId, onStateUpdate]);

  // ── Game Over handlers ─────────────────────────────────────

  const handleReturnToLobby = useCallback(async () => {
    if (!mpPlayerId || !mpToken) return;
    try {
      await api.returnToLobby(gameState.id, mpPlayerId, mpToken);
      // The lobby_update WS message will handle screen transition
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [gameState.id, mpPlayerId, mpToken]);

  const handleExitGame = useCallback(async () => {
    onLeaveGame?.();
  }, [onLeaveGame]);

  const selectedCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] : null;
  const hoveredCard = hoveredCardIndex !== null ? activePlayer?.hand[hoveredCardIndex] : null;
  // For grid highlighting, prefer hovered card over selected card
  const highlightCard = hoveredCard ?? selectedCard;

  // Review mode: compute tiles that had cards played on them
  const reviewPulseTiles = useMemo(() => {
    if (!reviewing) return undefined;
    const actions = revealedActionsRef.current;
    if (!actions) return undefined;
    const tiles = new Set<string>();
    for (const playerActions of Object.values(actions)) {
      for (const action of playerActions) {
        const key = actionTileKey(action);
        if (key) {
          tiles.add(key);
          // Include extra targets (e.g. Surge)
          if (action.extra_targets) {
            for (const [eq, er] of action.extra_targets) {
              tiles.add(`${eq},${er}`);
            }
          }
        }
      }
    }
    return tiles.size > 0 ? tiles : undefined;
  }, [reviewing, actionTileKey]);

  // Review mode: build lookup of cards played per tile (for hover popup)
  const reviewTileCards = useMemo(() => {
    if (!reviewing) return null;
    const actions = revealedActionsRef.current;
    if (!actions) return null;
    const map = new Map<string, { playerId: string; playerName: string; card: import('../types/game').Card; effectivePower?: number; effectiveResourceGain?: number; effectiveDrawCards?: number }[]>();
    for (const [pid, playerActions] of Object.entries(actions)) {
      const player = gameState.players[pid];
      const name = player?.name ?? pid;
      for (const action of playerActions) {
        const key = actionTileKey(action);
        const entry = { playerId: pid, playerName: name, card: action.card, effectivePower: action.effective_power, effectiveResourceGain: action.effective_resource_gain, effectiveDrawCards: action.effective_draw_cards };
        if (key) {
          if (!map.has(key)) map.set(key, []);
          map.get(key)!.push(entry);
        }
        // Also include extra targets (multi-target cards like Surge, Twin Cities, Bulwark)
        if (action.extra_targets) {
          for (const [eq, er] of action.extra_targets) {
            const extraKey = `${eq},${er}`;
            if (!map.has(extraKey)) map.set(extraKey, []);
            map.get(extraKey)!.push(entry);
          }
        }
      }
    }
    return map;
  }, [reviewing, gameState.players, actionTileKey]);

  // Submit Play button state (used by keyboard handler and UI)
  // NOTE: declared here so it's available to the keyboard effect above

  // Player tile count and VP tracking
  const tilesPerVp = 3;
  const playerTileCount = activePlayer
    ? Object.values(gameState.grid.tiles).filter(t => t.owner === activePlayerId).length
    : 0;
  const anyPlayerReachedVp = Object.values(gameState.players).some(p => !p.has_left && p.vp >= gameState.vp_target);
  const pendingClaimCount = activePlayer
    ? activePlayer.planned_actions.filter(a => a.card.card_type === 'claim' && a.target_q !== null).length
    : 0;

  // Hex distance in axial coordinates
  const hexDistance = useCallback((q1: number, r1: number, q2: number, r2: number): number => {
    return Math.max(Math.abs(q1 - q2), Math.abs(r1 - r2), Math.abs((q1 + r1) - (q2 + r2)));
  }, []);

  // Filter tiles to only those a given claim card can actually be played on
  const getValidClaimTiles = useCallback((card: Card | null | undefined): { strong: Set<string>; weak: Set<string> } => {
    const empty = { strong: new Set<string>(), weak: new Set<string>() };
    if (!card || card.card_type !== 'claim') return { strong: adjacentTiles, weak: new Set() };
    const tiles = gameState.grid?.tiles;
    if (!tiles) return empty;

    // Flood / target_own_tile: highlight player's own tiles as valid targets
    if (card.target_own_tile) {
      const strong = new Set<string>();
      for (const [key, tile] of Object.entries(tiles)) {
        if (tile.owner === activePlayerId) {
          strong.add(key);
        }
      }
      return { strong, weak: new Set() };
    }

    const strong = new Set<string>();
    const weak = new Set<string>();

    // Tiles locked by a prior non-stackable claim this turn (primary or
    // extra target). Stackable prior claims don't lock the tile, and a
    // stackable new card is never locked out.
    const alreadyClaimed = new Set<string>();
    if (!card.stackable && activePlayer?.planned_actions) {
      for (const action of activePlayer.planned_actions) {
        if (action.card.card_type !== 'claim') continue;
        if (action.card.stackable) continue;
        if (action.target_q != null) {
          alreadyClaimed.add(`${action.target_q},${action.target_r}`);
        }
        if (action.extra_targets) {
          for (const [eq, er] of action.extra_targets) {
            alreadyClaimed.add(`${eq},${er}`);
          }
        }
      }
    }

    // Determine candidate tiles based on adjacency requirement + claim_range
    let candidates: Iterable<string>;
    if (!card.adjacency_required) {
      candidates = Object.keys(tiles);
    } else if (card.claim_range > 1) {
      // Extended range: find all tiles within N steps of any owned tile
      const rangedSet = new Set<string>();
      const ownedTiles = Object.values(tiles).filter(t => t.owner === activePlayerId);
      for (const key of Object.keys(tiles)) {
        const t = tiles[key];
        if (!t || t.is_blocked || t.owner === activePlayerId) continue;
        for (const owned of ownedTiles) {
          if (hexDistance(t.q, t.r, owned.q, owned.r) <= card.claim_range) {
            rangedSet.add(key);
            break;
          }
        }
      }
      candidates = rangedSet;
    } else {
      candidates = adjacentTiles;
    }

    // Adjacency-bridge targeting restriction (legacy effect type; no current card uses it —
    // Road Builder now gets bonus power on bridging tiles instead): precompute the bridge check
    const needsBridge = card.effects?.some(e => e.type === 'adjacency_bridge') ?? false;
    // Build set of all owned tile coords for bridge BFS
    const ownedSet = needsBridge
      ? new Set<string>(Object.keys(tiles).filter(k => tiles[k].owner === activePlayerId))
      : null;

    const handSize = activePlayer?.hand.length ?? 0;

    for (const key of candidates) {
      const tile = tiles[key];
      if (!tile || tile.is_blocked) continue;
      // Skip own tiles (can't claim what you own)
      if (tile.owner === activePlayerId) continue;
      // Skip immune tiles (Iron Wall / Stronghold)
      if (tile.immune) continue;
      // Exclude occupied tiles for unoccupied_only cards
      if (tile.owner && card.unoccupied_only) continue;
      // Exclude tiles already claimed this turn (no stacking)
      if (alreadyClaimed.has(key)) continue;
      // Adjacency bridge: tile must connect 2+ disconnected territory groups
      if (needsBridge && ownedSet) {
        // Find owned neighbors of this tile
        const ownedNeighbors: string[] = [];
        for (const [dq, dr] of HEX_DIRS) {
          const nk = `${tile.q + dq},${tile.r + dr}`;
          if (ownedSet.has(nk)) ownedNeighbors.push(nk);
        }
        if (ownedNeighbors.length < 2) continue;
        // BFS to count distinct groups among owned neighbors
        const visited = new Set<string>();
        let groups = 0;
        for (const start of ownedNeighbors) {
          if (visited.has(start)) continue;
          groups++;
          if (groups >= 2) break;
          // BFS through owned tiles from this neighbor
          const queue = [start];
          visited.add(start);
          while (queue.length > 0) {
            const cur = queue.pop()!;
            const [cq, cr] = cur.split(',').map(Number);
            for (const [dq, dr] of HEX_DIRS) {
              const nk = `${cq + dq},${cr + dr}`;
              if (!visited.has(nk) && ownedSet.has(nk)) {
                visited.add(nk);
                queue.push(nk);
              }
            }
          }
        }
        if (groups < 2) continue;
      }
      // Classify: strong (power sufficient) vs weak (power insufficient)
      // Queued Claim buffs (War Banner, Swarm Tactics, Rally Cry+): the next Claim
      // consumes one buff per distinct source card, so sum those.
      const claimBuffBonus = card.card_type === 'claim'
        ? (() => {
            const seen = new Set<string | undefined>();
            let total = 0;
            for (const b of activePlayer?.claim_buffs ?? []) {
              if (seen.has(b.source_card_id)) continue;
              seen.add(b.source_card_id);
              total += b.power_bonus ?? 0;
            }
            return total;
          })()
        : 0;
      // Strike Team: bonus power if the active player already played another Claim this round.
      const hasPlayedClaim = (activePlayer?.planned_actions ?? [])
        .some(a => a.card.card_type === 'claim' && a.card.id !== card.id);
      let effectivePower = computeClaimPowerOnTile(card, tile, tiles, activePlayerId, handSize, playerTileCount, claimBuffBonus, hasPlayedClaim);
      // For stackable cards, add power from existing planned claims on this tile
      if (card.stackable && activePlayer?.planned_actions) {
        const combinedClaims: Card[] = [card];
        for (const action of activePlayer.planned_actions) {
          if (action.card.card_type !== 'claim') continue;
          if (`${action.target_q},${action.target_r}` === key) {
            effectivePower += computeClaimPowerOnTile(action.card, tile, tiles, activePlayerId, handSize, playerTileCount);
            combinedClaims.push(action.card);
          }
        }
        // Add stacking power bonus (e.g. Dog Pile) — each claim with
        // stacking_power_bonus grants its value to every other claim in the stack.
        effectivePower += computeStackingPowerBonus(combinedClaims);
      }
      if (canClaimCaptureTile(card, tile, effectivePower)) {
        strong.add(key);
      } else {
        weak.add(key);
      }
    }

    // Own tiles are valid defensive placements for Claim cards (the claim
    // power adds to the tile's defense at resolution time). Skip this for
    // unoccupied_only cards (e.g. Proliferate) and adjacency-bridge cards
    // (legacy restriction) which can't meaningfully target a tile already owned.
    if (!card.unoccupied_only && !needsBridge) {
      for (const [key, tile] of Object.entries(tiles)) {
        if (!tile || tile.is_blocked) continue;
        if (tile.owner !== activePlayerId) continue;
        if (alreadyClaimed.has(key)) continue;
        strong.add(key);
      }
    }

    return { strong, weak };
  }, [adjacentTiles, gameState.grid?.tiles, activePlayer?.planned_actions, activePlayerId, hexDistance]);

  // All tiles a card can legally be played on (includes own tiles for defensive claims)
  const getAllValidPlayTiles = useCallback((card: Card | null | undefined): Set<string> => {
    if (!card) return new Set();

    // Defense cards: only own tiles are valid targets
    if (card.card_type === 'defense') {
      const valid = new Set<string>();
      const tiles = gameState.grid?.tiles;
      if (tiles) {
        for (const [key, tile] of Object.entries(tiles)) {
          if (tile.owner === activePlayerId && !tile.is_blocked) {
            valid.add(key);
          }
        }
      }
      return valid;
    }

    // Engine cards targeting own tiles
    if (card.card_type === 'engine' && card.target_own_tile) {
      const valid = new Set<string>();
      const tiles = gameState.grid?.tiles;
      if (tiles) {
        // Consecrate: only connected VP tiles
        const isConsecrate = card.effects?.some(e => e.type === 'enhance_vp_tile');
        if (isConsecrate) {
          for (const key of connectedVpTiles) {
            const tile = tiles[key];
            if (tile && tile.owner === activePlayerId) {
              valid.add(key);
            }
          }
        } else {
          for (const [key, tile] of Object.entries(tiles)) {
            if (tile.owner === activePlayerId && !tile.is_base && !tile.is_blocked) {
              valid.add(key);
            }
          }
        }
      }
      return valid;
    }

    // Start with the highlighted expansion targets for claim cards (union strong + weak)
    const { strong, weak } = getValidClaimTiles(card);
    const valid = new Set([...strong, ...weak]);
    // For claim cards (not unoccupied_only, not target_own_tile which is already handled),
    // also include own tiles as valid defensive placements
    const isBridge = card.effects?.some(e => e.type === 'adjacency_bridge') ?? false;
    if (card.card_type === 'claim' && !card.unoccupied_only && !card.target_own_tile && !isBridge) {
      const tiles = gameState.grid?.tiles;
      if (tiles) {
        const alreadyClaimed = new Set<string>();
        if (!card.stackable && activePlayer?.planned_actions) {
          for (const action of activePlayer.planned_actions) {
            if (action.card.card_type !== 'claim') continue;
            if (action.card.stackable) continue;
            if (action.target_q != null) {
              alreadyClaimed.add(`${action.target_q},${action.target_r}`);
            }
            if (action.extra_targets) {
              for (const [eq, er] of action.extra_targets) {
                alreadyClaimed.add(`${eq},${er}`);
              }
            }
          }
        }
        for (const [key, tile] of Object.entries(tiles)) {
          if (tile.owner === activePlayerId && !tile.is_blocked && !alreadyClaimed.has(key)) {
            valid.add(key);
          }
        }
      }
    }
    return valid;
  }, [getValidClaimTiles, gameState.grid?.tiles, activePlayer?.planned_actions, activePlayerId, connectedVpTiles]);

  // Helper: find closest tile owned by a player to a target position
  const findClosestOwnedTile = useCallback((
    targetQ: number, targetR: number,
    tiles: Record<string, import('../types/game').HexTile>,
    playerId: string,
  ): { q: number; r: number } | null => {
    let closest: { q: number; r: number } | null = null;
    let minDist = Infinity;
    for (const tile of Object.values(tiles)) {
      if (tile.owner !== playerId) continue;
      const dist = hexDistance(tile.q, tile.r, targetQ, targetR);
      if (dist < minDist) {
        minDist = dist;
        closest = { q: tile.q, r: tile.r };
      }
    }
    return closest;
  }, [hexDistance]);

  // Build claim chevrons for the active player during play phase
  const planChevrons = useMemo((): ClaimChevron[] => {
    if (phase !== 'play' || !activePlayer?.planned_actions || resolving) return [];
    const tiles = gameState.grid?.tiles;
    if (!tiles) return [];

    const color = PLAYER_COLORS[activePlayerId] ?? 0xffffff;
    const chevrons: ClaimChevron[] = [];

    // Find base tile for ranged claims (fallback when target isn't adjacent to territory)
    const baseTile = Object.values(tiles).find(t => t.is_base && t.owner === activePlayerId);

    for (const action of activePlayer.planned_actions) {
      if (action.card.card_type !== 'claim') continue;
      if (action.target_q == null || action.target_r == null) continue;

      const closest = findClosestOwnedTile(action.target_q, action.target_r, tiles, activePlayerId);
      if (!closest) continue;
      // Skip if claim is on own tile (defensive play, no directional chevron needed)
      const targetKey = `${action.target_q},${action.target_r}`;
      if (tiles[targetKey]?.owner === activePlayerId) continue;

      // If closest owned tile is not adjacent, use base tile as arrow direction
      const dist = hexDistance(action.target_q, action.target_r, closest.q, closest.r);
      const source = dist > 1 && baseTile ? { q: baseTile.q, r: baseTile.r } : closest;

      chevrons.push({
        targetQ: action.target_q, targetR: action.target_r,
        sourceQ: source.q, sourceR: source.r,
        color, alpha: 1,
      });

      // Extra targets (Surge)
      if (action.extra_targets) {
        for (const [eq, er] of action.extra_targets) {
          const ec = findClosestOwnedTile(eq, er, tiles, activePlayerId);
          if (!ec) continue;
          const ek = `${eq},${er}`;
          if (tiles[ek]?.owner === activePlayerId) continue;
          const eDist = hexDistance(eq, er, ec.q, ec.r);
          const es = eDist > 1 && baseTile ? { q: baseTile.q, r: baseTile.r } : ec;
          chevrons.push({
            targetQ: eq, targetR: er,
            sourceQ: es.q, sourceR: es.r,
            color, alpha: 1,
          });
        }
      }
    }
    return chevrons;
  }, [phase, activePlayer?.planned_actions, gameState.grid?.tiles, activePlayerId, findClosestOwnedTile, resolving]);

  // Build chevrons for ALL players' claims during resolve phase (from resolution_steps)
  const resolveChevrons = useMemo((): ClaimChevron[] => {
    if (!resolving || !resolutionSteps.length) return [];
    const cached = resolveChevronCacheRef.current;
    if (!cached.length) return [];

    const chevrons: ClaimChevron[] = [];
    for (const entry of cached) {
      // Per-step alpha: already resolved → 0, currently resolving → fading, pending → full
      let stepAlpha: number;
      if (entry.stepIndex < resolvedUpToStep) {
        stepAlpha = 0;
      } else if (entry.stepIndex === resolvedUpToStep) {
        stepAlpha = chevronAlpha * currentStepFade;
      } else {
        stepAlpha = chevronAlpha;
      }
      if (stepAlpha <= 0) continue;

      chevrons.push({
        targetQ: entry.targetQ, targetR: entry.targetR,
        sourceQ: entry.sourceQ, sourceR: entry.sourceR,
        color: entry.color, alpha: stepAlpha,
      });
    }
    return chevrons;
  }, [resolving, resolutionSteps, chevronAlpha, resolvedUpToStep, currentStepFade]);

  // Active chevrons: play phase or resolve reveal
  const activeChevrons = resolving ? resolveChevrons : planChevrons;

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
    const map = new Map<string, PlannedActionIcon>();

    const addToMap = (key: string, type: string, power: number, name: string, card: Card, effectivePower?: number, isPermanentDef?: boolean) => {
      const existing = map.get(key);
      if (existing) {
        // Stackable: accumulate power from multiple cards on the same tile
        existing.power += power;
        existing.name = `${existing.name} + ${name}`;
        existing.card = card;
        existing.allCards.push({ card, effectivePower });
        if (isPermanentDef) {
          existing.permanentDefPower += power;
        } else if (type === 'defense' || type === 'claim') {
          existing.tempDefPower += power;
        }
      } else {
        const permDef = isPermanentDef ? power : 0;
        const tmpDef = !isPermanentDef && (type === 'defense' || type === 'claim') ? power : 0;
        map.set(key, { type, power, name, card, allCards: [{ card, effectivePower }], permanentDefPower: permDef, tempDefPower: tmpDef });
      }
    };

    for (const action of activePlayer.planned_actions) {
      if (action.target_q != null && action.target_r != null) {
        const key = `${action.target_q},${action.target_r}`;
        // Engine cards targeting own tiles (Scorched Retreat, Exodus) get 'abandon' type
        const type = action.card.card_type === 'engine' && action.card.target_own_tile ? 'abandon' : action.card.card_type;
        const effectivePow = action.effective_power ?? action.card.power;
        // For permanent_defense effects (e.g. Twin Cities), use effect value instead of defense_bonus
        const permDefEffect = action.card.effects?.find(e => e.type === 'permanent_defense');
        const defBonus = permDefEffect
          ? (action.card.is_upgraded && permDefEffect.upgraded_value != null ? permDefEffect.upgraded_value : permDefEffect.value)
          : action.card.defense_bonus;
        const power = type === 'defense' ? defBonus : effectivePow;
        const isPermDef = !!permDefEffect;
        addToMap(key, type, power, action.card.name, action.card, effectivePow, isPermDef);

        // Also show defense overlay on extra targets (multi-tile defense like Bulwark)
        if (type === 'defense' && action.extra_targets) {
          for (const [eq, er] of action.extra_targets) {
            const extraKey = `${eq},${er}`;
            addToMap(extraKey, type, defBonus, action.card.name, action.card, undefined, isPermDef);
          }
        }
        // Also show claim overlay on extra targets (Surge)
        if (type === 'claim' && action.extra_targets) {
          for (const [eq, er] of action.extra_targets) {
            const extraKey = `${eq},${er}`;
            addToMap(extraKey, type, effectivePow, action.card.name, action.card, effectivePow);
          }
        }
      }
    }
    return map.size > 0 ? map : undefined;
  }, [activePlayer?.planned_actions]);

  // Cards currently placed on the board during play phase (shown as "In Play" in deck viewer)
  // After resolve, these cards move to discard, so only show during play/reveal.
  const inPlayCards = useMemo(() => {
    if (phase !== 'play' && phase !== 'reveal') return [];
    if (!activePlayer?.planned_actions) return [];
    return activePlayer.planned_actions.map(a => a.card);
  }, [activePlayer?.planned_actions, phase]);

  // Full deck breakdown for the Deck viewer button
  const allDeckCards = useMemo(() => {
    if (!activePlayer) return [];
    return [
      ...(inPlayCards.length > 0 ? [{ label: 'In Play', items: inPlayCards }] : []),
      { label: 'In Hand', items: activePlayer.hand },
      { label: 'Draw Pile', items: activePlayer.deck_cards },
      { label: 'Discard Pile', items: activePlayer.discard },
      ...(activePlayer.trash?.length > 0 ? [{ label: 'Trashed', items: activePlayer.trash }] : []),
    ];
  }, [activePlayer, inPlayCards]);


  // Pre-compute weak highlight tiles for claim cards (orange outline = power insufficient)
  const weakHighlightTiles = useMemo((): Set<string> | undefined => {
    if (phase !== 'play') return undefined;
    // Determine active claim card (same logic as highlightTiles prop)
    let card: Card | null = null;
    if (multiTileCardIndex !== null) {
      const mtc = activePlayer?.hand[multiTileCardIndex];
      if (mtc?.card_type === 'claim') card = mtc;
    } else {
      card = highlightCard?.card_type === 'claim' ? highlightCard
        : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'claim'
          ? activePlayer?.hand[draggingCardIndex] ?? null : null;
    }
    if (!card) return undefined;
    const { weak } = getValidClaimTiles(card);
    return weak.size > 0 ? weak : undefined;
  }, [phase, multiTileCardIndex, activePlayer, highlightCard, draggingCardIndex, getValidClaimTiles]);

  // Undoable tiles: map tile key → planned action index for reversible cards
  const undoableTiles = useMemo(() => {
    if (phase !== 'play' || !activePlayer?.planned_actions || playSubmitted) return undefined;
    const map = new Map<string, number>();
    activePlayer.planned_actions.forEach((action, idx) => {
      if (!action.card.reversible) return;
      if (action.target_q != null && action.target_r != null) {
        const key = `${action.target_q},${action.target_r}`;
        map.set(key, idx); // LIFO: later index overwrites earlier
      }
      if (action.extra_targets) {
        for (const [eq, er] of action.extra_targets) {
          map.set(`${eq},${er}`, idx);
        }
      }
    });
    return map.size > 0 ? map : undefined;
  }, [phase, activePlayer?.planned_actions, playSubmitted]);

  const undoableTileSet = useMemo(() => {
    if (!undoableTiles) return undefined;
    return new Set(undoableTiles.keys());
  }, [undoableTiles]);

  // Undo: the returning card flies back to the hand from its tile
  const [undoReturn, setUndoReturn] = useState<UndoReturn | null>(null);
  const undoFlyIdRef = useRef(0);

  // Does this card aim at a tile when played? (Drives the aiming arrow's color.)
  const cardTargetsTile = useCallback((card: Card) => (
    card.card_type === 'claim'
    || card.card_type === 'defense'
    || (card.card_type === 'engine' && (needsOpponentTarget(card) || card.target_own_tile))
  ), []);

  // The tile under a dragged card, and whether the card can be played there.
  const dragTarget = useMemo<DragTargetInfo | null>(() => {
    if (draggingCardIndex === null || !dragHoverPos || !activePlayer) return null;
    const card = activePlayer.hand[draggingCardIndex];
    if (!card || !cardTargetsTile(card)) return null;
    const transform = gridTransformRef.current;
    const gRect = gridContainerRef.current?.getBoundingClientRect();
    if (!transform || !gRect) return null;
    const { clientX, clientY } = dragHoverPos;
    if (clientX < gRect.left || clientX > gRect.right || clientY < gRect.top || clientY > gRect.bottom) return null;
    const local = screenToLocal(clientX - gRect.left, clientY - gRect.top, transform, gRect.width, gRect.height);
    const { q, r } = pixelToAxial(local.x, local.y);
    const key = `${q},${r}`;
    const tile = gameState.grid?.tiles[key];
    if (!tile) return null;
    const valid = card.card_type === 'engine' && needsOpponentTarget(card)
      ? !!tile.owner && tile.owner !== activePlayerId
      : getAllValidPlayTiles(card).has(key);
    if (!valid) return { valid: false };
    const center = axialToPixel(q, r);
    const screen = localToScreen(center.x, center.y, transform, gRect.width, gRect.height, gRect);
    return { valid: true, x: screen.x, y: screen.y };
  }, [draggingCardIndex, dragHoverPos, activePlayer, activePlayerId, cardTargetsTile, gameState.grid, getAllValidPlayTiles]);

  // War Banner-style buffs waiting for the next Claim: one buff per distinct
  // source card (FIFO within each source), summed — mirrors the backend.
  const claimBuffBonus = useMemo(() => {
    if (phase !== 'play') return 0;
    const seen = new Set<string | undefined>();
    let total = 0;
    for (const b of activePlayer?.claim_buffs ?? []) {
      if (seen.has(b.source_card_id)) continue;
      seen.add(b.source_card_id);
      total += b.power_bonus ?? 0;
    }
    return total;
  }, [phase, activePlayer?.claim_buffs]);

  const handleTileLongPress = useCallback(async (q: number, r: number) => {
    if (phase !== 'play' || !activePlayer || !undoableTiles) return;
    const key = `${q},${r}`;
    const actionIndex = undoableTiles.get(key);
    if (actionIndex === undefined) return;

    // Capture the card before undo (for the animation)
    const action = activePlayer.planned_actions?.[actionIndex];
    const undoCard = action?.card;

    // Compute tile screen position for animation start
    let tileScreenX = 0, tileScreenY = 0;
    const transform = gridTransformRef.current;
    const gRect = gridContainerRef.current?.getBoundingClientRect();
    if (transform && gRect) {
      const local = axialToPixel(q, r);
      const screen = localToScreen(local.x, local.y, transform, gRect.width, gRect.height, gRect);
      tileScreenX = screen.x;
      tileScreenY = screen.y;
    }

    // An undone card's resources go straight back (just the +/−X).
    resourceCounterRef.current?.expect({ coins: false });
    try {
      const resp = await api.undoCard(gameState.id, activePlayer.id, actionIndex);
      if (undoCard) {
        setUndoReturn({ cardId: undoCard.id, screenX: tileScreenX, screenY: tileScreenY, key: ++undoFlyIdRef.current });
      }
      onStateUpdate(resp.state);

      // Auto-select the returned card so the player can immediately re-play
      // or retarget it. The backend appends to hand, so the index is the
      // last hand position. Skip selection if the card can't be validly
      // played right now (e.g. paid Mercenary cost, claim-banned).
      const newPlayer = resp.state.players[activePlayer.id];
      const newHand = newPlayer?.hand ?? [];
      const returnedIdx = newHand.length - 1;
      const returnedCard = newHand[returnedIdx];
      if (returnedCard) {
        const actionsAvail = newPlayer.actions_available - newPlayer.actions_used;
        const actionCost = returnedCard.action_cost ?? 1;
        const playCostEff = returnedCard.effects?.find((e: { type: string }) => e.type === 'play_resource_cost');
        const playResourceCost = playCostEff
          ? (returnedCard.is_upgraded && playCostEff.upgraded_value != null
              ? playCostEff.upgraded_value
              : playCostEff.value)
          : 0;
        const claimBanned = returnedCard.card_type === 'claim'
          && !!resp.state.claim_ban_rounds
          && resp.state.claim_ban_rounds > 0;
        const canPlay = actionsAvail >= actionCost
          && (newPlayer.resources ?? 0) >= playResourceCost
          && !claimBanned;
        if (canPlay) {
          setSelectedCardIndex(returnedIdx);
        }
      }

      // Spawn floating "+N action" icon
      const id = ++floatingActionIdRef.current;
      const undoAmount = undoCard?.action_cost ?? 1;
      setFloatingActions(prev => [...prev, { id, offsetX: -20, offsetY: 0, type: 'gain', amount: undoAmount }]);
      setTimeout(() => setFloatingActions(prev => prev.filter(a => a.id !== id)), 900);
    } catch (err) {
      console.warn('Undo failed', err);
    }
  }, [phase, activePlayer, undoableTiles, gameState.id, onStateUpdate]);

  // ── Played cards on the board ──
  /** Where my revealed cards land: the top of my discard pile. */
  const discardPilePose = useCallback((cardId: string): Pose | null => {
    const c = elementCenter('[data-discard-pile]');
    return c ? { x: c.x, y: c.y, rot: 0, scale: PILE_SCALE, tilt: PILE_TILT, spin: discardTopSpin(cardId) } : null;
  }, []);

  const launchBoardFlight = useCallback((f: Omit<Flight<BoardFlightKind>, 'key'>) => {
    setBoardFlights(prev => [...prev, { ...f, key: `bf${++boardFlightSeq.current}` }]);
  }, []);

  /**
   * Send revealed cards home: mine land on my discard pile, opponents' fly
   * into their ID card, trashed cards burn. Each card takes off from where it
   * sits on the board (or in the engine queue). Returns how long (ms) until
   * the last of them has landed.
   */
  const flyRevealCards = useCallback((pick: (rc: RevealCard) => boolean, stagger = 90): number => {
    const current = revealCardsRef.current;
    if (!current) return 0;
    const leaving = current.filter(pick);
    if (leaving.length === 0) return 0;
    const remaining = current.filter(rc => !pick(rc));
    revealCardsRef.current = remaining;
    setRevealCards(remaining);
    const speed = resolveSpeed || 1;
    let doneAt = 0;
    const launchHome = (f: Omit<Flight<BoardFlightKind>, 'key'>) => {
      doneAt = Math.max(doneAt, (f.delay ?? 0) + f.duration);
      launchBoardFlight(f);
    };
    leaving.forEach((rc, i) => {
      const el = document.querySelector(`[data-board-card="${CSS.escape(rc.key)}"]`);
      const r = el?.getBoundingClientRect();
      const from: Pose | null = r && r.width > 0
        ? { x: r.left + r.width / 2, y: r.top + r.height / 2, rot: 0, scale: r.width / CARD_W }
        : null;
      const delay = Math.round(i * stagger * speed);
      const duration = Math.round(600 * speed);
      if (!rc.primary) {
        // A multi-target card's extra copy just fades; the primary flies home.
        if (from) launchHome({ kind: 'fade', card: rc.card, frames: [
          { transform: poseTransform(from), opacity: 1 },
          { transform: poseTransform({ ...from, scale: from.scale * 0.7 }), opacity: 0 },
        ], delay, duration: Math.round(260 * speed) });
        return;
      }
      if (rc.trash) {
        if (from) setTimeout(() => setBoardBurns(b => [...b, { key: `burn-${rc.key}`, card: rc.card, pose: from }]), delay);
        doneAt = Math.max(doneAt, delay + Math.round(900 * speed));
        if (rc.playerId === activePlayerId || from) sound.cardTrash();
        return;
      }
      if (rc.playerId === activePlayerId) {
        const to = discardPilePose(rc.card.id);
        if (!from || !to) { setDiscardCountOverride(v => (v == null ? v : v + 1)); return; }
        launchHome({ kind: 'toDiscard', card: rc.card, frames: flightKeyframes(from, to, { arc: 80, ease: easeInOut }), delay, duration });
        return;
      }
      const row = playerRowRefs.current.get(rc.playerId)?.getBoundingClientRect();
      if (!row) return;
      const to: Pose = { x: row.left + row.width / 2, y: row.top + row.height / 2, rot: 0, scale: 0.06, opacity: 0 };
      if (from) {
        launchHome({ kind: 'toPlayer', card: rc.card, frames: flightKeyframes(from, to, {
          arc: 50, ease: easeInOut, opacity: t => (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3),
        }), delay, duration });
      } else {
        // An opponent's engine card has no spot on the board: it pops up
        // beside their ID card, holds a beat, then slips into it.
        const pop: Pose = { x: row.right + 14 + CARD_W * 0.17, y: row.top + row.height / 2, rot: 0, scale: 0.34 };
        launchHome({ kind: 'toPlayer', card: rc.card, frames: [
          { offset: 0, transform: poseTransform({ ...pop, scale: 0.1 }), opacity: 0 },
          { offset: 0.2, transform: poseTransform(pop), opacity: 1 },
          { offset: 0.55, transform: poseTransform(pop), opacity: 1 },
          ...flightKeyframes(pop, to, { ease: easeInOut, samples: 5, opacity: t => (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4) })
            .slice(1).map(f => ({ ...f, offset: 0.55 + (f.offset as number) * 0.45 })),
        ], delay, duration: Math.round(1300 * speed) });
      }
    });
    return doneAt;
  }, [resolveSpeed, activePlayerId, discardPilePose, launchBoardFlight, sound]);
  const flyRevealCardsRef = useRef(flyRevealCards);
  flyRevealCardsRef.current = flyRevealCards;

  // An opponent's purchase pops up beside their ID card, holds a beat so
  // everyone sees what they bought, then slips into it.
  popPurchaseRef.current = (playerId, card, index) => {
    if (animationOff) return;
    const row = playerRowRefs.current.get(playerId)?.getBoundingClientRect();
    if (!row || row.width === 0) return;
    const speed = animSpeed || 1;
    const pop: Pose = { x: row.right + 14 + CARD_W * 0.2, y: row.top + row.height / 2, rot: 0, scale: 0.4 };
    const to: Pose = { x: row.left + row.width / 2, y: row.top + row.height / 2, rot: 0, scale: 0.06, opacity: 0 };
    launchBoardFlight({ kind: 'toPlayer', card, frames: [
      { offset: 0, transform: poseTransform({ ...pop, scale: 0.1 }), opacity: 0 },
      { offset: 0.15, transform: poseTransform(pop), opacity: 1 },
      { offset: 0.62, transform: poseTransform(pop), opacity: 1 },
      ...flightKeyframes(pop, to, { ease: easeInOut, samples: 5, opacity: t => (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4) })
        .slice(1).map(f => ({ ...f, offset: 0.62 + (f.offset as number) * 0.38 })),
    ], delay: Math.round(index * 450 * speed), duration: Math.round(1800 * speed) });
  };

  const handleBoardFlightDone = useCallback((f: Flight<BoardFlightKind>) => {
    setBoardFlights(prev => prev.filter(x => x.key !== f.key));
    if (f.kind === 'toDiscard') {
      setDiscardCountOverride(v => (v == null ? v : v + 1));
      sound.cardDiscard();
    }
  }, [sound]);

  // Reveal: every player's plays turn face up over their tiles.
  beginRevealRef.current = (state: GameState) => {
    const revealed = state.revealed_actions;
    if (!revealed || animationOff) return;
    const cards: RevealCard[] = [];
    for (const pid of state.player_order) {
      const actions = revealed[pid] ?? [];
      const name = state.players[pid]?.name ?? pid;
      actions.forEach((a, i) => {
        const c = a.effective_power != null ? { ...a.card, power: a.effective_power } : a.card;
        const ctx: CardSubtitleContext = {
          ...(pid === activePlayerId ? frozenSubtitleContext : {}),
          powerFrozen: true,
          playedCardNames: actions.slice(0, i).map(b => b.card.name),
          effectiveResourceGain: a.effective_resource_gain,
          effectiveDrawCards: a.effective_draw_cards,
        };
        const base = {
          card: c,
          subtitleParts: buildCardSubtitle(c, ctx),
          playerId: pid,
          playerName: name,
          revealed: pid !== activePlayerId,
          trash: !!a.card.trash_on_use,
        };
        if (a.target_q != null && a.target_r != null) {
          const tileKey = `${a.target_q},${a.target_r}`;
          cards.push({ ...base, key: `${a.card.id}@${tileKey}`, tileKey, primary: true });
          for (const [eq, er] of a.extra_targets ?? []) {
            const k = `${eq},${er}`;
            cards.push({ ...base, key: `${a.card.id}@${k}`, tileKey: k, primary: false });
          }
        } else {
          cards.push({ ...base, key: `${a.card.id}@queue`, tileKey: null, primary: true });
        }
      });
    }
    revealCardsRef.current = cards;
    setRevealCards(cards);
    setRevealFocusTile(null);
    const mine = cards.filter(c => c.playerId === activePlayerId && c.primary && !c.trash).length;
    setDiscardCountOverride(Math.max(0, (state.players[activePlayerId]?.discard_count ?? 0) - mine));
  };

  // The last resolution step for each tile — its cards go home after it.
  const lastStepByTile = useMemo(() => {
    const m = new Map<string, number>();
    resolutionSteps.forEach((st, i) => m.set(st.tile_key, i));
    return m;
  }, [resolutionSteps]);
  const handleResolveStepStart = useCallback((idx: number) => {
    const step = resolutionSteps[idx];
    if (!step) return;
    setRevealFocusTile(step.tile_key);
  }, [resolutionSteps]);

  // Before the board resolves tile by tile, every card that has nothing to
  // resolve on the board — engine cards, and cards on tiles with no
  // resolution step (e.g. Sabotage on an opponent's tile) — goes home, all
  // together. The tile-by-tile resolution starts once they've landed.
  const resolveReady = resolving && resolutionSteps.length > 0 && !phaseBanner && !chevronRevealPhase;
  const [offBoardHome, setOffBoardHome] = useState(false);
  useEffect(() => {
    if (!resolveReady) { setOffBoardHome(false); return; }
    const offBoard = (rc: RevealCard) => rc.tileKey === null || !lastStepByTile.has(rc.tileKey);
    const ms = animationOff ? 0 : flyRevealCards(offBoard, 120);
    if (ms === 0) { setOffBoardHome(true); return; }
    const t = setTimeout(() => setOffBoardHome(true), ms + Math.round(180 * resolveSpeed));
    return () => clearTimeout(t);
  // Runs once per resolution: flying cards home is not repeatable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveReady]);
  const handleResolveStepEnd = useCallback((idx: number) => {
    const step = resolutionSteps[idx];
    if (!step || lastStepByTile.get(step.tile_key) !== idx) return;
    setRevealFocusTile(null);
    flyRevealCards(rc => rc.tileKey === step.tile_key, 90);
  }, [resolutionSteps, lastStepByTile, flyRevealCards]);

  // Once every revealed card is home, hand the discard count back to the state.
  useEffect(() => {
    if (revealCards && revealCards.length === 0 && boardFlights.length === 0 && boardBurns.length === 0) {
      setRevealCards(null);
      setDiscardCountOverride(null);
    }
  }, [revealCards, boardFlights.length, boardBurns.length]);
  // A new round never inherits the last reveal (e.g. animations interrupted).
  useEffect(() => {
    if (phase === 'upkeep' || phase === 'play') {
      if (revealCardsRef.current) {
        revealCardsRef.current = null;
        setRevealCards(null);
        setDiscardCountOverride(null);
      }
      setRevealFocusTile(null);
    }
  }, [phase]);

  // War Banner pulse: (1) hovering a tile whose planned Claim consumed a
  // buff pulses the banner that granted it; (2) holding a Claim in hand
  // pulses every banner whose buff is still waiting.
  const warBannerPulseIds = useMemo(() => {
    const ids = new Set<string>();
    const actions = activePlayer?.planned_actions ?? [];
    if (playHoveredTileKey) {
      for (const a of actions) {
        if (a.target_q == null || a.target_r == null || `${a.target_q},${a.target_r}` !== playHoveredTileKey) continue;
        const src = a.consumed_claim_buff?.source_card_ids
          ?? (a.consumed_claim_buff?.source_card_id ? [a.consumed_claim_buff.source_card_id] : []);
        for (const id of src) ids.add(id);
      }
    }
    const handClaimActive = hoveredCard?.card_type === 'claim' || selectedCard?.card_type === 'claim';
    if (handClaimActive) {
      for (const b of activePlayer?.claim_buffs ?? []) if (b.source_card_id) ids.add(b.source_card_id);
    }
    return ids;
  }, [activePlayer?.planned_actions, activePlayer?.claim_buffs, playHoveredTileKey, hoveredCard, selectedCard]);

  /** What sits on the board: cards over tiles, and engine cards in the queue. */
  const boardCards = useMemo(() => {
    const tiles = new Map<string, BoardCardEntry[]>();
    const engines: BoardCardEntry[] = [];
    const addTile = (key: string, e: BoardCardEntry) => {
      const list = tiles.get(key);
      if (list) list.push(e); else tiles.set(key, [e]);
    };
    if (revealCards) {
      // Opponents' cards turn face up the moment the reveal banner clears.
      const hideOthers = phaseBanner === 'reveal';
      for (const rc of revealCards) {
        if (hideOthers && rc.playerId !== activePlayerId) continue;
        if (rc.tileKey) addTile(rc.tileKey, rc);
        else if (rc.playerId === activePlayerId) engines.push(rc);
      }
      return { tiles, engines };
    }
    // Planned cards show during play only — at the reveal they become revealCards
    // (planned_actions linger on the server until the next round).
    if (phase !== 'play' || showIntro || introSequence !== 'done') return { tiles, engines };
    const actions = activePlayer?.planned_actions ?? [];
    actions.forEach((a, i) => {
      const c = a.effective_power != null ? { ...a.card, power: a.effective_power } : a.card;
      const ctx: CardSubtitleContext = { ...frozenSubtitleContext, playedCardNames: actions.slice(0, i).map(b => b.card.name), effectiveResourceGain: a.effective_resource_gain, effectiveDrawCards: a.effective_draw_cards };
      const base = { card: c, subtitleParts: buildCardSubtitle(c, ctx), playerId: activePlayerId, arriving: arrivingIds.has(a.card.id) };
      if (a.target_q != null && a.target_r != null) {
        const key = `${a.target_q},${a.target_r}`;
        addTile(key, { ...base, key: `${a.card.id}@${key}` });
        for (const [eq, er] of a.extra_targets ?? []) addTile(`${eq},${er}`, { ...base, key: `${a.card.id}@${eq},${er}` });
      } else {
        engines.push({ ...base, key: `${a.card.id}@queue`, pulse: warBannerPulseIds.has(a.card.id) });
      }
    });
    return { tiles, engines };
  }, [revealCards, phase, phaseBanner, showIntro, introSequence, activePlayer?.planned_actions, activePlayerId, frozenSubtitleContext, arrivingIds, warBannerPulseIds]);
  const tileCardKeys = useMemo(() => [...boardCards.tiles.keys()], [boardCards]);

  /** Click a board card: one card opens the zoom; several show side by side. */
  const openBoardCards = useCallback((entries: BoardCardEntry[], index: number) => {
    if (entries.length === 1) {
      showZoom(entries[index].card);
      return;
    }
    setDetailCards(entries.map(e => ({ card: e.card, subtitleParts: e.subtitleParts, playerId: e.playerId, playerName: e.playerName })));
  }, [showZoom]);

  // Aiming a card at a tile: the cards on the board step back (fainter, no
  // hover zoom) so the player can focus on picking the tile.
  const aimingCard = selectedCardIndex !== null ? activePlayer?.hand[selectedCardIndex] ?? null : null;
  const aimingAtTiles = phase === 'play' && (multiTileCardIndex !== null || (!!aimingCard && (
    aimingCard.card_type === 'claim' || aimingCard.card_type === 'defense'
    || (aimingCard.card_type === 'engine' && (needsOpponentTarget(aimingCard) || !!aimingCard.target_own_tile)))));
  const renderTileCards = (tileKey: string, zoom: number) => {
    const entries = boardCards.tiles.get(tileKey);
    if (!entries) return null;
    const undoable = !revealCards && undoableTiles?.has(tileKey);
    return (
      <TileCardStack
        entries={entries}
        scale={boardCardScale(zoom)}
        focus={revealFocusTile === tileKey}
        open={openCardsTile === tileKey && (detailCards != null || zoomedCard != null)}
        faded={draggingCardIndex !== null}
        passThrough={aimingAtTiles}
        onOpen={(list, i) => { setOpenCardsTile(tileKey); openBoardCards(list, i); }}
        onUndo={undoable ? () => {
          const [q, r] = tileKey.split(',').map(Number);
          handleTileLongPress(q, r);
        } : undefined}
      />
    );
  };

  return (
    <div style={{
      // clip, not hidden: the resting hand hangs below the screen, and a
      // hidden-overflow box can still be scrolled (focus, scrollIntoView).
      display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'clip', color: '#fff',
      backgroundColor: '#0e0e22',
      backgroundImage: GAME_BACKDROP,
      backgroundPosition: 'center',
    }}>
      {/* Full-width grid area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          ref={gridContainerRef}
          style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'visible' }}
          onPointerDown={(e) => {
            // Presses on the board itself are handled by GameBoard (a click on
            // empty board deselects via onEmptyClick; a drag orbits the camera).
            // Anything else in the grid area (HUD chrome) deselects as before.
            if ((e.target as HTMLElement).tagName === 'CANVAS') return;
            setSelectedCardIndex(null);
          }}
        >
          {displayState.grid && (
            <GameBoard
              tiles={displayState.grid.tiles}
              onTileClick={handleTileClick}
              onEmptyClick={() => setSelectedCardIndex(null)}
              highlightTiles={(() => {
                if (phase !== 'play') return undefined;
                if (multiTileCardIndex !== null) {
                  const multiTileCard = activePlayer?.hand[multiTileCardIndex];
                  const isDefenseMulti = multiTileCard?.card_type === 'defense' && (multiTileCard?.defense_target_count ?? 1) > 1;
                  // Build the set of tiles already chosen in this multi-tile selection.
                  // Non-stackable cards remove these from the highlighted valid set so
                  // the player can't visually pick the same tile twice.
                  const selected = new Set<string>();
                  if (multiTilePrimaryTarget) {
                    selected.add(`${multiTilePrimaryTarget[0]},${multiTilePrimaryTarget[1]}`);
                  }
                  for (const [tq, tr] of multiTileTargets) {
                    selected.add(`${tq},${tr}`);
                  }
                  const filterSelected = (set: Set<string>): Set<string> => {
                    if (multiTileCard?.stackable) return set;
                    const out = new Set<string>();
                    for (const k of set) {
                      if (!selected.has(k)) out.add(k);
                    }
                    return out;
                  };
                  if (isDefenseMulti) {
                    const ownTiles = new Set<string>();
                    for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                      if (t.owner === activePlayerId) ownTiles.add(k);
                    }
                    return filterSelected(ownTiles);
                  }
                  // Multi-target claim (Surge): every target must be adjacent to
                  // at least one already-selected target (connected subgraph).
                  // Only show strong (yellow) tiles here; weak tiles go to weakHighlightTiles
                  const { strong: mtStrong } = getValidClaimTiles(multiTileCard);
                  const claimValid = filterSelected(mtStrong);
                  if (selected.size === 0) return claimValid;
                  const adjacentToSelected = new Set<string>();
                  for (const k of selected) {
                    const [sq, sr] = k.split(',').map(Number);
                    for (const [dq, dr] of HEX_DIRS) {
                      adjacentToSelected.add(`${sq + dq},${sr + dr}`);
                    }
                  }
                  const out = new Set<string>();
                  for (const k of claimValid) {
                    if (adjacentToSelected.has(k)) out.add(k);
                  }
                  return out;
                }
                const card = highlightCard?.card_type === 'claim' ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'claim'
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (card) {
                  // Use only strong tiles for yellow highlight; weak tiles go to weakHighlightTiles (orange)
                  const { strong } = getValidClaimTiles(card);
                  // Add own tiles as valid defensive placements (always strong/yellow)
                  const isBridge = card.effects?.some(e => e.type === 'adjacency_bridge') ?? false;
                  if (!card.unoccupied_only && !card.target_own_tile && !isBridge) {
                    const alreadyClaimed = new Set<string>();
                    if (!card.stackable && activePlayer?.planned_actions) {
                      for (const action of activePlayer.planned_actions) {
                        if (action.card.card_type !== 'claim') continue;
                        if (action.card.stackable) continue;
                        if (action.target_q != null) alreadyClaimed.add(`${action.target_q},${action.target_r}`);
                        if (action.extra_targets) for (const [eq, er] of action.extra_targets) alreadyClaimed.add(`${eq},${er}`);
                      }
                    }
                    for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                      if (t.owner === activePlayerId && !t.is_blocked && !alreadyClaimed.has(k)) strong.add(k);
                    }
                  }
                  return strong;
                }
                // Defense card: highlight own tiles
                const defCard = highlightCard?.card_type === 'defense' ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'defense'
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (defCard) {
                  const ownTiles = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner === activePlayerId) ownTiles.add(k);
                  }
                  return ownTiles;
                }
                // Player-targeting engine card (e.g. Sabotage, Infestation): highlight opponent tiles
                const ptCard = highlightCard?.card_type === 'engine' && needsOpponentTarget(highlightCard) ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'engine'
                    && needsOpponentTarget(activePlayer?.hand[draggingCardIndex]!)
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (ptCard) {
                  const opponentTiles = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner && t.owner !== activePlayerId) opponentTiles.add(k);
                  }
                  return opponentTiles;
                }
                // Engine cards targeting own tiles (Exodus, Scorched Retreat)
                const ownTileEngCard = highlightCard?.card_type === 'engine' && highlightCard?.target_own_tile ? highlightCard
                  : draggingCardIndex !== null && activePlayer?.hand[draggingCardIndex]?.card_type === 'engine'
                    && activePlayer?.hand[draggingCardIndex]?.target_own_tile
                    ? activePlayer?.hand[draggingCardIndex] : null;
                if (ownTileEngCard) {
                  const isConsecrate = ownTileEngCard.effects?.some(e => e.type === 'enhance_vp_tile');
                  if (isConsecrate) {
                    const valid = new Set<string>();
                    for (const key of connectedVpTiles) {
                      const t = displayState.grid.tiles[key];
                      if (t && t.owner === activePlayerId) valid.add(key);
                    }
                    return valid;
                  }
                  const ownNonBase = new Set<string>();
                  for (const [k, t] of Object.entries(displayState.grid.tiles)) {
                    if (t.owner === activePlayerId && !t.is_base) ownNonBase.add(k);
                  }
                  return ownNonBase;
                }
                return undefined;
              })()}
              weakHighlightTiles={weakHighlightTiles}
              multiTileTargets={multiTileCardIndex !== null ? [
                ...(multiTilePrimaryTarget ? [multiTilePrimaryTarget] : []),
                ...multiTileTargets,
              ] : undefined}
              borderTiles={phase === 'play' ? adjacentTiles : undefined}
              playerInfo={playerInfo}
              transformRef={gridTransformRef}
              fxRef={boardFxRef}
              controlsRef={boardControlsRef}
              showCameraControls={!showIntro}
              extendBelow={handPanelH}
              viewInsetBottom={boardViewInset}
              gridRotation={gridRotation}
              dragHoverPosition={draggingCardIndex !== null ? dragHoverPos : null}
              activePlayerId={phase === 'play' ? activePlayerId : undefined}
              plannedActions={phase === 'play' ? plannedActions : undefined}
              tileCardKeys={tileCardKeys}
              renderTileCards={renderTileCards}
              raisedTileKey={revealFocusTile}
              previewCard={phase === 'play' ? (() => {
                // Strike Team: preview gets +2/+3 power if the active player has
                // already played another Claim this round (mirrors backend
                // `a.card.id != card.id` — exclude the previewed card itself).
                const playedClaimExcluding = (cardId: string | undefined) =>
                  (activePlayer?.planned_actions ?? [])
                    .some(a => a.card.card_type === 'claim' && a.card.id !== cardId);
                // In multi-tile selection mode, lock preview to the active card
                if (multiTileCardIndex !== null) {
                  const sc = activePlayer?.hand[multiTileCardIndex] ?? null;
                  return sc
                    ? withEffectivePower(sc, activePlayer?.hand.length ?? 0, activePlayer?.tile_count ?? 0, playedClaimExcluding(sc.id))
                    : null;
                }
                const raw = highlightCard?.card_type === 'claim' || highlightCard?.card_type === 'defense' ? highlightCard
                  : (highlightCard?.card_type === 'engine' && (needsOpponentTarget(highlightCard) || highlightCard?.target_own_tile)) ? highlightCard
                  : draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] ?? null
                  : null;
                return raw ? withEffectivePower(raw, activePlayer?.hand.length ?? 0, activePlayer?.tile_count ?? 0, playedClaimExcluding(raw.id)) : null;
              })() : null}
              previewValidTiles={(() => {
                if (phase !== 'play') return undefined;
                // In multi-tile selection mode, lock valid tiles to the active card
                if (multiTileCardIndex !== null) {
                  const sc = activePlayer?.hand[multiTileCardIndex] ?? null;
                  return sc ? getAllValidPlayTiles(sc) : undefined;
                }
                const card = highlightCard?.card_type === 'claim' || highlightCard?.card_type === 'defense' ? highlightCard
                  : (highlightCard?.card_type === 'engine' && (needsOpponentTarget(highlightCard) || highlightCard?.target_own_tile)) ? highlightCard
                  : draggingCardIndex !== null ? activePlayer?.hand[draggingCardIndex] ?? null
                  : null;
                return card ? getAllValidPlayTiles(card) : undefined;
              })()}
              previewClaimBuffBonus={claimBuffBonus}
              claimChevrons={activeChevrons.length > 0 ? activeChevrons : undefined}
              vpPaths={vpPaths.length > 0 ? vpPaths : undefined}
              connectedVpTiles={connectedVpTiles}
              buildProgress={gridBuildProgress}
              disableHover={!!(showIntro || gridBuildProgress !== undefined || showFullLog || showDeckViewer || showCardBrowser || showShopOverlay || showUpgradePreview || (phaseBanner && !reviewing) || resolving || prePlaySearchMode || activePlayer?.pending_search || searchAnimating || searchFlights || (draggingCardIndex !== null && (() => { const dc = activePlayer?.hand[draggingCardIndex]; return dc?.card_type === 'engine' && !needsOpponentTarget(dc!) && !dc?.target_own_tile; })()))}
              suppressTileTooltips={draggingCardIndex !== null}
              reviewPulseTiles={reviewPulseTiles}
              onTileHover={reviewing ? (q, r, sx, sy) => {
                setReviewHoveredTile(`${q},${r}`);
                setReviewTilePopupPos({ x: sx, y: sy });
              } : (phase === 'play' ? (q, r) => setPlayHoveredTileKey(`${q},${r}`) : undefined)}
              onTileHoverEnd={reviewing ? () => setReviewHoveredTile(null) : (phase === 'play' ? () => setPlayHoveredTileKey(null) : undefined)}
              paused={showShopOverlay || showCardBrowser || showDeckViewer || showUpgradePreview || showGameOver}
              onLongPress={handleTileLongPress}
              undoableTiles={undoableTileSet}
            />
          )}

          {/* ── Top-left overlay: round info + upkeep + expandable player panel ──
              Wrapper is pointer-events: none so background regions pass clicks
              through to the hex grid canvas underneath (e.g. enemy base tiles
              in the top-left corner). Interactive children below explicitly
              opt back in with pointer-events: auto. */}
          <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 210, width: 'fit-content', opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease', pointerEvents: 'none' }}>
            {/* Round / Phase / VP target */}
            <div style={{
              ...HUD_PANEL_STYLE,
              padding: '8px 14px 8px',
              marginBottom: 6,
              width: 'fit-content',
              pointerEvents: hudVisible ? 'auto' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, whiteSpace: 'nowrap' }}>
                <span style={{
                  fontSize: 16, fontWeight: 900, fontFamily: 'var(--cc-font-display)', letterSpacing: 0.8,
                  ...(gameState.max_rounds && gameState.current_round >= gameState.max_rounds
                    ? { color: '#ffe14d', animation: 'finalRoundGlow 2s ease-in-out infinite' }
                    : { color: '#fff' }),
                }}>
                  {gameState.max_rounds && gameState.current_round >= gameState.max_rounds
                    ? 'Final Round'
                    : `Round ${gameState.current_round}`}
                </span>
                <PhaseIndicatorPill phase={phase} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--cc-text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
                <IconValue icon="vp" value={gameState.vp_target} size={12} color="var(--cc-gold)" title="Victory points" />
                <span>VP to win</span>
                {gameState.max_rounds && (
                  <Tooltip content={`Game ends after round ${gameState.max_rounds}. Starting on round 5, the leading player will receive a Debt card each round.`} position="below">
                    <span style={{ marginLeft: 8, cursor: 'help', display: 'inline-flex' }}>
                      <IconValue icon="round" value={`${gameState.current_round}/${gameState.max_rounds}`} size={12} title="Round" />
                    </span>
                  </Tooltip>
                )}
              </div>
              {gameState.winner && (
                <div style={{
                  marginTop: 4, padding: '4px 8px', background: '#4a9eff33', borderRadius: 6, fontWeight: 'bold',
                  fontSize: 13,
                }}>
                  {gameState.winners && gameState.winners.length > 1
                    ? `Tied: ${gameState.winners.map(id => gameState.players[id]?.name).join(', ')}!`
                    : `${gameState.players[gameState.winner]?.name} wins!`}
                </div>
              )}
            </div>

            {/* Expandable player panel */}
            <div
              ref={playerPanelRef}
              onMouseEnter={() => setPlayerPanelExpanded(true)}
              onMouseLeave={() => setPlayerPanelExpanded(false)}
              style={{
                ...HUD_PANEL_STYLE,
                transition: 'all 0.2s ease',
                width: 200,
                maxHeight: 'calc(100dvh - 300px)',
                overflowY: 'auto',
                pointerEvents: hudVisible ? 'auto' : 'none',
              }}
            >
              {(playerPanelExpanded || forcePlayerPanelExpanded || reviewing || resolving || !!revealCards || phase === 'buy' || anyPlayerReachedVp || showGameOver) ? (
                /* Expanded: all players */
                <div style={{ padding: 6 }}>
                  {gameState.player_order.map((pid, i) => {
                    const p = displayState.players[pid];
                    // planned_actions contribute to the total only during play phase (before
                    // backend has moved cards to discard) or while viewing the frozen pre-resolve
                    // snapshot (resolveDisplayState active — applyResolveStep decrements planned_actions
                    // as discard grows). Otherwise the backend has already added those cards to discard
                    // while leaving planned_actions populated until next round's upkeep — counting them
                    // again would double-count.
                    const includePlanned = phase === 'play' || resolveDisplayState !== null;
                    const pInPlay = includePlanned ? (p.planned_actions?.length ?? p.planned_action_count ?? 0) : 0;
                    const pTotal = p.hand_count + p.deck_size + p.discard_count + pInPlay;
                    const pTiles = Object.values(displayState.grid.tiles).filter(t => t.owner === pid).length;
                    const isCpu = p.is_cpu;
                    return (
                      <div
                        key={pid}
                        ref={el => { if (el) playerRowRefs.current.set(pid, el); }}
                        onClick={() => {
                          if (reviewing && revealedActionsRef.current?.[pid]?.length) {
                            const actions = revealedActionsRef.current[pid];
                            const name = gameState.players[pid]?.name ?? pid;
                            setReviewHoveredPlayer(null);
                            if (actions.length === 1) {
                              showZoom(actions[0].card);
                            } else {
                              setDetailCards(actions.map(a => ({ playerId: pid, playerName: name, card: a.card })));
                            }
                          }
                        }}
                        onPointerEnter={reviewing ? () => setReviewHoveredPlayer(pid) : undefined}
                        onPointerLeave={reviewing ? () => setReviewHoveredPlayer(null) : undefined}
                        style={{ cursor: reviewing ? 'pointer' : 'default', marginBottom: i < gameState.player_order.length - 1 ? 4 : 0, opacity: isCpu ? 0.8 : 1, position: 'relative' }}
                      >
                        <PlayerHud
                          player={p}
                          isActive={i === activePlayerIndex}
                          isCurrent={i === activePlayerIndex}
                          isFirstPlayer={i === gameState.first_player_index}
                          isCurrentBuyer={phase === 'buy' && !gameState.players_done_buying.includes(pid)}
                          phase={phase}
                          totalCards={pTotal}
                          tileCount={pTiles}
                          purchases={phase === 'buy' ? enrichPurchases(gameState.buy_phase_purchases?.[pid]) : undefined}
                          onPurchaseHover={phase === 'buy' ? handlePurchaseHover : undefined}
                          onPurchaseLeave={phase === 'buy' ? handlePurchaseLeave : undefined}
                          vpTarget={gameState.vp_target}
                          vpBreakdown={computeVpBreakdown(displayState, pid)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* Collapsed: active player only */
                <div style={{ padding: 6 }}>
                  {activePlayer && (() => {
                    const displayPlayer = displayState.players[activePlayerId] ?? activePlayer;
                    const includePlanned = phase === 'play' || resolveDisplayState !== null;
                    const pInPlay = includePlanned ? (displayPlayer.planned_actions?.length ?? displayPlayer.planned_action_count ?? 0) : 0;
                    const pTotal = displayPlayer.hand_count + displayPlayer.deck_size + displayPlayer.discard_count + pInPlay;
                    const pDisplayTiles = Object.values(displayState.grid.tiles).filter(t => t.owner === activePlayerId).length;
                    return (
                      <PlayerHud
                        player={displayPlayer}
                        isActive={true}
                        isCurrent={true}
                        isFirstPlayer={activePlayerIndex === gameState.first_player_index}
                        isCurrentBuyer={phase === 'buy' && !gameState.players_done_buying.includes(activePlayerId)}
                        phase={phase}
                        totalCards={pTotal}
                        tileCount={pDisplayTiles}
                        purchases={phase === 'buy' ? enrichPurchases(gameState.buy_phase_purchases?.[activePlayerId]) : undefined}
                        onPurchaseHover={phase === 'buy' ? handlePurchaseHover : undefined}
                        onPurchaseLeave={phase === 'buy' ? handlePurchaseLeave : undefined}
                        vpTarget={gameState.vp_target}
                        vpBreakdown={computeVpBreakdown(displayState, activePlayerId)}
                      />
                    );
                  })()}
                </div>
              )}
            </div>

            {/* Engine cards played this round — queued under the ID card */}
            {boardCards.engines.length > 0 && (
              <div style={{
                ...HUD_PANEL_STYLE,
                marginTop: 6,
                padding: 6,
                // Sized to the cards played (EngineQueue lays out up to 3 a row).
                width: 'max-content',
                boxSizing: 'border-box',
                // Out of the way while a card is dragged from the hand.
                opacity: draggingCardIndex !== null ? 0.15 : 1,
                pointerEvents: draggingCardIndex !== null ? 'none' : 'auto',
                transition: 'opacity 0.15s ease-out',
              }}>
                <EngineQueue entries={boardCards.engines} onOpen={openBoardCards} containerRef={inPlayContainerRef} />
              </div>
            )}
          </div>

          {/* Purchase pill hover preview (fixed, portal) */}
          {purchaseHover && createPortal(
            <div style={{
              position: 'fixed',
              left: purchaseHover.rect.right + 12,
              top: Math.max(8, Math.min(
                purchaseHover.rect.top + purchaseHover.rect.height / 2 - 150,
                window.innerHeight - 320,
              )),
              width: 220,
              zIndex: 20000,
              pointerEvents: 'none',
              opacity: purchaseHoverVisible ? 1 : 0,
              transition: 'opacity 0.15s ease',
            }}>
              <CardFull card={purchaseHover.card} showKeywordHints />
            </div>,
            document.body
          )}

          {/* ── Top-right: action buttons + gear ──
              Wrapper is pointer-events: none so gap/background regions pass
              clicks through to the hex grid canvas underneath (e.g. enemy
              base tiles in the top-right corner). Each interactive child
              below explicitly opts back in with pointer-events: auto. */}
          <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: narrowTop ? 'column' : 'row', gap: 8, alignItems: narrowTop ? 'flex-end' : 'flex-start', zIndex: 210, opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease', pointerEvents: 'none' }}>
            <button
              className="hud-btn"
              onClick={() => { setShowCardBrowser(true); setShowDeckViewer(false); setShowShopOverlay(false); }}
              style={{
                ...HUD_BUTTON_STYLE,
                pointerEvents: hudVisible ? 'auto' : 'none',
              }}
            >
              <span style={{ textDecoration: 'underline' }}>C</span>ards
            </button>
            <button
              className="hud-btn"
              onClick={() => { setShowDeckViewer(s => !s); setShowShopOverlay(false); }}
              style={{
                ...HUD_BUTTON_STYLE,
                pointerEvents: hudVisible ? 'auto' : 'none',
              }}
            >
              <span style={{ textDecoration: 'underline' }}>D</span>eck
            </button>
            <button
              className="hud-btn"
              onClick={() => { setShowShopOverlay(s => !s); setShowDeckViewer(false); }}
              style={{
                ...HUD_BUTTON_STYLE,
                borderColor: phase === 'buy' && !phaseBanner && !showShopOverlay && !activePlayer?.has_ended_turn ? '#e8c46a' : HUD_BUTTON_STYLE.borderColor,
                pointerEvents: hudVisible ? 'auto' : 'none',
                ...(phase === 'buy' && !phaseBanner && !showShopOverlay && !activePlayer?.has_ended_turn ? {
                  animation: animationMode !== 'off' ? 'shopPulse 2s ease-in-out infinite' : undefined,
                  boxShadow: '0 0 12px rgba(232, 196, 106, 0.6)',
                  color: '#ffe7a8',
                } : {}),
              }}
            >
              <span style={{ textDecoration: 'underline' }}>S</span>hop
            </button>

            {/* Gear icon dropdown */}
            <div ref={settingsRef} style={{ position: 'relative', zIndex: settingsExpanded ? 5 : undefined, order: narrowTop ? -1 : undefined, pointerEvents: hudVisible ? 'auto' : 'none' }}>
              <button
                className="hud-btn"
                onClick={() => setSettingsExpanded(p => !p)}
                style={{
                  ...HUD_BUTTON_STYLE,
                  ...(settingsExpanded ? { background: 'rgba(58, 58, 110, 0.95)' } : {}),
                  color: 'var(--cc-text-dim)',
                  lineHeight: '1',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxSizing: 'border-box',
                }}
                title="Settings"
              >
                <Icon name="settings" size={16} decorative />
              </button>
              {settingsExpanded && (
                <div className="cc-rise-in" style={{
                  ...HUD_PANEL_STYLE,
                  position: 'absolute', top: 42, right: 0,
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 45%), rgba(20, 20, 44, 0.97)',
                  padding: 12, minWidth: 240,
                }}>
                  <SettingsPanel
                    isMultiplayer={isMultiplayer}
                    isHost={mpIsHost}
                    mapSeed={gameState.map_seed}
                    gameId={gameState.id}
                    playerId={mpPlayerId || undefined}
                    onLeaveGame={isMultiplayer && onLeaveGame ? async () => {
                      if (mpPlayerId && mpToken) {
                        try { await import('../api/client').then(api => api.leaveGame(gameState.id, mpPlayerId, mpToken)); } catch (e) { console.warn('leaveGame failed:', e); }
                      }
                      onLeaveGame();
                    } : undefined}
                    onEndGame={isMultiplayer && mpIsHost && onLeaveGame ? async () => {
                      if (mpPlayerId && mpToken) {
                        try { await import('../api/client').then(api => api.endGame(gameState.id, mpPlayerId, mpToken)); } catch { /* ignore */ }
                      }
                      onLeaveGame();
                    } : undefined}
                  />
                  <button
                    onClick={() => { setShowFullLog(true); setSettingsExpanded(false); }}
                    className="cc-btn-secondary"
                    style={{
                      width: '100%', padding: '7px 0', marginTop: 8,
                      fontSize: 12, fontWeight: 'bold', letterSpacing: 0.4,
                    }}
                  >
                    Full Game Log
                  </button>

                  {/* Test Mode Panel */}
                  {gameState.test_mode && (
                    <div style={{ borderTop: '1px solid #ffaa4a44', marginTop: 8, paddingTop: 8 }}>
                      <div
                        onClick={() => setShowTestPanel(p => !p)}
                        style={{ fontSize: 12, color: '#ffaa4a', cursor: 'pointer', fontWeight: 'bold', marginBottom: 4 }}
                      >
                        <Icon name="chevron" size={9} decorative style={{ transform: showTestPanel ? 'rotate(90deg)' : undefined, transition: 'transform 0.15s', marginRight: 4 }} />Test Mode
                      </div>
                      {showTestPanel && (
                        <div style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Give card to {activePlayer?.name}:</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input value={testCardId} onChange={e => setTestCardId(e.target.value)} placeholder="card_id"
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testCardId) handleTestGiveCard(testCardId); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', whiteSpace: 'nowrap' }}>Give</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} VP:</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="number" value={testVp} onChange={e => setTestVp(e.target.value)} placeholder={String(activePlayer?.vp ?? 0)}
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testVp !== '') handleTestSetStats(Number(testVp), undefined); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>Set</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} Resources:</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="number" value={testResources} onChange={e => setTestResources(e.target.value)} placeholder={String(activePlayer?.resources ?? 0)}
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testResources !== '') handleTestSetStats(undefined, Number(testResources)); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>Set</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Set {activePlayer?.name} Actions ({activePlayer?.actions_used ?? 0}/{activePlayer?.actions_available ?? 0} used):</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="number" value={testActions} onChange={e => setTestActions(e.target.value)} placeholder={String(activePlayer?.actions_available ?? 0)}
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testActions !== '') handleTestSetStats(undefined, undefined, Number(testActions)); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>Set</button>
                            </div>
                          </div>
                          <div>
                            <div style={{ color: '#888', marginBottom: 2 }}>Set Round (max {gameState.max_rounds ?? '?'}):</div>
                            <div style={{ display: 'flex', gap: 4 }}>
                              <input type="number" value={testRound} onChange={e => setTestRound(e.target.value)} placeholder={String(gameState.current_round ?? 1)}
                                style={{ flex: 1, padding: '3px 6px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, minWidth: 0 }} />
                              <button onClick={() => { if (testRound !== '') handleTestSetRound(Number(testRound)); }}
                                style={{ padding: '3px 8px', background: '#ffaa4a', border: 'none', borderRadius: 4, color: '#000', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}>Set</button>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center' }}>
                            <div style={{ color: '#888', fontSize: 11, flexShrink: 0 }}>Draw</div>
                            <input type="number" min={1} max={20} value={testDrawCount} onChange={e => setTestDrawCount(e.target.value)}
                              style={{ width: 36, padding: '3px 4px', background: '#2a2a3e', border: '1px solid #444', borderRadius: 4, color: '#fff', fontSize: 11, textAlign: 'center' }} />
                            <button
                              onClick={() => handleTestDrawCard(Math.max(1, Number(testDrawCount) || 1))}
                              style={{ flex: 1, padding: '4px 8px', background: '#4488aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold' }}
                            >
                              Draw Cards
                            </button>
                          </div>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <button
                              onClick={handleTestDiscardHand}
                              style={{ flex: 1, padding: '4px 8px', background: '#aa6633', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', marginTop: 4 }}
                            >
                              Discard Hand
                            </button>
                          </div>
                          <button
                            onClick={() => setShowGameOver(true)}
                            style={{ padding: '4px 8px', background: '#8844aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: 'pointer', fontWeight: 'bold', marginTop: 4 }}
                          >
                            Trigger Game Over
                          </button>
                          <button
                            onClick={() => {
                              setTestShuffleAnim(true);
                              setTimeout(() => setTestShuffleAnim(false), 2500);
                            }}
                            disabled={testShuffleAnim}
                            style={{ padding: '4px 8px', background: testShuffleAnim ? '#555' : '#4488aa', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: testShuffleAnim ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                          >
                            {testShuffleAnim ? 'Shuffling...' : 'Play Shuffling'}
                          </button>
                          <button
                            onClick={() => {
                              if (animationOff) return;
                              setShowIntro(true);
                              setIntroSequence('overlay');
                              setHudVisible(false);
                              setGridBuildProgress(0);
                              setBannerLabelOverride(null);
                              setPhaseBanner(null);
                              setInteractionBlocked(true);
                            }}
                            disabled={showIntro || animationOff}
                            style={{ padding: '4px 8px', background: (showIntro || animationOff) ? '#555' : '#44aa88', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: (showIntro || animationOff) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                          >
                            Replay Intro
                          </button>
                          <button
                            onClick={() => {
                              if (animationOff || phaseBanner) return;
                              // Pick a random non-left player as the debt recipient
                              const candidates = gameState.player_order.filter(pid => !gameState.players[pid].has_left);
                              const recipientId = candidates[Math.floor(Math.random() * candidates.length)];
                              const recipientName = gameState.players[recipientId].name;
                              testDebtRecipientRef.current = { id: recipientId, name: recipientName };
                              testDebtBannerRef.current = true;
                              const maxRounds = gameState.max_rounds ?? 20;
                              setBannerLabelOverride(`Round ${gameState.current_round} of ${maxRounds}`);
                              setBannerSubtitle(`Debt given to ${recipientName}`);
                              setBannerHoldUntilRelease(true);
                              setPhaseBanner('upkeep');
                              setBannerKey(k => k + 1);
                              setInteractionBlocked(true);
                            }}
                            disabled={animationOff || !!phaseBanner}
                            style={{ padding: '4px 8px', background: (animationOff || phaseBanner) ? '#555' : '#cc6622', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, cursor: (animationOff || phaseBanner) ? 'not-allowed' : 'pointer', fontWeight: 'bold' }}
                          >
                            Give Debt
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Shop overlay — available at any phase, purchasing disabled outside buy phase */}
          {showShopOverlay && activePlayer && (
            <ShopOverlay
              archetypeMarket={activePlayer.archetype_market}
              sharedMarket={gameState.shared_market}
              playerResources={activePlayer.resources}
              playerArchetype={activePlayer.archetype}
              onBuyArchetype={handleBuyArchetype}
              onBuyShared={handleBuyNeutral}
              onBuyUpgrade={handleBuyUpgrade}
              onReroll={handleReroll}
              disabled={phase !== 'buy' || gameState.players_done_buying.includes(activePlayerId)}
              buyLocked={!!activePlayer.buy_locked}
              onClose={() => setShowShopOverlay(false)}
              testMode={!!gameState.test_mode}
              effectiveBuyCosts={activePlayer?.effective_buy_costs}
              effectiveRerollCost={activePlayer?.effective_reroll_cost}
              effectiveUpgradeCreditCost={activePlayer?.effective_upgrade_credit_cost}
              neutralPurchasesLastRound={gameState.shared_purchases_last_round}
              currentPlayerId={activePlayerId}
              buyPhasePurchases={gameState.buy_phase_purchases}
              players={gameState.players}
              ownedUniqueCardNames={ownedUniqueCardNames}
              otherPlayerCursors={otherCursors}
              cursorClicks={cursorClicks}
              onCardHoverChange={handleShopCardHoverChange}
            />
          )}

          {/* Purchase fly animations — rendered above shop overlay (z > 5000) */}
          {neutralPurchaseEvents.map((evt, idx) => (
            <PurchaseFlyAnimation
              key={`${evt.player_id}-${evt.card_id}-${idx}`}
              event={evt}
              onDone={() => setSharedPurchaseEvents(prev => prev.filter((_, i) => i !== idx))}
            />
          ))}

          {/* Error toast — just above the resting hand cards, over everything
              in the hand layer so a raised or inspected card can't hide it */}
          {error && createPortal(
            <div style={{
              position: 'fixed',
              left: '50%',
              bottom: errorToastBottom,
              transform: 'translateX(-50%)',
              zIndex: 25000,
              pointerEvents: 'none',
              maxWidth: 'calc(100vw - 32px)',
            }}>
              <div key={error} style={{
                fontSize: 13,
                lineHeight: 1.35,
                padding: '7px 16px',
                background: 'rgba(42, 10, 16, 0.95)',
                border: '1px solid #ff4a4a88',
                borderRadius: 8,
                color: '#ff8a8a',
                textAlign: 'center',
                boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
                animation: 'cc-fade-in 0.15s ease-out both',
              }}>
                {error}
              </div>
            </div>,
            document.body,
          )}

          {/* Bottom bar: buttons (right) —
              Wrapper is pointer-events: none so the full-width bar (including
              the left spacer) passes clicks through to the hex grid canvas
              underneath. Only the button column opts back into pointer events. */}
          <div style={{ position: 'absolute', bottom: 12, left: 12, right: 12, display: 'flex', alignItems: 'flex-end', gap: 8, zIndex: 20, minHeight: 34, opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease', pointerEvents: 'none' }}>
            {/* Actions left — bottom-aligned with the action buttons on the right */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end' }}>
              {/* The action counter folds away outside your play turn; the
                  bank beside it stays, sliding over to take its place. */}
              {activePlayer && introSequence === 'done' && !showIntro && (() => {
                const showActions = phase === 'play' && !resolving && !phaseBanner && !playSubmitted;
                return (
                <div aria-hidden={!showActions} style={{
                  display: 'flex',
                  maxWidth: showActions ? 260 : 0,
                  marginRight: showActions ? 8 : 0,
                  opacity: showActions ? 1 : 0,
                  overflow: showActions ? 'visible' : 'hidden',
                  pointerEvents: showActions ? undefined : 'none',
                  transition: 'max-width 0.3s ease, margin-right 0.3s ease, opacity 0.25s ease',
                }}>
                <div
                  role="button"
                  tabIndex={showActions ? 0 : -1}
                  aria-label={`${submitActionsLeft} action${submitActionsLeft !== 1 ? 's' : ''} left`}
                  aria-expanded={actionsLabelOpen}
                  onPointerDown={(e) => { actionsPointerRef.current = e.pointerType; }}
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActionsLabelOpen(true); }}
                  onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActionsLabelOpen(false); }}
                  onClick={() => { if (actionsPointerRef.current !== 'mouse') toggleActionsLabel(); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleActionsLabel(); } }}
                  style={{
                    position: 'relative',
                    pointerEvents: 'auto',
                    cursor: 'default',
                    boxSizing: 'border-box',
                    height: 42,
                    display: 'flex', alignItems: 'center',
                    padding: '0 13px',
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%), rgba(14, 14, 34, 0.85)',
                    border: `1px solid ${submitActionsLeft > 0 ? 'rgba(232, 196, 106, 0.35)' : 'rgba(255,255,255,0.08)'}`,
                    borderRadius: 10,
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 12px rgba(0,0,0,0.4)',
                    opacity: submitButtonVisible ? 1 : 0,
                    transition: 'opacity 0.4s ease-in',
                    outline: 'none',
                  }}
                >
                  <div style={{
                    position: 'absolute', bottom: '100%', left: 0,
                    paddingBottom: 8,
                    opacity: actionsLabelOpen ? 1 : 0,
                    transition: 'opacity 0.15s ease',
                    pointerEvents: 'none',
                  }}>
                    <div style={{
                      padding: '4px 10px',
                      background: '#111122',
                      border: '1px solid #555',
                      borderRadius: 6,
                      color: '#ccc',
                      fontSize: 12,
                      whiteSpace: 'nowrap',
                    }}>
                      Playing a card costs 1 action.
                    </div>
                  </div>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center',
                    fontSize: 22, lineHeight: 1, fontWeight: 900, fontFamily: 'var(--cc-font-display)',
                    fontVariantNumeric: 'tabular-nums',
                    color: submitActionsLeft > 0 ? '#ffe7a8' : '#555',
                    textShadow: submitActionsLeft > 0 ? '0 0 10px rgba(232, 196, 106, 0.45), 0 1px 2px rgba(0,0,0,0.6)' : 'none',
                    position: 'relative',
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Icon name="action" size={22} title="Actions" />
                      <Num value={submitActionsLeft} style={{ fontFamily: 'inherit', fontWeight: 900, top: 0 }} />
                    </span>
                    {floatingActions.map(fa => (
                      <span
                        key={fa.id}
                        style={{
                          position: 'absolute',
                          left: fa.offsetX,
                          top: fa.offsetY,
                          fontSize: 18,
                          fontWeight: 'bold',
                          color: fa.type === 'gain' ? '#4ade80' : '#ff6b6b',
                          pointerEvents: 'none',
                          whiteSpace: 'nowrap',
                          animation: 'actionFloat 850ms ease-out forwards',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          {fa.type === 'gain' ? `+${fa.amount}` : `−${fa.amount}`}
                          <Icon name="action" size={17} decorative />
                        </span>
                      </span>
                    ))}
                  </span>
                  {/* "actions left" folds away until hovered or tapped */}
                  <span aria-hidden style={{
                    display: 'inline-block',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    maxWidth: actionsLabelOpen ? 110 : 0,
                    marginLeft: actionsLabelOpen ? 8 : 0,
                    opacity: actionsLabelOpen ? 1 : 0,
                    transition: 'max-width 0.2s ease, margin-left 0.2s ease, opacity 0.15s ease',
                    fontSize: 13,
                    lineHeight: 1,
                    color: submitActionsLeft > 0 ? '#aaa' : '#555',
                  }}>
                    action{submitActionsLeft !== 1 ? 's' : ''} left
                  </span>
                </div>
                </div>
                );
              })()}
              {activePlayer && (
                <ResourceCounter
                  ref={resourceCounterRef}
                  value={displayState.players[activePlayerId]?.resources ?? activePlayer.resources ?? 0}
                  playerId={activePlayerId}
                  speed={animSpeed}
                  visible={introSequence === 'done' && !showIntro && !showGameOver}
                  sourcesForGain={resourceSourcesForGain}
                />
              )}
            </div>
            {/* Buttons + waiting indicators — right aligned, stacked vertically */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, pointerEvents: 'auto' }}>
            {/* Multiplayer: waiting for other players indicator */}
            {isMultiplayer && activePlayer && (
              (phase === 'play' && activePlayer.has_submitted_play && !resolving) ||
              (phase === 'reveal' && activePlayer.has_acknowledged_resolve && !resolving && !phaseBanner)
            ) && (
              <div style={{
                padding: '4px 12px',
                background: 'rgba(74, 158, 255, 0.15)',
                border: '1px solid rgba(74, 158, 255, 0.3)',
                borderRadius: 6,
                color: '#4a9eff',
                fontSize: 12,
                fontWeight: 'bold',
                animation: 'pulse 2s ease-in-out infinite',
              }}>
                Waiting for other players...
              </div>
            )}
            {/* Concurrent buy: show who's still shopping */}
            {phase === 'buy' && activePlayer && gameState.players_done_buying.includes(activePlayerId) && !phaseBanner && (() => {
              const stillShopping = gameState.player_order
                .filter(pid => !gameState.players_done_buying.includes(pid) && !gameState.players[pid]?.has_left)
                .map(pid => gameState.players[pid]?.name)
                .filter(Boolean);
              return stillShopping.length > 0 ? (
                <div style={{ opacity: buyButtonVisible ? 1 : 0, transition: 'opacity 0.4s ease-in' }}>
                  <div style={{
                    padding: '4px 12px',
                    background: 'rgba(255, 170, 74, 0.15)',
                    border: '1px solid rgba(255, 170, 74, 0.3)',
                    borderRadius: 6,
                    color: '#ffaa4a',
                    fontSize: 12,
                    fontWeight: 'bold',
                    animation: 'pulse 2s ease-in-out infinite',
                  }}>
                    Waiting for {stillShopping.join(', ')} to finish...
                  </div>
                </div>
              ) : null;
            })()}
            {/* Test-mode Discard & Trash buttons */}
            {gameState.test_mode && phase === 'play' && activePlayer && !resolving &&
              selectedCard && selectedCardIndex !== null && multiTileCardIndex === null && (
              <>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => handleTestDiscardCard(selectedCardIndex)}
                  style={{
                    padding: '6px 16px',
                    background: '#666',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                  title="Test mode: discard this card to your discard pile"
                >
                  Discard
                </button>
                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => handleTestTrashCard(selectedCardIndex)}
                  style={{
                    padding: '6px 16px',
                    background: '#aa3333',
                    border: 'none',
                    borderRadius: 6,
                    color: '#fff',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: '1.2',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
                  }}
                  title="Test mode: permanently trash this card"
                >
                  <Icon name="trash" size={13} decorative style={{ verticalAlign: '-0.15em', marginRight: 4 }} />Trash
                </button>
              </>
            )}
            {/* Multi-tile confirm/cancel (Surge, Hive Mind, multi-target Defense, etc.) */}
            {phase === 'play' && multiTileCardIndex !== null && multiTilePrimaryTarget && (() => {
              const multiTileCard = activePlayer?.hand[multiTileCardIndex];
              const isDefenseMulti = multiTileCard?.card_type === 'defense' && (multiTileCard?.defense_target_count ?? 1) > 1;
              const maxTotal = isDefenseMulti
                ? (multiTileCard?.defense_target_count ?? 1)
                : 1 + (multiTileCard?.multi_target_count ?? 0);
              const label = multiTileCard?.name ?? (isDefenseMulti ? 'Defend' : 'Claim');
              const isFullSelection = (1 + multiTileTargets.length) >= maxTotal;
              return (
                <>
                  <style>{`
                    @keyframes pulseGlowGreenMulti {
                      0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 6px rgba(42,170,74,0.3), 0 4px 12px rgba(0,0,0,0.45); }
                      50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 18px rgba(60,200,100,0.65), 0 4px 12px rgba(0,0,0,0.45); }
                    }
                  `}</style>
                  <span style={{ fontSize: 12, color: '#aaa' }}>
                    Tiles selected: {1 + multiTileTargets.length}/{maxTotal}
                  </span>
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={handleCancelMultiTile}
                    style={{
                      ...actionButtonStyle('muted', 'sm'),
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <IrreversibleButton
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={handleConfirmMultiTile}
                    tooltip={`Confirm all selected tiles for this ${label} card.${isFullSelection ? ' (Press Enter)' : ''}`}
                    style={{
                      ...actionButtonStyle(isFullSelection ? 'go' : 'info'),
                      cursor: 'pointer',
                      animation: isFullSelection ? 'pulseGlowGreenMulti 1.6s ease-in-out infinite' : undefined,
                    }}
                  >
                    Confirm Tiles
                  </IrreversibleButton>
                </>
              );
            })()}
            {/* Trash/Discard selection confirm/cancel */}
            {phase === 'play' && trashMode && (() => {
              const card = activePlayer?.hand[trashMode.cardIndex];
              const count = trashSelectedIndices.size;
              const canConfirm = count >= trashMode.minCards && count <= trashMode.maxCards;
              const atMaxSelection = count === trashMode.maxCards && trashMode.maxCards > 0;
              const isOptional = trashMode.minCards === 0;
              return (
                <>
                  <style>{`
                    @keyframes pulseGlowConfirmTrash {
                      0%, 100% { box-shadow: 0 0 6px rgba(255,220,120,0.35), 0 2px 8px rgba(0,0,0,0.4); }
                      50% { box-shadow: 0 0 16px rgba(255,220,120,0.75), 0 2px 8px rgba(0,0,0,0.4); }
                    }
                  `}</style>
                  <span style={{ fontSize: 12, color: '#aaa' }}>
                    {trashMode.label}: {count}/{trashMode.maxCards} card{trashMode.maxCards !== 1 ? 's' : ''} selected
                    {isOptional && <span style={{ color: '#888' }}> (optional)</span>}
                  </span>
                  {!trashMode.pendingDiscard && (
                  <button
                    onClick={handleCancelTrash}
                    style={{
                      ...actionButtonStyle('muted', 'sm'),
                      color: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  )}
                  <IrreversibleButton
                    onClick={handleConfirmTrash}
                    disabled={!canConfirm}
                    tooltip={`Confirm ${trashMode.label.toLowerCase()} selection for ${card?.name ?? 'card'}.`}
                    style={{
                      ...actionButtonStyle(canConfirm ? (trashMode.label === 'Discard' ? 'slate' : 'danger') : 'muted'),
                      cursor: canConfirm ? 'pointer' : 'not-allowed',
                      opacity: canConfirm ? 1 : 0.5,
                      animation: atMaxSelection ? 'pulseGlowConfirmTrash 1.4s ease-in-out infinite' : undefined,
                    }}
                  >
                    Confirm {trashMode.label}
                  </IrreversibleButton>
                </>
              );
            })()}
            {phase === 'play' && !resolving && !phaseBanner && !showIntro && introSequence === 'done' && activePlayer && !playSubmitted && activePlayerEffects.length === 0 && multiTileCardIndex === null && !trashMode && (
              <div style={{
                opacity: submitButtonVisible ? 1 : 0,
                transition: 'opacity 0.4s ease-in',
              }}>
                <style>{`
                  @keyframes pulseGlowOrange {
                    0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 6px rgba(255,136,68,0.3), 0 4px 12px rgba(0,0,0,0.45); }
                    50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 18px rgba(255,136,68,0.65), 0 4px 12px rgba(0,0,0,0.45); }
                  }
                  @keyframes pulseGlowGreen {
                    0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 6px rgba(42,170,74,0.3), 0 4px 12px rgba(0,0,0,0.45); }
                    50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 18px rgba(60,200,100,0.65), 0 4px 12px rgba(0,0,0,0.45); }
                  }
                `}</style>
                <HoldToSubmitButton
                  ref={submitPlayRef}
                  key={activePlayerId}
                  onConfirm={handleSubmitPlay}
                  requireHold={submitCanStillPlay}
                  warning={`You still have ${activePlayer.hand.length} card(s) and ${submitActionsLeft} action(s) remaining.`}
                  tooltip="Submitting locks your play for this round. You cannot change it after."
                  style={{
                    ...actionButtonStyle(submitCanStillPlay ? 'warn' : 'go'),
                    cursor: 'pointer',
                    animation: submitCanStillPlay ? 'pulseGlowOrange 2s ease-in-out infinite' : 'pulseGlowGreen 2s ease-in-out infinite',
                  }}
                >
                  Submit Play<Icon name={submitCanStillPlay ? 'then' : 'check'} size={12} decorative style={{ marginLeft: 6, verticalAlign: '-0.1em' }} />
                </HoldToSubmitButton>
              </div>
            )}
            {resolving && (
              <button
                disabled
                style={{
                  ...actionButtonStyle('muted'),
                  cursor: 'not-allowed',
                }}
              >
                Resolving...
              </button>
            )}
            {reviewButtonVisible && !activePlayer?.has_acknowledged_resolve && (
              <button
                onClick={handleDoneReviewing}
                style={{
                  ...actionButtonStyle('go'),
                  cursor: 'pointer',
                  animation: 'reviewBtnFadeIn 0.4s ease-out forwards, pulseGlowGreen 2s ease-in-out 0.4s infinite',
                }}
              >
                Done Reviewing{reviewCountdown !== null && reviewCountdown > 0 ? ` (${reviewCountdown}s)` : ''}<Icon name="check" size={12} decorative style={{ marginLeft: 6, verticalAlign: '-0.1em' }} />
              </button>
            )}
            {phase === 'buy' && activePlayer && !resolving && !phaseBanner && activePlayerEffects.length === 0 && !gameState.players_done_buying.includes(activePlayerId) && !activePlayer.has_ended_turn && (
              <div style={{ opacity: buyButtonVisible ? 1 : 0, transition: 'opacity 0.4s ease-in' }}>
                <style>{`
                  @keyframes pulseGlowOrange {
                    0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 6px rgba(255,136,68,0.3), 0 4px 12px rgba(0,0,0,0.45); }
                    50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 18px rgba(255,136,68,0.65), 0 4px 12px rgba(0,0,0,0.45); }
                  }
                  @keyframes pulseGlowGreen {
                    0%, 100% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 6px rgba(42,170,74,0.3), 0 4px 12px rgba(0,0,0,0.45); }
                    50% { box-shadow: inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -2px 0 rgba(0,0,0,0.18), 0 0 18px rgba(60,200,100,0.65), 0 4px 12px rgba(0,0,0,0.45); }
                  }
                `}</style>
                <HoldToSubmitButton
                  ref={endTurnRef}
                  onConfirm={handleEndTurn}
                  requireHold={!cannotAffordAnyBuyOption}
                  warning="Done buying ends your shopping. Any unspent resources carry over."
                  tooltip={cannotAffordAnyBuyOption ? "You can't afford any card, upgrade, or re-roll." : undefined}
                  style={{
                    ...actionButtonStyle(cannotAffordAnyBuyOption ? 'go' : 'warn'),
                    cursor: 'pointer',
                    animation: cannotAffordAnyBuyOption ? 'pulseGlowGreen 2s ease-in-out infinite' : 'pulseGlowOrange 2s ease-in-out infinite',
                  }}
                >
                  Done Buying<Icon name={cannotAffordAnyBuyOption ? 'check' : 'then'} size={12} decorative style={{ marginLeft: 6, verticalAlign: '-0.1em' }} />
                </HoldToSubmitButton>
              </div>
            )}
            {phase === 'buy' && activePlayer && !resolving && !phaseBanner && activePlayerEffects.length === 0 && activePlayer.has_ended_turn && gameState.players_done_buying.includes(activePlayerId) && (
              <div style={{ opacity: buyButtonVisible ? 1 : 0, transition: 'opacity 0.4s ease-in' }}>
                <button
                  disabled
                  style={{
                    ...actionButtonStyle('muted'),
                    cursor: 'not-allowed',
                  }}
                >
                  <Icon name="check" size={12} decorative style={{ marginRight: 6, verticalAlign: '-0.1em' }} />Done Buying
                </button>
              </div>
            )}
            </div>
          </div>
        </div>

        {/* Bottom panel: hand */}
        <div ref={handPanelRef} style={{ padding: '0 8px', flexShrink: 0, overflow: 'visible', position: 'relative', zIndex: 30, opacity: hudVisible ? 1 : 0, transition: 'opacity 2.5s ease' }}>
          {/* Drag hint tooltip — just above the resting hand cards */}
          {showDragHint && (
            <div style={{
              position: 'absolute',
              top: -72,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 35,
              pointerEvents: 'none',
              animation: 'dragHintFadeIn 0.6s ease-out both',
            }}>
              <style>{`
                @keyframes dragHintFadeIn {
                  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
                  to { opacity: 1; transform: translateX(-50%) translateY(0); }
                }
              `}</style>
              <span style={{
                background: 'rgba(10, 10, 30, 0.9)',
                border: '1px solid #555',
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 12,
                color: '#aaa',
                whiteSpace: 'nowrap',
              }}>
                {isMobile ? 'Drag card out to play.' : 'Drag card out or double-click to play.'}
              </span>
            </div>
          )}
          {activePlayer && introSequence !== 'overlay' && (
            <div style={{
              opacity: hudVisible ? 1 : 0,
              transition: 'opacity 2.5s ease',
            }}>
            <CardHand
              playerId={activePlayerId}
              cards={introSequence !== 'done' && !introHandReady ? [] : activePlayer.hand}
              selectedIndex={selectedCardIndex}
              onSelect={(idx) => {
                if (phase !== 'play' || resolving || playSubmitted) return;
                setSelectedCardIndex(idx);
              }}
              onDragPlay={handleDragPlay}
              onDoubleClick={isMobile ? undefined : (idx) => {
                if (trashMode) return; // disable double-click during trash/discard selection
                const card = activePlayer?.hand[idx];
                if (card?.card_type === 'engine' && !needsOpponentTarget(card) && !card.target_own_tile) playCardNoTarget(idx);
              }}
              onDragStart={setDraggingCardIndex}
              onDragEnd={() => { setDraggingCardIndex(null); setDragHoverPos(null); }}
              onDragMove={(x, y) => setDragHoverPos({ clientX: x, clientY: y })}
              disabled={phase !== 'play' || playSubmitted || interactionBlocked}
              deckSize={introSequence !== 'done' && !introHandReady ? activePlayer.deck_size + activePlayer.hand.length : activePlayer.deck_size}
              discardCount={discardCountOverride !== null ? discardCountOverride : activePlayer.discard_count}
              discardCards={activePlayer.discard}
              deckCards={activePlayer.deck_cards}
              trashCards={activePlayer.trash}
              inPlayCards={inPlayCards}
              discardAll={discardingAll}
              onDiscardAllComplete={handleDiscardAllComplete}
              lastPlayedTarget={lastPlayedTarget}
              forceShuffleAnim={testShuffleAnim}
              trashMode={trashMode ? {
                playedCardIndex: trashMode.cardIndex,
                selectedIndices: trashSelectedIndices,
                minCards: trashMode.minCards,
                maxCards: trashMode.maxCards,
                label: trashMode.label,
              } : null}
              onTrashToggle={handleTrashToggle}
              subtitleContext={subtitleContext}
              closePopups={showShopOverlay || showCardBrowser || showDeckViewer}
              trashedCardIds={trashedCardIds.size > 0 ? trashedCardIds : undefined}
              claimBanned={!!gameState.claim_ban_rounds && gameState.claim_ban_rounds > 0}
              playerResources={activePlayer?.resources}
              actionsRemaining={phase === 'play' && activePlayer && !playSubmitted ? activePlayer.actions_available - activePlayer.actions_used : undefined}
              onCardHover={setHoveredCardIndex}
              suppressEnterAnimFor={searchSuppressedHandIds.size > 0 ? searchSuppressedHandIds : undefined}
              suppressShuffleDetection={tutorCommitInFlight}
              onOrderChange={(order) => { handVisualOrderRef.current = order; }}
              upgradeCreditsAvailable={activePlayer?.upgrade_credits ?? 0}
              onUpgradeCard={handleUpgradeCard}
              isPlayPhase={phase === 'play' && !resolving && !playSubmitted}
              cardTargetsTile={cardTargetsTile}
              dragTarget={dragTarget}
              undoReturn={undoReturn}
              claimBuffBonus={claimBuffBonus}
              incomingDiscards={incomingDiscards}
              onIncomingLanded={(key) => setIncomingDiscards(prev => prev.filter(i => i.key !== key))}
            />
            </div>
          )}
        </div>
      </div>

      {/* Full game log modal */}
      {showFullLog && (
        <FullGameLog
          gameId={gameState.id}
          playerId={activePlayerId}
          mapSeed={gameState.map_seed}
          onClose={() => setShowFullLog(false)}
        />
      )}

      {/* Deck viewer modal */}
      {showDeckViewer && (
        <CardViewPopup
          title="Your Full Deck"
          cards={allDeckCards}
          onClose={() => setShowDeckViewer(false)}
        />
      )}
      {showCardBrowser && (() => {
        const pack = cardPackDefs.find(p => p.id === (gameState.card_pack || 'everything'));
        return (
          <CardBrowser
            onClose={() => setShowCardBrowser(false)}
            packSharedIds={pack?.shared_card_ids}
            packArchetypeIds={pack?.archetype_card_ids}
            packName={pack?.name}
            onShiftClickCard={gameState.test_mode ? handleTestGiveCard : undefined}
            playerArchetype={activePlayer?.archetype}
          />
        );
      })()}

      {/* Resolve overlay — power numbers over grid */}
      {resolveReady && offBoardHome && (
        <ResolveOverlay
          steps={resolutionSteps}
          gridTransform={gridTransformSnapshot}
          gridTransformRef={gridTransformRef}
          gridRect={gridRectSnapshot ?? gridRect}
          gridContainerRef={gridContainerRef}
          fxRef={boardFxRef}
          onStepApply={applyResolveStep}
          onComplete={handleResolveComplete}
          onStepStart={handleResolveStepStart}
          onStepEnd={handleResolveStepEnd}
        />
      )}

      {/* Review mode: tile hover popup showing cards played on this tile */}
      {reviewing && reviewHoveredTile && reviewTilePopupPos && reviewTileCards?.has(reviewHoveredTile) && (() => {
        const cards = reviewTileCards.get(reviewHoveredTile)!;
        const POPUP_W = 180;
        const left = Math.min(reviewTilePopupPos.x + 16, window.innerWidth - POPUP_W - 12);
        const top = Math.min(reviewTilePopupPos.y - 20, window.innerHeight - cards.length * 70 - 20);
        return (
          <div style={{
            position: 'fixed',
            left,
            top: Math.max(8, top),
            zIndex: 500,
            background: 'rgba(15, 15, 30, 0.95)',
            border: '1px solid #555',
            borderRadius: 8,
            padding: 8,
            width: POPUP_W,
            pointerEvents: 'none',
          }}>
            {cards.map((entry, i) => {
              const playerColor = (() => {
                const n = PLAYER_COLORS[entry.playerId];
                return n != null ? `#${n.toString(16).padStart(6, '0')}` : '#888';
              })();
              const c = entry.effectivePower != null ? { ...entry.card, power: entry.effectivePower } : entry.card;
              const playerActions = revealedActionsRef.current?.[entry.playerId] ?? [];
              const actionIdx = playerActions.findIndex(a => a.card.id === entry.card.id);
              const priorNames = actionIdx > 0 ? playerActions.slice(0, actionIdx).map(a => a.card.name) : [];
              const ctx: CardSubtitleContext = { ...frozenSubtitleContext, playedCardNames: priorNames, effectiveResourceGain: entry.effectiveResourceGain, effectiveDrawCards: entry.effectiveDrawCards };
              const statParts = buildCardSubtitle(c, ctx);
              return (
                <div key={i} style={{ marginBottom: i < cards.length - 1 ? 6 : 0 }}>
                  <div style={{ fontSize: 10, color: playerColor, fontWeight: 'bold', marginBottom: 2 }}>
                    {entry.playerName}
                  </div>
                  <CompactCardFace card={c} width={154} subtitleParts={statParts} />
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Review mode: player hover popup showing all cards played this turn */}
      {reviewing && reviewHoveredPlayer && revealedActionsRef.current?.[reviewHoveredPlayer] && (() => {
        const actions = revealedActionsRef.current![reviewHoveredPlayer];
        if (actions.length === 0) return null;
        const rowEl = playerRowRefs.current.get(reviewHoveredPlayer);
        if (!rowEl) return null;
        const rect = rowEl.getBoundingClientRect();
        const POPUP_W = 180;
        const reviewPlayedCardNames = actions.map(a => a.card.name);
        return (
          <div style={{
            position: 'fixed',
            left: rect.right + 8,
            top: rect.top,
            zIndex: 500,
            background: 'rgba(15, 15, 30, 0.95)',
            border: '1px solid #555',
            borderRadius: 8,
            padding: 8,
            width: POPUP_W,
            pointerEvents: 'none',
            maxHeight: '80vh',
            overflowY: 'auto',
          }}>
            <div style={{ fontSize: 10, color: '#888', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>
              Cards Played ({actions.length})
            </div>
            {actions.map((action, i) => {
              const c = action.effective_power != null ? { ...action.card, power: action.effective_power } : action.card;
              const priorNames = actions.slice(0, i).map(a => a.card.name);
              const ctx: CardSubtitleContext = { ...frozenSubtitleContext, playedCardNames: priorNames, effectiveResourceGain: action.effective_resource_gain, effectiveDrawCards: action.effective_draw_cards };
              const statParts = buildCardSubtitle(c, ctx);
              return (
                <CompactCardFace key={i} card={c} width={154} subtitleParts={statParts}
                  style={{ marginBottom: i < actions.length - 1 ? 4 : 0 }} />
              );
            })}
          </div>
        );
      })()}

      {/* Several cards at full size (a tile's cards, the queue, a player's plays) */}
      {detailCards && detailCards.length > 0 && (
        <CardDetailOverlay entries={detailCards} onClose={() => setDetailCards(null)} />
      )}

      {/* Played cards flying home after the reveal, and trashed ones burning */}
      {boardFlights.length > 0 && createPortal(
        <>{boardFlights.map(f => <FlightCard key={f.key} flight={f} onDone={handleBoardFlightDone} />)}</>,
        document.body,
      )}
      {boardBurns.map(b => (
        <TrashBurn key={b.key} card={b.card} pose={b.pose} speed={resolveSpeed || 1} maxScale={0.5}
          onDone={() => setBoardBurns(prev => prev.filter(x => x.key !== b.key))} />
      ))}

      {/* Player effect popups (e.g. Sabotage forced discard) — shown over target base tiles.
          Lifecycle is self-managed by the component: intro fade-in → settle into stack
          above each target's base → expand into a vertical list on hover, collapse on
          unhover. No auto fade-out; dismissed when `activePlayerEffects` is cleared. */}
      {activePlayerEffects.length > 0 && (
        <PlayerEffectPopups
          effects={activePlayerEffects}
          gridTransform={gridTransformRef.current}
          gridRect={gridContainerRef.current?.getBoundingClientRect() ?? null}
          tiles={gameState.grid?.tiles ?? {}}
          playerNames={Object.fromEntries(
            Object.entries(gameState.players).map(([id, p]) => [id, p.name]),
          )}
          activePlayerId={activePlayerId}
          animSpeed={animSpeed}
          gridTransformRef={gridTransformRef}
          gridContainerRef={gridContainerRef}
        />
      )}

      {/* Game intro overlay */}
      {showIntro && (
        <GameIntroOverlay gameState={gameState} onReady={handleIntroReady} />
      )}

      {/* Phase banner — full-screen announcement */}
      {phaseBanner && (
        <PhaseBanner
          key={bannerKey}
          phase={phaseBanner}
          labelOverride={bannerLabelOverride ?? undefined}
          subtitle={bannerSubtitle ?? undefined}
          onMidpoint={handleBannerMidpoint}
          onComplete={handleBannerComplete}
          holdUntilRelease={bannerHoldUntilRelease}
          blocking={phaseBanner !== 'play' && phaseBanner !== 'buy'}
          extraHoldMs={phaseBanner === 'upkeep' ? 500 : 0}
        />
      )}

      {/* Debt card fly animation — above phase banner */}
      {debtFlyTarget && (
        <DebtCardFlyAnimation
          targetRect={debtFlyTarget}
          onComplete={handleDebtFlyComplete}
          speed={animationMode === 'fast' ? 0.5 : 1}
        />
      )}

      {/* Hatching Grounds / Master Engineer: cards fly from center to discard */}
      {createdCardFlights.map(flight => (
        <CardFlyToTargetAnimation
          key={flight.id}
          card={flight.card}
          targetRect={flight.targetRect}
          delayMs={flight.delayMs}
          glow={flight.glow}
          holdMs={800}
          spread
          speed={animationMode === 'fast' ? 0.5 : 1}
          onComplete={() => handleCreatedCardFlightComplete(flight.id)}
        />
      ))}

      {/* Pile search modal (SEARCH_ZONE tutor effects). Hidden while the fly
          animation plays so the cards aren't obscured by the overlay.
          Shown for either pre-play mode (card in hand pending play) or
          server-driven pending_search (legacy / reconnection path). */}
      {effectivePending && !searchAnimating && !searchFlights && (
        <PileSearchModal
          pending={effectivePending}
          cards={pileSearchSourceCards}
          onConfirm={handlePileSearchConfirm}
          onCancel={handlePileSearchCancel}
          cancelAlwaysEnabled={!!prePlaySearchMode}
          // Partial draw-pile peeks (top N) reveal which specific cards are
          // upcoming — info the player couldn't otherwise infer. Once shown,
          // the play is committed; cancel is hidden. Whole-pile peeks
          // (peek_all, e.g. Foresight) only reveal the SET (shuffled), which
          // the player could already deduce from public state, so cancel is
          // still allowed.
          forceCommit={effectivePending.source === 'draw' && !effectivePending.peek_all}
        />
      )}

      {/* Pile search fly animation — each card travels from modal to its zone */}
      {searchFlights && (
        <PileSearchFlyAnimation
          flights={searchFlights}
          speed={animationMode === 'fast' ? 0.5 : 1}
          onComplete={handlePileSearchFlyComplete}
        />
      )}

      {/* Game Over overlay */}
      {showGameOver && (
        <GameOverOverlay
          gameState={gameState}
          playerId={mpPlayerId || activePlayerId}
          isVictory={gameState.winners ? gameState.winners.includes(mpPlayerId || activePlayerId || '') : gameState.winner === (mpPlayerId || activePlayerId)}
          onReturnToLobby={handleReturnToLobby}
          onExitGame={handleExitGame}
          isMultiplayer={isMultiplayer}
          removedFromLobby={removedFromLobby}
        />
      )}

      {/* Interaction blocker overlay (invisible, blocks clicks during banner/resolve) */}
      {interactionBlocked && (
        <div style={{
          position: 'fixed',
          inset: 0,
          zIndex: 25000,
          cursor: 'not-allowed',
        }} />
      )}

      {/* Keyframes for shop pulse glow + player effect popup */}
      <style>{`
        @keyframes shopPulse {
          0%, 100% { box-shadow: 0 0 8px rgba(232, 196, 106, 0.35), 0 4px 12px rgba(0,0,0,0.4); }
          50% { box-shadow: 0 0 20px rgba(232, 196, 106, 0.75), 0 0 36px rgba(232, 196, 106, 0.25), 0 4px 12px rgba(0,0,0,0.4); }
        }
        @keyframes finalRoundGlow {
          0%, 100% { text-shadow: 0 0 6px rgba(255, 225, 77, 0.4), 0 0 12px rgba(255, 225, 77, 0.2); }
          50% { text-shadow: 0 0 10px rgba(255, 225, 77, 0.8), 0 0 20px rgba(255, 225, 77, 0.4), 0 0 30px rgba(255, 225, 77, 0.2); }
        }
        @keyframes playerEffectPopup {
          0% { opacity: 0; transform: translateX(-50%) translateY(10px) scale(0.8); }
          10% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1.05); }
          20% { transform: translateX(-50%) translateY(0) scale(1); }
          80% { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          100% { opacity: 0; transform: translateX(-50%) translateY(-20px) scale(0.9); }
        }
        @keyframes reviewBtnFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes actionFloat {
          0% { opacity: 1; transform: translateY(0) scale(1); }
          30% { opacity: 1; transform: translateY(-14px) scale(1.05); }
          100% { opacity: 0; transform: translateY(-48px) scale(0.7); }
        }
      `}</style>
    </div>
  );
}
