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
  immune?: boolean;  // tile has claim immunity this round (Iron Wall / Stronghold)
}

export interface Card {
  id: string;
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
  multi_target_count: number;
  defense_target_count: number;
  flood: boolean;
  target_own_tile: boolean;
  passive_vp: number;
  vp_formula?: string;
  unique?: boolean;
  current_vp?: number;
  description: string;
  upgrade_description?: string;
  name_upgraded?: string;
  starter: boolean;
  effects?: { type: string; condition: string; value: number; upgraded_value?: number; target?: string; condition_threshold?: number; metadata?: Record<string, unknown> }[];
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
  trash: Card[];
  rubble_count: number;
  claims_won_last_round: number;
  tiles_lost_last_round: number;
  tile_count: number;
  is_cpu: boolean;
  cpu_difficulty: 'easy' | 'medium' | 'hard' | null;
  has_left: boolean;
  free_rerolls: number;
  buy_locked: boolean;
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
  outcome: 'claimed' | 'defended' | 'tie' | 'defense_held' | 'consecrate' | 'defense_applied' | 'auto_claim';
  card_name?: string;  // auto_claim: name of the card that triggered the auto-claim (e.g. "Breakthrough")
  vp_value?: number;  // Consecrate: new VP value of the tile after enhancement
  defense_permanent?: number;  // defense_applied: persistent defense after application
  defense_temporary?: number;  // defense_applied: temporary defense after application
  defense_immunity?: boolean;  // defense_applied: tile has immunity (Iron Wall / Stronghold)
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
  test_mode?: boolean;
  shared_purchases_last_round?: SharedPurchaseRecord[];
  revealed_actions?: Record<string, PlannedAction[]>;
  players_done_buying: string[];
  buy_phase_purchases: Record<string, Array<{
    card_id: string;
    card_name: string;
    source: string;
    cost: number;
  }>>;
  card_pack?: string;
  map_seed?: string;
  claim_ban_rounds?: number;
  max_rounds?: number;
  winners?: string[];
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
  grid_size: string;
  speed: string;
  max_players: number;
  test_mode: boolean;
  vp_target: number | null;
  granted_actions: number | null;
  card_pack: string;
  max_rounds: number;
  map_seed: string;
  archetype_market_size: number;
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
