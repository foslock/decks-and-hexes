import type { HexTile, ResolutionClaimant, ResolutionEffect, ResolutionStep } from '../types/game';

/**
 * How each tile's fight plays out at the reveal, worked out up front from
 * the server's resolution steps and the cards on the board:
 *
 *   1. the defense builds up — the tile's standing defense, then each
 *      Defense card and each of the owner's own Claims on it;
 *   2. every attacker, weakest first, adds up their cards' power and
 *      smashes into whatever holds the tile: it breaks it (and holds the tile
 *      at its own power), bounces off, or ties another attacker (stalemate).
 *      Claims that ignore this round's defense bonuses (Siege Engine,
 *      Conqueror) come last: the bonuses crack off for them alone. A card's
 *      reveal-time bonus (Ambush, Strike Team, Dog Pile…) counts as its own
 *      labelled beat;
 *   3. what card effects did there (ResolutionEffect): coins, VP, cards
 *      gained or trashed — after the tile settles. Flood's spread plays
 *      before the tiles it reaches, and effects with no tile of their own
 *      (Diplomat, Battle Glory) play last, from their player's base.
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
  /** The card's id (matches the server's claim breakdown and effects). */
  cardId?: string;
}

/** One card's addition to a running number (null card: no card to show). */
export interface Beat {
  card: PlanCard | null;
  add: number;
  /** For the defense: this round only (blue), not a lasting fortification. */
  temp?: boolean;
  /** A reveal-time bonus, named for what gave it ("Ambush", "Dog Pile"). */
  label?: string;
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
  /** Its claim ignores this round's defense bonuses (Siege Engine / Conqueror). */
  ignores?: boolean;
  /** The bonuses crack off just before this claim lands (the first claim
   *  that ignores them while the tile's own defense still holds). */
  crack?: boolean;
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
  /** Temporary defense that some claims ignore (Siege Engine / Conqueror)
   *  and whose they are: it cracks off just before the first of them lands
   *  (they attack after everyone else, who face it in full). */
  ignored: number;
  ignoredBy: string[];
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
  /** effect plans: 'flood' — Flood spreading out to `targets`; 'round' —
   *  effects with no tile of their own, played from a player's base. */
  outcome: ResolutionStep['outcome'] | 'flood' | 'round' | null;
  /** What card effects did here, played after the tile settles. */
  after: ResolutionEffect[];
  /** Cards that burn here (Spoils of War) instead of going home as they count. */
  burn: string[];
  /** Flood: the tiles the water reaches. */
  targets?: string[];
  /** Breakthrough: where the auto-claim comes from, and the card's name. */
  source?: { q: number; r: number } | null;
  cardName?: string;
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

/** A claimant's beats: each card's printed power, then each bonus it gets
 *  at the reveal as a beat of its own, named for what gave it. Without the
 *  server's breakdown, the total spreads over the cards by their power.
 *  Either way the beats add up to the claim's power. */
function claimBeats(c: ResolutionClaimant, onTile: PlanCard[]): Beat[] {
  const mine = onTile.filter(x => x.playerId === c.player_id && x.cardType === 'claim');
  if (!c.cards?.length) return spread(c.power, mine, x => x.power);
  const left = [...mine];
  const beats: Beat[] = [];
  for (const entry of c.cards) {
    const i = left.findIndex(x => x.cardId === entry.card_id);
    const card = i >= 0 ? left.splice(i, 1)[0] : null;
    beats.push({ card, add: entry.power });
    for (const b of entry.bonuses) if (b.amount) beats.push({ card, add: b.amount, label: b.source });
  }
  // Cards the breakdown didn't name still turn over (and add nothing).
  for (const card of left) beats.push({ card, add: 0 });
  const diff = c.power - beats.reduce((n, b) => n + b.add, 0);
  if (diff) {
    const last = [...beats].reverse().find(b => !b.label);
    if (last) last.add += diff; else beats.push({ card: null, add: diff });
  }
  return beats;
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
 * The attackers' clashes, in order, from what holds the tile going in.
 * Returns the holder at the end ('stalemate' when attackers tie on top).
 *
 * Claims that ignore `ignored` of the defense (`ignores`) must come after the
 * rest: they face the tile's defense less that, everyone else faces it whole.
 */
export function walkClashes(
  attacks: Omit<AttackPlan, 'clash' | 'holder' | 'value'>[],
  owner: string | null,
  defense: number,
  ignored = 0,
): { attacks: AttackPlan[]; holder: string | null; stalemate: boolean } {
  type Holder = { kind: 'neutral' } | { kind: 'owner'; id: string } | { kind: 'attacker'; id: string } | { kind: 'stalemate' };
  let holder: Holder = owner ? { kind: 'owner', id: owner } : { kind: 'neutral' };
  let value = defense;
  let cracked = false;
  const out: AttackPlan[] = [];
  for (const a of attacks) {
    let clash: Clash;
    // The tile's own defense still holds: the bonuses crack off for this claim.
    const crack = !!a.ignores && ignored > 0 && !cracked && (holder.kind === 'owner' || holder.kind === 'neutral');
    if (crack) { value = Math.max(0, defense - ignored); cracked = true; }
    if (a.total > value) clash = 'break';
    else if (a.total < value) clash = 'bounce';
    else if (holder.kind === 'neutral') clash = 'break';
    else if (holder.kind === 'owner') clash = 'bounce';
    else clash = 'stalemate';
    if (clash === 'break') { holder = { kind: 'attacker', id: a.playerId }; value = a.total; }
    if (clash === 'stalemate') holder = { kind: 'stalemate' };
    out.push({
      ...a, clash, value, ...(crack ? { crack } : {}),
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
/**
 * Each card's place in the order the resolve turns cards over (and counts
 * them): per tile, the defense, then claims that fizzle (an immune tile), then
 * each attack in turn (weakest first, card by card), then the rest. A tile's
 * cards line up left to right in this order, so the player can follow along.
 */
export function revealOrder(plans: TilePlan[]): Map<string, number> {
  const order = new Map<string, number>();
  const add = (c: PlanCard | null | undefined) => { if (c && !order.has(c.key)) order.set(c.key, order.size); };
  for (const p of plans) {
    p.defenseBeats.forEach(b => add(b.card));
    p.fizzles.forEach(add);
    p.attacks.forEach(a => a.beats.forEach(b => add(b.card)));
    p.others.forEach(add);
  }
  return order;
}

/** Sort a tile's cards into reveal order (cards the plan doesn't name keep their places, last). */
export function sortByReveal<T extends { key: string }>(cards: T[], order: Map<string, number>): T[] {
  const rank = (c: T) => order.get(c.key) ?? Number.MAX_SAFE_INTEGER;
  return [...cards].sort((a, b) => rank(a) - rank(b));
}

export function buildResolvePlans(
  steps: ResolutionStep[],
  cards: Map<string, PlanCard[]>,
  tiles: Record<string, HexTile>,
  me: string,
  effects: ResolutionEffect[] = [],
): TilePlan[] {
  const groups = new Map<string, { defense: number[]; claim: number | null }>();
  const postSteps: number[] = [];
  /** Exodus / Scorched Retreat: tiles given up before anything else resolves. */
  const givenUp: number[] = [];
  steps.forEach((s, i) => {
    if (s.outcome === 'abandon' || s.outcome === 'scorch') { givenUp.push(i); return; }
    if (s.outcome === 'consecrate' || s.outcome === 'auto_claim') { postSteps.push(i); return; }
    const g = groups.get(s.tile_key) ?? { defense: [], claim: null };
    if (s.outcome === 'defense_applied') g.defense.push(i);
    else g.claim = i;
    groups.set(s.tile_key, g);
  });

  const plans: TilePlan[] = [];
  const used = new Set<string>();

  // Tiles given up come first: the server resolves them before defenses and
  // claims. Scorched: the server cancels every claim on the tile, so they all
  // turn over with the card and go home unresolved. Exodus: only the giver's
  // own card shows here; claims on the now-empty tile resolve after.
  for (const idx of givenUp) {
    const s = steps[idx];
    const t = tiles[s.tile_key];
    const mine = (cards.get(s.tile_key) ?? []).filter(c => !used.has(c.key)
      && (s.outcome === 'scorch' || (c.playerId === s.previous_owner && c.cardType !== 'claim')));
    mine.forEach(c => used.add(c.key));
    const perm = t ? t.base_defense + (t.permanent_defense_bonus ?? 0) : 0;
    plans.push({
      kind: 'effect', tileKey: s.tile_key, q: s.q, r: s.r,
      focus: involves(s.tile_key, tiles, mine, me),
      defenseSteps: [], mainStep: idx,
      holder: s.previous_owner, startPerm: perm, startTemp: 0, defenseBeats: [], perm, temp: 0, immune: false, ignored: 0, ignoredBy: [],
      attacks: [], fizzles: [], others: mine,
      winner: null, captured: false, baseRaid: false, outcome: s.outcome, after: [], burn: [],
    });
  }

  // Flood: the card sits on the tile it floods from (no claim there).
  const floods = effects.filter(e => e.type === 'flood' && e.tile_key);
  const floodPlans = floods.map((e): TilePlan => {
    const key = e.tile_key as string;
    const t = tiles[key];
    const [q, r] = key.split(',').map(Number);
    const own = (cards.get(key) ?? []).filter(c => !used.has(c.key) && c.playerId === e.player_id
      && (e.card_id ? c.cardId === e.card_id : c.cardType === 'claim'));
    own.forEach(c => used.add(c.key));
    const perm = t ? t.base_defense + (t.permanent_defense_bonus ?? 0) : 0;
    return {
      kind: 'effect', tileKey: key, q, r,
      focus: e.player_id === me || (e.targets ?? []).some(k => involves(k, tiles, [], me)),
      defenseSteps: [], mainStep: null,
      holder: t?.owner ?? null, startPerm: perm, startTemp: 0, defenseBeats: [], perm, temp: 0, immune: false, ignored: 0, ignoredBy: [],
      attacks: [], fizzles: [], others: own,
      winner: null, captured: false, baseRaid: false, outcome: 'flood', after: [], burn: [], targets: e.targets ?? [],
    };
  });

  for (const [key, g] of groups) {
    const claim = g.claim != null ? steps[g.claim] : null;
    const first = steps[g.claim ?? g.defense[0]];
    const t = tiles[key];
    const onTile = (cards.get(key) ?? []).filter(c => !used.has(c.key));
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
    // Bonuses that Siege Engine / Conqueror claims skip (only theirs).
    const ignored = claim?.defense_ignored ?? 0;
    const ignoredBy = new Set(claim?.ignored_by ?? []);
    if (claim) {
      const faced = holder || claim.outcome === 'defense_held' ? claim.defender_power : defense;
      const extra = Math.max(0, faced - defense);
      defenseBeats.push(...spread(extra, ownerClaims, c => c.power, true));
      temp += extra;
      if (faced < defense) {
        // Less defense than the tile showed: trust the server's number.
        temp = Math.max(0, faced - perm);
        perm = Math.min(perm, faced);
      }
      defense = faced;
    } else {
      defenseBeats.push(...ownerClaims.map(card => ({ card, add: 0 })));
    }

    // 2. Attackers, weakest first — those ignoring the bonuses after the rest.
    const seen = new Set<string>();
    const skips = (pid: string) => ignored > 0 && ignoredBy.has(pid);
    const raw = (claim?.claimants ?? []).filter(c => {
      if (c.player_id === holder || seen.has(c.player_id)) return false;
      seen.add(c.player_id);
      return true;
    }).map((c, order) => ({ c, order }))
      .sort((a, b) => Number(skips(a.c.player_id)) - Number(skips(b.c.player_id)) || a.c.power - b.c.power || a.order - b.order)
      .map(({ c }) => ({
        playerId: c.player_id,
        total: c.power,
        beats: claimBeats(c, onTile),
        sourceQ: c.source_q,
        sourceR: c.source_r,
        ...(skips(c.player_id) ? { ignores: true } : {}),
      }));
    let walk = walkClashes(raw, holder, defense, ignored);

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
      ignored, ignoredBy: [...ignoredBy],
      attacks: walk.attacks,
      fizzles, others,
      winner: walk.holder,
      captured: !!claim && walk.holder !== holder && !walk.stalemate,
      baseRaid: !!claim?.is_base_raid,
      outcome: claim?.outcome ?? null,
      after: [], burn: [],
    });
  }

  // Post-claim effects come last, in the server's order.
  for (const idx of postSteps) {
    const s = steps[idx];
    const t = tiles[s.tile_key];
    const onTile = (cards.get(s.tile_key) ?? []).filter(c => !used.has(c.key));
    onTile.forEach(c => used.add(c.key));
    const perm = t ? t.base_defense + (t.permanent_defense_bonus ?? 0) : 0;
    const src = s.claimants[0];
    plans.push({
      kind: 'effect', tileKey: s.tile_key, q: s.q, r: s.r,
      // Breakthrough's bonus tile: close in when it's yours (or by you).
      focus: s.outcome === 'auto_claim' && (s.winner_id === me || involves(s.tile_key, tiles, onTile, me)),
      defenseSteps: [], mainStep: idx,
      holder: t?.owner ?? null, startPerm: perm, startTemp: 0, defenseBeats: [], perm, temp: 0, immune: false, ignored: 0, ignoredBy: [],
      attacks: [], fizzles: [], others: onTile,
      winner: s.winner_id, captured: s.outcome === 'auto_claim', baseRaid: false, outcome: s.outcome, after: [], burn: [],
      source: src?.source_q != null && src.source_r != null ? { q: src.source_q, r: src.source_r } : null,
      cardName: s.card_name,
    });
  }

  // Flood spreads just before the tiles it reaches resolve (they follow it).
  for (const fp of floodPlans) {
    const reached = new Set(fp.targets);
    const followers = plans.filter(p => p.kind !== 'effect' && reached.has(p.tileKey));
    const rest = plans.filter(p => !followers.includes(p));
    // In place of the first tile it reaches (else after the tiles given up).
    const at = followers.length ? plans.indexOf(followers[0])
      : plans.filter(p => p.outcome === 'abandon' || p.outcome === 'scorch').length;
    plans.splice(0, plans.length, ...rest.slice(0, at), fp, ...followers, ...rest.slice(at));
  }

  // What card effects did, on the tile where it happened (its main plan),
  // or — with no tile, or none resolving — last, from the player's base.
  const homeless = new Map<string, ResolutionEffect[]>();
  for (const e of effects) {
    if (e.type === 'flood') continue;
    const onKey = e.tile_key ? plans.filter(p => p.tileKey === e.tile_key && p.outcome !== 'flood') : [];
    const host = onKey.find(p => p.kind !== 'effect') ?? onKey[onKey.length - 1];
    if (host) {
      host.after.push(e);
      if (e.type === 'trash' && e.card_id) {
        const victim = (cards.get(host.tileKey) ?? []).find(c => c.cardId === e.card_id && c.playerId === e.player_id);
        if (victim) host.burn.push(victim.key);
      }
      if (e.player_id === me && (e.type !== 'trash')) host.focus = host.focus || host.kind !== 'effect';
      continue;
    }
    const by = e.by_player_id ?? e.player_id;
    homeless.set(by, [...(homeless.get(by) ?? []), e]);
  }
  for (const [by, list] of homeless) {
    const base = Object.values(tiles).find(t => t.is_base && t.base_owner === by)
      ?? Object.values(tiles).find(t => t.owner === by);
    plans.push({
      kind: 'effect', tileKey: base ? `${base.q},${base.r}` : '', q: base?.q ?? 0, r: base?.r ?? 0,
      focus: false,
      defenseSteps: [], mainStep: null,
      holder: by, startPerm: 0, startTemp: 0, defenseBeats: [], perm: 0, temp: 0, immune: false, ignored: 0, ignoredBy: [],
      attacks: [], fizzles: [], others: [],
      winner: null, captured: false, baseRaid: false, outcome: 'round', after: list, burn: [],
    });
  }
  return plans;
}

/** A tile as a resolution step leaves it: its new owner, Consecrate's VP,
 *  the defense it was given, or given up (Exodus) / burnt to a wasteland
 *  (Scorched Retreat). Base tiles never change hands on a successful claim
 *  (the raid deals Rubble / Spoils instead). */
export function tileAfterStep(tile: HexTile, step: ResolutionStep): HexTile {
  if (step.outcome === 'abandon') {
    return { ...tile, owner: null, held_since_turn: null, defense_power: tile.base_defense, permanent_defense_bonus: 0 };
  }
  if (step.outcome === 'scorch') {
    return {
      ...tile, owner: null, held_since_turn: null, is_blocked: true, is_scorched: true,
      scorched_vp: step.vp_value ?? 0, is_vp: false, vp_value: 0, defense_power: 0, permanent_defense_bonus: 0,
    };
  }
  if (step.winner_id && (step.outcome === 'claimed' || step.outcome === 'auto_claim') && !tile.is_base) {
    // A capture knocks the walls down: defense back to the tile's own (as the
    // server does), so walls and barriers fall as it changes hands.
    if (step.winner_id !== tile.owner) {
      return { ...tile, owner: step.winner_id, defense_power: tile.base_defense, permanent_defense_bonus: 0 };
    }
    return { ...tile, owner: step.winner_id };
  }
  if (step.outcome === 'consecrate' && step.vp_value != null) return { ...tile, vp_value: step.vp_value };
  if (step.outcome === 'defense_applied') {
    const permDef = step.defense_permanent ?? 0;
    const tempDef = step.defense_temporary ?? 0;
    return {
      ...tile,
      defense_power: permDef + tempDef,
      permanent_defense_bonus: permDef - tile.base_defense,
      ...(step.defense_immunity ? { immune: true } : {}),
    };
  }
  return tile;
}
