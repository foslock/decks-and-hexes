# Card Clash – Passive Abilities Pool
# At game start, n+2 passives are drawn randomly (n = active players).
# Drafted in reverse turn order. Each player selects 1. Undrafted passives are discarded.
# Passives are permanent for the entire game.
#
# EDITING NOTES:
# - category: "territorial" | "deck_hand" | "combat" | "resource" | "objective_vp"
# - best_for: archetype(s) this passive most benefits (informational only, not restrictive)
# - effect: the precise, permanent effect of this passive

passives:

  # ── TERRITORIAL PASSIVES ─────────────────────────────────────────────────

  - id: passive_pathfinder
    name: Pathfinder
    category: territorial
    best_for: ["any"]
    effect: "You may play Claim cards targeting blocked terrain tiles as if they were neutral tiles (implicit defense 0). Claimed blocked tiles function as normal owned tiles."
    notes: "The terrain-unlock passive. Creates unique expansion routes no other player can use."

  - id: passive_fortified_borders
    name: Fortified Borders
    category: territorial
    best_for: ["fortress"]
    effect: "All tiles you own that are adjacent to at least one blocked terrain hex gain +1 permanent defense power. This bonus is applied at game start and updates immediately whenever you claim a tile adjacent to blocked terrain."
    notes: "Rewards hugging the terrain. Strong on boards with clustered blocked tiles."

  - id: passive_expansionist
    name: Expansionist
    category: territorial
    best_for: ["swarm"]
    effect: "The first Claim card you play each round costs 0 resources to purchase (when you buy it in a future buy phase). Track which card type you played first this round; when you next purchase that card, the cost is reduced by its full buy cost, once."
    notes: "Accelerates early spread. Rewards playing cheap Claim cards first each round."

  - id: passive_deep_roots
    name: Deep Roots
    category: territorial
    best_for: ["fortress"]
    effect: "Any tile you have owned for 3 or more consecutive rounds gains +1 permanent defense power. This bonus is lost if the tile is captured and reclaimed."
    notes: "Rewards holding ground. Stacks with Entrench. Long games benefit this passive more."

  - id: passive_border_patrol
    name: Border Patrol
    category: territorial
    best_for: ["fortress", "vanguard"]
    effect: "Opponents must spend 1 additional resource when using the Retain mechanic on any card that targets one of your tiles."
    notes: "Soft deterrent against opponents planning around your defenses."

  - id: passive_surveyors_eye
    name: Surveyor's Eye
    category: territorial
    best_for: ["any"]
    effect: "Once per game, before starting corner positions are chosen, you may view the complete blocked terrain and VP hex layout of the board before making your decision."
    notes: "Pure information advantage at setup. Particularly strong on larger boards."

  - id: passive_homefront
    name: Homefront
    category: territorial
    best_for: ["fortress"]
    effect: "Your two starting tiles each gain +2 permanent defense power at game start. This bonus cannot be removed by any card effect."
    notes: "Protects your base. Strong in aggressive 6-player games where early attacks are common."

  - id: passive_manifest_destiny
    name: Manifest Destiny
    category: territorial
    best_for: ["swarm", "vanguard"]
    effect: "Once per game, during the Plan Phase, you may claim any one neutral tile on the board ignoring adjacency restrictions, for free (no Claim card required, no action cost)."
    notes: "One free Proliferate effect. Timing matters — best used to grab a VP hex or block a path."

  # ── DECK & HAND PASSIVES ─────────────────────────────────────────────────

  - id: passive_archivist
    name: Archivist
    category: deck_hand
    best_for: ["fortress"]
    effect: "The resource cost to Retain an archetype market card is reduced from 3 to 1."
    notes: "Fortress's slow cycle means they benefit most from holding specific cards across turns."

  - id: passive_veteran
    name: Veteran
    category: deck_hand
    best_for: ["any"]
    effect: "At game start, after choosing your archetype, add 1 extra copy of any card already in your starting deck to your starting deck."
    notes: "Small early edge. Most impactful when duplicating a key engine card."

  - id: passive_iron_discipline_passive
    name: Iron Discipline
    category: deck_hand
    best_for: ["fortress"]
    effect: "Whenever you trash a card from your deck (via any card effect), gain 1 additional resource beyond any other effect."
    notes: "Pairs with Consolidate, Thin the Herd, and Scavenger passive. Strong in thin-deck builds."

  - id: passive_recycler
    name: Recycler
    category: deck_hand
    best_for: ["swarm"]
    effect: "Once per round, during Phase 1 (Start of Turn) before drawing your hand, you may trash 1 card from your discard pile. If you do, draw 1 extra card this turn."
    notes: "Accelerates deck thinning without costing an action slot. Swarm builds benefit from lean decks."

  - id: passive_curator
    name: Curator
    category: deck_hand
    best_for: ["any"]
    effect: "You may look at the top card of your deck at any time, including during the Plan Phase. You do not draw it — only view it."
    notes: "Reduces bad draws. Knowing what's coming enables better planning in the simultaneous phase."

  - id: passive_hoarder
    name: Hoarder
    category: deck_hand
    best_for: ["fortress"]
    effect: "You do not pay the 1 resource upkeep at the start of your turn. However, your maximum resource total is capped at 8."
    notes: "Removes the save-or-lose-it pressure. Cap prevents snowballing. Strong for patient Fortress players."

  - id: passive_efficient
    name: Efficient
    category: deck_hand
    best_for: ["vanguard", "swarm"]
    effect: "Once per game, at the start of Phase 1, you may draw your entire deck into your hand instead of your normal hand size. The 6-action cap still applies. All unplayed cards are discarded at end of turn as normal."
    notes: "One explosive turn. Best saved for a critical round near the VP win threshold."

  - id: passive_scavenger
    name: Scavenger
    category: deck_hand
    best_for: ["fortress"]
    effect: "Whenever you trash a card from your deck (via any card effect), gain 1 resource. This stacks with Iron Discipline passive if both are held."
    notes: "Double synergy with Consolidate and Thin the Herd. Fortress can build a strong resource engine."

  # ── COMBAT PASSIVES ──────────────────────────────────────────────────────

  - id: passive_blitz_doctrine
    name: Blitz Doctrine
    category: combat
    best_for: ["vanguard", "swarm"]
    effect: "If you successfully claim 2 or more tiles in a single round, draw 1 extra card at the start of your next turn."
    notes: "Rewards aggression. Compounds with action engine cards for sustained pressure."

  - id: passive_tactical_genius
    name: Tactical Genius
    category: combat
    best_for: ["vanguard"]
    effect: "Once per round, after all cards are revealed in the Reveal Phase but before resolution begins, you may move one of your already-placed Claim cards to a different adjacent tile."
    notes: "Highest skill ceiling passive. Allows reactive repositioning after seeing opponent plays."

  - id: passive_war_of_nerves
    name: War of Nerves
    category: combat
    best_for: ["vanguard"]
    effect: "Whenever you win a contested tile battle (successfully claim a tile that was defended by an opponent), the losing opponent loses 1 resource."
    notes: "Economic attrition. Compounds quickly in aggressive games."

  - id: passive_precision_strike
    name: Precision Strike
    category: combat
    best_for: ["fortress"]
    effect: "Your Claim cards that target a tile exactly 1 step away from an owned tile gain +1 power."
    notes: "Rewards tight positional play. Fortress's deliberate expansion style naturally triggers this."

  - id: passive_momentum
    name: Momentum
    category: combat
    best_for: ["vanguard"]
    effect: "Each consecutive round in which you successfully claim at least 1 tile, all your Claim cards gain +1 power (cumulative). This bonus resets to 0 if you claim no tiles in a round. Maximum bonus: +3."
    notes: "Snowball aggression. The reset condition means defensive opponents can interrupt it."

  - id: passive_counterpunch
    name: Counterpunch
    category: combat
    best_for: ["fortress"]
    effect: "Once per round, immediately after an opponent fails to claim one of your tiles, you may play a free Power 2 Claim on any tile adjacent to that opponent's territory. This does not cost an action slot."
    notes: "Punishes failed attacks. Creates a deterrent effect — opponents risk giving you free board space."

  - id: passive_guerrilla_tactics
    name: Guerrilla Tactics
    category: combat
    best_for: ["swarm"]
    effect: "Your Claim cards targeting a tile that has 2 or more tiles owned by other players adjacent to it gain +2 power."
    notes: "Rewards attacking into crowded, contested areas. Swarm's spread creates natural triggers."

  # ── RESOURCE PASSIVES ────────────────────────────────────────────────────

  - id: passive_treasure_hunter
    name: Treasure Hunter
    category: resource
    best_for: ["any"]
    effect: "At the start of each round (after upkeep), gain 1 resource for each VP hex tile you currently control."
    notes: "Universally strong. Creates a compounding economic advantage for players who control VP hexes."

  - id: passive_opportunist
    name: Opportunist
    category: resource
    best_for: ["any"]
    effect: "Whenever any opponent purchases the last copy of a neutral card stack, you immediately gain 1 resource."
    notes: "Soft consolation for being outbid. Encourages letting opponents buy out stacks."

  - id: passive_logistician
    name: Logistician
    category: resource
    best_for: ["any"]
    effect: "Once per game, during the Buy Phase, you may take one additional buy action (purchasing one additional card beyond your normal limit)."
    notes: "One free double-buy. Best saved for a pivotal round where two purchases are critical."

  - id: passive_merchant_prince
    name: Merchant Prince
    category: resource
    best_for: ["any"]
    effect: "All neutral cards cost you 1 less resource to purchase (minimum 1)."
    notes: "Strong if leaning into the neutral market. Pairs especially well with Forced March and Land Grant."

  - id: passive_war_profiteer
    name: War Profiteer
    category: resource
    best_for: ["any"]
    effect: "Whenever any player (including yourself) purchases an upgrade credit token, you gain 1 resource."
    notes: "Rewards upgrade-heavy metas. More players investing in upgrades means more passive income."

  - id: passive_frugal
    name: Frugal
    category: resource
    best_for: ["fortress"]
    effect: "At the end of each round, if you spent 0 resources during that round's Buy Phase, gain 3 resources."
    notes: "Rewards skipping purchases. Strong in early game or when banking for a big buy."

  - id: passive_investor
    name: Investor
    category: resource
    best_for: ["any"]
    effect: "At game start, after setup is complete, gain 3 bonus resources."
    notes: "Pure early game accelerator. Simple and universally useful."

  # ── OBJECTIVE & VP PASSIVES ──────────────────────────────────────────────

  - id: passive_cartographers_apprentice
    name: Cartographer's Apprentice
    category: objective_vp
    best_for: ["any"]
    effect: "At game start, after the board is generated but before starting corner positions are chosen, you may pick up and reposition up to 2 blocked terrain tiles to any non-starting, non-VP hex locations."
    notes: "Map manipulation. Can open routes for yourself or close routes for opponents."

  - id: passive_underdog
    name: Underdog
    category: objective_vp
    best_for: ["any"]
    effect: "While you have strictly fewer VP than every other active player, all your Claim cards gain +1 power."
    notes: "Comeback mechanic. Resets immediately when you tie or exceed another player's VP."

  - id: passive_visionary
    name: Visionary
    category: objective_vp
    best_for: ["any"]
    effect: "Once per game, immediately after objectives are revealed, you may swap one of the revealed objectives with a new one drawn randomly from the remaining objective pool. The swapped objective is discarded."
    notes: "Objective fishing. Best used when the revealed objectives are poorly suited to your archetype."

  - id: passive_monument_builder
    name: Monument Builder
    category: objective_vp
    best_for: ["any"]
    effect: "At the end of each round, each VP hex tile you control is worth 1 additional VP (2 VP total instead of 1)."
    notes: "Amplifies board control. Extremely strong if holding multiple VP hexes — accelerates the win condition."

  - id: passive_tactician
    name: Tactician
    category: objective_vp
    best_for: ["vanguard", "swarm"]
    effect: "Once per round, during Phase 1 before the Plan Phase, you may discard your three archetype market cards and draw three new ones for free (no re-roll resource cost)."
    notes: "Reduces bad market turns. Particularly strong for archetypes with high card variance."

  - id: passive_nomad
    name: Nomad
    category: objective_vp
    best_for: ["any"]
    effect: "Once per game, at the start of Phase 1, you may relocate your entire territory by shifting all owned tiles one step in a chosen direction. Tiles that would fall outside the board or onto blocked terrain are lost. Tiles that land on opponent territory are contested normally that round."
    notes: "The most dramatic passive. Creates memorable table moments. Best used to escape being surrounded."

  - id: passive_scout_network
    name: Scout Network
    category: objective_vp
    best_for: ["any"]
    effect: "Once per round, at the very start of the Reveal Phase (before any cards are flipped), you may look at one face-down card that any one opponent has placed on the board."
    notes: "Highest-impact information passive in the pool. In skilled hands, enables precise counter-plays."
