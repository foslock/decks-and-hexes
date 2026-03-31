# HexDraft – Neutral Card Pool
# Available to all archetypes from a shared market.
# Each card has a fixed number of copies. When exhausted, the stack is gone for the game.
# Buying out a neutral card stack is a valid denial strategy.
#
# NOTE: Advance and Gather are special starter cards. Every player begins with copies
# in their starting deck. They are NOT part of the shared market and cannot be purchased.
# All other cards below ARE purchasable from the shared market.
#
# EDITING NOTES:
# - copies: number of physical copies in the shared stack (null = starter card only, not in market)
# - action_return: 0 = standard, 1 = net-neutral (↺), 2 = net-positive (↑)
# - starter: true = included in starting decks, not available in market

cards:

  # ── STARTER CARDS (not purchasable) ──────────────────────────────────────

  - id: neutral_advance
    name: Advance
    name_upgraded: Advance+
    type: Claim
    buy_cost: null
    copies: null
    starter: true
    action_return: 0
    power: 1
    effect: "Claim: Power 1 on any adjacent tile."
    effect_upgraded: "Claim: Power 2 on any adjacent tile."
    trash_on_use: false
    note: "The baseline board action. Every archetype starts with copies of this card."

  - id: neutral_gather
    name: Gather
    name_upgraded: Gather+
    type: Engine
    buy_cost: null
    copies: null
    starter: true
    action_return: 0
    power: 0
    effect: "Engine: Gain 2 resources."
    effect_upgraded: "Engine: Gain 3 resources."
    trash_on_use: false
    note: "The baseline economy card. Every archetype starts with copies of this card."

  # ── MARKET CARDS (purchasable) ────────────────────────────────────────────

  - id: neutral_mercenary
    name: Mercenary
    name_upgraded: Mercenary+
    type: Claim
    buy_cost: 3
    copies: 5
    action_return: 0
    power: 3
    effect: "Claim: Power 3 on any adjacent tile."
    effect_upgraded: "Claim: Power 4 on any adjacent tile."
    trash_on_use: false

  - id: neutral_land_grant
    name: Land Grant
    name_upgraded: Land Grant+
    type: Engine
    buy_cost: 2
    copies: 3
    action_return: 0
    power: 0
    effect: "Gain 1 VP immediately. This card is trashed after use."
    effect_upgraded: "Gain 2 VP immediately. This card is trashed after use."
    trash_on_use: true
    note: "One of the few cards that directly awards VP. Limited copies make buying multiples a real investment."

  - id: neutral_sabotage
    name: Sabotage
    name_upgraded: Sabotage+
    type: Engine
    buy_cost: 4
    copies: 3
    action_return: 0
    power: 0
    effect: "Choose a target opponent. That opponent draws 1 fewer card at the start of their next turn."
    effect_upgraded: "Choose a target opponent. That opponent draws 2 fewer cards at the start of their next turn."
    trash_on_use: false

  - id: neutral_truce
    name: Truce
    name_upgraded: Truce+
    type: Engine
    buy_cost: 2
    copies: 4
    action_return: 0
    power: 0
    effect: "You and one chosen opponent cannot contest each other's tiles this round. Neither player may play Claim cards targeting the other's tiles."
    effect_upgraded: "You and up to two chosen opponents cannot contest each other's tiles this round."
    trash_on_use: false

  - id: neutral_road_builder
    name: Road Builder
    name_upgraded: Road Builder+
    type: Engine
    buy_cost: 3
    copies: 3
    action_return: 0
    power: 0
    effect: "Treat two of your non-adjacent tile groups as adjacent to each other this round for purposes of Claim card targeting."
    effect_upgraded: "Treat all of your tile groups as fully adjacent to each other this round for purposes of Claim card targeting."
    trash_on_use: false

  - id: neutral_prospector
    name: Prospector
    name_upgraded: Prospector+
    type: Engine
    buy_cost: 2
    copies: 5
    action_return: 0
    power: 0
    effect: "Engine: Gain 3 resources."
    effect_upgraded: "Engine: Gain 4 resources."
    trash_on_use: false

  - id: neutral_surveyor
    name: Surveyor
    name_upgraded: Surveyor+
    type: Engine
    buy_cost: 3
    copies: 4
    action_return: 0
    power: 0
    effect: "Look at the top 3 cards of any one archetype deck (including your own). Reorder them freely."
    effect_upgraded: "Look at the top 5 cards of any one archetype deck. Reorder them freely."
    trash_on_use: false

  - id: neutral_militia
    name: Militia
    name_upgraded: Militia+
    type: Claim
    buy_cost: 2
    copies: 5
    action_return: 0
    power: 2
    effect: "Claim: Power 2. If you own 3 or more tiles adjacent to the target tile, power is 4 instead."
    effect_upgraded: "Claim: Power 2. If you own 3 or more tiles adjacent to the target tile, power is 5 instead."
    trash_on_use: false

  - id: neutral_eminent_domain
    name: Eminent Domain
    name_upgraded: Eminent Domain+
    type: Claim
    buy_cost: 5
    copies: 3
    action_return: 0
    power: 3
    effect: "Claim: Power 3 on any neutral tile on the board, ignoring adjacency restrictions."
    effect_upgraded: "Claim: Power 4 on any neutral tile on the board, ignoring adjacency restrictions."
    trash_on_use: false

  - id: neutral_fortified_post
    name: Fortified Post
    name_upgraded: Fortified Post+
    type: Defense
    buy_cost: 3
    copies: 3
    action_return: 0
    power: 2
    effect: "Defense: Any one tile you own gains +2 defense power when defending this round."
    effect_upgraded: "Defense: Any one tile you own gains +3 defense power when defending this round."
    trash_on_use: false

  - id: neutral_forced_march
    name: Forced March
    name_upgraded: Forced March+
    type: Engine
    buy_cost: 4
    copies: 3
    action_return: 2
    power: 0
    effect: "Engine: Gain 2 actions back. All other active players also gain 1 action this turn."
    effect_upgraded: "Engine: Gain 2 actions back. All other active players also gain 2 actions this turn."
    trash_on_use: false
    note: "The shared action gain creates diplomatic tension — helping opponents may be worth the tempo."

  - id: neutral_war_bonds
    name: War Bonds
    name_upgraded: War Bonds+
    type: Engine
    buy_cost: 3
    copies: 4
    action_return: 1
    power: 0
    effect: "Engine: Gain 2 resources. Gain 1 action back."
    effect_upgraded: "Engine: Gain 3 resources. Gain 1 action back."
    trash_on_use: false

  - id: neutral_upgrade_credit
    name: Upgrade Credit
    name_upgraded: null
    type: Token
    buy_cost: 5
    copies: 12
    action_return: 0
    power: 0
    effect: "Token: Not a card. At the start of your next turn (before the Plan Phase), spend this token to upgrade any one card in your current hand. Maximum one upgrade per turn. Upgrades are permanent."
    effect_upgraded: null
    trash_on_use: true
    note: "Copies = 2 × max player count. Buying out upgrade credits is a valid denial strategy."
