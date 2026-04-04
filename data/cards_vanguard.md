# HexDraft – Vanguard Card Pool
# Archetype: Fast + Strong
# Action Slots: 4
# Identity: High power, expensive to buy, aggressive expansion
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = gain 1 action (net neutral), 2 = gain 2 actions (net +1)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stackable: true = this card can be played on a tile where you already have a claim this turn
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: vanguard_war_chest
    name: War Chest
    name_upgraded: War Chest+
    type: Engine
    buy_cost: null
    starter: true
    action_return: 0
    power: 0
    effect: "Gain 2 resources."
    effect_upgraded: "Gain 3 resources."
    resource_gain: 2
    upgraded_resource_gain: 3
    note: "Vanguard starter economy card. Fuels purchases of expensive high-power claim cards."

  - id: vanguard_blitz
    name: Blitz
    name_upgraded: Blitz+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 2
    upgraded_power: 3
    effect: "Claim: Power 2."
    effect_upgraded: "Claim: Power 3."
    secondary_effect: "If successful, draw 1 card next turn."
    secondary_timing: on_resolution

    effects:
      - type: draw_next_turn
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_overrun
    name: Overrun
    name_upgraded: Overrun+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 4
    effect: "Claim: Power 4. May target a tile up to 2 steps away from any tile you own."
    effect_upgraded: "Claim: Power 6. May target a tile up to 2 steps away from any tile you own."
    secondary_effect: null
    secondary_timing: null


  - id: vanguard_strike_team
    name: Strike Team
    name_upgraded: Strike Team+
    type: Claim
    buy_cost: 4
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If you played another Claim card this turn, +2 power."
    effect_upgraded: "Claim: Power 3. If you played another Claim card this turn, +3 power."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: power_modifier
        value: 2
        upgraded_value: 3
        timing: on_resolution
        condition: if_played_claim_this_turn

  - id: vanguard_rapid_assault
    name: Rapid Assault
    name_upgraded: Rapid Assault+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If successful against an opponent's tile, they lose 1 resource."
    effect_upgraded: "Claim: Power 4. If successful against an opponent's tile, they lose 1 resource."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: resource_drain
        value: 1
        timing: on_resolution
        condition: if_successful
        target: defender

  - id: vanguard_spearhead
    name: Spearhead
    name_upgraded: Spearhead+
    type: Claim
    buy_cost: 7
    action_return: 0
    power: 5
    effect: "Claim: Power 5."
    effect_upgraded: "Claim: Power 7."
    secondary_effect: null
    secondary_timing: null

  - id: vanguard_coordinated_push
    name: Coordinated Push
    name_upgraded: Coordinated Push+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 3
    effect: "Claim: Power 3. Stackable — can be played on a tile where you already have a claim this turn."
    effect_upgraded: "Claim: Power 4. Stackable."
    secondary_effect: null
    secondary_timing: null
    stackable: true

  - id: vanguard_double_time
    name: Double Time
    name_upgraded: Double Time+
    type: Engine
    buy_cost: 4
    action_return: 2
    power: 0
    effect: "Draw 1 card. Gain 2 actions."
    effect_upgraded: "Draw 2 cards. Gain 2 actions."
    secondary_effect: null
    secondary_timing: null


  - id: vanguard_rally
    name: Rally
    name_upgraded: Rally+
    type: Engine
    buy_cost: 3
    action_return: 1
    power: 0
    effect: "Draw 2 cards. Discard 1 card. Gain 1 action."
    effect_upgraded: "Draw 3 cards. Discard 1 card. Gain 1 action."
    secondary_effect: null
    secondary_timing: null

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
    unoccupied_only: true
    upgraded_unoccupied_only: false
    effect: "Claim: Power 2 on any adjacent neutral tile."
    effect_upgraded: "Claim: Power 3 on any adjacent tile."
    secondary_effect: "If successful, draw 1 card next turn."
    secondary_timing: on_resolution

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
    effect: "Gain 3 resources. Draw 1 card next turn. Gain 1 action."
    effect_upgraded: "Gain 4 resources. Draw 1 card next turn. Gain 1 action."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: draw_next_turn
        value: 1
        timing: immediate

  - id: vanguard_breakthrough
    name: Breakthrough
    name_upgraded: Breakthrough+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 3
    effect: "Claim: Power 3."
    effect_upgraded: "Claim: Power 5."
    secondary_effect: "If successful, also claim one adjacent neutral tile automatically."
    secondary_timing: on_resolution

    effects:
      - type: auto_claim_adjacent_neutral
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_flanking_strike
    name: Flanking Strike
    name_upgraded: Flanking Strike+
    type: Claim
    buy_cost: 5
    action_return: 0
    power: 3
    claim_range: 2
    effect: "Claim: Power 3. May target a tile up to 2 steps away from any tile you own."
    effect_upgraded: "Claim: Power 4. May target a tile up to 2 steps away from any tile you own."
    secondary_effect: null
    secondary_timing: null


  - id: vanguard_surge_protocol
    name: Surge Protocol
    name_upgraded: Surge Protocol+
    type: Engine
    buy_cost: 3
    action_return: 2
    power: 0
    effect: "Gain 2 actions. One other player of your choice gains 1 extra action next turn."
    effect_upgraded: "Gain 2 actions. Two other players of your choice each gain 1 extra action next turn."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: grant_actions_next_turn
        value: 1
        timing: immediate
        target: chosen_player

  - id: vanguard_spoils_of_war
    name: Spoils of War
    name_upgraded: Spoils of War+
    type: Claim
    buy_cost: 6
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If this claim wins a contested tile, the opponent's claim card is permanently trashed."
    effect_upgraded: "Claim: Power 4. If this claim wins a contested tile, the opponent's claim card is permanently trashed."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: trash_opponent_card
        timing: on_resolution
        condition: if_successful
        value: 1

  - id: vanguard_elite_vanguard
    name: Elite Vanguard
    name_upgraded: Elite Vanguard+
    type: Claim
    buy_cost: 8
    action_return: 0
    power: 6
    effect: "Claim: Power 6. Costs 1 less resource to purchase for each VP hex you currently control."
    effect_upgraded: "Claim: Power 8. Costs 1 less resource to purchase for each VP hex you currently control."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: dynamic_buy_cost
        condition: vp_hexes_controlled
        value: -1
        metadata: {per_unit: true}

  - id: vanguard_battle_glory
    name: Battle Glory
    name_upgraded: Battle Glory+
    type: Passive
    buy_cost: 4
    action_return: 0
    power: 0
    unplayable: true
    vp_formula: contested_wins
    effect: "Passive: While in your hand, if you win 2 or more contested tiles this turn, this card permanently gains +1 VP."
    effect_upgraded: "Passive: While in your hand, if you win 2 or more contested tiles this turn, this card permanently gains +2 VP."
    secondary_effect: null
    secondary_timing: null
    note: "Escalating VP engine — grows each round you hit the threshold while in hand. Takes up a hand slot when drawn."

    effects:
      - type: vp_from_contested_wins
        value: 1
        upgraded_value: 2
        timing: on_resolution
        metadata: {required_wins: 2}

  - id: vanguard_counterattack
    name: Counterattack
    name_upgraded: Counterattack+
    type: Defense
    buy_cost: 3
    action_return: 0
    power: 0
    defense_bonus: 2
    upgraded_defense_bonus: 3
    effect: "One tile you own gains +2 defense this round. If an opponent's claim on this tile fails, gain 1 resource."
    effect_upgraded: "One tile you own gains +3 defense this round. If an opponent's claim on this tile fails, gain 2 resources."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: defense_bonus
        value: 2
        upgraded_value: 3
        timing: on_resolution
      - type: gain_resources
        value: 1
        upgraded_value: 2
        timing: on_resolution
        condition: if_defender_holds

  - id: vanguard_rearguard
    name: Rearguard
    name_upgraded: Rearguard+
    type: Defense
    buy_cost: 4
    action_return: 0
    power: 0
    defense_bonus: 3
    upgraded_defense_bonus: 4
    effect: "One tile you own gains +3 defense this round."
    effect_upgraded: "One tile you own gains +4 defense this round."
    secondary_effect: null
    secondary_timing: null

  - id: vanguard_arsenal
    name: Arsenal
    name_upgraded: Arsenal+
    type: Passive
    buy_cost: 4
    action_return: 0
    power: 0
    unplayable: true
    vp_formula: deck_div_10
    effect: "+1 VP for every 10 cards in your deck."
    effect_upgraded: "+1 VP for every 8 cards in your deck."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards aggressive card purchasing. Creates a strategic fork: thin for efficiency or bulk up for VP. Takes up a hand slot when drawn."
