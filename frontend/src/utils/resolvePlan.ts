import type { HexTile, ResolutionStep } from '../types/game';

/**
 * How each tile's fight plays out at the reveal, worked out up front from
 * the server's resolution steps and the cards on the board:
 *
 *   1. the defense builds up — the tile's standing defense, then each
 *      Defense card and each of the owner's own Claims on it;
 *   2. every attacker, weakest first, adds up their cards' power and
 *      smashes into whatever holds the tile: it breaks it (and holds the tile
 *      at its own power), bounces off, or ties another attacker (stalemate).
 *
 * The sequence agrees with the server's rules: a tie against a neutral
 * tile's own defense goes to the attacker, against an owner to the owner,
 * and between attackers to nobody (the tile doesn't change hands).
 */

/** A card on the board that takes part in a tile's resolution. */
export interface PlanCard {
  /** The board card's key (card id @ tile). */
  key: string;
  playerId: string;
  cardType: string;
  /** Effective claim power. */
  power: number;
  /** Defense bonus (Defense cards), used when the steps don't say. */
  defense: number;
  /** Still face down (an opponent's card): it turns over as it counts. */
  faceDown?: boolean;
}

/** One card's addition to a running number (null card: no card to show). */
export interface Beat {
  card: PlanCard | null;
  add: number;
  /** For the defense: this round only (blue), not a lasting fortification. */
  temp?: boolean;
}

/** How a claim meets what holds the tile: breaks it, bounces off, ties the
 *  claim in the lead, or — on an immune tile — just dinks off it. */
export type Clash = 'break' | 'bounce' | 'stalemate' | 'dink';

/** The tile a player holds nearest to (q, r) — where their claim comes from. */
function nearestOwned(tiles: Record<string, HexTile>, pid: string, q: number, r: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (const t of Object.values(tiles)) {
    if (t.owner !== pid) continue;
    const d = (Math.abs(t.q - q) + Math.abs(t.r - r) + Math.abs(t.q + t.r - q - r)) / 2;
    if (d < bestD) { bestD = d; best = [t.q, t.r]; }
  }
  return best;
}

export interface AttackPlan {
  playerId: string;
  total: number;
  beats: Beat[];
  /** Where the attack comes from (its nearest tile), if known. */
  sourceQ: number | null;
  sourceR: number | null;
  clash: Clash;
  /** What holds the tile after this clash, at what value. */
  holder: string | null;
  value: number;
}

export interface TilePlan {
  /** clash: claims; defense: only Defense cards; effect: a post-claim step
   *  (Consecrate, a Breakthrough spill-over). */
  kind: 'clash' | 'defense' | 'effect';
  tileKey: string;
  q: number;
  r: number;
  /** It involves the player (their card, their tile, or next to it): the
   *  camera closes in and every card counts up. Otherwise it's quick. */
  focus: boolean;
  /** Defense steps (applied once the defense has built up). */
  defenseSteps: number[];
  /** The claim / effect step (applied when the tile settles). */
  mainStep: number | null;
  /** Who held the tile going in (null: neutral). */
  holder: string | null;
  startPerm: number;
  startTemp: number;
  defenseBeats: Beat[];
  /** The defense the attackers face. */
  perm: number;
  temp: number;
  immune: boolean;
  attacks: AttackPlan[];
  /** Cards with nothing to add (e.g. a claim on an immune tile). */
  fizzles: PlanCard[];
  /** Anything else on the tile — it simply goes home at the end. */
  others: PlanCard[];
  /** Who holds the tile at the end (null: neutral / unchanged neutral). */
  winner: string | null;
  /** The tile changes hands (or, on a base, the raid succeeds). */
  captured: boolean;
  baseRaid: boolean;
  outcome: ResolutionStep['outcome'] | null;
}

const NEIGHBORS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Split `total` over cards by their own values; the last card absorbs any
 *  difference, and no running sum overshoots the total. */
function spread(total: number, cards: PlanCard[], valueOf: (c: PlanCard) => number, temp?: boolean): Beat[] {
  if (cards.length === 0) return total !== 0 ? [{ card: null, add: total, temp }] : [];
  let left = total;
  return cards.map((card, i) => {
    const last = i === cards.length - 1;
    const add = last ? left : Math.max(0, Math.min(left, valueOf(card)));
    left -= add;
    return { card, add, temp };
  });
}

/** Does this tile involve `me`? */
function involves(key: string, tiles: Record<string, HexTile>, cards: PlanCard[], me: string): boolean {
  if (cards.some(c => c.playerId === me)) return true;
  const t = tiles[key];
  if (!t) return false;
  if (t.owner === me) return true;
  return NEIGHBORS.some(([dq, dr]) => tiles[`${t.q + dq},${t.r + dr}`]?.owner === me);
}

/**
 * The attackers' clashes, weakest first, from what holds the tile going in.
 * Returns the holder at the end ('stalemate' when attackers tie on top).
 */
export function walkClashes(
  attacks: Omit<AttackPlan, 'clash' | 'holder' | 'value'>[],
  owner: string | null,
  defense: number,
): { attacks: AttackPlan[]; holder: string | null; stalemate: boolean } {
  type Holder = { kind: 'neutral' } | { kind: 'owner'; id: string } | { kind: 'attacker'; id: string } | { kind: 'stalemate' };
  let holder: Holder = owner ? { kind: 'owner', id: owner } : { kind: 'neutral' };
  let value = defense;
  const out: AttackPlan[] = [];
  for (const a of attacks) {
    let clash: Clash;
    if (a.total > value) clash = 'break';
    else if (a.total < value) clash = 'bounce';
    else if (holder.kind === 'neutral') clash = 'break';
    else if (holder.kind === 'owner') clash = 'bounce';
    else clash = 'stalemate';
    if (clash === 'break') { holder = { kind: 'attacker', id: a.playerId }; value = a.total; }
    if (clash === 'stalemate') holder = { kind: 'stalemate' };
    out.push({
      ...a, clash, value,
      holder: holder.kind === 'attacker' || holder.kind === 'owner' ? holder.id : holder.kind === 'stalemate' ? null : null,
    });
  }
  const stalemate = holder.kind === 'stalemate';
  const final = holder.kind === 'attacker' || holder.kind === 'owner' ? holder.id : owner;
  return { attacks: out, holder: stalemate ? owner : final, stalemate };
}

/**
 * Build the reveal's tile-by-tile plan.
 *
 * @param steps   the server's resolution steps
 * @param cards   the board cards on each tile (everyone's plays)
 * @param tiles   the board going into the reveal
 * @param me      the local player
 */
export function buildResolvePlans(
  steps: ResolutionStep[],
  cards: Map<string, PlanCard[]>,
  tiles: Record<string, HexTile>,
  me: string,
): TilePlan[] {
  const groups = new Map<string, { defense: number[]; claim: number | null }>();
  const effects: number[] = [];
  steps.forEach((s, i) => {
    if (s.outcome === 'consecrate' || s.outcome === 'auto_claim') { effects.push(i); return; }
    const g = groups.get(s.tile_key) ?? { defense: [], claim: null };
    if (s.outcome === 'defense_applied') g.defense.push(i);
    else g.claim = i;
    groups.set(s.tile_key, g);
  });

  const plans: TilePlan[] = [];
  const used = new Set<string>();

  for (const [key, g] of groups) {
    const claim = g.claim != null ? steps[g.claim] : null;
    const first = steps[g.claim ?? g.defense[0]];
    const t = tiles[key];
    const onTile = cards.get(key) ?? [];
    const holder = claim ? claim.previous_owner : (t?.owner ?? null);
    const startPerm = t ? t.base_defense + (t.permanent_defense_bonus ?? 0) : 0;
    const startTemp = t ? Math.max(0, t.defense_power - startPerm) : 0;

    // 1. Defense cards, matched to their defense steps in order of play.
    const defenseCards = onTile.filter(c => c.playerId === holder && c.cardType === 'defense');
    const defenseBeats: Beat[] = [];
    let perm = startPerm, temp = startTemp, immune = false;
    g.defense.forEach((idx, i) => {
      const s = steps[idx];
      const nextPerm = s.defense_permanent ?? perm;
      const nextTemp = s.defense_temporary ?? temp;
      const card = defenseCards[i] ?? null;
      if (nextPerm > perm) defenseBeats.push({ card, add: nextPerm - perm, temp: false });
      if (nextTemp > temp) defenseBeats.push({ card: nextPerm > perm ? null : card, add: nextTemp - temp, temp: true });
      if (nextPerm <= perm && nextTemp <= temp) defenseBeats.push({ card, add: 0 });
      perm = nextPerm;
      temp = nextTemp;
      if (s.defense_immunity) immune = true;
    });
    for (const c of defenseCards.slice(g.defense.length)) defenseBeats.push({ card: c, add: 0 });

    // …then the owner's own Claims on it, up to the defense the server used.
    const ownerClaims = holder ? onTile.filter(c => c.playerId === holder && c.cardType === 'claim') : [];
    let defense = perm + temp;
    if (claim) {
      const faced = holder || claim.outcome === 'defense_held' ? claim.defender_power : defense;
      const extra = Math.max(0, faced - defense);
      defenseBeats.push(...spread(extra, ownerClaims, c => c.power, true));
      temp += extra;
      if (faced < defense) {
        // Defense stripped (e.g. siege ignores this round's bonuses).
        temp = Math.max(0, faced - perm);
        perm = Math.min(perm, faced);
      }
      defense = faced;
    } else {
      defenseBeats.push(...ownerClaims.map(card => ({ card, add: 0 })));
    }

    // 2. Attackers, weakest first.
    const seen = new Set<string>();
    const raw = (claim?.claimants ?? []).filter(c => {
      if (c.player_id === holder || seen.has(c.player_id)) return false;
      seen.add(c.player_id);
      return true;
    }).map((c, order) => ({ c, order }))
      .sort((a, b) => a.c.power - b.c.power || a.order - b.order)
      .map(({ c }) => ({
        playerId: c.player_id,
        total: c.power,
        beats: spread(c.power, onTile.filter(x => x.playerId === c.player_id && x.cardType === 'claim'), x => x.power),
        sourceQ: c.source_q,
        sourceR: c.source_r,
      }));
    let walk = walkClashes(raw, holder, defense);

    // Trust the server's verdict if the walk ever disagrees.
    if (claim) {
      const serverHolder = claim.outcome === 'tie' || claim.outcome === 'defense_held' ? claim.previous_owner : claim.winner_id;
      if (walk.holder !== serverHolder || (claim.outcome === 'tie') !== walk.stalemate) {
        let value = defense;
        const fixed = walk.attacks.map((a): AttackPlan => {
          const wins = a.playerId === claim.winner_id && claim.outcome === 'claimed';
          const tied = claim.outcome === 'tie' && a.total >= Math.max(...walk.attacks.map(x => x.total));
          if (wins) value = a.total;
          return { ...a, clash: wins ? 'break' : tied ? 'stalemate' : 'bounce', value, holder: wins ? a.playerId : a.holder };
        });
        walk = { attacks: fixed, holder: serverHolder, stalemate: claim.outcome === 'tie' };
      }
    }

    const inPlay = new Set<string>([
      ...defenseBeats.flatMap(b => (b.card ? [b.card.key] : [])),
      ...walk.attacks.flatMap(a => a.beats.flatMap(b => (b.card ? [b.card.key] : []))),
    ]);
    const attackers = new Set(walk.attacks.map(a => a.playerId));
    let fizzles = onTile.filter(c => !inPlay.has(c.key) && c.cardType === 'claim' && c.playerId !== holder && !attackers.has(c.playerId));
    const others = onTile.filter(c => !inPlay.has(c.key) && !fizzles.includes(c));
    // An immune tile turns every claim away, whatever its power: each
    // claimer still counts up — then just dinks off the defense.
    if (immune && fizzles.length) {
      const byPlayer = new Map<string, PlanCard[]>();
      for (const c of fizzles) byPlayer.set(c.playerId, [...(byPlayer.get(c.playerId) ?? []), c]);
      const dinks = [...byPlayer].map(([playerId, list]): AttackPlan => {
        const total = list.reduce((n, c) => n + Math.max(0, c.power), 0);
        const src = nearestOwned(tiles, playerId, first.q, first.r);
        return {
          playerId, total, beats: list.map(card => ({ card, add: Math.max(0, card.power) })),
          sourceQ: src?.[0] ?? null, sourceR: src?.[1] ?? null, clash: 'dink', holder, value: defense,
        };
      }).sort((a, b) => a.total - b.total);
      walk = { ...walk, attacks: [...walk.attacks, ...dinks] };
      fizzles = [];
    }
    onTile.forEach(c => used.add(c.key));

    plans.push({
      kind: claim ? 'clash' : 'defense',
      tileKey: key, q: first.q, r: first.r,
      focus: involves(key, tiles, onTile, me),
      defenseSteps: g.defense,
      mainStep: g.claim,
      holder, startPerm, startTemp, defenseBeats, perm, temp, immune,
      attacks: walk.attacks,
      fizzles, others,
      winner: walk.holder,
      captured: !!claim && walk.holder !== holder && !walk.stalemate,
      baseRaid: !!claim?.is_base_raid,
      outcome: claim?.outcome ?? null,
    });
  }

  // Post-claim effects come last, in the server's order.
  for (const idx of effects) {
    const s = steps[idx];
    const t = tiles[s.tile_key];
    const onTile = (cards.get(s.tile_key) ?? []).filter(c => !used.has(c.key));
    onTile.forEach(c => used.add(c.key));
    const perm = t ? t.base_defense + (t.permanent_defense_bonus ?? 0) : 0;
    plans.push({
      kind: 'effect', tileKey: s.tile_key, q: s.q, r: s.r,
      focus: false,
      defenseSteps: [], mainStep: idx,
      holder: t?.owner ?? null, startPerm: perm, startTemp: 0, defenseBeats: [], perm, temp: 0, immune: false,
      attacks: [], fizzles: [], others: onTile,
      winner: s.winner_id, captured: s.outcome === 'auto_claim', baseRaid: false, outcome: s.outcome,
    });
  }
  return plans;
}
