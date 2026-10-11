import type { HexTile, SoloArchetypeCampaign, SoloCampaigns } from '../../types/game';

/**
 * Solo campaign progress, kept per browser in localStorage: each archetype's
 * campaign separately (a shared level cleared as Vanguard is still to do as
 * Fortress). Every access is guarded: with storage blocked (private mode,
 * quota, previews) the campaigns still play — they just don't remember
 * between visits.
 *
 * Levels unlock in path order: a level is open once every level before it
 * in its campaign is cleared. The overworld's territory covers the road up
 * to the next level (see territoryKeys).
 */

const KEY = 'cardclash_solo_progress';

export interface LevelClear {
  /** Round the objective was met in (best so far). */
  round: number;
  /** When it was first cleared (ms since epoch). */
  at: number;
}

export interface CampaignProgress {
  cleared: Record<string, LevelClear>;
  /** How many levels the overworld last showed cleared: it grows the
   *  territory for the rest when it next opens. */
  shown: number;
}

export interface SoloProgress {
  campaigns: Record<string, CampaignProgress>;
  /** The campaign last chosen. */
  last?: string;
}

const EMPTY_CAMPAIGN: CampaignProgress = { cleared: {}, shown: 0 };

function campaignOf(data: unknown): CampaignProgress {
  const c = (data ?? {}) as Partial<CampaignProgress>;
  return {
    cleared: c.cleared && typeof c.cleared === 'object' ? c.cleared : {},
    shown: typeof c.shown === 'number' ? c.shown : 0,
  };
}

export function loadProgress(): SoloProgress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { campaigns: {} };
    const data = JSON.parse(raw) as Partial<SoloProgress>;
    const campaigns: Record<string, CampaignProgress> = {};
    // (Saves from before the three campaigns had no `campaigns`: they start over.)
    for (const [arch, c] of Object.entries(data.campaigns ?? {})) campaigns[arch] = campaignOf(c);
    return { campaigns, last: typeof data.last === 'string' ? data.last : undefined };
  } catch {
    return { campaigns: {} };
  }
}

export function saveProgress(progress: SoloProgress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch { /* storage unavailable: progress lasts this visit only */ }
}

export function campaignProgress(progress: SoloProgress, archetype: string): CampaignProgress {
  return progress.campaigns[archetype] ?? { ...EMPTY_CAMPAIGN, cleared: {} };
}

function update(archetype: string, change: (c: CampaignProgress) => void): SoloProgress {
  const progress = loadProgress();
  const c = campaignProgress(progress, archetype);
  change(c);
  progress.campaigns[archetype] = c;
  saveProgress(progress);
  return progress;
}

/** Record a cleared level in its campaign (keeping the best round) and save. */
export function recordClear(archetype: string, levelId: string, round: number, now = Date.now()): SoloProgress {
  return update(archetype, c => {
    const prev = c.cleared[levelId];
    c.cleared[levelId] = prev ? { ...prev, round: Math.min(prev.round, round) } : { round, at: now };
  });
}

export function markShown(archetype: string, shown: number): void {
  if (campaignProgress(loadProgress(), archetype).shown === shown) return;
  update(archetype, c => { c.shown = shown; });
}

/** Remember the campaign chosen last (the selection screen leads with it). */
export function chooseCampaign(archetype: string): void {
  const progress = loadProgress();
  if (progress.last === archetype) return;
  progress.last = archetype;
  saveProgress(progress);
}

/** Levels cleared in a row from the first: the frontier is the next one. */
export function frontier(levelIds: string[], progress: CampaignProgress): number {
  let n = 0;
  while (n < levelIds.length && progress.cleared[levelIds[n]]) n++;
  return n;
}

export type LevelState = 'cleared' | 'open' | 'locked' | 'soon';

/** A stop's state: cleared, open (unlocked, not cleared), locked, or a spot
 *  past the last level ("soon"). */
export function spotState(index: number, levelIds: string[], progress: CampaignProgress): LevelState {
  if (index >= levelIds.length) return 'soon';
  if (progress.cleared[levelIds[index]]) return 'cleared';
  return index <= frontier(levelIds, progress) ? 'open' : 'locked';
}

type Roads = Pick<SoloArchetypeCampaign, 'castle' | 'segments'>;

/** The road you've built with `cleared` levels behind you, castle first —
 *  each step to a neighbouring tile (a tile two roads share appears twice):
 *  each cleared level's road (ending on its spot), then the road on to the
 *  next stop, stopping beside it. */
export function roadChain(c: Roads, cleared: number): string[] {
  const out = [c.castle];
  const done = Math.min(cleared, c.segments.length);
  for (let i = 0; i < done; i++) out.push(...c.segments[i]);
  const next = c.segments[done];
  if (next) out.push(...next.slice(0, -1));
  return out;
}

/** The overworld land you hold, in the order it was won (no repeats). */
export function territoryKeys(c: Roads, cleared: number): string[] {
  return [...new Set(roadChain(c, cleared))];
}

export const SOLO_PLAYER_ID = 'player_0';

/** The overworld as board tiles for one campaign: its castle, its spots as
 *  towns, `owned` keys yours. Other campaigns' castles and spots are plain
 *  land here. */
export function overworldTiles(
  ow: SoloCampaigns['overworld'], c: Pick<SoloArchetypeCampaign, 'castle' | 'spots' | 'soon'>, owned: Iterable<string>,
): Record<string, HexTile> {
  const mine = new Set(owned);
  const towns = new Set([...c.spots, ...c.soon]);
  const tiles: Record<string, HexTile> = {};
  for (const [key, t] of Object.entries(ow.tiles)) {
    const castle = key === c.castle;
    tiles[key] = {
      q: t.q, r: t.r, is_blocked: t.blocked, is_vp: towns.has(key), vp_value: 1,
      ...(t.scorched ? { is_scorched: true } : {}), ...(t.water ? { is_water: true } : {}),
      owner: mine.has(key) || castle ? SOLO_PLAYER_ID : null,
      defense_power: 0, base_defense: 0, permanent_defense_bonus: 0,
      held_since_turn: null, is_base: castle, base_owner: castle ? SOLO_PLAYER_ID : null,
    };
  }
  return tiles;
}

/** Points for the board's road renderer (far end first, castle last). */
export function roadPoints(ow: SoloCampaigns['overworld'], chain: string[]): [number, number][] {
  return chain
    .map(k => ow.tiles[k])
    .filter(Boolean)
    .map(t => [t.q, t.r] as [number, number])
    .reverse();
}
