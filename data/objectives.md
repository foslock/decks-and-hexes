# Card Clash – Objective Pool
# Three objectives are revealed at the 1/3 mark of the game.
# Each completed objective awards 2 VP to the first player to meet its condition.
# Each objective can only be claimed once per game.
#
# EDITING NOTES:
# - archetype: "vanguard" | "swarm" | "fortress" | "wildcard"
# - condition: the precise, unambiguous condition that must be met
# - verification: how to verify completion at the table
# - notes: design intent / balance notes

objectives:

  # ── VANGUARD OBJECTIVES ──────────────────────────────────────────────────

  - id: obj_blitzkrieg
    name: Blitzkrieg
    archetype: vanguard
    vp_reward: 2
    condition: "Be the first player to control 2 VP hex tiles that are both connected to your base simultaneously at the end of any round."
    verification: "Check tile control and connectivity after resolve phase. Both VP hexes must be connected to the player's base via owned tiles."
    notes: "Natural for Vanguard who pushes center. Connectivity requirement rewards contiguous expansion, not scattered grabs."

  - id: obj_overwhelming_force
    name: Overwhelming Force
    archetype: vanguard
    vp_reward: 2
    condition: "Win 3 or more contested tile battles in a single round (tiles where at least one opponent also played a Claim card)."
    verification: "Count contested claim wins during the resolve phase of a single round."
    notes: "Requires stacking high-power cards deliberately. Rewards aggressive deck construction."

  - id: obj_deep_strike
    name: Deep Strike
    archetype: vanguard
    vp_reward: 2
    condition: "Successfully claim 3 tiles using range-breaking cards (cards that target tiles more than 1 step away) across any number of rounds."
    verification: "Track range-breaking claim successes cumulatively. Cards: Overrun, Flanking Strike, and any equivalent."
    notes: "Rewards building around Overrun / Flanking Strike. Cumulative so no need to do it all at once."

  - id: obj_shock_and_awe
    name: Shock and Awe
    archetype: vanguard
    vp_reward: 2
    condition: "Successfully capture a tile that had at least 1 point of permanent defense bonus (from Entrench or equivalent) applied to it."
    verification: "Confirm the tile had a permanent defense marker before the successful claim."
    notes: "Rewards attacking fortified positions. Creates conflict with Fortress players."

  - id: obj_war_of_conquest
    name: War of Conquest
    archetype: vanguard
    vp_reward: 2
    condition: "Control at least 1 tile in three different board quadrants simultaneously at the end of any round."
    verification: "Divide the board into four quadrants at setup. Check ownership at end of round."
    notes: "Rewards aggressive expansion over turtling. Quadrant boundaries set at game start."

  - id: obj_elite_corps
    name: Elite Corps
    archetype: vanguard
    vp_reward: 2
    condition: "Have 3 or more upgraded cards (+) in your hand at the start of any turn."
    verification: "Check hand at the start of Phase 1 before any cards are played."
    notes: "Rewards heavy upgrade credit investment. Naturally pairs with Vanguard's expensive card economy."

  # ── SWARM OBJECTIVES ─────────────────────────────────────────────────────

  - id: obj_flood_the_zone
    name: Flood the Zone
    archetype: swarm
    vp_reward: 2
    condition: "Control 8 or more tiles simultaneously at the end of any round."
    verification: "Count all tiles owned by the player after the resolve phase."
    notes: "Swarm's natural endgame state. Achievable by others but requires significant sacrifice."

  - id: obj_endless_horde
    name: Endless Horde
    archetype: swarm
    vp_reward: 2
    condition: "Play 5 or more Claim cards in a single round."
    verification: "Count Claim cards played during the plan/reveal phase of a single round."
    notes: "Requires action engine setup. Cards that grant 2+ actions are key to achieving this."

  - id: obj_encirclement
    name: Encirclement
    archetype: swarm
    vp_reward: 2
    condition: "Completely surround one opponent's tile cluster such that they have no adjacent neutral tiles they could expand into."
    verification: "Check after resolve phase. All tiles adjacent to the opponent's territory must be either owned or blocked."
    notes: "Creates a dramatic board moment. Requires board awareness and spatial planning."

  - id: obj_death_by_a_thousand_cuts
    name: Death by a Thousand Cuts
    archetype: swarm
    vp_reward: 2
    condition: "Successfully claim tiles from 3 different opponents in a single round."
    verification: "Count distinct opponent tile captures in the resolve phase of a single round."
    notes: "Rewards spread aggression across multiple fronts. Requires careful multi-target planning."

  - id: obj_cheap_wins
    name: Cheap Wins
    archetype: swarm
    vp_reward: 2
    condition: "Purchase 8 or more cards total before any other player has purchased 5."
    verification: "Track cumulative cards purchased per player since game start."
    notes: "Rewards low-cost buying strategy. Swarm's cheap cards give a natural head start."

  - id: obj_swarm_intelligence
    name: Swarm Intelligence
    archetype: swarm
    vp_reward: 2
    condition: "Have 6 or more cards in your hand at the start of any turn before playing any cards."
    verification: "Check hand size at start of Phase 1 before any actions are taken."
    notes: "Rewards deep draw engine investment. Thin the Herd and Swarm Tactics key enablers."

  # ── FORTRESS OBJECTIVES ──────────────────────────────────────────────────

  - id: obj_immovable_object
    name: Immovable Object
    archetype: fortress
    vp_reward: 2
    condition: "Successfully defend the same tile against Claim cards from 2 or more different opponents in a single round."
    verification: "After resolve phase, confirm the tile was contested by 2+ distinct players and held by the defender."
    notes: "Rewards compact, contested positioning near other players. Creates memorable defensive moments."

  - id: obj_iron_curtain
    name: Iron Curtain
    archetype: fortress
    vp_reward: 2
    condition: "Have no tiles captured by opponents for 3 consecutive rounds after the objective is revealed."
    verification: "Track from the round objectives are revealed. Reset counter if any tile is lost."
    notes: "Fortress's natural defensive identity. Achievable by turtling with Iron Wall and Stronghold."

  - id: obj_heartland
    name: Heartland
    archetype: fortress
    vp_reward: 2
    condition: "Control a contiguous group of 6 or more tiles at the end of any round."
    verification: "All 6+ tiles must form a single connected group (touching hexes count as connected)."
    notes: "Rewards tight territorial consolidation. Contiguous requirement means no scattered tiles count."

  - id: obj_siege_mastery
    name: Siege Mastery
    archetype: fortress
    vp_reward: 2
    condition: "Successfully apply permanent defense bonuses (via Entrench or equivalent cards) to 4 different tiles across any number of rounds."
    verification: "Track cumulative Entrench applications. Each tile counts only once even if entrenched multiple times."
    notes: "Rewards deep defensive card investment. Permanent markers on the board make this easy to track."

  - id: obj_war_of_attrition_objective
    name: War of Attrition
    archetype: fortress
    vp_reward: 2
    condition: "Cause opponents to draw a combined total of 5 fewer cards through card effects across any number of rounds."
    verification: "Track cumulative hand reduction effects applied to opponents. Each -1 card draw applied counts as 1 toward the total."
    notes: "Rewards disruptive defensive play. Attrition card and Sabotage neutral card are the primary contributors."

  - id: obj_the_long_game
    name: The Long Game
    archetype: fortress
    vp_reward: 2
    condition: "Have the highest total resource count among all players at the end of any round after round 5."
    verification: "Compare resource totals after upkeep and buy phase at end of round. Must be strictly highest."
    notes: "Rewards patient resource banking. Hoarder passive pairs extremely well."

  # ── WILDCARD OBJECTIVES ───────────────────────────────────────────────────

  - id: obj_arms_race
    name: Arms Race
    archetype: wildcard
    vp_reward: 2
    condition: "Be the first player to have 3 upgraded (+) cards anywhere in your deck (hand, draw pile, or discard pile)."
    verification: "Count all upgraded cards across all zones. Declared when third upgrade is applied."
    notes: "Rewards early upgrade credit investment. Races all archetypes equally."

  - id: obj_market_cornered
    name: Market Cornered
    archetype: wildcard
    vp_reward: 2
    condition: "Buy the last copy of any 2 different neutral card types across any number of rounds."
    verification: "Track which player bought the last copy of each neutral stack."
    notes: "Rewards denial strategy. Creates pressure to buy neutral cards even when not immediately needed."

  - id: obj_cartographer
    name: Cartographer
    archetype: wildcard
    vp_reward: 2
    condition: "Control at least 1 tile adjacent to a blocked terrain hex at the end of any round."
    verification: "Check tile adjacency to any blocked hex after resolve phase."
    notes: "Rewards unconventional expansion routes. Pairs with Fortified Borders passive."

  - id: obj_diplomatic_incident
    name: Diplomatic Incident
    archetype: wildcard
    vp_reward: 2
    condition: "Successfully trigger Cease Fire's bonus in 3 different rounds (do not claim any opponent-owned tiles those turns)."
    verification: "Track rounds where a Cease Fire card resolved with its condition met. Must reach 3 qualifying rounds."
    notes: "Rewards restraint and card economy strategy. Requires investing actions in Cease Fire and forgoing aggression multiple turns."

  - id: obj_renaissance
    name: Renaissance
    archetype: wildcard
    vp_reward: 2
    condition: "Have cards from at least 4 different neutral card types in your deck (hand, draw pile, or discard pile) simultaneously."
    verification: "Count distinct neutral card names owned by the player across all zones."
    notes: "Rewards diverse buying strategy. Encourages engaging with the neutral market broadly."

  - id: obj_first_blood
    name: First Blood
    archetype: wildcard
    vp_reward: 2
    condition: "Be the first player to successfully claim a tile that was owned by another player (not neutral)."
    verification: "Awarded immediately in the resolve phase when the first player-vs-player capture occurs."
    notes: "Almost certainly claimed within 1–2 rounds of reveal. Creates an immediate aggression scramble."

  - id: obj_kingmaker
    name: Kingmaker
    archetype: wildcard
    vp_reward: 2
    condition: "Have the fewest derived VP of all active players at the objective reveal round, but have the highest derived VP (excluding this objective's reward) at the end of any subsequent round."
    verification: "Record derived VP standings at reveal. Check derived VP (excluding objective bonuses) at end of each subsequent round."
    notes: "Comeback mechanic. Hard to game since it requires being behind at reveal. With derived VP, being behind means fewer tiles — a real deficit to overcome."

  - id: obj_veteran
    name: Veteran
    archetype: wildcard
    vp_reward: 2
    condition: "Trash 5 or more cards from your deck across any number of rounds."
    verification: "Track cumulative trashed cards per player. Trashed cards are removed from the game."
    notes: "Rewards aggressive deck thinning. Pairs with Consolidate, Thin the Herd, and Iron Discipline passive."

  - id: obj_border_dispute
    name: Border Dispute
    archetype: wildcard
    vp_reward: 2
    condition: "Have tiles adjacent to every other active player's territory simultaneously at the end of any round."
    verification: "Check adjacency after resolve phase. Must share a hex border with at least one tile from each player."
    notes: "Rewards central board positioning. Very difficult in 6-player games — a meaningful achievement."

  - id: obj_jack_of_all_trades
    name: Jack of All Trades
    archetype: wildcard
    vp_reward: 2
    condition: "Successfully play at least one Claim card, one Defense card, and one Engine card in a single round."
    verification: "All three card types must be played in the same round's plan/reveal phase."
    notes: "Rewards hand versatility. Naturally challenging for Swarm (few Defense cards) and Fortress (few Engine cards)."
