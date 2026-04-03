# HexDraft – Fortress Card Pool
# Archetype: Cheap + Strong
# Action Slots: 3
# Identity: High power, deliberate cycle, defensive turtling
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = net-neutral (↺), 2 = net-positive (↑)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stackable: true = this card can be played on a tile where you already have a claim this turn
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: fortress_bunker
    name: Bunker
    name_upgraded: Bunker+
    type: Defense
    buy_cost: null
    starter: true
    action_return: 0
    power: 0
    defense_bonus: 2
    upgraded_defense_bonus: 3
    effect: "Defense: One tile you own gains +2 defense this round. Gain 1 resource."
    effect_upgraded: "Defense: One tile you own gains +3 defense this round. Gain 2 resources."
    resource_gain: 1
    upgraded_resource_gain: 2
    note: "Fortress starter. Defensive positioning plus economy in one card."

  - id: fortress_fortify
    name: Fortify
    name_upgraded: Fortify+
    type: Defense
    buy_cost: 2
    action_return: 1
    power: 3
    defense_target_count: 1
    upgraded_defense_target_count: 2
    effect: "Defense: One tile you own gains +3 defense power when defending this round."
    effect_upgraded: "Defense: Two tiles you own each gain +3 defense power when defending this round."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_bulwark
    name: Bulwark
    name_upgraded: Bulwark+
    type: Defense
    buy_cost: 3
    action_return: 0
    power: 2
    defense_target_count: 2
    upgraded_defense_target_count: 3
    effect: "Defense: Two tiles you own each gain +2 defense power when defending this round."
    effect_upgraded: "Defense: Three tiles you own each gain +2 defense power when defending this round."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_siege_engine
    name: Siege Engine
    name_upgraded: Siege Engine+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 5
    effect: "Claim: Power 5. Cannot be countered by Defense cards this round."
    effect_upgraded: "Claim: Power 6. Cannot be countered by Defense cards this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: ignore_defense
        timing: on_resolution

  - id: fortress_iron_wall
    name: Iron Wall
    name_upgraded: Iron Wall+
    type: Defense
    buy_cost: 2
    action_return: 0
    power: 0
    defense_target_count: 1
    upgraded_defense_target_count: 2
    effect: "Defense: One tile you own cannot be claimed this round."
    effect_upgraded: "Defense: Two tiles you own cannot be claimed this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: tile_immunity
        duration: 1
        timing: immediate

  - id: fortress_garrison
    name: Garrison
    name_upgraded: Garrison+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If defending an owned tile, power is 5 instead."
    effect_upgraded: "Claim: Power 4. If defending an owned tile, power is 7 instead."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 2
        timing: on_resolution
        condition: if_defending_owned

  - id: fortress_slow_advance
    name: Slow Advance
    name_upgraded: Slow Advance+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If the target is a neutral tile, claim it automatically."
    effect_upgraded: "Claim: Power 4. If the target is a neutral tile, claim it automatically and draw 1 card next turn."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: auto_claim_if_neutral
        timing: on_resolution
        condition: if_target_neutral

  - id: fortress_supply_line
    name: Supply Line
    name_upgraded: Supply Line+
    type: Engine
    buy_cost: 2
    action_return: 1
    power: 0
    effect: "Engine: Gain 2 resources. One card in your hand costs 2 less resources to purchase this turn. Gain 1 action back."
    effect_upgraded: "Engine: Gain 3 resources. One card in your hand costs 2 less resources to purchase this turn. Gain 1 action back."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: cost_reduction
        value: 2
        timing: immediate
        metadata: {scope: "any_one_card"}

  - id: fortress_entrench
    name: Entrench
    name_upgraded: Entrench+
    type: Defense
    buy_cost: 1
    action_return: 0
    power: 0
    defense_bonus: 0
    effect: "Defense: Target tile you own permanently gains +1 defense power until it is captured."
    effect_upgraded: "Defense: Target tile you own permanently gains +2 defense power until it is captured."
    secondary_effect: null
    secondary_timing: null

    note: "Permanent defense bonus persists across rounds and stacks with round-based Defense cards."

    effects:
      - type: permanent_defense
        value: 1
        timing: immediate
        metadata: {upgraded_value: 2}

  - id: fortress_war_of_attrition
    name: War of Attrition
    name_upgraded: War of Attrition+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 2
    effect: "Claim: Power 2."
    effect_upgraded: "Claim: Power 3."
    secondary_effect: "If the defender successfully holds the tile, that defending player draws 1 fewer card at the start of their next turn."
    secondary_timing: on_resolution

    effects:
      - type: on_defend_forced_discard
        value: 1
        timing: on_resolution
        condition: if_defender_holds

  - id: fortress_stronghold
    name: Stronghold
    name_upgraded: Stronghold+
    type: Defense
    buy_cost: 5
    action_return: 0
    power: 0
    defense_target_count: 1
    upgraded_defense_target_count: 2
    effect: "Defense: One tile you own cannot be claimed this round or next round."
    effect_upgraded: "Defense: Two tiles you own cannot be claimed this round or next round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: tile_immunity
        duration: 2
        timing: immediate

  - id: fortress_overwhelming_force
    name: Overwhelming Force
    name_upgraded: Overwhelming Force+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 3
    effect: "Claim: Power 3. Stackable. If the target tile is neutral, gain 1 resource refund."
    effect_upgraded: "Claim: Power 4. Stackable. If the target tile is neutral, gain 2 resource refund."
    secondary_effect: null
    secondary_timing: null
    stackable: true
    effects:
      - type: resource_refund_if_neutral
        value: 1
        timing: on_resolution
        condition: if_target_neutral

  - id: fortress_consolidate
    name: Consolidate
    name_upgraded: Consolidate+
    type: Engine
    buy_cost: 2
    action_return: 1
    power: 0
    effect: "Engine: Trash 1 card from your hand. Gain resources equal to that card's buy cost. Draw 1 card immediately. Gain 1 action back."
    effect_upgraded: "Engine: Trash 1 card from your hand. Gain resources equal to that card's buy cost +2. Draw 1 card immediately. Gain 1 action back."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: trash_gain_buy_cost
        value: 1
        timing: immediate
        requires_choice: true

  - id: fortress_tactical_reserve
    name: Tactical Reserve
    name_upgraded: Tactical Reserve+
    type: Engine
    buy_cost: 3
    action_return: 2
    power: 0
    effect: "Engine: Gain 2 actions back. The next Defense card you play this turn costs 0 resources to purchase (retroactive discount on future copies)."
    effect_upgraded: "Engine: Gain 2 actions back. The next two Defense cards you play this turn each cost 0 resources to purchase."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: cost_reduction
        value: 0
        timing: immediate
        metadata: {scope: "next_defense", remaining: 1}

  - id: fortress_iron_discipline
    name: Iron Discipline
    name_upgraded: Iron Discipline+
    type: Engine
    buy_cost: 2
    action_return: 1
    power: 0
    effect: "Engine: Gain 1 resource. Draw 1 card immediately. Gain 1 action back."
    effect_upgraded: "Engine: Gain 2 resources. Draw 1 card immediately. Gain 1 action back."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_fortified_position
    name: Fortified Position
    name_upgraded: Fortified Position+
    type: Engine
    buy_cost: 3
    action_return: 0
    power: 0
    unplayable: true
    vp_formula: fortified_tiles_3
    effect: "Passive: Worth 1 VP for every non-base tile you own with a permanent defense bonus of 3 or higher."
    effect_upgraded: "Passive: Worth 1 VP for every non-base tile you own with a permanent defense bonus of 2 or higher."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards Entrench investment. Fluctuates as tiles are lost or captured. Takes up a hand slot when drawn."

  - id: fortress_diplomacy
    name: Diplomacy
    name_upgraded: Diplomacy+
    type: Engine
    buy_cost: 2
    action_return: 0
    power: 0
    trash_on_use: true
    effect: "Engine: All players (including you) receive a Land Grant card in their discard pile. Trash this card."
    effect_upgraded: "Engine: All players (including you) receive a Land Grant card in their discard pile. You receive an additional Land Grant. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "Shared benefit — everyone gets +1 VP from the Land Grant. The upgraded version gives you a second one for a net +1 advantage."

    effects:
      - type: grant_land_grants
        timing: immediate

