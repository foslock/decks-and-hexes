# Card Clash – Fortress Card Pool
# Archetype: Cheap + Strong
# Action Slots: 3
# Identity: High power, deliberate cycle, defensive turtling
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = gain 1 action (net neutral), 2 = gain 2 actions (net +1)
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
    effect: "One tile you own gains +2 defense this round."
    effect_upgraded: "One tile you own gains +3 defense this round. Gain 1 resource."
    resource_gain: 0
    upgraded_resource_gain: 1
    note: "Fortress starter. Pure defensive positioning; upgrade adds economy."

  - id: fortress_fortify
    name: Fortify
    name_upgraded: Fortify+
    type: Defense
    buy_cost: 2
    action_return: 1
    power: 0
    defense_bonus: 3
    defense_target_count: 1
    upgraded_defense_target_count: 2
    effect: "One tile you own gains +3 defense this round. Gain 1 action."
    effect_upgraded: "Two tiles you own each gain +3 defense this round. Gain 1 action."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_bulwark
    name: Bulwark
    name_upgraded: Bulwark+
    type: Defense
    buy_cost: 3
    action_return: 0
    power: 0
    defense_bonus: 2
    defense_target_count: 2
    upgraded_defense_target_count: 3
    effect: "Two tiles you own each gain +2 defense this round."
    effect_upgraded: "Three tiles you own each gain +2 defense this round."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_siege_engine
    name: Siege Engine
    name_upgraded: Siege Engine+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 3
    upgraded_power: 4
    effect: "Claim: Power 3. Ignores all defense bonuses on targeted tile."
    effect_upgraded: "Claim: Power 4. Ignores all defense bonuses on targeted tile."
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
    effect: "One tile you own cannot be claimed this round."
    effect_upgraded: "Two tiles you own cannot be claimed this round."
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
        upgraded_value: 3
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
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Gain 2 resources. One card in your hand costs 2 less resources to purchase this turn. Gain 1 action."
    effect_upgraded: "Gain 3 resources. One card in your hand costs 2 less resources to purchase this turn. Gain 1 action."
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
    effect: "Target tile you own permanently gains +1 defense until it is captured."
    effect_upgraded: "Target tile you own permanently gains +2 defense until it is captured."
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
    effect: "Claim: Power 2. If the defender holds, they draw 1 fewer card next turn."
    effect_upgraded: "Claim: Power 3. If the defender holds, they draw 1 fewer card next turn."
    secondary_effect: null
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
    effect: "One tile you own cannot be claimed this round or next round."
    effect_upgraded: "Two tiles you own cannot be claimed this round or next round."
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
    effect: "Claim: Power 3. Stackable. If the target tile is neutral, gain 1 resource."
    effect_upgraded: "Claim: Power 4. Stackable. If the target tile is neutral, gain 2 resources."
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
    buy_cost: 4
    action_return: 0
    power: 0
    effect: "Trash 1 card from your hand. If you did, gain resources equal to half that card's buy cost (rounded down). Draw 1 card."
    effect_upgraded: "Trash 1 card from your hand. If you did, gain resources equal to half that card's buy cost (rounded down) +2. Draw 1 card."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: trash_gain_buy_cost
        value: 1
        timing: immediate
        requires_choice: true
        metadata: {optional: true, upgrade_bonus: 2, gates_draw: true}

  - id: fortress_battering_ram
    name: Battering Ram
    name_upgraded: Battering Ram+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 5
    effect: "Claim: Power 5. If the target tile has any defense bonuses, gain +2 power."
    effect_upgraded: "Claim: Power 7. If the target tile has any defense bonuses, gain +3 power."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 2
        upgraded_value: 3
        timing: on_resolution
        condition: if_target_has_defense

  - id: fortress_citadel
    name: Citadel
    name_upgraded: Citadel+
    type: Defense
    buy_cost: 7
    action_return: 0
    power: 0
    effect: "One tile you own gains permanent +3 defense. That tile's defense cannot be ignored this round."
    effect_upgraded: "Permanent +4 defense. Cannot be ignored. Adjacent tiles gain +1 defense this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: permanent_defense
        value: 3
        timing: immediate
        metadata: {upgraded_value: 4}
      - type: ignore_defense_override
        timing: immediate

  - id: fortress_war_council
    name: War Council
    name_upgraded: War Council+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    draw_cards: 2
    upgraded_draw_cards: 3
    effect: "Draw 2 cards. Gain 1 action. You cannot buy any cards this turn."
    effect_upgraded: "Draw 3 cards. Gain 1 action. You cannot buy any cards this turn."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: buy_restriction
        timing: immediate

  - id: fortress_iron_discipline
    name: Iron Discipline
    name_upgraded: Iron Discipline+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Gain 1 resource. Draw 1 card. Gain 1 action."
    effect_upgraded: "Gain 2 resources. Draw 1 card. Gain 1 action."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_fortified_position
    name: Fortified Position
    name_upgraded: Fortified Position+
    type: Passive
    buy_cost: 3
    action_return: 0
    power: 0
    unplayable: true
    vp_formula: fortified_tiles_3
    effect: "+1 VP for every non-base tile you own with a permanent defense bonus of 3 or higher."
    effect_upgraded: "+1 VP for every non-base tile you own with a permanent defense bonus of 2 or higher."
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
    effect: "You receive a Land Grant in your discard pile. Then, target opponent receives a Land Grant in their discard pile. Trash this card."
    effect_upgraded: "You receive 2 Land Grants in your discard pile. Then, target opponent receives a Land Grant in their discard pile. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "You get VP, but must give one to an opponent too. Upgraded version nets +1 VP advantage."

    effects:
      - type: grant_land_grants
        timing: immediate
        target: chosen_player

  - id: fortress_catch_up
    name: Catch Up
    name_upgraded: Catch Up+
    type: Engine
    buy_cost: 2
    action_return: 1
    upgraded_action_return: 2
    power: 0
    effect: "Gain 1 action. If you control the fewest tiles of any player, gain 2 resources."
    effect_upgraded: "Gain 2 actions. If you control the fewest tiles of any player, gain 2 resources."
    secondary_effect: null
    secondary_timing: null
    note: "Comeback mechanic — rewards Fortress for playing slowly. The resource bonus helps fund defense or a late expansion push."

    effects:
      - type: gain_resources
        value: 2
        timing: immediate
        condition: fewest_tiles

