# Card Clash – Vanguard Card Pool
# Archetype: Fast + Strong
# Action Slots: 4
# Identity: High power, expensive to buy, aggressive expansion
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = gain 1 action (net neutral), 2 = gain 2 actions (net +1)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stackable: true = this card can be played on a tile where you already have a claim this round
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: vanguard_war_tithe
    name: War Tithe
    name_upgraded: War Tithe+
    type: Engine
    buy_cost: 4
    action_return: 0
    power: 0
    resource_gain: 0
    upgraded_resource_gain: 0
    effect: "Gain 1 resource for each tile you successfully claimed last round (max 4)."
    effect_upgraded: "Gain 2 resources for each tile you successfully claimed last round (max 8). Draw 1 card."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards sustained aggression across rounds. Creates a virtuous cycle: claim tiles → fund more claims."

    effects:
      - type: resources_per_claims_last_round
        value: 1
        upgraded_value: 2
        timing: immediate
        metadata: {max_resources: 4, upgraded_max_resources: 8, upgraded_draw: 1}

  - id: vanguard_blitz
    name: Blitz
    name_upgraded: Blitz+
    type: Claim
    buy_cost: 4
    action_return: 0
    reversible: true
    power: 2
    upgraded_power: 3
    effect: "Claim: Power 2."
    effect_upgraded: "Claim: Power 3."
    secondary_effect: "If successful, draw 1 card next round."
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
    buy_cost: 7
    action_return: 0
    action_cost: 2
    reversible: true
    power: 4
    claim_range: 2
    effect: "Claim: Power 4. May target a tile up to 2 steps away from any tile you own. Costs 2 actions to play."
    effect_upgraded: "Claim: Power 6. May target a tile up to 2 steps away from any tile you own. Costs 2 actions to play."
    secondary_effect: null
    secondary_timing: null


  - id: vanguard_strike_team
    name: Strike Team
    name_upgraded: Strike Team+
    type: Claim
    buy_cost: 5
    action_return: 0
    reversible: true
    power: 3
    effect: "Claim: Power 3. If you played another Claim card this round, +2 power."
    effect_upgraded: "Claim: Power 3. If you played another Claim card this round, +3 power."
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
    buy_cost: 6
    action_return: 0
    reversible: true
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
    buy_cost: 8
    action_return: 0
    power: 8
    upgraded_power: 9
    resource_gain: 0
    upgraded_resource_gain: 0
    trash_on_use: true
    effect: "Claim: Power 8. Trash this card."
    effect_upgraded: "Claim: Power 9. If successful, gain 5 resources. Trash this card."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: gain_resources
        value: 0
        upgraded_value: 5
        timing: on_resolution
        condition: if_successful

  - id: vanguard_coordinated_push
    name: Coordinated Push
    name_upgraded: Coordinated Push+
    type: Claim
    buy_cost: 6
    action_return: 0
    reversible: true
    power: 3
    effect: "Claim: Power 3. Stackable."
    effect_upgraded: "Claim: Power 4. Stackable."
    secondary_effect: null
    secondary_timing: null
    stackable: true

  - id: vanguard_double_time
    name: Double Time
    name_upgraded: Double Time+
    type: Engine
    buy_cost: 5
    action_return: 2
    power: 0
    effect: "Draw 1 card. Gain 2 actions."
    effect_upgraded: "Draw 2 cards. Gain 2 actions."
    secondary_effect: null
    secondary_timing: null


  - id: vanguard_rally
    name: Regroup
    name_upgraded: Regroup+
    type: Engine
    buy_cost: 4
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
    reversible: true
    power: 1
    upgraded_power: 3
    unoccupied_only: true
    upgraded_unoccupied_only: false
    effect: "Claim: Power 1 on any adjacent neutral tile."
    effect_upgraded: "Claim: Power 3 on any adjacent tile."
    secondary_effect: "If successful, draw 1 card next round."
    secondary_timing: on_resolution

    effects:
      - type: draw_next_turn
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_war_cache
    name: Plunder
    name_upgraded: Plunder+
    type: Engine
    buy_cost: 5
    action_return: 1
    power: 0
    effect: "Gain 4 resources. Draw 1 card next round. Gain 1 action."
    effect_upgraded: "Gain 5 resources. Draw 1 card next round. Gain 1 action."
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
    buy_cost: 7
    action_return: 0
    power: 3
    effect: "Claim: Power 3. If successful, randomly claim up to one available adjacent neutral tile automatically."
    effect_upgraded: "Claim: Power 5. If successful, randomly claim up to one available adjacent neutral tile automatically."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: auto_claim_adjacent_neutral
        value: 1
        timing: on_resolution
        condition: if_successful

  - id: vanguard_flanking_strike
    name: Flanking Strike
    name_upgraded: Flanking Strike+
    type: Claim
    buy_cost: 6
    action_return: 0
    reversible: true
    power: 2
    upgraded_power: 3
    claim_range: 2
    effect: "Claim: Power 2. May target a tile up to 2 steps away from any tile you own."
    effect_upgraded: "Claim: Power 3. May target a tile up to 2 steps away from any tile you own."
    secondary_effect: null
    secondary_timing: null


  - id: vanguard_surge_protocol
    name: Battle Cry
    name_upgraded: Battle Cry+
    type: Engine
    buy_cost: 4
    action_return: 2
    upgraded_action_return: 3
    power: 0
    effect: "Gain 2 actions. Target opponent gains 1 extra action next round."
    effect_upgraded: "Gain 3 actions."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: grant_actions_next_turn
        value: 1
        upgraded_value: 0
        timing: on_resolution
        target: chosen_player

  - id: vanguard_spoils_of_war
    name: Spoils of War
    name_upgraded: Spoils of War+
    type: Claim
    buy_cost: 7
    action_return: 0
    reversible: true
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
    buy_cost: 9
    action_return: 0
    action_cost: 2
    reversible: true
    power: 6
    effect: "Claim: Power 6. Costs 1 less resource to purchase for each VP tile you currently control. Costs 2 actions to play."
    effect_upgraded: "Claim: Power 8. Costs 1 less resource to purchase for each VP tile you currently control. Costs 2 actions to play."
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
    buy_cost: 5
    action_return: 0
    power: 0
    unplayable: true
    unique: true
    vp_formula: contested_wins
    effect: "Passive: While in your hand, if you win 2 or more contested tiles this round, this card permanently gains +1 VP."
    effect_upgraded: "Passive: While in your hand, if you win 2 or more contested tiles this round, this card permanently gains +2 VP."
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
    reversible: true
    power: 0
    defense_bonus: 2
    upgraded_defense_bonus: 3
    resource_gain: 0
    upgraded_resource_gain: 0
    effect: "One tile you own gains +2 defense this round. If an opponent's claim on this tile fails, draw 1 card next round."
    effect_upgraded: "One tile you own gains +3 defense this round. If an opponent's claim on this tile fails, draw 1 card next round."
    secondary_effect: null
    secondary_timing: null

    effects:
      - type: defense_bonus
        value: 2
        upgraded_value: 3
        timing: on_resolution
      - type: draw_next_turn
        value: 1
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
    resource_gain: 3
    upgraded_resource_gain: 3
    effect: "One tile you own gains +3 defense this round. Gain 3 resources."
    effect_upgraded: "One tile you own gains +4 defense this round. Gain 3 resources."
    secondary_effect: null
    secondary_timing: null

  - id: vanguard_arsenal
    name: Arsenal
    name_upgraded: Arsenal+
    type: Passive
    buy_cost: 5
    action_return: 0
    power: 0
    unplayable: true
    unique: true
    vp_formula: deck_div_10
    effect: "+1 VP for every 10 cards in your deck."
    effect_upgraded: "+1 VP for every 8 cards in your deck."
    secondary_effect: null
    secondary_timing: null
    note: "Rewards aggressive card purchasing. Creates a strategic fork: thin for efficiency or bulk up for VP. Takes up a hand slot when drawn."

  - id: vanguard_demon_pact
    name: Demon Pact
    name_upgraded: Demon Pact+
    type: Claim
    buy_cost: 8
    action_return: 0
    power: 10
    upgraded_power: 12
    effect: "Trash exactly 3 other cards from your hand. Claim: Power 10."
    effect_upgraded: "Trash exactly 3 other cards from your hand. Claim: Power 12."
    secondary_effect: null
    secondary_timing: null
    note: "The highest raw power in the game. Requires sacrificing 3 cards — nearly your whole hand. Cannot be played with fewer than 3 other cards in hand."

    effects:
      - type: mandatory_self_trash
        value: 3
        timing: immediate
        requires_choice: true
        metadata: {exact: true}

  - id: vanguard_financier
    name: Financier
    name_upgraded: Financier+
    type: Engine
    buy_cost: 8
    action_return: 0
    upgraded_action_return: 2
    power: 0
    resource_gain: 0
    draw_cards: 0
    effect: "Draw 1 card for each Debt you have in your deck."
    effect_upgraded: "Draw 1 card for each Debt you have in your deck. Gain 2 actions."
    secondary_effect: null
    secondary_timing: null
    note: "Turns the Debt penalty into a card draw engine. Expensive at 7 cost, but becomes very powerful when loaded with Debt cards. Upgraded version also grants 2 actions, making it a net-positive action card."

    effects:
      - type: draw_per_debt
        value: 1
        timing: immediate

  - id: vanguard_war_economy
    name: War Economy
    name_upgraded: War Economy+
    type: Engine
    buy_cost: 6
    action_return: 0
    power: 0
    draw_cards: 1
    upgraded_draw_cards: 2
    effect: "Gain 1 resource for every 4 tiles you own (rounded down). Draw 1 card."
    effect_upgraded: "Gain 1 resource for every 3 tiles you own (rounded down). Draw 2 cards."
    secondary_effect: null
    secondary_timing: null
    note: "Territory-scaling economy. Rewards Vanguard for building and holding a large footprint. Becomes 3-5+ resources mid-game as territory grows."

    effects:
      - type: resources_per_tiles_owned
        timing: immediate
        value: 4
        upgraded_value: 3
        metadata: {divisor_based: true}

  - id: vanguard_arms_dealer
    name: Arms Dealer
    name_upgraded: Arms Dealer+
    type: Engine
    buy_cost: 3
    action_return: 0
    power: 0
    effect: "Trash 1 card from your hand. If it was a Claim card, gain resources equal to double its effective power and gain 1 action."
    effect_upgraded: "Trash 1 card from your hand. If it was a Claim card, gain resources equal to double its effective power and gain 2 actions."
    secondary_effect: null
    secondary_timing: null
    note: "Combat-themed deck thinning. Uses effective power (including upgrades and printed modifiers), not base power. Turns outgrown Explores (0 res) into deck thinning, or surplus Claim cards into fuel."

    effects:
      - type: trash_gain_power
        value: 2
        timing: immediate
        requires_choice: true
        metadata: {optional: true, multiplier: 2, claim_only_bonus: true, use_effective_power: true, claim_action_return: 1, upgraded_claim_action_return: 2}

  - id: vanguard_ultimatum
    name: Ultimatum
    name_upgraded: Ultimatum+
    type: Claim
    buy_cost: 10
    action_return: 0
    action_cost: 3
    power: 8
    upgraded_power: 10
    draw_cards: 2
    upgraded_draw_cards: 3
    unique: true
    effect: "Claim: Power 8. Draw 2 cards. Costs 3 actions to play."
    effect_upgraded: "Claim: Power 10. Draw 3 cards. Costs 3 actions to play."
    secondary_effect: null
    secondary_timing: null
    note: "The biggest single-card play in the Vanguard arsenal. Burns nearly your entire turn but delivers massive power and card advantage. Unique — only one copy allowed per deck."
