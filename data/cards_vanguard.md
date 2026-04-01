# HexDraft – Vanguard Card Pool
# Archetype: Fast + Strong
# Action Slots: 4
# Identity: High power, expensive to buy, aggressive expansion
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = net-neutral (↺), 2 = net-positive (↑)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stacking_exception: true = this card allows multiple Claims on same tile
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: vanguard_blitz
    name: Blitz
    name_upgraded: Blitz+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 4
    effect: "Claim: Power 4."
    effect_upgraded: "Claim: Power 5."
    secondary_effect: "If successful, draw 1 card next turn."
    secondary_timing: on_resolution
    stacking_exception: false
    effects:
      - type: draw_next_turn
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_overrun
    name: Overrun
    name_upgraded: Overrun+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 5
    effect: "Claim: Power 5. May target a tile up to 2 steps away from any tile you own."
    effect_upgraded: "Claim: Power 6. May target a tile up to 2 steps away from any tile you own."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: vanguard_strike_team
    name: Strike Team
    name_upgraded: Strike Team+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If you played another Claim card this turn, +2 power."
    effect_upgraded: "Claim: Power 3. If you played another Claim card this turn, +3 power."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    effects:
      - type: power_modifier
        value: 2
        timing: on_resolution
        condition: if_played_claim_this_turn

  - id: vanguard_rapid_assault
    name: Rapid Assault
    name_upgraded: Rapid Assault+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 3
    effect: "Claim: Power 3."
    effect_upgraded: "Claim: Power 4."
    secondary_effect: "If successful, opponent must spend 1 resource to contest this tile next round."
    secondary_timing: on_resolution
    stacking_exception: false
    effects:
      - type: contest_cost
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_spearhead
    name: Spearhead
    name_upgraded: Spearhead+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 6
    effect: "Claim: Power 6. Resolve immediately — skip the reveal phase for this tile."
    effect_upgraded: "Claim: Power 7. Resolve immediately — skip the reveal phase for this tile. If successful, gain 2 resources."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    effects:
      - type: immediate_resolve
        timing: immediate

  - id: vanguard_coordinated_push
    name: Coordinated Push
    name_upgraded: Coordinated Push+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 0
    effect: "Claim: Play a second Claim card on the same tile this round. Both cards' power values are added together."
    effect_upgraded: "Claim: Play a second Claim card on the same tile this round. Both cards' power values are added together. If successful, draw 1 card next turn."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: true

  - id: vanguard_double_time
    name: Double Time
    name_upgraded: Double Time+
    type: Engine
    buy_cost: 4
    action_return: 2
    power: 0
    effect: "Engine: Draw 1 card immediately. Gain 2 actions back."
    effect_upgraded: "Engine: Draw 2 cards immediately. Gain 2 actions back."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: vanguard_rally
    name: Rally
    name_upgraded: Rally+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Engine: Draw 2 cards immediately. Discard 1. Gain 1 action back."
    effect_upgraded: "Engine: Draw 3 cards immediately. Discard 1. Gain 1 action back."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    effects:
      - type: self_discard
        value: 1
        timing: immediate
        requires_choice: true

  - id: vanguard_forward_march
    name: Forward March
    name_upgraded: Forward March+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 2
    effect: "Claim: Power 2 on any adjacent neutral tile."
    effect_upgraded: "Claim: Power 3 on any adjacent neutral tile."
    secondary_effect: "If successful, draw 1 card next turn."
    secondary_timing: on_resolution
    stacking_exception: false
    effects:
      - type: draw_next_turn
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_war_cache
    name: War Cache
    name_upgraded: War Cache+
    type: Engine
    buy_cost: 4
    action_return: 1
    power: 0
    effect: "Engine: Gain 3 resources. Draw 1 card next turn. Gain 1 action back."
    effect_upgraded: "Engine: Gain 4 resources. Draw 1 card next turn. Gain 1 action back."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    effects:
      - type: draw_next_turn
        value: 1
        timing: immediate

  - id: vanguard_breakthrough
    name: Breakthrough
    name_upgraded: Breakthrough+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 4
    effect: "Claim: Power 4."
    effect_upgraded: "Claim: Power 5."
    secondary_effect: "If successful, also claim one adjacent neutral tile automatically."
    secondary_timing: on_resolution
    stacking_exception: false
    effects:
      - type: auto_claim_adjacent_neutral
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_flanking_strike
    name: Flanking Strike
    name_upgraded: Flanking Strike+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 3
    effect: "Claim: Power 3. May target any tile adjacent to a tile you own, ignoring normal border adjacency restrictions."
    effect_upgraded: "Claim: Power 4. May target any tile adjacent to a tile you own, ignoring normal border adjacency restrictions."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: vanguard_surge_protocol
    name: Surge Protocol
    name_upgraded: Surge Protocol+
    type: Engine
    buy_cost: 3
    action_return: 2
    power: 0
    effect: "Engine: Gain 2 actions back. One other player of your choice also gains 1 action this turn."
    effect_upgraded: "Engine: Gain 2 actions back. Two other players of your choice each gain 1 action this turn."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    effects:
      - type: grant_actions
        value: 1
        timing: immediate
        target: chosen_player

  - id: vanguard_elite_vanguard
    name: Elite Vanguard
    name_upgraded: Elite Vanguard+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 7
    effect: "Claim: Power 7. Costs 1 less resource to purchase for each VP hex you currently control."
    effect_upgraded: "Claim: Power 8. Costs 1 less resource to purchase for each VP hex you currently control."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false
    effects:
      - type: dynamic_buy_cost
        condition: vp_hexes_controlled
        value: -1
        metadata: {per_unit: true}
