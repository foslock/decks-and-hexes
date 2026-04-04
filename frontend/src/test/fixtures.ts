import type { GameState, Player, Card, HexTile, MarketStack } from '../types/game';

export function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'test_card',
    name: 'Test Card',
    archetype: 'neutral',
    card_type: 'claim',
    power: 1,
    resource_gain: 0,
    action_return: 0,
    timing: 'immediate',
    buy_cost: null,
    is_upgraded: false,
    trash_on_use: false,
    stackable: false,
    forced_discard: 0,
    draw_cards: 0,
    defense_bonus: 0,
    adjacency_required: true,
    claim_range: 1,
    unoccupied_only: false,
    multi_target_count: 0,
    defense_target_count: 1,
    flood: false,
    target_own_tile: false,
    passive_vp: 0,
    description: 'Test card',
    starter: false,
    ...overrides,
  };
}

export function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: 'player_0',
    name: 'Alice',
    archetype: 'vanguard',
    hand: [
      makeCard({ id: 'adv_0', name: 'Advance', card_type: 'claim', power: 1 }),
      makeCard({ id: 'adv_1', name: 'Advance', card_type: 'claim', power: 1 }),
      makeCard({ id: 'gather_0', name: 'Gather', card_type: 'engine', resource_gain: 2, power: 0 }),
      makeCard({ id: 'blitz_0', name: 'Blitz', card_type: 'claim', power: 4 }),
    ],
    hand_count: 4,
    resources: 3,
    vp: 0,
    actions_used: 0,
    actions_available: 4,
    archetype_market: [
      makeCard({ id: 'arch_1', name: 'Overrun', buy_cost: 5, power: 5 }),
    ],
    upgrade_credits: 0,
    deck_size: 4,
    discard_count: 0,
    discard: [],
    deck_cards: [],
    planned_action_count: 0,
    planned_actions: [],
    has_submitted_plan: false,
    has_ended_turn: false,
    trash: [],
    last_upkeep_paid: 0,
    upkeep_cost: 0,
    tiles_lost_to_upkeep: 0,
    rubble_count: 0,
    neutral_bought_this_turn: false,
    is_cpu: false,
    cpu_difficulty: null,
    ...overrides,
  };
}

export function makeTile(q: number, r: number, overrides: Partial<HexTile> = {}): HexTile {
  return {
    q,
    r,
    is_blocked: false,
    is_vp: false,
    vp_value: 1,
    owner: null,
    defense_power: 0,
    base_defense: 0,
    held_since_turn: null,
    is_base: false,
    base_owner: null,
    ...overrides,
  };
}

export function makeGameState(overrides: Partial<GameState> = {}): GameState {
  const tiles: Record<string, HexTile> = {};
  // Small grid subset for testing
  const coords = [
    [0, 0], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1],
    [2, 0], [2, -1], [3, 0], [3, -1], [3, -2],
    [-2, 0], [-2, 1], [-3, 0], [-3, 1], [-3, 2],
  ];
  for (const [q, r] of coords) {
    const key = `${q},${r}`;
    tiles[key] = makeTile(q, r);
  }
  // Player starting positions
  tiles['3,0'].owner = 'player_0';
  tiles['3,-1'].owner = 'player_0';
  tiles['-3,0'].owner = 'player_1';
  tiles['-3,1'].owner = 'player_1';
  // VP and blocked tiles
  tiles['1,0'].is_vp = true;
  tiles['-1,0'].is_vp = true;

  return {
    id: 'test-game-id',
    grid: {
      size: 'small',
      tiles,
      starting_positions: [[[3, 0], [3, -1]], [[-3, 0], [-3, 1]]],
    },
    players: {
      player_0: makePlayer({ id: 'player_0', name: 'Alice', archetype: 'vanguard' }),
      player_1: makePlayer({
        id: 'player_1',
        name: 'Bob',
        archetype: 'swarm',
        hand_count: 5,
        actions_available: 4,
      }),
    },
    player_order: ['player_0', 'player_1'],
    current_phase: 'plan',
    current_round: 1,
    first_player_index: 0,
    neutral_market: [
      { card: makeCard({ id: 'neutral_mercenary', name: 'Mercenary', buy_cost: 3, power: 3 }), remaining: 5 },
      { card: makeCard({ id: 'neutral_gather', name: 'Land Grant', buy_cost: 2, card_type: 'engine' }), remaining: 3 },
    ],
    vp_target: 10,
    winner: null,
    log: ['Game created', '=== Round 1, Start of Turn ===', 'Plan phase begins'],
    ...overrides,
  };
}
