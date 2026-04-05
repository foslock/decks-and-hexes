import { useState, useEffect, useMemo, useRef } from 'react';
import type { Card } from '../types/game';
import Tooltip from './Tooltip';
import { renderWithKeywords, extractKeywordsFromText } from './Keywords';
import { useTooltips } from './SettingsContext';

const TYPE_COLORS: Record<string, string> = {
  claim: '#4a9eff',
  defense: '#4aff6a',
  engine: '#ffaa4a',
  passive: '#aa88cc',
};

/** Fallback emoji per card type (used when no per-card art is defined) */
const TYPE_EMOJI: Record<string, string> = {
  claim: '⚔️',
  defense: '🛡️',
  engine: '⚙️',
  passive: '📜',
};

/**
 * Per-card emoji art keyed by base card ID (without instance suffixes).
 * Provides a unique visual identity for each card in the art placeholder.
 */
const CARD_ART: Record<string, string> = {
  // ── Vanguard ──
  vanguard_blitz: '⚡',
  vanguard_overrun: '🐎',
  vanguard_strike_team: '🎯',
  vanguard_rapid_assault: '💨',
  vanguard_spearhead: '🔱',
  vanguard_coordinated_push: '🤝',
  vanguard_double_time: '⏩',
  vanguard_rally: '📯',
  vanguard_forward_march: '🚩',
  vanguard_war_cache: '🏴',
  vanguard_breakthrough: '💥',
  vanguard_flanking_strike: '🗡️',
  vanguard_surge_protocol: '📡',
  vanguard_spoils_of_war: '👑',
  vanguard_elite_vanguard: '🦅',
  vanguard_war_chest: '💰',
  vanguard_battle_glory: '🏆',
  vanguard_arsenal: '🗄️',
  vanguard_counterattack: '↩️',
  vanguard_rearguard: '🛡️',

  // ── Swarm ──
  swarm_scout: '👁️',
  swarm_surge: '🌊',
  swarm_overwhelm: '🐜',
  swarm_swarm_tactics: '🐝',
  swarm_proliferate: '🌱',
  swarm_flood: '🌀',
  swarm_rabble: '👥',
  swarm_dog_pile: '🐺',
  swarm_thin_the_herd: '✂️',
  swarm_numbers_game: '🔢',
  swarm_frenzy: '🔥',
  swarm_scavenge: '🦴',
  swarm_blitz_rush: '⚡',
  swarm_nest: '🪹',
  swarm_safety_in_numbers: '🫂',
  swarm_mob_rule: '✊',
  swarm_hive_mind: '🧠',
  swarm_locust_swarm: '🦗',
  swarm_consecrate: '⛪',
  swarm_war_trophies: '🏅',

  // ── Fortress ──
  fortress_fortify: '🧱',
  fortress_bulwark: '🏗️',
  fortress_siege_engine: '💣',
  fortress_iron_wall: '🚧',
  fortress_garrison: '🏰',
  fortress_slow_advance: '🐢',
  fortress_supply_line: '📦',
  fortress_entrench: '⛏️',
  fortress_war_of_attrition: '⏳',
  fortress_stronghold: '🏯',
  fortress_overwhelming_force: '🔨',
  fortress_consolidate: '♻️',
  fortress_battering_ram: '🪓',
  fortress_citadel: '🏛️',
  fortress_war_council: '📋',
  fortress_iron_discipline: '⚖️',
  fortress_fortified_position: '🏅',
  fortress_diplomacy: '🕊️',

  // ── Neutral ──
  neutral_explore: '🧭',
  neutral_gather: '💎',
  neutral_mercenary: '🗡️',
  neutral_land_grant: '📜',
  neutral_sabotage: '💀',
  neutral_cease_fire: '🕊️',
  neutral_road_builder: '🛤️',
  neutral_prospector: '⛏️',
  neutral_surveyor: '🔭',
  neutral_militia: '🏹',
  neutral_eminent_domain: '⚖️',
  neutral_fortified_post: '🛡️',
  neutral_forced_march: '🥁',
  neutral_rally_cry: '📣',
  neutral_war_bonds: '💰',
  neutral_reduce: '✂️',
  neutral_recruit: '🙋',
  neutral_conscription: '📖',
  neutral_watchtower: '🗼',
  neutral_siege_tower: '🏗️',
  neutral_reclaim: '💱',
  neutral_diplomat: '🤝',
  fortress_catch_up: '🏃',
};

const ARCHETYPE_LABEL: Record<string, string> = {
  vanguard: 'Vanguard',
  swarm: 'Swarm',
  fortress: 'Fortress',
  neutral: 'Neutral',
};

const TYPE_LABEL: Record<string, string> = {
  claim: 'Claim',
  defense: 'Defense',
  engine: 'Engine',
  passive: 'Passive',
};

/** Resolve the art emoji for a card, handling instance ID suffixes. */
function getCardArt(id: string, cardType: string): string {
  if (CARD_ART[id]) return CARD_ART[id];
  // Strip instance suffixes: e.g. "neutral_explore_start_adv_0" → try progressively shorter prefixes
  let key = id;
  while (key.includes('_')) {
    key = key.substring(0, key.lastIndexOf('_'));
    if (CARD_ART[key]) return CARD_ART[key];
  }
  return TYPE_EMOJI[cardType] || '📄';
}

/** Standard card width for all full card views */
export const CARD_FULL_WIDTH = 220;
/** Standard card height (approximate — flex layout) */
export const CARD_FULL_MIN_HEIGHT = 280;

interface CardFullProps {
  card: Card;
  /** Override the displayed buy cost (for dynamic pricing in shop) */
  effectiveCost?: number | null;
  /** Show remaining copies badge */
  remaining?: number | null;
  style?: React.CSSProperties;
  /** Show keyword definitions next to the card after a delay */
  showKeywordHints?: boolean;
}

/**
 * Unified full card layout used everywhere cards are displayed in detail:
 * shop hover, shop full view, deck/discard viewers, hand hover preview.
 *
 * Matches the CardDetail modal design: title top-center, cost top-right,
 * art placeholder, archetype-type line, abilities box.
 */
/** Extract unique keywords present in a card's description text. */
function extractKeywords(card: Card): { keyword: string; definition: string }[] {
  return extractKeywordsFromText(card.description || '');
}

export default function CardFull({ card, effectiveCost, remaining, style, showKeywordHints }: CardFullProps) {
  const typeColor = TYPE_COLORS[card.card_type] || '#555';
  const displayCost = effectiveCost ?? card.buy_cost;
  const tooltipsEnabled = useTooltips();

  // Keyword hints state — fade in after delay
  const keywords = useMemo(() => extractKeywords(card), [card]);
  const [hintsVisible, setHintsVisible] = useState(false);
  const [hintsOnLeft, setHintsOnLeft] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const shouldShowHints = showKeywordHints && tooltipsEnabled;

  useEffect(() => {
    if (!shouldShowHints || keywords.length === 0) {
      setHintsVisible(false);
      return;
    }
    // Measure whether hints fit on the right; if not, place on left
    if (cardRef.current) {
      const rect = cardRef.current.getBoundingClientRect();
      const hintWidth = 180 + 8; // width + gap
      const spaceRight = window.innerWidth - rect.right;
      setHintsOnLeft(spaceRight < hintWidth);
    }
    const timer = setTimeout(() => setHintsVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [shouldShowHints, keywords]);
  const hasCost = displayCost !== null && displayCost !== undefined;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;

  // Build abilities text
  const abilityParts: string[] = [];
  if (card.description) abilityParts.push(card.description);

  const statNotes: string[] = [];
  if (card.action_return === 1) statNotes.push('Returns 1 action (↺)');
  if (card.action_return === 2) statNotes.push('Returns 2 actions (↑)');
  if (card.trash_on_use) statNotes.push('Trashed after use.');
  if (card.stackable) statNotes.push('Stackable');
  if (!card.adjacency_required) statNotes.push('No adjacency required.');

  return (
    <div ref={cardRef} style={{
      width: CARD_FULL_WIDTH,
      position: 'relative',
      background: '#1e1e3a',
      border: `2px solid ${typeColor}`,
      borderRadius: 12,
      padding: '12px 14px 14px',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      ...style,
    }}>
      {/* Top row: VP badge top-left, title left-aligned, cost top-right */}
      <div style={{ position: 'relative', textAlign: 'left', minHeight: 22 }}>
        {card.current_vp !== undefined && (
          <Tooltip content={
            card.current_vp >= 0
              ? `This card is currently worth ${card.current_vp} VP`
              : `This card costs you ${Math.abs(card.current_vp)} VP`
          }>
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              cursor: 'help',
              fontSize: 12,
              fontWeight: 'bold',
              color: card.current_vp > 0 ? '#ffd700' : card.current_vp < 0 ? '#ff6666' : '#888',
              background: '#2a2a4e',
              borderRadius: 5,
              padding: '1px 6px',
              border: `1px solid ${card.current_vp > 0 ? '#ffd700' : card.current_vp < 0 ? '#ff6666' : '#555'}`,
              lineHeight: 1.3,
            }}>
              {card.current_vp > 0 ? '+' : ''}{card.current_vp} ★
            </div>
          </Tooltip>
        )}
        <div style={{ fontSize: 15, fontWeight: 'bold', lineHeight: 1.3, paddingLeft: card.current_vp !== undefined ? 36 : 0, paddingRight: 36 }}>
          {card.name}
          {card.is_upgraded && !card.name.endsWith('+') && <span style={{ color: '#ffd700' }}> +</span>}
        </div>
        {hasCost ? (
          <Tooltip content={
            isDiscounted
              ? `Cost: ${displayCost} (reduced from ${card.buy_cost})`
              : `Cost to purchase: ${displayCost} resources`
          }>
            <div style={{
              position: 'absolute',
              top: 0,
              right: 0,
              cursor: 'help',
              fontSize: 12,
              fontWeight: 'bold',
              color: isDiscounted ? '#4aff6a' : '#ffd700',
              background: '#2a2a4e',
              borderRadius: 5,
              padding: '1px 6px',
              border: '1px solid #555',
              lineHeight: 1.3,
            }}>
              {isDiscounted ? `${displayCost}*` : displayCost}💰
            </div>
          </Tooltip>
        ) : (
          <div style={{
            position: 'absolute',
            top: 0,
            right: 0,
            fontSize: 12,
            fontWeight: 'bold',
            color: '#555',
            background: '#2a2a4e',
            borderRadius: 5,
            padding: '1px 6px',
            border: '1px solid #444',
            lineHeight: 1.3,
          }}>
            —
          </div>
        )}
      </div>

      {/* Art placeholder */}
      <div style={{
        width: '100%',
        height: 100,
        borderRadius: 8,
        border: `2px solid ${typeColor}44`,
        background: '#151530',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 52,
        userSelect: 'none',
        flexShrink: 0,
      }}>
        {getCardArt(card.id, card.card_type)}
      </div>

      {/* Archetype — Type line */}
      <div style={{
        textAlign: 'center',
        fontSize: 10,
        color: '#999',
        letterSpacing: 0.5,
      }}>
        {ARCHETYPE_LABEL[card.archetype] || card.archetype}{' '}
        <span style={{ color: '#555' }}>—</span>{' '}
        <span style={{ color: typeColor }}>
          {TYPE_LABEL[card.card_type] || card.card_type}
        </span>
        {card.starter && (
          <>
            {' '}<span style={{ color: '#555' }}>—</span>{' '}
            <span style={{ color: '#888', fontStyle: 'italic' }}>Starter</span>
          </>
        )}
        {remaining != null && (
          <>
            {' '}<span style={{ color: '#555' }}>·</span>{' '}
            <span style={{ color: '#888' }}>×{remaining}</span>
          </>
        )}
      </div>

      {/* Abilities box */}
      <div style={{
        background: '#151530',
        borderRadius: 8,
        border: '1px solid #2a2a4e',
        padding: '8px 10px',
        fontSize: 11,
        lineHeight: 1.5,
        color: '#ccc',
        flex: 1,
      }}>
        {abilityParts.map((text, i) => (
          <div key={i}>{renderWithKeywords(text)}</div>
        ))}
        {statNotes.length > 0 && (
          <div style={{
            marginTop: abilityParts.length > 0 ? 6 : 0,
            paddingTop: abilityParts.length > 0 ? 6 : 0,
            borderTop: abilityParts.length > 0 ? '1px solid #2a2a4e' : 'none',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
          }}>
            {statNotes.map((note, i) => (
              <span key={i} style={{
                fontSize: 9,
                padding: '1px 6px',
                borderRadius: 8,
                border: '1px solid #555',
                color: '#aaa',
              }}>
                {note}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* Keyword hint panel — fades in next to card */}
      {shouldShowHints && keywords.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 0,
          ...(hintsOnLeft
            ? { right: CARD_FULL_WIDTH + 8 }
            : { left: CARD_FULL_WIDTH + 8 }),
          width: 180,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          opacity: hintsVisible ? 1 : 0,
          transition: 'opacity 0.4s ease',
          pointerEvents: 'none',
        }}>
          {keywords.map(({ keyword, definition }) => (
            <div key={keyword} style={{
              background: 'rgba(15, 15, 35, 0.95)',
              border: '1px solid #3a3a5e',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 10,
              lineHeight: 1.4,
              color: '#bbb',
            }}>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>{keyword}:</span>{' '}
              {definition}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
