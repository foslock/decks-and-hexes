import { useState } from 'react';
import { CARD_TYPE_COLORS } from '../constants/cardColors';

const PAGES = [
  {
    title: 'Welcome to Card Clash',
    content: (
      <>
        <p style={{ fontSize: 17, lineHeight: 1.7, color: '#ccc' }}>
          Card Clash is a <strong style={{ color: '#fff' }}>deck-building territory control game</strong> for 2–6 players.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginTop: 16 }}>
          You start in a corner of a hex grid with a small deck of cards. Each round, you play cards to
          <strong style={{ color: CARD_TYPE_COLORS.claim }}> claim tiles</strong>,
          <strong style={{ color: '#5dde5d' }}> gather resources</strong>, and
          <strong style={{ color: '#ffaa33' }}> buy new cards</strong> to
          strengthen your deck.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginTop: 16 }}>
          Expand your territory, compete for valuable VP hexes, and be the first player to reach the
          <strong style={{ color: '#ffd700' }}> Victory Point target</strong> to win.
        </p>
        <div style={{
          marginTop: 28,
          padding: '16px 20px',
          background: '#1a1a40',
          borderRadius: 8,
          border: '1px solid #333',
        }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>How you earn VP</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#bbb' }}>
            <div>🗺️ <strong style={{ color: '#ccc' }}>Territory</strong> — own tiles to earn VP (1 VP for every 3 tiles)</div>
            <div>⭐ <strong style={{ color: '#ffd700' }}>VP Tiles</strong> — worth bonus VP when connected to your base</div>
            <div>🃏 <strong style={{ color: '#ccc' }}>Cards</strong> — some cards contribute VP directly when in your deck</div>
          </div>
        </div>
      </>
    ),
  },
  {
    title: 'Your Deck',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa' }}>
          You start with a <strong style={{ color: '#fff' }}>10-card deck</strong> of basic cards.
          Each round you draw a hand of 5 cards in your Upkeep phase, play some during the Play phase, then discard
          the rest. When your deck runs out, your discard pile is reshuffled into a new draw pile.
        </p>
        <div style={{
          marginTop: 20,
          padding: '16px 20px',
          background: '#1a1a40',
          borderRadius: 8,
          border: '1px solid #333',
        }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Starting cards</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#bbb' }}>
            <div>⚔️ <strong style={{ color: CARD_TYPE_COLORS.claim }}>Explore</strong> ×5 — claim an adjacent, defenseless tile</div>
            <div>💰 <strong style={{ color: '#5dde5d' }}>Gather</strong> ×5 — gain 1 resource</div>
          </div>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginTop: 20 }}>
          During the <strong style={{ color: '#ffaa33' }}>Buy phase</strong>, spend resources to purchase
          stronger cards from the market. New cards go to your discard pile and will appear in future hands.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginTop: 12 }}>
          Building your deck is key — add powerful cards, and trash weak ones to draw your best cards
          more often.
        </p>
      </>
    ),
  },
  {
    title: 'The Hex Grid',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa' }}>
          The board is a <strong style={{ color: '#fff' }}>hexagonal grid</strong> where all the action happens.
          You start in a corner with your base tile and expand outward.
        </p>
        <div style={{
          marginTop: 20,
          padding: '16px 20px',
          background: '#1a1a40',
          borderRadius: 8,
          border: '1px solid #333',
        }}>
          <div style={{ fontSize: 13, color: '#888', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Tile Types</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, color: '#bbb' }}>
            <div>🔷 <strong style={{ color: '#ccc' }}>Neutral Tiles</strong> — unclaimed, free to explore</div>
            <div>⭐ <strong style={{ color: '#ffd700' }}>VP Tiles</strong> — earn bonus VP while connected to your base</div>
            <div>🚫 <strong style={{ color: '#666' }}>Blocked Terrain</strong> — impassable, unclaimable obstacles</div>
            <div>🏰 <strong style={{ color: '#4a9eff' }}>Base Tiles</strong> — your permanent starting tile, can never be captured</div>
          </div>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginTop: 20 }}>
          <strong style={{ color: '#fff' }}>Adjacency matters.</strong> Most Claim cards can only target tiles
          next to ones you already own. Keep your territory connected to maximize your score from VP tiles.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginTop: 12 }}>
          When you claim an opponent's tile, they lose it — and it becomes yours. The highest
          power claim wins, with <strong style={{ color: '#ccc' }}>ties going to the defender</strong>.
        </p>
      </>
    ),
  },
  {
    title: 'Card Types',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa' }}>
          Most cards cost <strong style={{ color: '#fff' }}>1 action</strong> to play. You start each
          round with a set number of actions, though some cards grant extra actions when played.
        </p>
        <div style={{
          marginTop: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.claim}`,
          }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.claim, marginBottom: 4 }}>⚔️ Claim Cards</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              Target a tile on the board to claim it. Each has a Power value — highest power wins
              the tile. This is how you expand your territory and contest opponents.
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.engine}`,
          }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.engine, marginBottom: 4 }}>⚙️ Engine Cards</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              Support cards that generate resources, draw extra cards, grant actions, or
              provide other effects. They don't claim tiles directly but fuel your strategy.
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.defense}`,
          }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.defense, marginBottom: 4 }}>🛡️ Defense Cards</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              Protect tiles you own by boosting their defense. A defended tile is harder
              for opponents to take. Applied before any claims in a round.
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.passive}`,
          }}>
            <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.passive, marginBottom: 4 }}>📜 Passive Cards</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              Cards that provide ongoing effects or VP bonuses without being played.
              They take up a hand slot when drawn.
            </div>
          </div>
        </div>
      </>
    ),
  },
  {
    title: 'The Three Archetypes',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa' }}>
          Each archetype has a <strong style={{ color: '#fff' }}>unique pool of cards</strong> to purchase
          from their private market. Your archetype shapes your strategy.
        </p>
        <div style={{
          marginTop: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: '1px solid #e05050',
          }}>
            <div style={{ fontSize: 17, fontWeight: 'bold', color: '#e05050', marginBottom: 4 }}>⚔️ Vanguard</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              High-power claim cards that hit hard. Excels at taking contested territory
              and overwhelming opponents. Cards are expensive but decisive.
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: '1px solid #e0c050',
          }}>
            <div style={{ fontSize: 17, fontWeight: 'bold', color: '#e0c050', marginBottom: 4 }}>🐝 Swarm</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              Floods the board with many low-power claims. Cheap cards, lots of card draw,
              and action generation let Swarm play more cards per turn than anyone else.
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: '#1a1a40',
            borderRadius: 8,
            border: '1px solid #5090e0',
          }}>
            <div style={{ fontSize: 17, fontWeight: 'bold', color: '#5090e0', marginBottom: 4 }}>🏰 Fortress</div>
            <div style={{ fontSize: 14, color: '#aaa', lineHeight: 1.6 }}>
              Slow but sturdy. Strong defense cards make territory hard to take back.
              Generates lots of resources and builds an engine before pushing outward.
            </div>
          </div>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#777', marginTop: 16 }}>
          All archetypes also have access to a <strong style={{ color: '#aaa' }}>Shared Market</strong> of
          cards available to everyone.
        </p>
      </>
    ),
  },
  {
    title: 'Round Phases',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: '#aaa', marginBottom: 16 }}>
          Each round follows the same sequence of phases: Upkeep &rarr; Play &rarr; Reveal &rarr; Buy.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ padding: '12px 16px', background: '#1a1a40', borderRadius: 8, border: '1px solid #333' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#ffaa33', marginBottom: 4 }}>1. Upkeep</div>
            <div style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5 }}>
              Draw your hand for the round. Starting from round 5, the VP leader receives a <strong style={{ color: '#fff' }}>Debt</strong> card
              in their discard pile — a dead card that costs 1 action + 3 resources to trash.
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: '#1a1a40', borderRadius: 8, border: '1px solid #333' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#4a9eff', marginBottom: 4 }}>2. Play</div>
            <div style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5 }}>
              Use actions to play cards onto the grid. Claim cards target tiles,
              defense cards protect tiles, and engine cards provide utility. You start each round with a set number of actions
              to spend (some cards grant more).
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: '#1a1a40', borderRadius: 8, border: '1px solid #333' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#e05050', marginBottom: 4 }}>3. Reveal</div>
            <div style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5 }}>
              All played cards are revealed. Effects are resolved — if multiple players target the
              same tile, highest power wins (ties go to the defender). Territory changes hands.
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: '#1a1a40', borderRadius: 8, border: '1px solid #333' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#5dde5d', marginBottom: 4 }}>4. Buy</div>
            <div style={{ fontSize: 13, color: '#aaa', lineHeight: 1.5 }}>
              Players take turns buying. Spend resources to buy new cards from your archetype
              market and/or the shared neutral market. You can also re-roll your archetype market or
              purchase upgrade credits. Other players can see what you bought.
            </div>
          </div>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#777', marginTop: 16 }}>
          At the end of each round, Vicory Points are checked — if any player has reached the target, they win! Otherwise,
          the leading player wins the game at the end of the last round.
        </p>
      </>
    ),
  },
];

interface HowToPlayProps {
  onClose: () => void;
}

export default function HowToPlay({ onClose }: HowToPlayProps) {
  const [page, setPage] = useState(0);
  const current = PAGES[page];
  const isLast = page === PAGES.length - 1;
  const isFirst = page === 0;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        background: 'rgba(10, 10, 20, 0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(92vw, 560px)',
          maxHeight: '85vh',
          background: '#12122a',
          border: '2px solid #4a4a6a',
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 20px',
          background: '#1a1a40',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 'bold', color: '#fff' }}>{current.title}</div>
            <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
              {page + 1} of {PAGES.length}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '4px 10px',
              background: '#2a2a3e',
              border: '1px solid #555',
              borderRadius: 4,
              color: '#aaa',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{
          padding: '20px 24px',
          overflowY: 'auto',
          flex: 1,
        }}>
          {current.content}
        </div>

        {/* Footer navigation */}
        <div style={{
          padding: '12px 20px',
          borderTop: '1px solid #333',
          display: 'flex',
          gap: 8,
          flexShrink: 0,
        }}>
          {/* Page dots */}
          <div style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            flex: 1,
          }}>
            {PAGES.map((_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: i === page ? '#4a9eff' : '#444',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  transition: 'background 0.2s',
                }}
              />
            ))}
          </div>

          {!isFirst && (
            <button
              onClick={() => setPage(page - 1)}
              style={{
                padding: '8px 20px',
                background: '#2a2a3e',
                border: '1px solid #555',
                borderRadius: 6,
                color: '#ccc',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Back
            </button>
          )}
          <button
            onClick={() => isLast ? onClose() : setPage(page + 1)}
            style={{
              padding: '8px 24px',
              background: isLast ? '#5dde5d' : '#4a9eff',
              border: 'none',
              borderRadius: 6,
              color: isLast ? '#111' : '#fff',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 'bold',
            }}
          >
            {isLast ? 'Got it!' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
