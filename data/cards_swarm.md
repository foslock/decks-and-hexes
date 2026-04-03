# HexDraft – Swarm Card Pool
# Archetype: Fast + Cheap
# Action Slots: 4
# Identity: Low power, cheap to buy, floods the board with many tiles
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = net-neutral (↺), 2 = net-positive (↑)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stackable: true = this card can be played on a tile where you already have a claim this turn
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: swarm_scout
    name: Scout
    name_upgraded: Scout+
    type: Claim
    buy_cost: null
    starter: true
    action_return: 0
    power: 1
    resource_gain: 1
    upgraded_resource_gain: 2
    unoccupied_only: true
    upgraded_unoccupied_only: false
    effect: "Claim: Power 1 on any adjacent unoccupied tile. Gain 1 resource."
    effect_upgraded: "Claim: Power 2. Gain 2 resources."
    secondary_effect: null
    secondary_timing: null


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
    buy_cost: 1
    action_return: 1
    power: 0
    draw_cards: 1
    upgraded_draw_cards: 2
    upgraded_action_return: 1
    effect: "Engine: Draw 1 card immediately. Gain 1 action back (↺)."
    effect_upgraded: "Engine: Draw 2 cards immediately. Gain 1 action back (↺)."
    secondary_effect: null
    secondary_timing: null


  - id: swarm_cheap_shot
    name: Cheap Shot
    name_upgraded: Cheap Shot+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 2
    effect: "Claim: Power 2. Costs 1 less resource to purchase if you control the most tiles."
    effect_upgraded: "Claim: Power 3. Costs 1 less resource to purchase if you control the most tiles."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: dynamic_buy_cost
        condition: tiles_more_than_defender
        value: -1

  - id: swarm_proliferate
    name: Proliferate
    name_upgraded: Proliferate+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 1
    adjacency_required: false
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
    effect: "Claim: Power 1. If you play another Rabble card this turn, gain 1 action back after playing this one (↺)."
    effect_upgraded: "Claim: Power 1. If you play another Rabble+ card this turn, gain 1 action back. Additionally, +1 power per Rabble+ played this turn."
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
    buy_cost: 2
    action_return: 0
    power: 1
    effect: "Claim: Power 1. Stackable. Each other claim you play on the same tile this turn gets +1 power."
    effect_upgraded: "Claim: Power 2. Stackable. Each other claim you play on the same tile this turn gets +2 power."
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
    buy_cost: 2
    action_return: 2
    power: 0
    effect: "Engine: Trash 1 card from your hand. Draw 2 cards immediately. Gain 2 actions back."
    effect_upgraded: "Engine: Trash 1 card from your hand. Draw 3 cards immediately. Gain 2 actions back."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: self_trash
        value: 1
        timing: immediate
        requires_choice: true

  - id: swarm_numbers_game
    name: Numbers Game
    name_upgraded: Numbers Game+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 0
    effect: "Claim: Power equal to the number of cards in your hand when this card is played."
    effect_upgraded: "Claim: Power equal to the number of cards in your hand +2 when this card is played."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 0
        timing: on_resolution
        condition: cards_in_hand

  - id: swarm_frenzy
    name: Frenzy
    name_upgraded: Frenzy+
    type: Engine
    buy_cost: 3
    action_return: 2
    power: 0
    effect: "Engine: Gain 2 actions back. Discard 1 card."
    effect_upgraded: "Engine: Gain 2 actions back. Discard 1 card. Gain 1 resource."
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
    action_return: 1
    power: 0
    effect: "Engine: Gain 2 resources. Draw 1 card immediately. Gain 1 action back."
    effect_upgraded: "Engine: Gain 3 resources. Draw 1 card immediately. Gain 1 action back."
    secondary_effect: null
    secondary_timing: null


  - id: swarm_blitz_rush
    name: Blitz Rush
    name_upgraded: Blitz Rush+
    type: Engine
    buy_cost: 4
    action_return: 2
    power: 0
    effect: "Engine: Gain 2 actions back. You cannot purchase any cards during the Buy Phase this round."
    effect_upgraded: "Engine: Gain 3 actions back. You cannot purchase any cards during the Buy Phase this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: buy_restriction
        timing: immediate

  - id: swarm_consecrate
    name: Consecrate
    name_upgraded: Consecrate+
    type: Engine
    buy_cost: 4
    action_return: 0
    power: 0
    trash_on_use: true
    target_own_tile: true
    effect: "Engine: Play on a connected VP tile you own. Permanently increase that tile's VP value by 1. Trash this card."
    effect_upgraded: "Engine: Play on a connected VP tile you own. Permanently increase that tile's VP value by 2. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "Permanent board modification — any future owner of the tile benefits from the increased VP value."

    effects:
      - type: enhance_vp_tile
        timing: immediate
        metadata: {upgraded_bonus: 2}

  - id: swarm_war_trophies
    name: War Trophies
    name_upgraded: War Trophies+
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
