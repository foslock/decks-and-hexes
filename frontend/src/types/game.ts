export interface HexTile {
  q: number;
  r: number;
  is_blocked: boolean;
  is_vp: boolean;
  vp_value: number;  // 1 = standard, 2 = premium
  owner: string | null;
  defense_power: number;
  base_defense: number;
  permanent_defense_bonus: number;
  held_since_turn: number | null;
  is_base: boolean;
  base_owner: string | null;
  /** Scorched Retreat: burnt to a wasteland (also blocked) for the rest of the match. */
  is_scorched?: boolean;
  /** The VP value a scorched tile had (its town's ruins are drawn). */
  scorched_vp?: number;
  /** Water (solo maps): a lake or inlet nobody can claim (also blocked),
   *  drawn as sea with beaches on the land around it. */
  is_water?: boolean;
  immune?: boolean;  // tile has claim immunity this round (Iron Wall / Stronghold)
}

export interface Card {
  // Per-instance identifier. Unique across all cards in a game session so
  // individual copies can be tracked (e.g. when picking a target). Not
  // stable across a card's definition — use `definition_id` for identity.
  id: string;
  // Stable identifier for the card *definition*. Identical across every
  // copy of the card. Use this for identity-based logic/lookups.
  definition_id: string;
  name: string;
  archetype: string;
  card_type: string;
  power: number;
  resource_gain: number;
  action_return: number;
  action_cost: number;
  timing: string;
  buy_cost: number | null;
  is_upgraded: boolean;
  trash_on_use: boolean;
  trash_immune?: boolean;
  stackable: boolean;
  granted_stackable?: boolean;
  reversible?: boolean;
  forced_discard: number;
  draw_cards: number;
  defense_bonus: number;
  adjacency_required: boolean;
  claim_range: number;
  unoccupied_only: boolean;
  /** "core" cards make up the card packs; "set_aside" ones wait for future sets. */
  card_set?: string;
  /** Explore: only a tile nobody owns with no defense (it has no power). */
  defenseless_only?: boolean;
  multi_target_count: number;
  defense_target_count: number;
  flood: boolean;
  target_own_tile: boolean;
  passive_vp: number;
  vp_formula?: string;
  unique?: boolean;
  /** Debt cards added to the buyer's discard pile when bought (Warden, Land Grant). */
  buy_debt?: number;
  /** Can't be played from hand (Land Grant, Spoils, Rubble). */
  unplayable?: boolean;
  current_vp?: number;
  description: string;
  upgrade_description?: string;
  name_upgraded?: string;
  starter: boolean;
  effects?: {
    type: string; condition: string; value: number; upgraded_value?: number; target?: string; timing?: string;
    condition_threshold?: number; duration?: number; requires_choice?: boolean; metadata?: Record<string, unknown>;
  }[];
  upgraded_stats?: {
    power?: number;
    resource_gain?: number;
    action_return?: number;
    draw_cards?: number;
    forced_discard?: number;
    defense_bonus?: number;
    multi_target_count?: number;
    defense_target_count?: number;
  };
}

export interface ArchetypeSupplyEntry {
  card: Card;
  /** Copies left in this private pile (including the one on sale). */
  remaining: number;
  /** On sale right now (false once bought this round, or sold out). */
  available: boolean;
}

export interface PlannedAction {
  card: Card;
  target_q: number | null;
  target_r: number | null;
  target_player_id: string | null;
  extra_targets?: [number, number][];
  /** Computed effective power at resolve time (accounts for hand size, tile count, etc.) */
  effective_power?: number;
  /** Dynamic resource gain snapshotted at play time (e.g. War Tithe) */
  effective_resource_gain?: number;
  /** Dynamic draw count snapshotted at play time (e.g. Financier: draw per Debt) */
  effective_draw_cards?: number;
  /** War Banner: the claim_buff consumed by this Claim. When multiple War
   *  Banners stack onto a single Claim, power_bonus/draw_on_success are
   *  aggregated and source_card_ids lists every contributing banner. The
   *  singular source_card_id is retained (first consumed) for back-compat. */
  consumed_claim_buff?: {
    power_bonus: number;
    draw_on_success?: number;
    source_card_id?: string;
    source_card_ids?: string[];
  };
}

export type SearchZoneSource = 'discard' | 'draw' | 'trash';
export type SearchZoneTarget = 'hand' | 'top_of_draw' | 'discard' | 'trash';

/** Deferred tutor/search state — player must pick cards from a pile. */
export interface PendingSearch {
  source: SearchZoneSource;
  count: number;           // max cards to pick
  min_count: number;       // min cards to pick (0 = optional)
  allowed_targets: SearchZoneTarget[];
  card_filter?: { card_type?: string; name?: string } | null;
  /** Stable order of eligible cards at the time the search was triggered. */
  snapshot_card_ids: string[];
  /** True when the snapshot covers the entire source pile (peek_all metadata).
   *  Lets the frontend decide whether opening the modal leaks new info: a
   *  whole-pile peek shows only the SET (order is shuffled) which players can
   *  already infer from public state, so cancellation stays allowed. A
   *  partial peek leaks specific upcoming cards and must commit. */
  peek_all?: boolean;
}

export interface Player {
  id: string;
  name: string;
  archetype: string;
  color: string;
  hand: Card[];
  hand_count: number;
  resources: number;
  vp: number;
  actions_used: number;
  actions_available: number;
  archetype_market: Card[];
  /** Pack games: the market is the pack's whole archetype supply (no re-roll). */
  archetype_market_fixed?: boolean;
  /** Pack games: every archetype pile, bought out or not, in pack order. */
  archetype_supply?: ArchetypeSupplyEntry[];
  upgrade_credits: number;
  deck_size: number;
  discard_count: number;
  discard: Card[];
  deck_cards: Card[];
  planned_action_count: number;
  planned_actions: PlannedAction[];
  has_submitted_play: boolean;
  has_acknowledged_resolve: boolean;
  has_ended_turn: boolean;
  effective_buy_costs?: Record<string, number>;
  effective_reroll_cost?: number;
  effective_upgrade_credit_cost?: number;
  trash: Card[];
  rubble_count: number;
  claims_won_last_round: number;
  tiles_lost_last_round: number;
  tiles_captured_from_opponents_last_round: number;
  tile_count: number;
  is_cpu: boolean;
  cpu_difficulty: 'easy' | 'medium' | 'hard' | null;
  has_left: boolean;
  free_rerolls: number;
  buy_locked: boolean;
  /** War Banner: queued +power bonuses the next Claim(s) will consume.
   *  source_card_id ties each buff back to the originating War Banner card
   *  instance so the UI can pulse a specific War Banner in the In Play list
   *  while its buff is still unconsumed. */
  claim_buffs?: { power_bonus: number; draw_on_success?: number; source_card_id?: string }[];
  pending_discard: number;
  pending_search?: PendingSearch | null;
}

export interface SearchSelection {
  card_id: string;
  target: SearchZoneTarget;
}

export interface MarketStack {
  card: Card;
  remaining: number;
  selling_out?: boolean;
  selling_out_bought_by?: string[];
}

export interface CursorPosition {
  player_id: string;
  player_name: string;
  player_color: string;
  hovered_card_id: string | null;
  source: string | null;
}

export interface SharedPurchaseEvent {
  player_id: string;
  player_name: string;
  player_color: string;
  card_id: string;
  card_name: string;
  card: Card;
  isSelf?: boolean;
}

export interface ResolutionClaimant {
  player_id: string;
  power: number;
  source_q: number | null;
  source_r: number | null;
  /** Each of the player's claim cards on the tile: its printed power and what
   *  the reveal adds to it (Ambush, Battering Ram, Strike Team, Dog Pile…). */
  cards?: ResolutionClaimCard[];
}

export interface ResolutionClaimCard {
  card_id: string;
  name: string;
  power: number;
  bonuses: { source: string; amount: number }[];
}

/**
 * Something a card effect changed as the reveal resolved, on the tile it
 * happened on (null: no tile — e.g. Diplomat, Battle Glory):
 *  - resources: a bank gained (Scorched Retreat) or lost (Rapid Assault) `amount`;
 *  - vp: a player's card VP went up by `amount` (Battle Glory);
 *  - card: `count` copies of `card` joined the player's deck (Debt, Land
 *    Grant, Spoils, Rubble), worth `vp_each` VP apiece;
 *  - trash: the player's card `card_id` on the tile was trashed (Spoils of War);
 *  - flood: Flood spread from the tile to `targets` before those claims land.
 */
export interface ResolutionEffect {
  type: 'resources' | 'vp' | 'card' | 'trash' | 'flood';
  player_id: string;
  /** Whose card did it. */
  by_player_id?: string;
  tile_key: string | null;
  /** The card that did it (for 'card': the card gained; see source_card). */
  card_name: string;
  amount?: number;
  count?: number;
  card?: Card;
  vp_each?: number;
  source_card?: string;
  card_id?: string;
  targets?: string[];
}

export interface ResolutionStep {
  tile_key: string;
  q: number;
  r: number;
  contested: boolean;
  claimants: ResolutionClaimant[];
  defender_id: string | null;
  defender_power: number;
  /** Axial coords of the defender's nearest owned tile — used client-side to anchor the
   *  defender's number/shield to the edge closest to their territory in the resolve animation. */
  defender_source_q?: number;
  defender_source_r?: number;
  winner_id: string | null;
  previous_owner: string | null;
  outcome: 'claimed' | 'defended' | 'tie' | 'defense_held' | 'consecrate' | 'defense_applied' | 'auto_claim'
    | 'abandon' | 'scorch';  // abandon / scorch: Exodus / Scorched Retreat give the tile up (before claims)
  card_name?: string;  // auto_claim: name of the card that triggered the auto-claim (e.g. "Breakthrough")
  vp_value?: number;  // Consecrate: new VP value of the tile after enhancement; scorch: the VP it had
  defense_permanent?: number;  // defense_applied: persistent defense after application
  defense_temporary?: number;  // defense_applied: temporary defense after application
  defense_immunity?: boolean;  // defense_applied: tile has immunity (Iron Wall / Stronghold)
  is_base_raid?: boolean;  // claim targets the defender's base tile — uses a distinct resolution animation
  defense_ignored?: number;  // Siege Engine / Conqueror: temporary defense the tile lost for this round's claims
  ignored_by?: string[];  // …and who played the claim(s) that ignored it
}

export interface PlayerEffect {
  source_player_id: string;
  target_player_id: string;
  card_name: string;
  effect: string;
  effect_type: string;
  value: number;
  /** Source tile coordinates for flying-card animations */
  source_q?: number;
  source_r?: number;
  /** Name of the card being added (e.g. "Rubble", "Land Grant", "Spoils") */
  added_card_name?: string;
  /** Number of cards being added */
  added_card_count?: number;
  /** Full serialized card definition for fly animations (Hatching Grounds, Master Engineer) */
  added_card?: Card;
}

export interface SharedPurchaseRecord {
  card_id: string;
  card_name: string;
  player_id: string;
  player_name: string;
  round: number;
}

export interface GameState {
  id: string;
  grid: {
    size: string;
    tiles: Record<string, HexTile>;
    starting_positions: [number, number][][];
  };
  players: Record<string, Player>;
  player_order: string[];
  current_phase: string;
  current_round: number;
  first_player_index: number;
  shared_market: MarketStack[];
  vp_target: number;
  winner: string | null;
  log: string[];
  resolution_steps?: ResolutionStep[];
  player_effects?: PlayerEffect[];
  resolution_effects?: ResolutionEffect[];
  test_mode?: boolean;
  shared_purchases_last_round?: SharedPurchaseRecord[];
  revealed_actions?: Record<string, PlannedAction[]>;
  players_done_buying: string[];
  buy_phase_purchases: Record<string, Array<{
    card_id: string;
    definition_id?: string;
    card_name: string;
    source: string;
    cost: number;
  }>>;
  card_pack?: string;
  map_seed?: string;
  claim_ban_rounds?: number;
  max_rounds?: number;
  winners?: string[];
  /** A solo campaign level (null in a regular game). */
  solo?: SoloGameInfo | null;
}

// ── Solo campaign ────────────────────────────────────────

export type SoloObjectiveType = 'vp' | 'territory' | 'vp_hexes' | 'raid' | 'capture' | 'fortify' | 'survive';

export interface SoloObjective {
  type: SoloObjectiveType;
  /** The last round; null: no time limit (lost only when a rival reaches bot_vp). */
  rounds: number | null;
  vp: number | null;
  /** territory: tiles to hold (from `share` of `land` when given); capture:
   *  tiles to take; fortify: tiles to fortify; survive: tiles still held at the end. */
  tiles: number | null;
  share: number | null;
  land: number | null;
  /** vp_hexes: VP hexes on the map; raid / capture / survive: rivals. */
  count: number | null;
  connected: boolean;
  /** fortify: the permanent defense each tile needs. */
  defense: number | null;
  /** survive: raids on your base you can take (more and it's lost). */
  raids_allowed: number;
  /** survive: tiles you can lose (null: any). */
  tiles_lost_max: number | null;
  /** A bot reaching this first loses the level (null: bots can't). */
  bot_vp: number | null;
  /** "Reach 7 VP" — the goal alone (a survive goal includes its deadline). */
  goal: string;
  /** The goal in a few words, for titles: "Hold out for 10 rounds". */
  headline: string;
  /** The goal with its deadline, as one sentence. */
  text: string;
}

export interface SoloProgressInfo {
  value: number;
  target: number;
  unit: string;
  met: boolean;
  /** survive: already lost (raided, or too many tiles lost). */
  failed: boolean;
  /** survive: "base unraided · 1 of 3 tiles lost". */
  detail: string | null;
}

/** GameState.solo: the level being played and, once decided, the result. */
export interface SoloGameInfo {
  level_id: string;
  level_title: string;
  /** The campaign (and the archetype you play). */
  campaign: string;
  player_id: string;
  objective: SoloObjective;
  debt: boolean;
  market: 'fixed' | 'random';
  pack: { shared_card_ids: string[]; archetype_card_ids: Record<string, string[]>; fixed: boolean };
  result: 'won' | 'lost' | null;
  reason: string | null;
  round?: number;
  raided?: string[];
  progress?: SoloProgressInfo;
}

export interface SoloLevel {
  id: string;
  /** The campaign it's played in (you play as this archetype). */
  archetype: string;
  /** Its overworld tile key. */
  spot: string;
  title: string;
  intro: string;
  objective: SoloObjective;
  map: { name: string; tiles: number; vp_hexes: number; vp_total: number; mountains: number; scorched?: number; water?: number };
  cards: { shared: string[]; archetype: Record<string, string[]> };
  pack_id: string | null;
  market: 'fixed' | 'random';
  market_size: number;
  bots: { name: string; archetype: string; difficulty: string }[];
  debt: boolean;
  hints: string[];
  /** Cards the level introduces. */
  spotlight: string[];
  /** Other campaigns this level is in, fought from their side. */
  shared_with: string[];
}

/** One archetype's campaign on the overworld. */
export interface SoloArchetypeCampaign {
  archetype: string;
  title: string;
  blurb: string;
  castle: string;
  /** Each level's spot, in play order. */
  spots: string[];
  /** Spots past the last level ("coming soon"). */
  soon: string[];
  /** segments[i]: the road to stop i (spots, then soon), from the castle or
   *  the stop before; it ends on the stop. */
  segments: string[][];
  levels: SoloLevel[];
}

export interface SoloCampaigns {
  overworld: { tiles: Record<string, { q: number; r: number; blocked: boolean; scorched?: boolean; water?: boolean }> };
  campaigns: SoloArchetypeCampaign[];
}

// ── Lobby types ──────────────────────────────────────────

export interface LobbyPlayer {
  id: string;
  name: string;
  archetype: string;
  color: string;
  is_cpu: boolean;
  is_host: boolean;
  has_returned: boolean;
  cpu_difficulty: 'easy' | 'medium' | 'hard' | null;
}

export interface LobbyConfig {
  /** The map the game will start on: the host's pick, or (while
   *  grid_size_auto) the size suggested for the player count. */
  grid_size: string;
  grid_size_auto?: boolean;
  /** Smallest map where games run 11+ rounds for this many players. */
  suggested_grid_size?: string;
  speed: string;
  max_players: number;
  test_mode: boolean;
  vp_target: number | null;
  granted_actions: number | null;
  card_pack: string;
  max_rounds: number;
  map_seed: string;
  archetype_market_size: number;
  /** Listed in the home page lobby browser (default on). */
  open_to_public?: boolean;
}

/** A public lobby waiting for players (home page browser). */
export interface BrowseLobby {
  code: string;
  host_name: string;
  host_color: string;
  grid_size: string;
  card_pack: string;
  card_pack_name: string;
  players: number;
  humans: number;
  cpus: number;
  max_players: number;
  full: boolean;
  /** Counting down to start — can't be joined. */
  starting: boolean;
}

/** A public game in progress (home page browser). */
export interface BrowseGame {
  code: string;
  host_name: string;
  host_color: string;
  grid_size: string;
  card_pack: string;
  card_pack_name: string;
  players: number;
  humans: number;
  cpus: number;
  round: number;
  max_rounds: number;
  vp_target: number;
  /** Everyone tied for the VP lead. */
  leaders: { name: string; color: string; vp: number }[];
}

export interface LobbyState {
  code: string;
  host_id: string;
  players: Record<string, LobbyPlayer>;
  player_order: string[];
  config: LobbyConfig;
  status: string;
  game_id: string | null;
}
