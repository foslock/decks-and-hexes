import type { Card, HexTile, ResolutionEffect, ResolutionStep } from '../../types/game';
import type { BoardCardEntry } from '../BoardCards';

/**
 * The tutorial's little world: a fixed radius-4 island (a Small map), you
 * at the bottom and a rival at the top, plus the pure helpers the scenes use
 * to build each scene's starting state and score it.
 */

export const YOU = 'tutorial_you';
export const RIVAL = 'tutorial_rival';
export const YOU_COLOR = 0x3d8bff;
export const RIVAL_COLOR = 0xe6194b;
export const TUTORIAL_COLORS: Record<string, number> = { [YOU]: YOU_COLOR, [RIVAL]: RIVAL_COLOR };
export const PLAYER_INFO = {
  [YOU]: { name: 'You', archetype: 'vanguard' },
  [RIVAL]: { name: 'Rival', archetype: 'swarm' },
};

export const VP_TARGET = 10;
export const TILES_PER_VP = 3;
const RADIUS = 4;

export const BASE_YOU = '0,4';
export const BASE_RIVAL = '0,-4';
export const CENTER_VP = '0,0';
/** The star hex you take in the VP scene, and the one that wins the game. */
export const STAR = '-2,3';
export const FINAL_STAR = '3,0';
/** The tile fought over in the middle scenes. */
export const FRONT = '2,0';
const STANDARD_VPS = [STAR, '2,-3', FINAL_STAR, '-3,0'];
const BLOCKED = ['-3,2', '-2,-1', '4,-2', '-4,4', '2,2', '4,0'];

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
export const parseKey = (k: string): [number, number] => k.split(',').map(Number) as [number, number];
export const neighbours = (k: string): string[] => {
  const [q, r] = parseKey(k);
  return DIRS.map(([dq, dr]) => `${q + dq},${r + dr}`);
};

/** Territory as the story goes on. */
export const LAND = {
  youStart: [BASE_YOU, '0,3'],
  rivalStart: [BASE_RIVAL, '0,-3'],
  /** Your first two Explores. */
  youFirst: ['-1,3', '1,2'],
  /** "A few rounds later". */
  youMid: ['1,3', '0,2', '2,1'],
  rivalMid: ['1,-3', '2,-3', '2,-2', '2,-1', '-1,-3'],
  /** "Late in the game": you've pushed up the east side to the rival's base. */
  youLate: ['3,-1', '3,-2', '3,-3', '3,-4', '2,-4', '1,-4', '2,-2', '2,-1', '-1,2'],
  rivalLate: ['-1,-2', '0,-2', '1,-2'],
  /** The last round's claims. */
  youFinal: ['1,1', '-2,2', FINAL_STAR],
};

function blankTile(q: number, r: number): HexTile {
  return {
    q, r, is_blocked: false, is_vp: false, vp_value: 1, owner: null,
    defense_power: 0, base_defense: 0, permanent_defense_bonus: 0,
    held_since_turn: null, is_base: false, base_owner: null,
  };
}

/** The island with no one on it but the two bases. */
function island(): Record<string, HexTile> {
  const tiles: Record<string, HexTile> = {};
  for (let q = -RADIUS; q <= RADIUS; q++) {
    for (let r = -RADIUS; r <= RADIUS; r++) {
      if (Math.abs(q + r) > RADIUS) continue;
      tiles[`${q},${r}`] = blankTile(q, r);
    }
  }
  for (const k of BLOCKED) tiles[k].is_blocked = true;
  const fortify = (k: string, d: number) => { tiles[k].base_defense = d; tiles[k].defense_power = d; };
  for (const k of STANDARD_VPS) { tiles[k].is_vp = true; fortify(k, 2); }
  tiles[CENTER_VP].is_vp = true;
  tiles[CENTER_VP].vp_value = 2;
  fortify(CENTER_VP, 3);
  for (const k of neighbours(CENTER_VP)) fortify(k, 1);
  for (const [k, pid] of [[BASE_YOU, YOU], [BASE_RIVAL, RIVAL]] as const) {
    Object.assign(tiles[k], { is_base: true, base_owner: pid, owner: pid, held_since_turn: 0 });
    fortify(k, 3);
  }
  return tiles;
}

/** The island with `you` / `rival` owning those tiles and lasting defense
 *  (`fortified`: tile → permanent bonus). */
export function board(you: string[], rival: string[], fortified: Record<string, number> = {}): Record<string, HexTile> {
  const tiles = island();
  for (const k of you) tiles[k].owner = YOU;
  for (const k of rival) tiles[k].owner = RIVAL;
  for (const [k, bonus] of Object.entries(fortified)) {
    tiles[k].permanent_defense_bonus = bonus;
    tiles[k].defense_power = tiles[k].base_defense + bonus;
  }
  return tiles;
}

/** Tiles connected to a player's base through land they own. */
export function connectedTiles(tiles: Record<string, HexTile>, pid: string): Set<string> {
  const base = Object.entries(tiles).find(([, t]) => t.is_base && t.base_owner === pid)?.[0];
  const seen = new Set<string>();
  if (!base) return seen;
  const queue = [base];
  seen.add(base);
  while (queue.length) {
    const k = queue.shift()!;
    for (const n of neighbours(k)) {
      if (!seen.has(n) && tiles[n]?.owner === pid) { seen.add(n); queue.push(n); }
    }
  }
  return seen;
}

/** Star hexes that score (owned and connected), for every player. */
export function connectedVp(tiles: Record<string, HexTile>): Set<string> {
  const out = new Set<string>();
  for (const pid of [YOU, RIVAL]) {
    for (const k of connectedTiles(tiles, pid)) if (tiles[k].is_vp) out.add(k);
  }
  return out;
}

/** A player's VP from the board (as the game scores it) plus bonus VP. */
export function scoreVp(tiles: Record<string, HexTile>, pid: string, bonus = 0): { tiles: number; tileVp: number; starVp: number; total: number } {
  const owned = Object.values(tiles).filter(t => t.owner === pid).length;
  const connected = connectedTiles(tiles, pid);
  let starVp = 0;
  for (const k of connected) if (tiles[k].is_vp) starVp += tiles[k].vp_value;
  const tileVp = Math.floor(owned / TILES_PER_VP);
  return { tiles: owned, tileVp, starVp, total: tileVp + starVp + bonus };
}

/** Shortest path through a player's land from a tile back to their base
 *  (the tile first), for drawing a VP connection line. */
export function pathToBase(tiles: Record<string, HexTile>, pid: string, from: string): [number, number][] | null {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const k = queue.shift()!;
    const t = tiles[k];
    if (t.is_base && t.base_owner === pid) {
      const out: [number, number][] = [];
      for (let c: string | null = k; c; c = prev.get(c) ?? null) out.push(parseKey(c));
      return out.reverse();
    }
    for (const n of neighbours(k)) {
      if (!prev.has(n) && tiles[n]?.owner === pid) { prev.set(n, k); queue.push(n); }
    }
  }
  return null;
}

/** A card played onto a tile (shown as a power or defense readout). */
export interface PlannedPlay {
  card: Card;
  power: number;
  type: 'claim' | 'defense';
  temp?: number;
  perm?: number;
}

/** Everything a scene shows. Each scene builds its own starting World, so
 *  Next / Back always land on the same picture. */
export interface World {
  tiles: Record<string, HexTile>;
  round: number;
  phase: string | null;
  hand: Card[];
  showHand: boolean;
  drawCount: number;
  discard: Card[];
  actions: number;
  resources: number;
  /** Spoils and other card VP. */
  bonusVp: number;
  /** Cards over tiles. */
  cards: Record<string, BoardCardEntry[]>;
  planned: Record<string, PlannedPlay>;
  chevrons: { from: string; to: string; pid: string }[];
  highlight: string[];
  pulse: string[];
  /** VP connection lines, from these star hexes to their owner's base. */
  paths: string[];
  focus: string | null;
  shop: { cards: Card[]; hot: string | null; bought: string[] } | null;
  victory: boolean;
}

export function makeWorld(over: Partial<World> = {}): World {
  return {
    tiles: board(LAND.youStart, LAND.rivalStart),
    round: 1,
    phase: null,
    hand: [],
    showHand: false,
    drawCount: 10,
    discard: [],
    actions: 5,
    resources: 0,
    bonusVp: 0,
    cards: {},
    planned: {},
    chevrons: [],
    highlight: [],
    pulse: [],
    paths: [],
    focus: null,
    shop: null,
    victory: false,
    ...over,
  };
}

/** A distinct copy of a card (hand cards need their own ids). */
export function copy(card: Card, n: number | string): Card {
  return { ...card, id: `${card.definition_id}-${n}` };
}

/** Claimable tiles: empty, unblocked neighbours of a player's land. */
export function frontier(tiles: Record<string, HexTile>, pid: string): string[] {
  const out = new Set<string>();
  for (const [k, t] of Object.entries(tiles)) {
    if (t.owner !== pid) continue;
    for (const n of neighbours(k)) {
      const nt = tiles[n];
      if (nt && !nt.owner && !nt.is_blocked) out.add(n);
    }
  }
  return [...out];
}

/** A one-claim resolution step, shaped like the server's. */
export function claimStep(tile: string, claims: { pid: string; power: number; from: string }[], opts: {
  defender?: string | null;
  defense?: number;
  defenderFrom?: string;
  winner: string | null;
  outcome?: ResolutionStep['outcome'];
  baseRaid?: boolean;
} = { winner: null }): ResolutionStep {
  const [q, r] = parseKey(tile);
  const defender = opts.defender ?? null;
  const dsrc = opts.defenderFrom ? parseKey(opts.defenderFrom) : undefined;
  return {
    tile_key: tile, q, r,
    contested: claims.length > 1 || !!defender,
    claimants: claims.map(c => {
      const [sq, sr] = parseKey(c.from);
      return { player_id: c.pid, power: c.power, source_q: sq, source_r: sr };
    }),
    defender_id: defender,
    defender_power: opts.defense ?? 0,
    defender_source_q: dsrc?.[0],
    defender_source_r: dsrc?.[1],
    winner_id: opts.winner,
    previous_owner: defender,
    outcome: opts.outcome ?? (opts.winner && opts.winner !== defender ? 'claimed' : 'defended'),
    is_base_raid: !!opts.baseRaid,
  };
}

/** A card a player gains on a tile as it resolves (Mercenary's Debt), shaped like the server's. */
export function cardGain(tile: string, pid: string, card: Card, source: string): ResolutionEffect {
  return { type: 'card', player_id: pid, by_player_id: pid, tile_key: tile, card_name: card.name, count: 1, card, vp_each: 0, source_card: source };
}

/** Defense landing on your own tile (Watchtower / Barricade). */
export function defenseStep(tile: string, pid: string, permanent: number, temporary: number): ResolutionStep {
  const [q, r] = parseKey(tile);
  return {
    tile_key: tile, q, r, contested: false,
    claimants: [{ player_id: pid, power: 0, source_q: null, source_r: null }],
    defender_id: pid, defender_power: permanent + temporary,
    winner_id: pid, previous_owner: pid, outcome: 'defense_applied',
    defense_permanent: permanent, defense_temporary: temporary,
  };
}
