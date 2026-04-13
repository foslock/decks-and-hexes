# Card Clash – Fortress Card Pool
# Archetype: Cheap + Strong
# Action Slots: 3
# Identity: High power, deliberate cycle, defensive turtling
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = gain 1 action (net neutral), 2 = gain 2 actions (net +1)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stackable: true = this card can be played on a tile where you already have a claim this round
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: fortress_warden
    name: Warden
    name_upgraded: Warden+
    type: Passive
    buy_cost: 4
    action_return: 0
    power: 0
    unplayable: true
    unique: true
    vp_formula: uncaptured_tiles_8
    effect: "+1 VP for every 8 tiles you own that have never changed hands since you claimed them."
    effect_upgraded: "+1 VP for every 6 tiles you own that have never changed hands since you claimed them."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards holding ground permanently. Tiles lost and recaptured don't count. Takes up a hand slot when drawn."

    effects:
      - type: vp_from_uncaptured_tiles
        value: 8
        upgraded_value: 6
        timing: on_resolution
        metadata: {divisor: 8, upgraded_divisor: 6}

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
    reversible: true
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
    reversible: true
    power: 3
    upgraded_power: 4
    effect: "Claim: Power 3. Ignores temporary defense bonuses on targeted tile."
    effect_upgraded: "Claim: Power 4. Ignores temporary defense bonuses on targeted tile."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: ignore_defense
        timing: on_resolution

  - id: fortress_iron_wall
    name: Iron Wall
    name_upgraded: Iron Wall+
    type: Defense
    buy_cost: 4
    action_return: 0
    reversible: true
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
        timing: on_resolution

  - id: fortress_garrison
    name: Garrison
    name_upgraded: Garrison+
    type: Claim
    buy_cost: 3
    action_return: 0
    reversible: true
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
    name: Mountaineer
    name_upgraded: Mountaineer+
    type: Claim
    buy_cost: 4
    action_return: 0
    reversible: true
    power: 2
    upgraded_power: 4
    effect: "Claim: Power 2. If the targeted tile is neutral, Power 4."
    effect_upgraded: "Claim: Power 4."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 2
        upgraded_value: 0
        timing: on_resolution
        condition: if_target_neutral

  - id: fortress_supply_line
    name: Supply Line
    name_upgraded: Supply Line+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Gain 2 resources. Gain 1 action. Your next purchase this round costs 1 less."
    effect_upgraded: "Gain 3 resources. Gain 1 action. Your next purchase this round costs 1 less."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: cost_reduction
        value: 1
        timing: on_resolution
        metadata: {scope: "any_one_card"}

  - id: fortress_entrench
    name: Entrench
    name_upgraded: Entrench+
    type: Defense
    buy_cost: 1
    action_return: 0
    reversible: true
    power: 0
    defense_bonus: 0
    effect: "One tile you own permanently gains +1 defense until it is captured."
    effect_upgraded: "One tile you own permanently gains +2 defense until it is captured."
    secondary_effect: null
    secondary_timing: null

    note: "Permanent defense bonus persists across rounds and stacks with round-based Defense cards."

    effects:
      - type: permanent_defense
        value: 1
        timing: on_resolution
        metadata: {upgraded_value: 2}

  - id: fortress_war_of_attrition
    name: Attrition
    name_upgraded: Attrition+
    type: Claim
    buy_cost: 3
    action_return: 0
    reversible: true
    power: 2
    effect: "Claim: Power 2. If the defender holds, they draw 1 fewer card next round."
    effect_upgraded: "Claim: Power 3. If the defender holds, they draw 1 fewer card next round."
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
    buy_cost: 6
    action_return: 0
    reversible: true
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
        timing: on_resolution

  - id: fortress_overwhelming_force
    name: Juggernaut
    name_upgraded: Juggernaut+
    type: Claim
    buy_cost: 4
    action_return: 0
    reversible: true
    power: 3
    effect: "Claim: Power 3. Stackable. If the target tile is neutral, gain 2 resources."
    effect_upgraded: "Claim: Power 4. Stackable. If the target tile is neutral, gain 3 resources."
    secondary_effect: null
    secondary_timing: null
    stackable: true
    effects:
      - type: resource_refund_if_neutral
        value: 2
        upgraded_value: 3
        timing: on_resolution
        condition: if_target_neutral

  - id: fortress_consolidate
    name: Consolidate
    name_upgraded: Consolidate+
    type: Engine
    buy_cost: 4
    action_return: 0
    power: 0
    effect: "Trash 1 card from your hand. If you did, gain resources equal to half that card's buy cost (rounded down) and draw 1 card."
    effect_upgraded: "Trash 1 card from your hand. If you did, gain resources equal to half that card's buy cost (rounded down) +2 and draw 1 card."
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
    action_cost: 2
    reversible: true
    power: 5
    effect: "Claim: Power 5. If the target tile has any defense bonuses, gain +2 power. Costs 2 actions to play."
    effect_upgraded: "Claim: Power 7. If the target tile has any defense bonuses, gain +3 power. Costs 2 actions to play."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 2
        upgraded_value: 3
        timing: on_resolution
        condition: if_target_has_defense

  - id: fortress_citadel
    name: Twin Cities
    name_upgraded: Twin Cities+
    type: Defense
    buy_cost: 7
    action_return: 0
    power: 0
    defense_target_count: 2
    upgraded_defense_target_count: 2
    trash_on_use: true
    effect: "Two tiles you own each get +3 permanent defense until captured. Trash this card."
    effect_upgraded: "Two tiles you own each get +5 permanent defense until captured. Trash this card."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: permanent_defense
        value: 3
        timing: on_resolution
        metadata: {upgraded_value: 5}

  - id: fortress_war_council
    name: Grand Strategy
    name_upgraded: Grand Strategy+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    draw_cards: 2
    upgraded_draw_cards: 3
    effect: "Draw 2 cards. Gain 1 action. You cannot buy any cards this round."
    effect_upgraded: "Draw 3 cards. Gain 1 action. You cannot buy any cards this round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: buy_restriction
        timing: on_resolution

  - id: fortress_iron_discipline
    name: Iron Discipline
    name_upgraded: Iron Discipline+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Gain 2 resources. Draw 1 card. Gain 1 action."
    effect_upgraded: "Gain 3 resources. Draw 1 card. Gain 1 action."
    secondary_effect: null
    secondary_timing: null


  - id: fortress_fortified_position
    name: Ironclad
    name_upgraded: Ironclad+
    type: Passive
    buy_cost: 3
    action_return: 0
    power: 0
    unplayable: true
    unique: true
    vp_formula: fortified_tiles_3
    effect: "+1 VP for every non-base tile you own with a permanent defense bonus of 3 or higher."
    effect_upgraded: "+1 VP for every non-base tile you own with a permanent defense bonus of 2 or higher."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards Entrench investment. Fluctuates as tiles are lost or captured. Takes up a hand slot when drawn."

  - id: fortress_toll_road
    name: Toll Road
    name_upgraded: Toll Road+
    type: Engine
    buy_cost: 5
    action_return: 0
    power: 0
    effect: "Draw 2 cards for each connected VP tile you own."
    effect_upgraded: "Draw 3 cards for each connected VP tile you own."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards VP hex connectivity with massive card draw. Upgraded version draws 3 per tile."

    effects:
      - type: draw_per_connected_vp
        timing: immediate
        value: 2
        upgraded_value: 3

  - id: fortress_catch_up
    name: Resilience
    name_upgraded: Resilience+
    type: Engine
    buy_cost: 2
    action_return: 1
    upgraded_action_return: 2
    power: 0
    effect: "Gain 1 action. If you control the fewest tiles of any player, gain 3 resources."
    effect_upgraded: "Gain 2 actions. If you control the fewest tiles of any player, gain 3 resources."
    secondary_effect: null
    secondary_timing: null
    note: "Comeback mechanic — rewards Fortress for playing slowly. The resource bonus helps fund defense or a late expansion push."

    effects:
      - type: gain_resources
        value: 3
        timing: immediate
        condition: fewest_tiles

  - id: fortress_mulligan
    name: Mulligan
    name_upgraded: Mulligan+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Discard your entire hand. Draw that many cards. Gain 1 action."
    effect_upgraded: "Discard your entire hand. Draw that many cards +1. Gain 1 action."
    secondary_effect: null
    secondary_timing: null
    note: "Full hand reset. Lets Fortress throw back a bad draw and try again. The action refund means it doesn't cost tempo."

    effects:
      - type: mulligan
        timing: immediate

  - id: fortress_robin_hood
    name: Robin Hood
    name_upgraded: Robin Hood+
    type: Engine
    buy_cost: 3
    action_return: 0
    power: 0
    effect: "Gain 3 resources for each tile that was captured from you last round."
    effect_upgraded: "Gain 5 resources for each tile that was captured from you last round."
    secondary_effect: null
    secondary_timing: null
    note: "Turns territorial losses into economic fuel. Creates a deterrent: opponents know that taking Fortress tiles feeds their economy."

    effects:
      - type: resources_per_tiles_lost
        value: 3
        upgraded_value: 5
        timing: immediate

  - id: fortress_scorched_retreat
    name: Scorched Retreat
    name_upgraded: Scorched Retreat+
    type: Engine
    buy_cost: 4
    action_return: 0
    power: 0
    trash_on_use: true
    target_own_tile: true
    effect: "Abandon a tile you own. It becomes blocked terrain. Gain 3 resources. Trash this card."
    effect_upgraded: "Abandon a tile you own. It becomes blocked terrain. Gain 4 resources. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "Strategic denial — if you can't hold it, nobody gets it. One-time use prevents abuse."

    effects:
      - type: abandon_and_block
        value: 3
        upgraded_value: 4
        timing: on_resolution

  - id: fortress_snowy_holiday
    name: Snowy Holiday
    name_upgraded: Snowy Holiday+
    type: Engine
    buy_cost: 5
    action_return: 0
    power: 0
    trash_on_use: true
    effect: "Next round, no player can play Claim cards. Trash this card."
    effect_upgraded: "Next round, no player can play Claim cards. Draw 2 cards. Trash this card."
    secondary_effect: null
    secondary_timing: null
    note: "The panic button. Buys Fortress one round of absolute safety. The upgraded version draws cards so the stalled round isn't wasted."

    effects:
      - type: global_claim_ban
        timing: on_resolution
        duration: 1

  - id: fortress_aegis
    name: Aegis
    name_upgraded: Aegis+
    type: Defense
    buy_cost: 10
    action_return: 0
    action_cost: 3
    reversible: true
    power: 0
    defense_bonus: 5
    upgraded_defense_bonus: 6
    defense_target_count: 4
    upgraded_defense_target_count: 5
    unique: true
    effect: "Four tiles you own gain +5 defense this round. Costs 3 actions to play."
    effect_upgraded: "Five tiles you own gain +6 defense this round. Costs 3 actions to play."
    secondary_effect: null
    secondary_timing: null
    note: "The ultimate defensive play. Locks down a huge swath of territory for one round. Unique — only one copy allowed per deck."

