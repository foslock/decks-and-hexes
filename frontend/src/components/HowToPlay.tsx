import { useState } from 'react';
import { CARD_TYPE_COLORS } from '../constants/cardColors';
import Icon from '../icons/Icon';
import type { IconName } from '../icons/glyphs';

/** Legend glyph aligned to the first line of text. */
function LegendIcon({ name, color }: { name: IconName; color?: string }) {
  return <Icon name={name} size={15} color={color} decorative style={{ verticalAlign: '-0.2em', marginRight: 6 }} />;
}

const PAGES = [
  {
    title: 'Welcome to Card Clash',
    content: (
      <>
        <p style={{ fontSize: 17, lineHeight: 1.7, color: '#ccc' }}>
          Card Clash is a <strong style={{ color: '#fff' }}>deck-building territory control game</strong> for 2–6 players.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginTop: 16 }}>
          You start in a corner of a hex grid with a small deck of cards. Each round, you play cards to
          <strong style={{ color: CARD_TYPE_COLORS.claim }}> claim tiles</strong>,
          <strong style={{ color: '#5dde5d' }}> gather resources</strong>, and
          <strong style={{ color: '#ffaa33' }}> buy new cards</strong> to
          strengthen your deck.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginTop: 16 }}>
          Expand your territory, compete for valuable VP hexes, and be the first player to reach the
          <strong style={{ color: '#ffd700' }}> Victory Point target</strong> to win.
        </p>
        <div style={{
          marginTop: 28,
          padding: '16px 20px',
          background: 'var(--cc-scr-inset)',
          borderRadius: 8,
          border: '1px solid var(--cc-panel-border)',
        }}>
          <div style={{ fontSize: 11, color: 'rgba(232, 196, 106, 0.8)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.18em', fontFamily: 'var(--cc-font-display)', fontWeight: 700 }}>How you earn VP</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#bbb' }}>
            <div><LegendIcon name="tile" color="#ccc" /><strong style={{ color: '#ccc' }}>Territory</strong> — own tiles to earn VP (1 VP for every 3 tiles)</div>
            <div><LegendIcon name="vpTile" color="#ffd700" /><strong style={{ color: '#ffd700' }}>VP Tiles</strong> — worth bonus VP when connected to your base</div>
            <div><LegendIcon name="card" color="#ccc" /><strong style={{ color: '#ccc' }}>Cards</strong> — some cards contribute VP directly when in your deck</div>
          </div>
        </div>
      </>
    ),
  },
  {
    title: 'Your Deck',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)' }}>
          You start with a <strong style={{ color: '#fff' }}>10-card deck</strong> of basic cards.
          Each round you draw a hand of 5 cards in your Upkeep phase, play some during the Play phase, then discard
          the rest. When your draw pile runs out, your discard pile is reshuffled into a new draw pile.
        </p>
        <div style={{
          marginTop: 20,
          padding: '16px 20px',
          background: 'var(--cc-scr-inset)',
          borderRadius: 8,
          border: '1px solid var(--cc-panel-border)',
        }}>
          <div style={{ fontSize: 11, color: 'rgba(232, 196, 106, 0.8)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.18em', fontFamily: 'var(--cc-font-display)', fontWeight: 700 }}>Starting cards</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 14, color: '#bbb' }}>
            <div><LegendIcon name="power" color={CARD_TYPE_COLORS.claim} /><strong style={{ color: CARD_TYPE_COLORS.claim }}>Explore</strong> ×5 — claim an adjacent, neutral tile</div>
            <div><LegendIcon name="resource" color="#5dde5d" /><strong style={{ color: '#5dde5d' }}>Gather</strong> ×5 — gains resources</div>
          </div>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginTop: 20 }}>
          During the <strong style={{ color: '#ffaa33' }}>Buy phase</strong>, spend resources to purchase
          stronger cards from the market. New cards go to your discard pile and will appear in future hands.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginTop: 12 }}>
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
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)' }}>
          The board is a <strong style={{ color: '#fff' }}>hexagonal grid</strong> where all the action happens.
          You start in a corner with your base tile and expand outward.
        </p>
        <div style={{
          marginTop: 20,
          padding: '16px 20px',
          background: 'var(--cc-scr-inset)',
          borderRadius: 8,
          border: '1px solid var(--cc-panel-border)',
        }}>
          <div style={{ fontSize: 11, color: 'rgba(232, 196, 106, 0.8)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.18em', fontFamily: 'var(--cc-font-display)', fontWeight: 700 }}>Tile Types</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14, color: '#bbb' }}>
            <div><LegendIcon name="tile" color="#ccc" /><strong style={{ color: '#ccc' }}>Neutral Tiles</strong> — unclaimed, free to explore</div>
            <div><LegendIcon name="vpTile" color="#ffd700" /><strong style={{ color: '#ffd700' }}>VP Tiles</strong> — earn bonus VP while connected to your base</div>
            <div><LegendIcon name="mountain" color="#888" /><strong style={{ color: '#666' }}>Blocked Terrain</strong> — impassable, unclaimable obstacles</div>
            <div><LegendIcon name="base" color="#4a9eff" /><strong style={{ color: '#4a9eff' }}>Base Tiles</strong> — your permanent starting tile, can never be captured</div>
          </div>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginTop: 20 }}>
          <strong style={{ color: '#fff' }}>Adjacency matters.</strong> Most Claim cards can only target tiles
          next to ones you already own. Keep your territory connected to maximize your score from VP tiles.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginTop: 12 }}>
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
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)' }}>
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
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.claim}`,
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/claim.webp" alt="" style={{ width: 80, height: 80, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.claim, marginBottom: 4 }}>Claim Cards</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                Target a tile on the board to claim it. Each has a Power value — highest power wins
                the tile. This is how you expand your territory and contest opponents.
              </div>
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.engine}`,
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/engine.webp" alt="" style={{ width: 80, height: 80, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.engine, marginBottom: 4 }}>Engine Cards</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                Support cards that generate resources, draw extra cards, grant actions, or
                provide other effects. They don't claim tiles directly but fuel your strategy.
              </div>
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.defense}`,
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/defense.webp" alt="" style={{ width: 80, height: 80, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.defense, marginBottom: 4 }}>Defense Cards</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                Protect tiles you own by boosting their defense. A defended tile is harder
                for opponents to take. Applied before any claims in a round.
              </div>
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: `1px solid ${CARD_TYPE_COLORS.passive}`,
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/passive.webp" alt="" style={{ width: 80, height: 80, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 'bold', color: CARD_TYPE_COLORS.passive, marginBottom: 4 }}>Passive Cards</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                Cards that provide ongoing effects or VP bonuses without being played.
                They take up a hand slot when drawn.
              </div>
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
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)' }}>
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
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: '1px solid #e05050',
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/vanguard.webp" alt="" style={{ width: 96, height: 96, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 'bold', color: '#e05050', marginBottom: 4 }}>Vanguard</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                High-power claim cards that hit hard. Excels at taking contested territory
                and overwhelming opponents. Cards are expensive but decisive.
              </div>
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: '1px solid #e0c050',
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/swarm.webp" alt="" style={{ width: 96, height: 96, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 'bold', color: '#e0c050', marginBottom: 4 }}>Swarm</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                Floods the board with many low-power claims. Cheap cards, lots of card draw,
                and action generation let Swarm play more cards per turn than anyone else.
              </div>
            </div>
          </div>
          <div style={{
            padding: '14px 18px',
            background: 'var(--cc-scr-inset)',
            borderRadius: 8,
            border: '1px solid #5090e0',
            display: 'flex',
            gap: 14,
            alignItems: 'center',
          }}>
            <img src="/assets/howtoplay/fortress.webp" alt="" style={{ width: 96, height: 96, flexShrink: 0, objectFit: 'contain' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 17, fontWeight: 'bold', color: '#5090e0', marginBottom: 4 }}>Fortress</div>
              <div style={{ fontSize: 14, color: 'var(--cc-text-dim)', lineHeight: 1.6 }}>
                Slow but sturdy. Strong defense cards make territory hard to take back.
                Generates lots of resources and builds an engine before pushing outward.
              </div>
            </div>
          </div>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#777', marginTop: 16 }}>
          All archetypes also have access to a <strong style={{ color: 'var(--cc-text-dim)' }}>Shared Market</strong> of
          cards available to everyone.
        </p>
      </>
    ),
  },
  {
    title: 'Round Phases',
    content: (
      <>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--cc-text-dim)', marginBottom: 16 }}>
          Each round follows the same sequence of phases: Upkeep &rarr; Play &rarr; Resolve &rarr; Buy.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ padding: '12px 16px', background: 'var(--cc-scr-inset)', borderRadius: 8, border: '1px solid var(--cc-panel-border)' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#ffaa33', marginBottom: 4 }}>1. Upkeep</div>
            <div style={{ fontSize: 13, color: 'var(--cc-text-dim)', lineHeight: 1.5 }}>
              Draw your hand for the round. Starting from round 5, the VP leader receives a <strong style={{ color: '#fff' }}>Debt</strong> card
              in their discard pile — a dead card that costs 1 action + 3 resources to trash.
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: 'var(--cc-scr-inset)', borderRadius: 8, border: '1px solid var(--cc-panel-border)' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#4a9eff', marginBottom: 4 }}>2. Play</div>
            <div style={{ fontSize: 13, color: 'var(--cc-text-dim)', lineHeight: 1.5 }}>
              Use actions to play cards onto the grid. Claim cards target tiles,
              defense cards protect tiles, and engine cards provide utility. You start each round with a set number of actions
              to spend (some cards grant more).
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: 'var(--cc-scr-inset)', borderRadius: 8, border: '1px solid var(--cc-panel-border)' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#e05050', marginBottom: 4 }}>3. Resolve</div>
            <div style={{ fontSize: 13, color: 'var(--cc-text-dim)', lineHeight: 1.5 }}>
              All played cards are revealed. Effects are resolved — if multiple players target the
              same tile, highest power wins (ties go to the defender). Territory changes hands.
            </div>
          </div>
          <div style={{ padding: '12px 16px', background: 'var(--cc-scr-inset)', borderRadius: 8, border: '1px solid var(--cc-panel-border)' }}>
            <div style={{ fontSize: 14, fontWeight: 'bold', color: '#5dde5d', marginBottom: 4 }}>4. Buy</div>
            <div style={{ fontSize: 13, color: 'var(--cc-text-dim)', lineHeight: 1.5 }}>
              All players buy simultaneously. Spend resources on new cards from your archetype
              market and/or the shared market. You can also re-roll your archetype market or
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
      className="cc-scr-modal-backdrop"
      style={{ zIndex: 10000 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="cc-panel cc-scr-modal cc-scr-htp"
      >
        {/* Header */}
        <div className="cc-scr-modal-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="cc-scr-modal-title">{current.title}</div>
            <div className="cc-scr-modal-sub">
              {page + 1} of {PAGES.length}
            </div>
          </div>
          <button
            onClick={onClose}
            className="cc-scr-close"
            aria-label="Close"
          >
            <Icon name="close" size={14} decorative />
          </button>
        </div>

        {/* Content */}
        <div className="cc-scr-modal-body cc-scr-htp-body">
          <div key={page} className="cc-scr-htp-page">
            {current.content}
          </div>
        </div>

        {/* Footer navigation */}
        <div className="cc-scr-modal-foot">
          {/* Page dots */}
          <div className="cc-scr-htp-dots">
            {PAGES.map((_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`cc-scr-htp-dot${i === page ? ' is-active' : ''}`}
              />
            ))}
          </div>

          {!isFirst && (
            <button
              onClick={() => setPage(page - 1)}
              className="cc-btn-secondary cc-scr-htp-nav"
            >
              Back
            </button>
          )}
          <button
            onClick={() => isLast ? onClose() : setPage(page + 1)}
            className="cc-btn-primary cc-scr-htp-nav"
          >
            {isLast ? 'Got it!' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
