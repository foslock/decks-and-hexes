export interface HexTile {
  q: number;
  r: number;
  is_blocked: boolean;
  is_vp: boolean;
  vp_value: number;  // 1 = standard, 2 = premium
  owner: string | null;
  defense_power: number;
  base_defense: number;
  held_since_turn: number | null;
  is_base: boolean;
  base_owner: string | null;
}

export interface Card {
  id: string;
  name: string;
  archetype: string;
  card_type: string;
  power: number;
  resource_gain: number;
  action_return: number;
  timing: string;
  buy_cost: number | null;
  is_upgraded: boolean;
  trash_on_use: boolean;
  stackable: boolean;
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
  current_vp?: number;
  description: string;
  upgrade_description?: string;
  name_upgraded?: string;
  starter: boolean;
  effects?: { type: string; condition: string; value: number; metadata?: Record<string, unknown> }[];
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
}

export interface Player {
  id: string;
  name: string;
  archetype: string;
  hand: Card[];
  hand_count: number;
  resources: number;
  vp: number;
  actions_used: number;
  actions_available: number;
  archetype_market: Card[];
  upgrade_credits: number;
  passive: Record<string, string> | null;
  deck_size: number;
  discard_count: number;
  discard: Card[];
  deck_cards: Card[];
  planned_action_count: number;
  planned_actions: PlannedAction[];
  has_submitted_plan: boolean;
  has_ended_turn: boolean;
  effective_buy_costs?: Record<string, number>;
  trash: Card[];
  last_upkeep_paid: number;
  upkeep_cost: number;
  tiles_lost_to_upkeep: number;
  rubble_count: number;
}

export interface MarketStack {
  card: Card;
  remaining: number;
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
  winner_id: string | null;
  previous_owner: string | null;
  outcome: 'claimed' | 'defended' | 'tie' | 'defense_held';
}

export interface PlayerEffect {
  source_player_id: string;
  target_player_id: string;
  card_name: string;
  effect: string;
  effect_type: string;
  value: number;
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
  neutral_market: MarketStack[];
  vp_target: number;
  winner: string | null;
  log: string[];
  resolution_steps?: ResolutionStep[];
  player_effects?: PlayerEffect[];
  test_mode?: boolean;
}
