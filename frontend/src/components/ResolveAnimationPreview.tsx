import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { Card, HexTile, PlayerEffect, ResolutionClaimCard, ResolutionEffect, ResolutionStep, ResolutionClaimant } from '../types/game';
import GameBoard, { type GridTransform, type BoardFx, type BoardControls, PLAYER_COLORS } from './GameBoard';
import TileResolver, { resolveCamera, type ResolverApi } from './TileResolver';
import { buildResolvePlans, tileAfterStep, type PlanCard } from '../utils/resolvePlan';
import { TileCardStack, boardCardScale, type BoardCardEntry } from './BoardCards';
import FlightCard, { type Flight } from './hand/FlightCard';
import TrashBurn from './hand/TrashBurn';
import { CARD_W, easeInOut, flightKeyframes, poseTransform, type Pose } from './hand/cardMotion';
import { CoinFlight, splitCoins, type Coin } from './ResourceCounter';
import { useCardCatalog, type CardCatalog } from '../cardCatalog';
import { axialToPixel } from '../utils/hexGeometry';
import type { CameraView } from '../board3d/engine';
import PlayerEffectPopups from './PlayerEffectPopups';
import { useSettings, useAnimationSpeed, type AnimationMode } from './SettingsContext';

/**
 * Iteration sandbox for tile-battle resolution animations.
 *
 * Reuses the production `GameBoard` + `TileResolver` components so any tweaks
 * to the animation code paths are reflected here AND in the real game. Buttons
 * trigger scripted `ResolutionStep` payloads that match the backend shape.
 *
 * Route: `?preview=resolve-animations`
 */

// 6 players arranged along the 6 hex directions from (0,0)
const PLAYERS = ['player_0', 'player_1', 'player_2', 'player_3', 'player_4', 'player_5'];
const PLAYER_LABELS = ['Blue', 'Green', 'Yellow', 'Red', 'Orange', 'Purple'];

// Approach direction for each player's territory (one hex direction each)
const APPROACH_DIRS: [number, number][] = [
  [1, 0],    // E  → player_0
  [1, -1],   // NE → player_1
  [0, -1],   // N  → player_2
  [-1, 0],   // W  → player_3
  [-1, 1],   // SW → player_4
  [0, 1],    // S  → player_5
];

const RADIUS = 7;
const CONTESTED_KEY = '0,0';
// Base tiles live at the 6 corners of the radius-7 hex grid so the stack
// offset logic has room to breathe.
const BASE_STEP = RADIUS;
// Territory starts this many tiles inward from each corner base — gives a
// visible owned chain between the base and the contested center.
const TERRITORY_FIRST_STEP = 4;

function makeBlankTile(q: number, r: number): HexTile {
  return {
    q, r,
    is_blocked: false,
    is_vp: false,
    vp_value: 0,
    owner: null,
    defense_power: 0,
    base_defense: 0,
    permanent_defense_bonus: 0,
    held_since_turn: null,
    is_base: false,
    base_owner: null,
  };
}

function buildDemoTiles(centralOwner: string | null, centerIsBase: boolean = false): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -RADIUS; q <= RADIUS; q++) {
    for (let r = -RADIUS; r <= RADIUS; r++) {
      if (Math.abs(q + r) > RADIUS) continue;
      tiles[`${q},${r}`] = makeBlankTile(q, r);
    }
  }
  // Territory for each player: base at a corner (step BASE_STEP), chain inward
  // to TERRITORY_FIRST_STEP. Leaves the inner hexes neutral so claims still
  // need to travel across empty ground.
  for (let i = 0; i < PLAYERS.length; i++) {
    const pid = PLAYERS[i];
    const [dq, dr] = APPROACH_DIRS[i];
    for (let step = TERRITORY_FIRST_STEP; step <= BASE_STEP; step++) {
      const k = `${dq * step},${dr * step}`;
      if (tiles[k]) {
        tiles[k].owner = pid;
        if (step === BASE_STEP) {
          tiles[k].is_base = true;
          tiles[k].base_owner = pid;
        }
      }
    }
  }
  // Central contested tile — either a VP prize (default) or the defender's base (base-raid mode)
  const center = tiles[CONTESTED_KEY];
  if (center) {
    center.owner = centralOwner;
    if (centerIsBase && centralOwner) {
      center.is_base = true;
      center.base_owner = centralOwner;
      center.is_vp = false;
      center.vp_value = 0;
    } else {
      center.is_vp = true;
      center.vp_value = 1;
    }
  }
  return tiles;
}

interface Scenario {
  id: string;
  label: string;
  /** Number of attacker claimants (excludes defender). */
  numAttackers: number;
  /** If true, the central tile is owned by an additional player not in the attacker list. */
  hasDefender: boolean;
  /** Base raid: the central tile is the defender's base tile instead of a VP tile. */
  isBaseRaid?: boolean;
  /** Force the base-raid outcome: 'defended' = base holds, 'captured' = raid succeeds. */
  baseRaidOutcome?: 'defended' | 'captured';
  /** The defender plays a Defense card (+2 this round) and a Claim (+1) on the tile. */
  fortified?: boolean;
  /** The defender's tile is immune this round (Iron Wall): every claim dinks off. */
  immune?: boolean;
  /** Attack powers (default 2, 3, 4, 5 by seat). */
  powers?: number[];
  /** Blue attacks with Siege Engine: the defender's temporary bonus is ignored. */
  siege?: boolean;
  /** Exodus / Scorched Retreat: the center tile's holder gives it up. */
  giveUp?: 'abandon' | 'scorch';
  /** …and it's a VP town (scorched: its ruins are left). */
  giveUpVp?: boolean;
  /** Seat giving it up (default 0 — you, face up). */
  giveUpSeat?: number;
  description: string;
}

const SCENARIOS: Scenario[] = [
  { id: 'solo-neutral',   label: '1 → Neutral',   numAttackers: 1, hasDefender: false, description: '1 player capturing a neutral tile' },
  { id: 'solo-enemy',     label: '1 → Enemy',     numAttackers: 1, hasDefender: true,  description: '1 player capturing an enemy-owned tile' },
  { id: 'battle-2-n',     label: '2-way Neutral',   numAttackers: 2, hasDefender: false, description: '2 players battling over a neutral tile' },
  { id: 'battle-3-n',     label: '3-way Neutral',   numAttackers: 3, hasDefender: false, description: '3 players battling over a neutral tile' },
  { id: 'battle-4-n',     label: '4-way Neutral',   numAttackers: 4, hasDefender: false, description: '4 players battling over a neutral tile' },
  { id: 'battle-5-n',     label: '5-way Neutral',   numAttackers: 5, hasDefender: false, description: '5 players battling over a neutral tile' },
  { id: 'battle-6-n',     label: '6-way Neutral',   numAttackers: 6, hasDefender: false, description: '6 players battling over a neutral tile' },
  { id: 'battle-2-o',     label: '2-way Owned',     numAttackers: 1, hasDefender: true,  description: '2 players (1 attacker + defender) battling over an owned tile' },
  { id: 'battle-3-o',     label: '3-way Owned',     numAttackers: 2, hasDefender: true,  description: '3 players (2 attackers + defender) battling over an owned tile' },
  { id: 'battle-4-o',     label: '4-way Owned',     numAttackers: 3, hasDefender: true,  description: '4 players (3 attackers + defender) battling over an owned tile' },
  { id: 'battle-5-o',     label: '5-way Owned',     numAttackers: 4, hasDefender: true,  description: '5 players (4 attackers + defender) battling over an owned tile' },
  { id: 'battle-6-o',     label: '6-way Owned',     numAttackers: 5, hasDefender: true,  description: '6 players (5 attackers + defender) battling over an owned tile' },
  { id: 'base-raid-def',  label: 'Base Raid: Defended', numAttackers: 1, hasDefender: true, isBaseRaid: true, baseRaidOutcome: 'defended', description: 'Base raid on an enemy base — defender holds' },
  { id: 'base-raid-cap',  label: 'Base Raid: Captured', numAttackers: 1, hasDefender: true, isBaseRaid: true, baseRaidOutcome: 'captured', description: 'Base raid on an enemy base — raid succeeds' },
  { id: 'fortified',      label: 'Fortified Owned', numAttackers: 3, hasDefender: true, fortified: true, description: 'The owner fortifies (Defense card + their own Claim); three attackers climb from weakest to strongest' },
  { id: 'stalemate',      label: 'Stalemate',       numAttackers: 2, hasDefender: true, powers: [3, 3], description: 'Two attackers tie above the owner — nobody takes the tile' },
  { id: 'immune',         label: 'Immune',          numAttackers: 2, hasDefender: true, immune: true, powers: [2, 7], description: 'The owner plays Iron Wall — claims of 2 and 7 both just dink off' },
  { id: 'power-ramp',     label: 'Power Ramp',      numAttackers: 4, hasDefender: false, powers: [1, 3, 5, 9], description: 'Claims of 1, 3, 5 and 9 on a neutral tile — each smash hits harder than the last' },
  { id: 'siege',          label: 'Siege Engine',    numAttackers: 2, hasDefender: true, fortified: true, siege: true, powers: [2, 3], description: 'The owner fortifies (+2 Defense card, +1 Claim). Green\'s 3 bounces off the full 3; then the +2 cracks for your Siege Engine alone, and its 2 breaks through the 1 left' },
  { id: 'abandon',        label: 'Abandon (Exodus)', numAttackers: 0, hasDefender: false, giveUp: 'abandon', description: 'You play Exodus on your walled tile — your color lifts away and the camp and walls sink' },
  { id: 'scorch',         label: 'Scorched Retreat', numAttackers: 0, hasDefender: false, giveUp: 'scorch', description: 'You scorch your walled tile — it burns to a smoldering wasteland for the rest of the match' },
  { id: 'scorch-vp',      label: 'Scorch a VP Town', numAttackers: 0, hasDefender: false, giveUp: 'scorch', giveUpVp: true, giveUpSeat: 1, description: 'A rival scorches the VP town they hold — the town burns, leaving charred ruins' },
];

/** Build a ResolutionStep + the defender_id (for grid pre-setup) for a scenario.
 *  `forceDefended`: if true and the scenario has a defender, force the defender to win
 *  regardless of powers — useful for previewing the attacker-shrinks-back animation. */
function buildScenarioStep(s: Scenario, forceDefended: boolean): { step: ResolutionStep; defenderId: string | null } {
  // Attackers take the first `numAttackers` players
  const claimants: ResolutionClaimant[] = [];
  for (let i = 0; i < s.numAttackers; i++) {
    const pid = PLAYERS[i];
    const [dq, dr] = APPROACH_DIRS[i];
    // Deterministic but varied powers so you can tell numbers apart visually
    const power = s.powers?.[i] ?? 2 + (i % 4);
    claimants.push({
      player_id: pid,
      power,
      // Nearest owned tile to the center (step TERRITORY_FIRST_STEP along
      // the approach direction). Cards fly from here to the contested hex.
      source_q: dq * TERRITORY_FIRST_STEP,
      source_r: dr * TERRITORY_FIRST_STEP,
    });
  }

  let defenderId: string | null = null;
  let defenderPower = 0;
  let defenderSourceQ: number | undefined;
  let defenderSourceR: number | undefined;
  if (s.hasDefender) {
    defenderId = PLAYERS[s.numAttackers]; // next unused player
    if (s.isBaseRaid) {
      // Base raid: force the desired outcome directly via defender power.
      // 'defended' → defender > any attacker (max attacker power 5).
      // 'captured' → defender lower than the lone attacker (attacker has power 2).
      defenderPower = s.baseRaidOutcome === 'defended' ? 9 : 1;
    } else {
      // Normal mode: nominal 1 so there's a visible defense number. Forced-defended: 9 so the
      // defender wins outright against any attacker (max attacker power in demo is 5), while
      // staying a single digit so the centered number renders identically to normal play.
      defenderPower = forceDefended ? 9 : s.fortified ? 3 : 1;
    }
    // Defender's nearest owned tile — used by the overlay to anchor the
    // defense number to the edge closest to the defender's territory.
    const [dq, dr] = APPROACH_DIRS[s.numAttackers];
    defenderSourceQ = dq * TERRITORY_FIRST_STEP;
    defenderSourceR = dr * TERRITORY_FIRST_STEP;
  }

  // Winner: strongest attacker if they beat defender outright; otherwise defender holds.
  // Ties between multiple top attackers also go to the defender (if any).
  const powers = claimants.map(c => c.power).sort((a, b) => b - a);
  const topPower = powers[0] ?? 0;
  const topCount = powers.filter(p => p === topPower).length;
  const topAttacker = claimants.find(c => c.power === topPower) ?? null;
  let winnerId: string | null;
  if (topAttacker && topPower > defenderPower && topCount === 1) {
    winnerId = topAttacker.player_id;
  } else if (defenderId) {
    winnerId = defenderId;
  } else if (topAttacker) {
    // Neutral tile, all-attacker tie → defender wins ties, but there's no
    // defender, so for the demo just pick the first top attacker.
    winnerId = topAttacker.player_id;
  } else {
    winnerId = null;
  }

  // Attackers tying on top of the defense: nobody takes it.
  let tie = topCount > 1 && topPower > defenderPower;
  if (tie) winnerId = null;
  if (s.siege && !forceDefended) {
    // Your Siege Engine faces the defense less its +2; everyone else, all of it.
    const through = claimants.filter(c => c.power > defenderPower - (c.player_id === PLAYERS[0] ? 2 : 0));
    const best = Math.max(...through.map(c => c.power));
    const top = through.filter(c => c.power === best);
    tie = top.length > 1;
    winnerId = top.length === 1 ? top[0].player_id : defenderId;
  }
  const outcome: ResolutionStep['outcome'] =
    tie ? 'tie' : winnerId && winnerId !== defenderId ? 'claimed' : 'defended';
  if (s.fortified && defenderId) claimants.push({ player_id: defenderId, power: defenderPower, source_q: null, source_r: null });

  return {
    step: {
      tile_key: CONTESTED_KEY,
      q: 0, r: 0,
      contested: s.numAttackers > 1 || s.hasDefender,
      claimants,
      defender_id: defenderId,
      defender_power: defenderPower,
      defender_source_q: defenderSourceQ,
      defender_source_r: defenderSourceR,
      winner_id: winnerId,
      previous_owner: defenderId,
      outcome,
      is_base_raid: s.isBaseRaid === true,
      ...(s.siege ? { defense_ignored: 2, ignored_by: [PLAYERS[0]] } : {}),
    },
    defenderId,
  };
}

// ── Card-effect scenarios ───────────────────────────────────────────────────
// Scripted reveals for what card effects do as a tile resolves: Flood's
// spread, reveal-time power bonuses, coins and VP, cards gained or burnt,
// Breakthrough's bonus tile. Each builds the board, the cards on it, the
// server's steps and its `resolution_effects` (the shapes the backend sends).

interface Scripted {
  tiles: Record<string, HexTile>;
  cards: BoardCardEntry[];
  steps: ResolutionStep[];
  effects: ResolutionEffect[];
}

interface EffectScenario {
  id: string;
  label: string;
  description: string;
  build: (catalog: CardCatalog) => Scripted;
}

/** The tile a board card sits on (its key ends "@q,r"). */
const tileOfCard = (key: string) => key.slice(key.lastIndexOf('@') + 1);

function scriptKit(catalog: CardCatalog) {
  const cards: BoardCardEntry[] = [];
  /** A card `name` played by seat `seat` on `tile` (yours face up). */
  const card = (seat: number, n: number, tile: string, name: string, over: Partial<Card> = {}): string => {
    const pid = PLAYERS[seat];
    const base = catalog.getCardByName(name) ?? catalog.getCardByName('Blitz');
    const key = `${pid}-${n}@${tile}`;
    if (base) {
      cards.push({
        key, playerId: pid, playerName: PLAYER_LABELS[seat],
        card: { ...base, id: key, ...over },
        faceDown: seat !== 0, stacked: seat !== 0, revealed: seat !== 0,
      });
    }
    return key;
  };
  const claimCard = (key: string, name: string, power: number, bonuses: ResolutionClaimCard['bonuses'] = []): ResolutionClaimCard =>
    ({ card_id: key, name, power, bonuses });
  /** Seat `seat` claiming with `power`, coming from its frontier (or `from`). */
  const claimant = (seat: number, power: number, list: ResolutionClaimCard[] = [], from?: [number, number]): ResolutionClaimant => {
    const [dq, dr] = APPROACH_DIRS[seat];
    return {
      player_id: PLAYERS[seat], power, cards: list,
      source_q: from ? from[0] : dq * TERRITORY_FIRST_STEP, source_r: from ? from[1] : dr * TERRITORY_FIRST_STEP,
    };
  };
  const step = (tile: string, s: Partial<ResolutionStep>): ResolutionStep => {
    const [q, r] = tile.split(',').map(Number);
    return {
      tile_key: tile, q, r, contested: false, claimants: [], defender_id: null, defender_power: 0,
      winner_id: null, previous_owner: null, outcome: 'claimed', ...s,
    };
  };
  const gift = (name: string): Card | undefined => catalog.getCardByName(name);
  return { cards, card, claimCard, claimant, step, gift };
}

const EFFECT_SCENARIOS: EffectScenario[] = [
  {
    id: 'flood', label: 'Flood',
    description: 'You flood from the middle tile: the water surges into all six tiles around it — four neutral and a Yellow tile are taken at power 1; Red\'s walled tile (2) holds',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(PLAYERS[0]);
      tiles[CONTESTED_KEY].is_vp = false;
      tiles[CONTESTED_KEY].vp_value = 0;
      tiles['0,-1'].owner = PLAYERS[2];
      Object.assign(tiles['-1,0'], { owner: PLAYERS[3], defense_power: 2 });
      const flood = k.card(0, 0, CONTESTED_KEY, 'Flood');
      const around = ['1,0', '1,-1', '0,-1', '-1,0', '-1,1', '0,1'];
      const steps = around.map(t => {
        const owner = tiles[t].owner;
        const held = tiles[t].defense_power > 1;
        return k.step(t, {
          contested: !!owner, previous_owner: owner, defender_id: owner, defender_power: tiles[t].defense_power,
          claimants: [k.claimant(0, 1, [k.claimCard(flood, 'Flood', 1)], [0, 0])],
          winner_id: held ? owner : PLAYERS[0], outcome: held ? 'defended' : 'claimed',
        });
      });
      return {
        tiles, cards: k.cards, steps,
        effects: [{ type: 'flood', player_id: PLAYERS[0], by_player_id: PLAYERS[0], tile_key: CONTESTED_KEY, targets: around, card_id: flood, card_name: 'Flood' }],
      };
    },
  },
  {
    id: 'bonuses', label: 'Power Bonuses',
    description: 'Green fortifies (+2). You play Dog Pile, Ambush (+2 contested) and Strike Team (+2 with another Claim), Dog Pile giving +1 to each other claim: 13. Yellow\'s Battering Ram gets +2 against the defense: 7',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(PLAYERS[1]);
      k.card(1, 0, CONTESTED_KEY, 'Fortify', { defense_bonus: 2 });
      const dog = k.card(0, 0, CONTESTED_KEY, 'Dog Pile');
      const amb = k.card(0, 1, CONTESTED_KEY, 'Ambush');
      const st = k.card(0, 2, CONTESTED_KEY, 'Strike Team');
      const ram = k.card(2, 0, CONTESTED_KEY, 'Battering Ram');
      return {
        tiles, cards: k.cards, effects: [],
        steps: [
          k.step(CONTESTED_KEY, {
            claimants: [{ player_id: PLAYERS[1], power: 0, source_q: null, source_r: null }],
            defender_id: PLAYERS[1], defender_power: 2, winner_id: PLAYERS[1], previous_owner: PLAYERS[1],
            outcome: 'defense_applied', defense_permanent: 0, defense_temporary: 2,
          }),
          k.step(CONTESTED_KEY, {
            contested: true, defender_id: PLAYERS[1], defender_power: 2, previous_owner: PLAYERS[1], winner_id: PLAYERS[0],
            claimants: [
              k.claimant(0, 13, [
                k.claimCard(dog, 'Dog Pile', 2),
                k.claimCard(amb, 'Ambush', 2, [{ source: 'Ambush', amount: 2 }, { source: 'Dog Pile', amount: 1 }]),
                k.claimCard(st, 'Strike Team', 3, [{ source: 'Strike Team', amount: 2 }, { source: 'Dog Pile', amount: 1 }]),
              ]),
              k.claimant(2, 7, [k.claimCard(ram, 'Battering Ram', 5, [{ source: 'Battering Ram', amount: 2 }])]),
            ],
          }),
        ],
      };
    },
  },
  {
    id: 'rapid-assault', label: 'Rapid Assault',
    description: 'Your Rapid Assault takes Green\'s tile — and drains a resource from Green\'s bank',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(PLAYERS[1]);
      const ra = k.card(0, 0, CONTESTED_KEY, 'Rapid Assault');
      return {
        tiles, cards: k.cards,
        steps: [k.step(CONTESTED_KEY, {
          contested: true, defender_id: PLAYERS[1], defender_power: 0, previous_owner: PLAYERS[1], winner_id: PLAYERS[0],
          claimants: [k.claimant(0, 3, [k.claimCard(ra, 'Rapid Assault', 3)])],
        })],
        effects: [{ type: 'resources', player_id: PLAYERS[1], by_player_id: PLAYERS[0], amount: -1, tile_key: CONTESTED_KEY, card_name: 'Rapid Assault' }],
      };
    },
  },
  {
    id: 'spoils-of-war', label: 'Spoils of War',
    description: 'Your Spoils of War (3) beats Green\'s Blitz (2) to the tile — and Green\'s Blitz is trashed: it burns on the tile',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(null);
      const sw = k.card(0, 0, CONTESTED_KEY, 'Spoils of War');
      const bz = k.card(1, 0, CONTESTED_KEY, 'Blitz');
      return {
        tiles, cards: k.cards,
        steps: [k.step(CONTESTED_KEY, {
          contested: true, winner_id: PLAYERS[0],
          claimants: [k.claimant(0, 3, [k.claimCard(sw, 'Spoils of War', 3)]), k.claimant(1, 2, [k.claimCard(bz, 'Blitz', 2)])],
        })],
        effects: [{ type: 'trash', player_id: PLAYERS[1], by_player_id: PLAYERS[0], tile_key: CONTESTED_KEY, card_id: bz, card_name: 'Blitz', source_card: 'Spoils of War' }],
      };
    },
  },
  {
    id: 'mercenary', label: 'Mercenary vs Iron Wall',
    description: 'Green\'s Iron Wall makes the tile immune: your Mercenary dinks off — and you still take its Debt',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(PLAYERS[1]);
      k.card(1, 0, CONTESTED_KEY, 'Iron Wall', { defense_bonus: 0 });
      k.card(0, 0, CONTESTED_KEY, 'Mercenary');
      const debt = k.gift('Debt');
      return {
        tiles, cards: k.cards,
        steps: [k.step(CONTESTED_KEY, {
          claimants: [{ player_id: PLAYERS[1], power: 0, source_q: null, source_r: null }],
          defender_id: PLAYERS[1], winner_id: PLAYERS[1], previous_owner: PLAYERS[1],
          outcome: 'defense_applied', defense_permanent: 0, defense_temporary: 0, defense_immunity: true,
        })],
        effects: debt ? [{
          type: 'card', player_id: PLAYERS[0], by_player_id: PLAYERS[0], tile_key: CONTESTED_KEY,
          card_name: 'Debt', count: 1, card: debt, vp_each: 0, source_card: 'Mercenary',
        }] : [],
      };
    },
  },
  {
    id: 'breakthrough', label: 'Breakthrough',
    description: 'Your Breakthrough takes the middle tile, then breaks through into a neutral tile beside it — the camera follows it there',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(null);
      const bt = k.card(0, 0, CONTESTED_KEY, 'Breakthrough');
      return {
        tiles, cards: k.cards, effects: [],
        steps: [
          k.step(CONTESTED_KEY, { winner_id: PLAYERS[0], claimants: [k.claimant(0, 3, [k.claimCard(bt, 'Breakthrough', 3)])] }),
          k.step('-1,1', {
            winner_id: PLAYERS[0], outcome: 'auto_claim', card_name: 'Breakthrough',
            claimants: [{ player_id: PLAYERS[0], power: 0, source_q: 0, source_r: 0 }],
          }),
        ],
      };
    },
  },
  {
    id: 'battle-glory', label: 'Battle Glory',
    description: 'You take Green\'s tile; at the end of the reveal your Battle Glory gains +1 VP (two Claims beat opponents\' tiles this round)',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const tiles = buildDemoTiles(PLAYERS[1]);
      const bz = k.card(0, 0, CONTESTED_KEY, 'Blitz');
      return {
        tiles, cards: k.cards,
        steps: [k.step(CONTESTED_KEY, {
          contested: true, defender_id: PLAYERS[1], previous_owner: PLAYERS[1], winner_id: PLAYERS[0],
          claimants: [k.claimant(0, 2, [k.claimCard(bz, 'Blitz', 2)])],
        })],
        effects: [{ type: 'vp', player_id: PLAYERS[0], by_player_id: PLAYERS[0], amount: 1, tile_key: null, card_name: 'Battle Glory' }],
      };
    },
  },
  {
    id: 'diplomat', label: 'Diplomat',
    description: 'Your Diplomat: two Land Grants fly to you and one to every rival, from your base — each worth 1 VP as it lands',
    build: (catalog) => {
      const k = scriptKit(catalog);
      const grant = k.gift('Land Grant');
      const effects: ResolutionEffect[] = grant ? PLAYERS.map((pid, i) => ({
        type: 'card' as const, player_id: pid, by_player_id: PLAYERS[0], tile_key: null,
        card_name: 'Land Grant', count: i === 0 ? 2 : 1, card: grant, vp_each: 1, source_card: 'Diplomat',
      })) : [];
      return { tiles: buildDemoTiles(null), cards: k.cards, steps: [], effects };
    },
  },
];

// ── Popup simulation scenarios ──────────────────────────────────────────────
// These build sample `PlayerEffect[]` payloads so you can iterate on the
// post-resolution popup animation (intro → stack → hover-expand) without
// playing a real game. Each scenario targets one or more player base tiles;
// the preview uses the same base-tile layout as the resolve scenarios above.

interface PopupScenario {
  id: string;
  label: string;
  build: () => PlayerEffect[];
  description: string;
}

function fx(
  sourceIdx: number,
  targetIdx: number,
  cardName: string,
  effectText: string,
  effectType: string,
  value: number = 1,
): PlayerEffect {
  return {
    source_player_id: PLAYERS[sourceIdx],
    target_player_id: PLAYERS[targetIdx],
    card_name: cardName,
    effect: effectText,
    effect_type: effectType,
    value,
  };
}

const POPUP_SCENARIOS: PopupScenario[] = [
  {
    id: 'single',
    label: 'Single popup',
    description: '1 effect on one base — simplest case',
    build: () => [fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2)],
  },
  {
    id: 'stack-3',
    label: '3-stack on one base',
    description: '3 effects stacked over a single base tile',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 0, 'Embargo', 'Cannot buy next turn', 'buy_restriction'),
      fx(3, 0, 'Raze', '-1 action next turn', 'action_loss', 1),
    ],
  },
  {
    id: 'multi-target',
    label: 'Multi-target (2×2)',
    description: '2 effects on player 0 + 2 on player 3 — two stacks side by side',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 0, 'Embargo', 'Cannot buy next turn', 'buy_restriction'),
      fx(4, 3, 'Raze', '-1 action next turn', 'action_loss', 1),
      fx(5, 3, 'Spoils', '+1 Land Grant', 'grant_land_grants', 1),
    ],
  },
  {
    id: 'stack-5',
    label: '5-stack (tall)',
    description: '5 effects on one base — tests offscreen-flip for small viewports',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 0, 'Embargo', 'Cannot buy next turn', 'buy_restriction'),
      fx(3, 0, 'Raze', '-1 action next turn', 'action_loss', 1),
      fx(4, 0, 'Cease Fire', '+1 free reroll', 'free_reroll', 1),
      fx(5, 0, 'Base Raid', 'Defended!', 'base_raid_defended', 1),
    ],
  },
  {
    id: 'all-six',
    label: '1 each on 6 bases',
    description: '1 effect on every base — tests all six hex directions',
    build: () => [
      fx(1, 0, 'Sabotage', '-2 resources', 'resource_loss', 2),
      fx(2, 1, 'Embargo', 'Cannot buy', 'buy_restriction'),
      fx(3, 2, 'Raze', '-1 action', 'action_loss', 1),
      fx(4, 3, 'Cease Fire', '+1 free reroll', 'free_reroll', 1),
      fx(5, 4, 'Spoils', '+1 Land Grant', 'grant_land_grants', 1),
      fx(0, 5, 'Base Raid', 'Defended!', 'base_raid_defended', 1),
    ],
  },
  {
    id: 'stack-5-all',
    label: '5-stack on all bases',
    description: '5 effects on every base — stress-tests offscreen clamping and stacking at every corner',
    build: () => {
      const effects: PlayerEffect[] = [];
      const templates: Array<{ name: string; effect: string; type: string; value: number }> = [
        { name: 'Sabotage',  effect: '-2 resources',         type: 'resource_loss', value: 2 },
        { name: 'Embargo',   effect: 'Cannot buy next turn', type: 'buy_restriction', value: 1 },
        { name: 'Raze',      effect: '-1 action next turn',  type: 'action_loss',   value: 1 },
        { name: 'Cease Fire',effect: '+1 free reroll',       type: 'free_reroll',   value: 1 },
        { name: 'Base Raid', effect: 'Defended!',            type: 'base_raid_defended', value: 1 },
      ];
      for (let target = 0; target < PLAYERS.length; target++) {
        for (let i = 0; i < templates.length; i++) {
          const source = (target + i + 1) % PLAYERS.length; // don't target self
          const t = templates[i];
          effects.push(fx(source, target, t.name, t.effect, t.type, t.value));
        }
      }
      return effects;
    },
  },
];

export default function ResolveAnimationPreview() {
  const [tiles, setTiles] = useState<Record<string, HexTile>>(() => buildDemoTiles(null));
  const [resolving, setResolving] = useState(false);
  const [steps, setSteps] = useState<ResolutionStep[]>([]);
  const [snapshotTransform, setSnapshotTransform] = useState<GridTransform | null>(null);
  const [snapshotRect, setSnapshotRect] = useState<DOMRect | null>(null);
  const [runId, setRunId] = useState(0);
  const [lastScenario, setLastScenario] = useState<Scenario | null>(null);
  /** When on, owned-tile scenarios force the defender to win so the attacker-shrink-back plays. */
  const [forceDefended, setForceDefended] = useState(false);

  // Popup simulation state — keyed on `popupRunId` so re-triggering the same
  // scenario remounts the component and replays the intro animation.
  const [popupEffects, setPopupEffects] = useState<PlayerEffect[]>([]);
  const [popupRunId, setPopupRunId] = useState(0);
  const [lastPopupScenario, setLastPopupScenario] = useState<PopupScenario | null>(null);

  // Grid rotation — mirrors GameScreen's r / shift+r shortcuts so the preview
  // can exercise the same rotation animation that the real game uses.
  const [gridRotation, setGridRotation] = useState(0);

  const transformRef = useRef<GridTransform | null>(null);
  const gridContainerRef = useRef<HTMLDivElement | null>(null);
  const fxRef = useRef<BoardFx | null>(null);
  const controlsRef = useRef<BoardControls | null>(null);
  const savedViewRef = useRef<CameraView | null>(null);
  const [closeUp, setCloseUp] = useState<string | null>(null);
  const [activeTile, setActiveTile] = useState<string | null>(null);
  /** The cards played on the contested tile (rivals' face down). */
  const [tileCards, setTileCards] = useState<BoardCardEntry[]>([]);
  const planCardsRef = useRef<Map<string, PlanCard[]>>(new Map());
  /** Preview a tile that doesn't involve you (quick, no close-up). */
  const [quick, setQuick] = useState(false);
  /** Cards on their way home (here: to their player's base — the game sends
   *  them to your discard pile or a rival's player card). */
  const [flights, setFlights] = useState<Flight<'home'>[]>([]);
  const flightSeq = useRef(0);
  const tileCardsRef = useRef<BoardCardEntry[]>([]);
  tileCardsRef.current = tileCards;
  const catalog = useCardCatalog();
  /** The scenario's card effects (the server's resolution_effects). */
  const [effects, setEffects] = useState<ResolutionEffect[]>([]);
  const [lastEffectScenario, setLastEffectScenario] = useState<EffectScenario | null>(null);
  /** Coins and VP stars in flight (here: to and from each player's base). */
  const [coins, setCoins] = useState<Coin[]>([]);
  const coinSeq = useRef(0);
  /** "+8", "−1", "+1 VP" rising off a player's base as things land there. */
  const [floats, setFloats] = useState<{ id: number; x: number; y: number; text: string; color: string }[]>([]);
  const [burns, setBurns] = useState<{ key: string; card: Card; pose: Pose }[]>([]);
  const landings = useRef(new Map<number, () => void>());

  const { settings, setAnimationMode } = useSettings();
  const animSpeed = useAnimationSpeed();

  const playScenario = useCallback((s: Scenario) => {
    if (s.giveUp) {
      // The center tile is held (walled, with a camp); its holder gives it up.
      const seat = s.giveUpSeat ?? 0;
      const pid = PLAYERS[seat];
      const demo = buildDemoTiles(pid);
      const center = demo[CONTESTED_KEY];
      center.is_vp = !!s.giveUpVp;
      center.vp_value = s.giveUpVp ? 2 : 0;
      center.base_defense = s.giveUpVp ? 3 : 0;
      center.permanent_defense_bonus = 2;
      center.defense_power = center.base_defense + 2;
      setTiles(demo);
      const card = catalog.getCardByName(s.giveUp === 'scorch' ? 'Scorched Retreat' : 'Exodus');
      const key = `${pid}-0@${CONTESTED_KEY}`;
      const entries: BoardCardEntry[] = card ? [{
        key, playerId: pid, playerName: PLAYER_LABELS[seat],
        card: { ...card, id: key },
        faceDown: seat !== 0, stacked: seat !== 0, revealed: seat !== 0,
      }] : [];
      setTileCards(entries);
      planCardsRef.current = new Map([[CONTESTED_KEY, entries.map(e => ({
        key: e.key, playerId: e.playerId, cardType: e.card.card_type, power: e.card.power, defense: e.card.defense_bonus ?? 0, faceDown: !!e.faceDown,
      }))]]);
      setSteps([{
        tile_key: CONTESTED_KEY, q: 0, r: 0, contested: false,
        claimants: [{ player_id: pid, power: 0, source_q: null, source_r: null }],
        defender_id: null, defender_power: 0, winner_id: null, previous_owner: pid,
        outcome: s.giveUp, vp_value: s.giveUpVp ? 2 : 0,
      }]);
      // Scorched Retreat pays its holder 8 resources off the burning tile.
      setEffects(s.giveUp === 'scorch'
        ? [{ type: 'resources', player_id: pid, by_player_id: pid, amount: 8, tile_key: CONTESTED_KEY, card_name: 'Scorched Retreat' }]
        : []);
      setLastEffectScenario(null);
      setLastScenario(s);
      setRunId(x => x + 1);
      setSnapshotTransform(transformRef.current);
      setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
      setResolving(true);
      return;
    }
    const { step, defenderId } = buildScenarioStep(s, forceDefended);
    // Reset the grid so the central tile matches this scenario's pre-battle state.
    // For base-raid scenarios the central tile is the defender's base (not a VP tile).
    setTiles(buildDemoTiles(defenderId, s.isBaseRaid === true));
    const steps: ResolutionStep[] = [];
    if (s.fortified && defenderId) {
      steps.push({
        tile_key: CONTESTED_KEY, q: 0, r: 0, contested: false,
        claimants: [{ player_id: defenderId, power: 0, source_q: null, source_r: null }],
        defender_id: defenderId, defender_power: 2, winner_id: defenderId, previous_owner: defenderId,
        outcome: 'defense_applied', defense_permanent: 0, defense_temporary: 2,
      });
    }
    if (s.immune && defenderId) {
      // Immunity: the server drops every other claim — only the defense step.
      steps.push({
        tile_key: CONTESTED_KEY, q: 0, r: 0, contested: false,
        claimants: [{ player_id: defenderId, power: 0, source_q: null, source_r: null }],
        defender_id: defenderId, defender_power: 0, winner_id: defenderId, previous_owner: defenderId,
        outcome: 'defense_applied', defense_permanent: 0, defense_temporary: 0, defense_immunity: true,
      });
    } else {
      steps.push(step);
    }
    // The cards on the tile: each attacker's power over two Claims (three
    // for a big one, one for a tiny one); the
    // fortified defender's Defense card and Claim. "You" (Blue) are face up.
    const claimCard = catalog.getCardByName('Blitz');
    const defenseCard = catalog.getCardByName('Fortify');
    const entries: BoardCardEntry[] = [];
    const add = (pid: string, n: number, base: typeof claimCard, over: Partial<NonNullable<typeof claimCard>>) => {
      if (!base) return;
      const key = `${pid}-${n}@${CONTESTED_KEY}`;
      entries.push({
        key, playerId: pid, playerName: PLAYER_LABELS[PLAYERS.indexOf(pid)],
        card: { ...base, id: key, ...over },
        faceDown: pid !== PLAYERS[0], stacked: pid !== PLAYERS[0], revealed: pid !== PLAYERS[0],
      });
    };
    for (const c of step.claimants) {
      if (c.player_id === defenderId) {
        if (s.immune) {
          add(c.player_id, 0, catalog.getCardByName('Iron Wall') ?? defenseCard, { defense_bonus: 0 });
          continue;
        }
        add(c.player_id, 0, defenseCard, { defense_bonus: 2 });
        add(c.player_id, 1, claimCard, { power: 1 });
        continue;
      }
      if (s.siege && c.player_id === PLAYERS[0]) {
        add(c.player_id, 0, catalog.getCardByName('Siege Engine') ?? claimCard, { power: c.power });
        continue;
      }
      const n = c.power >= 6 ? 3 : c.power >= 2 ? 2 : 1;
      for (let j = 0; j < n; j++) {
        const share = Math.floor(c.power / n) + (j < c.power % n ? 1 : 0);
        add(c.player_id, j, claimCard, { power: share });
      }
    }
    setTileCards(entries);
    planCardsRef.current = new Map([[CONTESTED_KEY, entries.map(e => ({
      key: e.key, playerId: e.playerId, cardType: e.card.card_type, power: e.card.power, defense: e.card.defense_bonus ?? 0, faceDown: !!e.faceDown,
    }))]]);
    // A raid that breaks through: Spoils (+1 VP) to the raider, Rubble to the base's owner.
    const spoils = catalog.getCardByName('Spoils'), rubble = catalog.getCardByName('Rubble');
    setEffects(s.isBaseRaid && step.outcome === 'claimed' && step.winner_id && defenderId && spoils && rubble ? [
      { type: 'card', player_id: step.winner_id, by_player_id: step.winner_id, tile_key: CONTESTED_KEY, card_name: 'Spoils', count: 1, card: spoils, vp_each: 1, source_card: 'Base Raid' },
      { type: 'card', player_id: defenderId, by_player_id: step.winner_id, tile_key: CONTESTED_KEY, card_name: 'Rubble', count: 1, card: rubble, vp_each: 0, source_card: 'Base Raid' },
    ] : []);
    setLastEffectScenario(null);
    setSteps(steps);
    setLastScenario(s);
    setRunId(x => x + 1);
    // Snapshot transform for the effect popups' hex→screen conversion
    setSnapshotTransform(transformRef.current);
    setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    setResolving(true);
  }, [forceDefended, catalog]);

  /** Keep snapshotted transform fresh if the user resizes while idle. */
  useEffect(() => {
    if (resolving) return;
    const onResize = () => {
      setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [resolving]);

  /** r / shift+r to rotate the grid (matches GameScreen's shortcut).
   *  Ignored while a rotation-sensitive resolve animation is running or when
   *  an input element has focus. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (resolving) return;
      e.preventDefault();
      setGridRotation(prev => prev + (e.shiftKey ? -1 : 1) * (Math.PI / 6));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [resolving]);

  /** Apply a step's ownership change (the resolver calls it as the tile settles). */
  const applyStep = useCallback((idx: number) => {
    const step = steps[idx];
    if (!step) return;
    setTiles(prev => {
      const tile = prev[step.tile_key];
      if (!tile) return prev;
      const next = tileAfterStep(tile, step);
      return next === tile ? prev : { ...prev, [step.tile_key]: next };
    });
  }, [steps]);

  const handleComplete = useCallback(() => {
    setResolving(false);
    setSteps([]);
    setEffects([]);
    setTileCards([]);
  }, []);

  // The tile-by-tile plan, from the scenario's steps and the cards on the
  // tile. Blue is "you", so the camera closes in — unless Quick is on.
  const plans = useMemo(() => (steps.length || effects.length
    ? buildResolvePlans(steps, planCardsRef.current, tiles, PLAYERS[0], effects).map(p => (quick ? { ...p, focus: false } : p))
    : []),
  // Planned once per run, from the board as it was going in.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [steps, effects]);
  const project = useCallback((q: number, r: number) => {
    const t = transformRef.current;
    const rect = (gridContainerRef.current?.querySelector('canvas') ?? gridContainerRef.current)?.getBoundingClientRect();
    if (!t?.project || !rect) return null;
    const p = axialToPixel(q, r);
    const s = t.project(p.x, p.y, 0.15);
    return { x: s.x + rect.left, y: s.y + rect.top };
  }, []);
  /** A player's base on screen (where the preview sends what's theirs). */
  const baseOf = useCallback((pid: string) => {
    const seat = PLAYERS.indexOf(pid);
    const [dq, dr] = APPROACH_DIRS[seat] ?? [0, 0];
    return project(dq * BASE_STEP, dr * BASE_STEP);
  }, [project]);
  const addFloat = useCallback((at: { x: number; y: number }, text: string, color: string) => {
    const id = ++coinSeq.current;
    setFloats(f => [...f, { id, x: at.x, y: at.y, text, color }]);
    setTimeout(() => setFloats(f => f.filter(x => x.id !== id)), 1300);
  }, []);
  /** Coins (or VP stars) flying from → to; `done` once the last has landed. */
  const flyCoins = useCallback((amount: number, from: { x: number; y: number }, to: { x: number; y: number }, icon: 'resource' | 'vp', done?: () => void) => {
    const list = splitCoins(amount).map((value, i): Coin => ({
      id: ++coinSeq.current, from, to, value, batch: 0, icon, delay: i * 90, duration: icon === 'vp' ? 820 : 680,
    }));
    if (done && list.length) landings.current.set(list[list.length - 1].id, done);
    setCoins(cs => [...cs, ...list]);
  }, []);
  const onCoinLand = useCallback((c: Coin) => {
    setCoins(cs => cs.filter(x => x.id !== c.id));
    landings.current.get(c.id)?.();
    landings.current.delete(c.id);
  }, []);

  const api = useMemo<ResolverApi>(() => ({
    focus: (key, shot) => {
      const ms = resolveCamera(controlsRef.current, savedViewRef, key, 1, shot);
      setCloseUp(key);
      return new Promise(res => setTimeout(res, ms));
    },
    setActive: (plan) => setActiveTile(plan?.tileKey ?? null),
    spread: (keys) => setTileCards(cs => cs.map(c => (keys.includes(c.key) ? { ...c, stacked: false } : c))),
    flip: (keys) => setTileCards(cs => cs.map(c => (keys.includes(c.key) ? { ...c, faceDown: false } : c))),
    sendHome: (keys) => {
      const leaving = tileCardsRef.current.filter(c => keys.includes(c.key));
      const launched: Flight<'home'>[] = [];
      leaving.forEach((c, i) => {
        const r = document.querySelector(`[data-board-card="${CSS.escape(c.key)}"]`)?.getBoundingClientRect();
        const seat = PLAYERS.indexOf(c.playerId);
        const [dq, dr] = APPROACH_DIRS[seat] ?? [0, 0];
        const base = project(dq * BASE_STEP, dr * BASE_STEP);
        if (!r || r.width === 0 || !base) return;
        const from: Pose = { x: r.left + r.width / 2, y: r.top + r.height / 2, rot: 0, scale: r.width / CARD_W };
        const to: Pose = { x: base.x, y: base.y, rot: 0, scale: 0.06, opacity: 0 };
        launched.push({
          key: `home${++flightSeq.current}`, kind: 'home', card: c.card,
          frames: flightKeyframes(from, to, { arc: 50, ease: easeInOut, opacity: t => (t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3) }),
          delay: i * 90, duration: 600,
        });
      });
      setTileCards(cs => cs.filter(c => !keys.includes(c.key)));
      if (launched.length) setFlights(fs => [...fs, ...launched]);
    },
    applyStep: (idx) => applyStep(idx),
    // No bank, score or deck here: what goes to a player flies to their base.
    bank: (pid, amount, at) => {
      const base = baseOf(pid);
      if (!base || !amount) return;
      const [from, to] = amount > 0 ? [at, base] : [base, at];
      const float = () => addFloat(amount > 0 ? base : at, `${amount > 0 ? '+' : '−'}${Math.abs(amount)}`, amount > 0 ? '#8ff0a4' : '#ff8f8f');
      flyCoins(Math.abs(amount), from, to, 'resource', float);
    },
    vp: (pid, amount, at) => {
      const base = baseOf(pid);
      if (base) flyCoins(amount, at, base, 'vp', () => addFloat(base, `+${amount} VP`, '#ffd24a'));
    },
    giveCard: (pid, card, count, at, vpEach) => {
      const base = baseOf(pid);
      if (!base) return;
      const start: Pose = { x: at.x, y: at.y, rot: 0, scale: 0.1 };
      const lift: Pose = { x: at.x, y: at.y - 70, rot: 0, scale: 0.36 };
      const to: Pose = { x: base.x, y: base.y, rot: 0, scale: 0.06, opacity: 0 };
      const launched: Flight<'home'>[] = [];
      for (let i = 0; i < count; i++) {
        const key = `gift${++flightSeq.current}`;
        if (vpEach) landings.current.set(-flightSeq.current, () => addFloat(base, `+${vpEach} VP`, '#ffd24a'));
        launched.push({
          key, kind: 'home', card: { ...card, id: key }, delay: i * 220, duration: 1300,
          frames: [
            { offset: 0, transform: poseTransform(start), opacity: 0 },
            { offset: 0.2, transform: poseTransform(lift), opacity: 1 },
            { offset: 0.45, transform: poseTransform(lift), opacity: 1 },
            ...flightKeyframes(lift, to, { arc: 60, ease: easeInOut, samples: 6, opacity: t => (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4) })
              .slice(1).map(f => ({ ...f, offset: 0.45 + (f.offset as number) * 0.55 })),
          ],
        });
      }
      setFlights(fs => [...fs, ...launched]);
    },
    burn: (keys) => {
      const leaving = tileCardsRef.current.filter(c => keys.includes(c.key));
      for (const c of leaving) {
        const r = document.querySelector(`[data-board-card="${CSS.escape(c.key)}"]`)?.getBoundingClientRect();
        if (r && r.width > 0) {
          setBurns(b => [...b, { key: `burn-${c.key}`, card: c.card, pose: { x: r.left + r.width / 2, y: r.top + r.height / 2, rot: 0, scale: r.width / CARD_W } }]);
        }
      }
      setTileCards(cs => cs.filter(c => !keys.includes(c.key)));
    },
  }), [applyStep, project, baseOf, flyCoins, addFloat]);

  const playEffectScenario = useCallback((s: EffectScenario) => {
    const built = s.build(catalog);
    setTiles(built.tiles);
    setTileCards(built.cards);
    const byTile = new Map<string, PlanCard[]>();
    for (const e of built.cards) {
      const t = tileOfCard(e.key);
      byTile.set(t, [...(byTile.get(t) ?? []), {
        key: e.key, playerId: e.playerId, cardType: e.card.card_type, power: e.card.power,
        defense: e.card.defense_bonus ?? 0, faceDown: !!e.faceDown, cardId: e.card.id,
      }]);
    }
    planCardsRef.current = byTile;
    setEffects(built.effects);
    setSteps(built.steps);
    setLastScenario(null);
    setLastEffectScenario(s);
    setRunId(x => x + 1);
    setSnapshotTransform(transformRef.current);
    setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    setResolving(true);
  }, [catalog]);

  const handleReset = useCallback(() => {
    setTiles(buildDemoTiles(null));
    setTileCards([]);
    setSteps([]);
    setEffects([]);
    setResolving(false);
    setLastScenario(null);
    setLastEffectScenario(null);
  }, []);

  const handleTileClick = useCallback(() => {/* no-op */}, []);

  const playPopupScenario = useCallback((s: PopupScenario) => {
    // Make sure we have a fresh transform snapshot so popups position correctly
    // even if the user just resized or scrolled.
    setSnapshotTransform(transformRef.current);
    setSnapshotRect(gridContainerRef.current?.getBoundingClientRect() ?? null);
    // Ensure the grid layout matches expectations (all 6 bases present, neutral center).
    setTiles(buildDemoTiles(null));
    setPopupEffects(s.build());
    setLastPopupScenario(s);
    setPopupRunId(x => x + 1);
  }, []);

  const clearPopups = useCallback(() => {
    setPopupEffects([]);
    setLastPopupScenario(null);
  }, []);

  const desc = lastScenario?.description
    ?? lastEffectScenario?.description
    ?? lastPopupScenario?.description
    ?? 'Click a scenario to play an animation';

  // Build a player-name map from the demo PLAYERS/PLAYER_LABELS arrays.
  const playerNames = useMemo(
    () => Object.fromEntries(PLAYERS.map((p, i) => [p, PLAYER_LABELS[i]])),
    [],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', background: '#1a1a2e', color: '#fff' }}>
      {/* Top bar — structured so height is stable regardless of state.
          Row 1: scenario buttons (may wrap; width-only dependent).
          Row 2: reset + animation toggle + status text (fixed-height row). */}
      <div style={{ padding: '12px 20px 10px', borderBottom: '1px solid #333', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 16, marginRight: 8 }}>Resolve Animation Preview</h2>
          {SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => playScenario(s)}
              disabled={resolving}
              style={{
                ...btnStyle,
                background: resolving ? '#2a2a3e' : (lastScenario?.id === s.id ? '#6a8fff' : '#4a9eff'),
                opacity: resolving ? 0.5 : 1,
                cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Card effects as a tile resolves (Flood, bonuses, coins, VP, cards). */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#aaa', marginRight: 4 }}>Card effects:</span>
          {EFFECT_SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => playEffectScenario(s)}
              disabled={resolving}
              style={{
                ...btnStyle,
                background: resolving ? '#2a2a3e' : (lastEffectScenario?.id === s.id ? '#3fd0a0' : '#21a67a'),
                opacity: resolving ? 0.5 : 1,
                cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)',
              }}
              title={s.description}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Row 2: popup-simulation scenarios. These trigger the PlayerEffectPopups
            component directly so you can iterate on the intro → stacked → hover-expand
            lifecycle without playing a full game. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#aaa', marginRight: 4 }}>Popups:</span>
          {POPUP_SCENARIOS.map(s => (
            <button
              key={s.id}
              onClick={() => playPopupScenario(s)}
              disabled={resolving}
              style={{
                ...btnStyle,
                background: resolving ? '#2a2a3e' : (lastPopupScenario?.id === s.id ? '#c77dff' : '#8a4fff'),
                opacity: resolving ? 0.5 : 1,
                cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)',
              }}
              title={s.description}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={clearPopups}
            disabled={popupEffects.length === 0}
            style={{
              ...btnStyle,
              background: popupEffects.length === 0 ? '#2a2a3e' : '#555',
              opacity: popupEffects.length === 0 ? 0.5 : 1,
              cursor: popupEffects.length === 0 ? 'not-allowed' : 'var(--cc-cursor-pointer)',
            }}
          >
            Clear popups
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28 }}>
          <button onClick={handleReset} disabled={resolving} style={{ ...btnStyle, background: '#555', opacity: resolving ? 0.5 : 1, cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)' }}>
            Reset
          </button>

          <div style={{ display: 'inline-flex', borderRadius: 6, overflow: 'hidden', border: '1px solid #555' }}>
            <span style={{ padding: '6px 8px', fontSize: 11, color: '#aaa', background: '#2a2a3e' }}>Animations</span>
            {(['normal', 'fast', 'off'] as AnimationMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setAnimationMode(mode)}
                disabled={resolving}
                style={{
                  padding: '6px 10px',
                  background: settings.animationMode === mode ? '#4a9eff' : '#2a2a3e',
                  border: 'none',
                  borderLeft: '1px solid #555',
                  color: settings.animationMode === mode ? '#fff' : '#aaa',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)',
                  opacity: resolving ? 0.5 : 1,
                  textTransform: 'capitalize',
                }}
              >
                {mode}
              </button>
            ))}
          </div>

          {/* Force-defended toggle — forces owned-tile scenarios to resolve in the defender's favor
              so you can preview the attacker-shrink-back animation. No effect on neutral scenarios. */}
          <button
            onClick={() => setForceDefended(v => !v)}
            disabled={resolving}
            style={{
              ...btnStyle,
              background: forceDefended ? '#ff9a3c' : '#2a2a3e',
              border: '1px solid #555',
              color: forceDefended ? '#1a1a2e' : '#aaa',
              opacity: resolving ? 0.5 : 1,
              cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)',
            }}
            title="Force the defender to win on owned-tile scenarios"
          >
            Defended: {forceDefended ? 'ON' : 'off'}
          </button>
          <button
            onClick={() => setQuick(v => !v)}
            disabled={resolving}
            style={{
              ...btnStyle,
              background: quick ? '#ff9a3c' : '#2a2a3e',
              border: '1px solid #555',
              color: quick ? '#1a1a2e' : '#aaa',
              opacity: resolving ? 0.5 : 1,
              cursor: resolving ? 'not-allowed' : 'var(--cc-cursor-pointer)',
            }}
            title="Resolve as a tile that doesn't involve you: no close-up, no count-up"
          >
            Quick: {quick ? 'ON' : 'off'}
          </button>

          {/* Status text: min-width: 0 + overflow: hidden + whiteSpace: nowrap so the
              bar height never changes when text grows/shrinks. */}
          <span style={{ fontSize: 12, color: '#888', marginLeft: 8, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {resolving ? 'Resolving…' : desc}
          </span>
        </div>
      </div>

      <div ref={gridContainerRef} style={{ flex: 1, position: 'relative' }}>
        <GameBoard
          tiles={tiles}
          onTileClick={handleTileClick}
          transformRef={transformRef}
          fxRef={fxRef}
          activePlayerId={lastScenario ? PLAYERS[0] : undefined}
          gridRotation={gridRotation}
          controlsRef={controlsRef}
          focusTileKey={closeUp}
          hideDefenseLabelKey={activeTile}
          raisedTileKey={activeTile}
          tileCardKeys={[...new Set(tileCards.map(c => tileOfCard(c.key)))]}
          renderTileCards={(key, zoom) => (
            <TileCardStack entries={tileCards.filter(c => tileOfCard(c.key) === key)} scale={boardCardScale(zoom)} focus={activeTile === key} still={resolving} onOpen={() => {}} />
          )}
        />
      </div>

      <div style={{ padding: '10px 20px', borderTop: '1px solid #333', fontSize: 12, color: '#aaa', lineHeight: 1.6 }}>
        Each player sits in one hex-direction from the central (0,0) tile. Attackers fly their power numbers in from their frontier tile;
        the defense builds on the target, then each attacker (weakest first) counts up and smashes into it. Animation code is the production <code>TileResolver</code> + <code>GameBoard</code> — tweaks here flow through to the real game.{' '}
        <span style={{ marginLeft: 8 }}>
          Players:{' '}
          {PLAYERS.map((p, i) => (
            <span key={p} style={{ color: `#${(PLAYER_COLORS[p] ?? 0xffffff).toString(16).padStart(6, '0')}`, marginRight: 10 }}>
              {PLAYER_LABELS[i]}
            </span>
          ))}
        </span>
      </div>

      {resolving && plans.length > 0 && (
        <TileResolver
          key={runId}
          plans={plans}
          speed={1}
          fxRef={fxRef}
          project={project}
          api={api}
          onComplete={handleComplete}
        />
      )}
      {flights.map(f => (
        <FlightCard key={f.key} flight={f} onDone={(done) => {
          setFlights(fs => fs.filter(x => x.key !== done.key));
          const n = Number(done.key.replace('gift', ''));
          if (done.key.startsWith('gift')) { landings.current.get(-n)?.(); landings.current.delete(-n); }
        }} />
      ))}
      {coins.length > 0 && (
        <div className="cc-res-coins">
          {coins.map(c => <CoinFlight key={c.id} coin={c} onLand={onCoinLand} />)}
        </div>
      )}
      {floats.map(f => (
        <div key={f.id} style={{
          position: 'fixed', left: f.x, top: f.y - 28, transform: 'translateX(-50%)', zIndex: 9600, pointerEvents: 'none',
          color: f.color, fontWeight: 800, fontSize: 18, textShadow: '0 1px 3px rgba(0,0,0,0.9)',
          animation: 'cc-res-float 1.2s ease-out forwards',
        }}>{f.text}</div>
      ))}
      {burns.map(b => (
        <TrashBurn key={b.key} card={b.card} pose={b.pose} speed={1} maxScale={0.5}
          onDone={() => setBurns(prev => prev.filter(x => x.key !== b.key))} />
      ))}

      {/* Keep the component mounted once a scenario has played so clearing
          popups triggers the built-in fade-out instead of instantly unmounting.
          The `key` resets the component when a new scenario is triggered. */}
      {popupRunId > 0 && (
        <PlayerEffectPopups
          key={popupRunId}
          effects={popupEffects}
          gridTransform={snapshotTransform}
          gridRect={snapshotRect}
          tiles={tiles}
          playerNames={playerNames}
          activePlayerId={PLAYERS[0]}
          animSpeed={animSpeed}
          gridTransformRef={transformRef}
          gridContainerRef={gridContainerRef}
        />
      )}
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '6px 10px',
  background: '#4a9eff',
  border: 'none',
  borderRadius: 6,
  color: '#fff',
  fontSize: 12,
  fontWeight: 600,
};
