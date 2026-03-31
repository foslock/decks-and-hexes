export interface HexTile {
  q: number;
  r: number;
  is_blocked: boolean;
  is_vp: boolean;
  owner: string | null;
  defense_power: number;
  held_since_turn: number | null;
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
  stacking_exception: boolean;
  forced_discard: number;
  draw_cards: number;
  defense_bonus: number;
  adjacency_required: boolean;
  description: string;
  starter: boolean;
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
  planned_action_count: number;
  has_submitted_plan: boolean;
}

export interface MarketStack {
  card: Card;
  remaining: number;
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
  winner: string | null;
  log: string[];
}
