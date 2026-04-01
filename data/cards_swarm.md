# HexDraft – Swarm Card Pool
# Archetype: Fast + Cheap
# Action Slots: 4
# Identity: Low power, cheap to buy, floods the board with many tiles
#
# EDITING NOTES:
# - action_return: 0 = standard, 1 = net-neutral (↺), 2 = net-positive (↑)
# - timing: "immediate" | "on_resolution" | "next_turn"
# - stacking_exception: true = this card allows multiple Claims on same tile
# - upgraded: the "+" version of the card after spending an upgrade credit

cards:

  - id: swarm_scout
    name: Scout
    name_upgraded: Scout+
    type: Claim
    buy_cost: 1
    action_return: 0
    power: 1
    unoccupied_only: true
    effect: "Claim: Power 1 on any adjacent unoccupied tile."
    effect_upgraded: "Claim: Power 2 on any adjacent unoccupied tile."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: swarm_surge
    name: Surge
    name_upgraded: Surge+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 1
    effect: "Claim: Power 1 on up to 2 adjacent tiles simultaneously."
    effect_upgraded: "Claim: Power 1 on up to 3 adjacent tiles simultaneously."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

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
    stacking_exception: false

  - id: swarm_swarm_tactics
    name: Swarm Tactics
    name_upgraded: Swarm Tactics+
    type: Engine
    buy_cost: 1
    action_return: 2
    power: 0
    effect: "Engine: Draw 2 cards immediately. Gain 2 actions back."
    effect_upgraded: "Engine: Draw 3 cards immediately. Gain 2 actions back."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: swarm_cheap_shot
    name: Cheap Shot
    name_upgraded: Cheap Shot+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 2
    effect: "Claim: Power 2. Costs 1 less resource to purchase if you own more tiles than the target tile's controller."
    effect_upgraded: "Claim: Power 3. Costs 1 less resource to purchase if you own more tiles than the target tile's controller."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: swarm_proliferate
    name: Proliferate
    name_upgraded: Proliferate+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 1
    effect: "Claim: Power 1 on any neutral tile on the board, ignoring adjacency restrictions."
    effect_upgraded: "Claim: Power 2 on any neutral tile on the board, ignoring adjacency restrictions."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

  - id: swarm_flood
    name: Flood
    name_upgraded: Flood+
    type: Claim
    buy_cost: 2
    action_return: 0
    power: 1
    effect: "Claim: Power 1 on all neutral tiles adjacent to one tile you own, simultaneously."
    effect_upgraded: "Claim: Power 2 on all neutral tiles adjacent to one tile you own, simultaneously."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: false

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
    stacking_exception: false

  - id: swarm_dog_pile
    name: Dog Pile
    name_upgraded: Dog Pile+
    type: Claim
    buy_cost: 3
    action_return: 0
    power: 0
    effect: "Claim: Play any number of additional Claim cards on the same tile this round. Each additional Claim card adds +1 power on top of its own value."
    effect_upgraded: "Claim: Play any number of additional Claim cards on the same tile this round. Each additional Claim card adds +2 power on top of its own value."
    secondary_effect: null
    secondary_timing: null
    stacking_exception: true

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
    stacking_exception: false

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
    stacking_exception: false

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
    stacking_exception: false

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
    stacking_exception: false

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
    stacking_exception: false
