# Card Clash – Swarm Card Pool
# Archetype: Fast + Cheap
# Action Slots: 4
# Identity: Low power, cheap to buy, floods the board with many tiles
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = gain 1 action (net neutral), 2 = gain 2 actions (net +1)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stackable: true = this card can be played on a tile where you already have a claim this round
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: swarm_colony
    name: Colony
    name_upgraded: Colony+
    type: Passive
    buy_cost: 4
    action_return: 0
    power: 0
    unplayable: true
    vp_formula: disconnected_groups_3
    effect: "+1 VP for each group of 3+ tiles you own that is disconnected from your base."
    effect_upgraded: "+1 VP for each group of 2+ tiles you own that is disconnected from your base."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards scattered expansion via Proliferate and other non-adjacency plays. Stronger on larger maps with more room to spread. Takes up a hand slot when drawn."

    effects:
      - type: vp_from_disconnected_groups
        value: 3
        upgraded_value: 2
        timing: on_resolution
        metadata: {min_group_size: 3, upgraded_min_group_size: 2}

  - id: swarm_surge
    name: Surge
    name_upgraded: Surge+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 1
    multi_target_count: 1
    upgraded_multi_target_count: 2
    effect: "Claim: Power 1 on up to 2 adjacent tiles simultaneously."
    effect_upgraded: "Claim: Power 1 on up to 3 adjacent tiles simultaneously."
    secondary_effect: null
    secondary_timing: null


  - id: swarm_overwhelm
    name: Overwhelm
    name_upgraded: Overwhelm+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 1
    effect: "Claim: Power 1. +1 power for each other tile you own adjacent to the target tile."
    effect_upgraded: "Claim: Power 2. +1 power for each other tile you own adjacent to the target tile."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 1
        timing: on_resolution
        condition: if_adjacent_owned_gte
        condition_threshold: 1
        metadata: {per_tile: true}

  - id: swarm_swarm_tactics
    name: Swarm Tactics
    name_upgraded: Swarm Tactics+
    type: Engine
    buy_cost: 2
    action_return: 1
    power: 0
    draw_cards: 1
    upgraded_draw_cards: 2
    upgraded_action_return: 1
    effect: "Draw 1 card. Gain 1 action."
    effect_upgraded: "Draw 2 cards. Gain 1 action."
    secondary_effect: null
    secondary_timing: null


  - id: swarm_proliferate
    name: Proliferate
    name_upgraded: Proliferate+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 1
    adjacency_required: false
    unoccupied_only: true
    effect: "Claim: Power 1 on any neutral tile on the board, ignoring adjacency restrictions."
    effect_upgraded: "Claim: Power 2 on any neutral tile on the board, ignoring adjacency restrictions."
    secondary_effect: null
    secondary_timing: null


  - id: swarm_flood
    name: Flood
    name_upgraded: Flood+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 1
    flood: true
    target_own_tile: true
    effect: "Claim: Target one tile you own. Power 1 claim on all adjacent tiles simultaneously."
    effect_upgraded: "Claim: Target one tile you own. Power 2 claim on all adjacent tiles simultaneously."
    secondary_effect: null
    secondary_timing: null


  - id: swarm_rabble
    name: Rabble
    name_upgraded: Rabble+
    type: Claim
    buy_cost: 1
    action_return: 0
    power: 1
    effect: "Claim: Power 1. If you play another Rabble card this round, gain 1 action."
    effect_upgraded: "Claim: Power 1. If you play another Rabble+ card this round, gain 1 action. Additionally, +1 power per Rabble+ played this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: conditional_action_return
        value: 1
        timing: on_resolution
        condition: if_played_same_name

  - id: swarm_dog_pile
    name: Dog Pile
    name_upgraded: Dog Pile+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 2
    effect: "Claim: Power 2. Stackable. Each other claim you play on the same tile this round gets +1 power."
    effect_upgraded: "Claim: Power 3. Stackable. Each other claim you play on the same tile this round gets +1 power."
    secondary_effect: null
    secondary_timing: null
    stackable: true
    effects:
      - type: stacking_power_bonus
        value: 1
        timing: on_resolution

  - id: swarm_thin_the_herd
    name: Thin the Herd
    name_upgraded: Thin the Herd+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Trash 1 card from your hand. If you did, draw 1 card and gain 1 action."
    effect_upgraded: "Trash 1 card from your hand. If you did, draw 2 cards and gain 1 action."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: self_trash
        value: 1
        timing: immediate
        requires_choice: true
        metadata: {optional: true, gates_draw: true}

  - id: swarm_numbers_game
    name: Strength in Numbers
    name_upgraded: Strength in Numbers+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 0
    effect: "Claim: Power equal to the number of other cards in your hand (not including this card)."
    effect_upgraded: "Claim: Power equal to the number of other cards in your hand +2 (not including this card)."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 0
        upgraded_value: 2
        timing: on_resolution
        condition: cards_in_hand

  - id: swarm_frenzy
    name: Frenzy
    name_upgraded: Frenzy+
    type: Engine
    buy_cost: 3
    action_return: 2
    power: 0
    effect: "Discard 1 card. Gain 2 actions."
    effect_upgraded: "Discard 1 card. Gain 2 actions. Gain 2 resources."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: self_discard
        value: 1
        timing: immediate
        requires_choice: true

  - id: swarm_scavenge
    name: Scavenge
    name_upgraded: Scavenge+
    type: Engine
    buy_cost: 1
    action_return: 0
    power: 0
    effect: "Gain 2 resources. If you have 0 actions, gain 1 action."
    effect_upgraded: "Gain 3 resources. If you have 0 actions, gain 1 action."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: grant_actions
        value: 1
        timing: immediate
        condition: zero_actions


  - id: swarm_blitz_rush
    name: Stampede
    name_upgraded: Stampede+
    type: Engine
    buy_cost: 4
    action_return: 2
    power: 0
    effect: "Gain 2 actions. You cannot purchase any cards during the Buy Phase this round."
    effect_upgraded: "Gain 3 actions. You cannot purchase any cards during the Buy Phase this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: buy_restriction
        timing: on_resolution

  - id: swarm_consecrate
    name: Consecrate
    name_upgraded: Consecrate+
    type: Engine
    buy_cost: 3
    action_return: 0
    power: 0
    trash_on_use: true
    target_own_tile: true
    effect: "Play on a connected VP tile you own. Permanently increase that tile's VP value by 1. Trash this card."
    effect_upgraded: "Play on a connected VP tile you own. Permanently increase that tile's VP value by 2. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "Permanent board modification — any future owner of the tile benefits from the increased VP value."

    effects:
      - type: enhance_vp_tile
        timing: on_resolution
        metadata: {upgraded_bonus: 2}

  - id: swarm_nest
    name: Nest
    name_upgraded: Nest+
    type: Defense
    buy_cost: 2
    action_return: 0
    power: 0
    effect: "One tile you own gains +1 defense this round for each other tile you own adjacent to it."
    effect_upgraded: "One tile you own gains +2 defense per adjacent owned tile."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: defense_per_adjacent
        value: 1
        upgraded_value: 2
        timing: on_resolution

  - id: swarm_safety_in_numbers
    name: Phalanx
    name_upgraded: Phalanx+
    type: Defense
    buy_cost: 3
    action_return: 0
    power: 0
    defense_target_count: 2
    upgraded_defense_target_count: 2
    defense_bonus: 1
    upgraded_defense_bonus: 2
    effect: "Choose up to 2 tiles you own. Each gains +1 defense this round."
    effect_upgraded: "Choose up to 2 tiles. Each gains +2 defense this round."
    secondary_effect: null
    secondary_timing: null

  - id: swarm_mob_rule
    name: Mob Rule
    name_upgraded: Mob Rule+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 2
    effect: "Claim: Power 2. +1 power for every 3 tiles you own (rounded down)."
    effect_upgraded: "Claim: Power 3. +1 power for every 2 tiles you own (rounded down)."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_per_tiles_owned
        value: 3
        upgraded_value: 2
        timing: on_resolution
        metadata: {divisor_based: true}

  - id: swarm_hive_mind
    name: Hive Mind
    name_upgraded: Hive Mind+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 1
    trash_on_use: true
    multi_target_count: 3
    upgraded_multi_target_count: 4
    effect: "Claim: Power 1 on up to 4 adjacent tiles simultaneously. Trash this card."
    effect_upgraded: "Claim: Power 2 on up to 5 adjacent tiles simultaneously. Trash this card."
    secondary_effect: null
    secondary_timing: null

  - id: swarm_locust_swarm
    name: Locust Swarm
    name_upgraded: Locust Swarm+
    type: Claim
    buy_cost: 7
    action_return: 0
    power: 0
    trash_on_use: true
    multi_target_count: 1
    upgraded_multi_target_count: 2
    effect: "Claim: Power equal to the number of tiles you own divided by 3 (rounded down). Targets up to 2 tiles. Trash this card."
    effect_upgraded: "Claim: Power equal to the number of tiles you own divided by 2 (rounded down). Targets up to 3 tiles. Trash this card."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_per_tiles_owned
        value: 3
        upgraded_value: 2
        timing: on_resolution
        metadata: {divisor_based: true, replaces_base_power: true}

  - id: swarm_war_trophies
    name: Spoils Hoard
    name_upgraded: Spoils Hoard+
    type: Passive
    buy_cost: 3
    action_return: 0
    power: 0
    unplayable: true
    vp_formula: trash_div_5
    effect: "+1 VP for every 5 cards in your trash pile."
    effect_upgraded: "+1 VP for every 4 cards in your trash pile."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards aggressive deck thinning. Synergizes with Thin the Herd and trash effects. Takes up a hand slot when drawn."

  - id: swarm_heady_brew
    name: Heady Brew
    name_upgraded: Heady Brew+
    type: Engine
    buy_cost: 4
    action_return: 0
    power: 0
    trash_on_use: true
    effect: "Swap your draw and discard piles, then shuffle your draw pile. Trash this card."
    effect_upgraded: "Swap your draw and discard piles, then shuffle your draw pile. Draw 2 cards. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "Lets Swarm start a new deck cycle immediately. The upgraded version draws into the freshly shuffled pile."

    effects:
      - type: swap_draw_discard
        timing: immediate

  - id: swarm_plague
    name: Plague
    name_upgraded: Plague+
    type: Engine
    buy_cost: 3
    action_return: 0
    power: 0
    effect: "At the beginning of next round, every player (including you) trashes a random card from their hand."
    effect_upgraded: "At the beginning of next round, every opponent trashes a random card from their hand."
    secondary_effect: null
    secondary_timing: null
    note: "Symmetrical disruption that favors Swarm — their cheap cards are expendable, but opponents may lose key pieces. Upgrade removes self-cost."

    effects:
      - type: global_random_trash
        timing: on_resolution
        target: all_players

  - id: swarm_infestation
    name: Infestation
    name_upgraded: Infestation+
    type: Engine
    buy_cost: 4
    action_return: 0
    power: 0
    trash_on_use: true
    effect: "Target opponent adds 3 Rubble cards to their discard pile. Trash this card."
    effect_upgraded: "Target opponent adds 4 Rubble cards to their discard pile. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "Aggressive deck pollution. Rubble clogs the opponent's hand slots, reducing their effective draws."

    effects:
      - type: inject_rubble
        timing: on_resolution
        value: 3
        upgraded_value: 4
        target: chosen_opponent

  - id: swarm_exodus
    name: Exodus
    name_upgraded: Exodus+
    type: Engine
    buy_cost: 3
    action_return: 2
    power: 0
    target_own_tile: true
    effect: "Abandon a tile you own. Gain 2 actions. Draw 2 cards."
    effect_upgraded: "Abandon a tile you own. Gain 2 actions. Draw 3 cards."
    secondary_effect: null
    secondary_timing: null
    note: "Converts board position into raw tempo. Swarm can afford to lose a tile because they take three more with the extra actions and cards."

    effects:
      - type: abandon_tile
        timing: on_resolution
