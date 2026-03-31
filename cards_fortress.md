# HexDraft – Fortress Card Pool
# Archetype: Cheap + Strong
# Action Slots: 3
# Identity: High power, deliberate cycle, defensive turtling
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = net-neutral (↺), 2 = net-positive (↑)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stacking_exception: true = this card allows multiple Claims on same tile
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: fortress_fortify
    name: Fortify
    name_upgraded: Fortify+
    type: Defense
    buy_cost: 2
    action_return: 0
    power: 3
    effect: "Defense: One tile you own gains +3 defense power when defending this round."
    effect_upgraded: "Defense: Two tiles you own each gain +3 defense power when defending this round."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: fortress_bulwark
    name: Bulwark
    name_upgraded: Bulwark+
    type: Defense
    buy_cost: 3
    action_return: 0
    power: 2
    effect: "Defense: Two tiles you own each gain +2 defense power when defending this round."
    effect_upgraded: "Defense: Three tiles you own each gain +2 defense power when defending this round."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

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
    stacking_exception: false

  - id: fortress_iron_wall
    name: Iron Wall
    name_upgraded: Iron Wall+
    type: Defense
    buy_cost: 2
    action_return: 0
    power: 0
    effect: "Defense: One tile you own cannot be claimed this round."
    effect_upgraded: "Defense: Two tiles you own cannot be claimed this round."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

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
    stacking_exception: false

  - id: fortress_slow_advance
    name: Slow Advance
    name_upgraded: Slow Advance+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 3
    effect: "Claim: Power 3 on an adjacent tile. If the target is a neutral tile, claim it automatically."
    effect_upgraded: "Claim: Power 4 on an adjacent tile. If the target is a neutral tile, claim it automatically and draw 1 card next turn."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

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
    stacking_exception: false

  - id: fortress_entrench
    name: Entrench
    name_upgraded: Entrench+
    type: Defense
    buy_cost: 1
    action_return: 0
    power: 1
    effect: "Defense: Target tile you own permanently gains +1 defense power until it is captured."
    effect_upgraded: "Defense: Target tile you own permanently gains +2 defense power until it is captured."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    note: "Permanent defense bonus persists across rounds and stacks with round-based Defense cards."

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
    stacking_exception: false

  - id: fortress_stronghold
    name: Stronghold
    name_upgraded: Stronghold+
    type: Defense
    buy_cost: 5
    action_return: 0
    power: 0
    effect: "Defense: One tile you own cannot be claimed this round or next round."
    effect_upgraded: "Defense: Two tiles you own cannot be claimed this round or next round."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: fortress_overwhelming_force
    name: Overwhelming Force
    name_upgraded: Overwhelming Force+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 0
    effect: "Claim: Play a second Claim card on the same tile this round, combining both cards' power values. If the target tile is neutral, gain 1 resource refund."
    effect_upgraded: "Claim: Play a second Claim card on the same tile this round, combining both cards' power values. If the target tile is neutral, gain 2 resource refund."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: true

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
    stacking_exception: false

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
    stacking_exception: false

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
    stacking_exception: false
