import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import Tooltip from './Tooltip';
import { extractKeywordsFromText, KEYWORDS } from './Keywords';
import { renderDescription } from './renderDescription';
import { useCardCatalog } from '../cardCatalog';
import { useTooltips } from './SettingsContext';
import { CARD_TYPE_COLORS, CARD_TITLE_FONT, getCardDisplayColor, getCardDisplayType } from '../constants/cardColors';
import {
  cardImageUrl,
  isCardImageMissing,
  isCardImageReady,
  markCardImageMissing,
  markCardImageReady,
  markCardImageWebpFailed,
  onCardImageReady,
  preloadCardImages,
} from '../utils/cardImagePreload';
import Icon from '../icons/Icon';
import { CostLabel, IconValue } from '../icons/Num';
import type { IconName } from '../icons/glyphs';

const ARCHETYPE_LABEL: Record<string, string> = {
  vanguard: 'Vanguard',
  swarm: 'Swarm',
  fortress: 'Fortress',
  shared: 'Shared',
};

const TYPE_LABEL: Record<string, string> = {
  claim: 'Claim',
  defense: 'Defense',
  engine: 'Engine',
  passive: 'Passive',
};

/** Sigil shown when a card's art image is unavailable: its card type, with
 *  a few token cards getting their own glyph. */
function fallbackSigil(cardId: string, cardType: string): IconName {
  if (cardId === 'neutral_debt' || cardId === 'debt') return 'debt';
  if (cardId === 'neutral_rubble' || cardId === 'rubble') return 'rubble';
  if (cardId === 'neutral_spoils' || cardId === 'spoils') return 'vp';
  if (cardType === 'claim' || cardType === 'defense' || cardType === 'engine' || cardType === 'passive') return cardType;
  return 'card';
}

/** Glyph for each stat-note pill. */
const STAT_NOTE_ICONS: Record<string, IconName> = {
  'Trashed after use.': 'trash',
  'Stackable': 'stack',
  'No adjacency required.': 'anywhere',
  'Unique': 'unique',
  'Immune': 'immune',
};

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
/** Build the list of stat-note pills shown under a card's description. */
function buildStatNotes(card: Card): string[] {
  const statNotes: string[] = [];
  if (card.trash_on_use) statNotes.push('Trashed after use.');
  if (card.stackable) statNotes.push('Stackable');
  if (!card.adjacency_required) statNotes.push('No adjacency required.');
  if (card.unique) statNotes.push('Unique');
  if (card.effects?.some(e => e.type === 'tile_immunity')) statNotes.push('Immune');
  return statNotes;
}

/** Tooltip text for each stat-note pill. Keyword-backed pills reuse the
 *  canonical keyword definition so they stay in sync with the rest of the UI. */
const STAT_NOTE_TOOLTIPS: Record<string, string> = {
  'Stackable': KEYWORDS.Stackable,
  'Unique': KEYWORDS.Unique,
  'Trashed after use.': 'This card is removed from your deck permanently after it is played.',
  'No adjacency required.': 'This card can target any tile — it does not need to be next to a tile you already own.',
  'Immune': 'The targeted tile cannot be claimed this round.',
};

/**
 * Extract unique keywords present anywhere on the card — description text
 * and the stat-note pills (Unique, Stackable, etc.) that live below it.
 */
function extractKeywords(card: Card): { keyword: string; definition: string }[] {
  const desc = card.is_upgraded && card.upgrade_description ? card.upgrade_description : card.description;
  const combined = [desc || '', ...buildStatNotes(card)].join(' ');
  return extractKeywordsFromText(combined);
}

/** Art slot that loads a card image (WebP, then PNG), falling back to the
 *  card-type sigil.
 *  Drop a .png in public/cards/ named by definition id and run
 *  frontend/scripts/optimize_images.py to generate its compressed .webp.
 *  Art that was preloaded (see utils/cardImagePreload) paints immediately;
 *  anything else shows a soft shimmer and fades in when it arrives. */
function CardArtSlot({ cardId, cardName, cardType, typeColor }: {
  cardId: string; cardName: string; cardType: string; typeColor: string;
}) {
  const [imgFailed, setImgFailed] = useState(() => isCardImageMissing(cardId));
  // Bumped when the WebP fails so the <img> re-renders with the PNG URL.
  const [, setUrlEpoch] = useState(0);
  const [loaded, setLoaded] = useState(() => isCardImageReady(cardId));
  // Only animate the fade when the art wasn't already warm at mount.
  const fadeIn = useRef(!loaded);
  const [showFull, setShowFull] = useState(false);
  const imgUrl = cardImageUrl(cardId);

  const hasImage = !imgFailed;

  useEffect(() => {
    // Promote this card to the front of the preload queue (no-op if loaded).
    preloadCardImages([cardId], 'high');
    if (loaded) return;
    return onCardImageReady(cardId, () => setLoaded(true));
  }, [cardId, loaded]);

  // Close fullscreen on pointer/mouse up anywhere
  useEffect(() => {
    if (!showFull) return;
    const close = () => setShowFull(false);
    window.addEventListener('pointerup', close);
    window.addEventListener('pointercancel', close);
    return () => {
      window.removeEventListener('pointerup', close);
      window.removeEventListener('pointercancel', close);
    };
  }, [showFull]);

  return (
    <>
      <div
        onPointerDown={(e) => {
          if (hasImage) {
            e.preventDefault();
            setShowFull(true);
          }
        }}
        style={{
          width: '100%',
          height: 100,
          borderRadius: 8,
          border: `1px solid ${hasImage ? typeColor + '66' : typeColor + '44'}`,
          background: hasImage && !loaded
            ? 'linear-gradient(100deg, #151530 30%, #20204a 50%, #151530 70%) 0 0 / 300% 100%'
            : '#151530',
          animation: hasImage && !loaded ? 'cc-art-shimmer 1.2s linear infinite' : undefined,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 52,
          userSelect: 'none',
          flexShrink: 0,
          overflow: 'hidden',
          position: 'relative',
          cursor: hasImage ? 'zoom-in' : undefined,
        }}
      >
        {hasImage && (
          <div style={{
            position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 1,
            boxShadow: 'inset 0 0 16px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.35)',
            borderRadius: 'inherit',
          }} />
        )}
        {hasImage ? (
          <img
            src={imgUrl}
            alt={cardName}
            draggable={false}
            decoding="async"
            onLoad={() => { markCardImageReady(cardId); setLoaded(true); }}
            onError={() => {
              if (!imgUrl.endsWith('.png')) {
                markCardImageWebpFailed(cardId);
                setUrlEpoch(n => n + 1);
              } else {
                markCardImageMissing(cardId);
                setImgFailed(true);
              }
            }}
            style={{
              display: 'block', width: '100%', height: '100%', objectFit: 'cover',
              opacity: loaded ? 1 : 0,
              transition: fadeIn.current ? 'opacity 220ms ease-out' : undefined,
            }}
          />
        ) : (
          <span style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%',
            background: `radial-gradient(circle at 50% 45%, ${typeColor}55 0%, rgba(0,0,0,0) 72%)`,
          }}>
            <Icon
              name={fallbackSigil(cardId, cardType)}
              size={46}
              color="#f3e9d2"
              title={`${cardName} (art unavailable)`}
              style={{ filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.6))', ['--cc-icon-accent-opacity' as string]: 0.5 }}
            />
          </span>
        )}
      </div>
      {showFull && hasImage && createPortal(
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.9)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 60000,
          cursor: 'zoom-out',
        }}>
          <img
            src={imgUrl}
            alt={cardName}
            draggable={false}
            style={{
              maxWidth: '95vw',
              maxHeight: '95vh',
              objectFit: 'contain',
              borderRadius: 8,
            }}
          />
        </div>,
        document.body
      )}
    </>
  );
}

export default function CardFull({ card, effectiveCost, remaining, style, showKeywordHints }: CardFullProps) {
  const typeColor = getCardDisplayColor(card);
  const displayCost = effectiveCost ?? card.buy_cost;
  const tooltipsEnabled = useTooltips();
  const catalog = useCardCatalog();

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

  // Build abilities text — use upgrade description for upgraded cards
  const abilityParts: string[] = [];
  const displayDescription = card.is_upgraded && card.upgrade_description ? card.upgrade_description : card.description;
  if (displayDescription) abilityParts.push(displayDescription);

  const statNotes = buildStatNotes(card);

  return (
    <div ref={cardRef} data-card-full="true" data-hints-side={hintsOnLeft ? 'left' : 'right'} style={{
      width: CARD_FULL_WIDTH,
      position: 'relative',
      // Layered background gives the blue/grey panel some depth: a base color
      // plus two faint repeating gradients that read as fine fabric/paper grain
      // and a soft top-down highlight, so the card doesn't feel flat under the
      // 3D tilt and glare effects when zoomed.
      background:
        `linear-gradient(180deg, ${typeColor}33 0%, ${typeColor}0d 22%, rgba(0,0,0,0) 40%),` +
        'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 35%, rgba(0,0,0,0.22) 100%),' +
        'repeating-linear-gradient(45deg, rgba(255,255,255,0.018) 0 1px, rgba(0,0,0,0) 1px 3px),' +
        'repeating-linear-gradient(-45deg, rgba(255,255,255,0.014) 0 1px, rgba(0,0,0,0) 1px 4px),' +
        '#1c1c38',
      border: `2px solid ${typeColor}`,
      borderRadius: 12,
      padding: '12px 14px 14px',
      color: '#fff',
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
      // Inner gold hairline + dark outer rim read as a printed card frame.
      boxShadow: 'inset 0 0 0 1px rgba(232, 196, 106, 0.16), inset 0 1px 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(0,0,0,0.55), 0 10px 32px rgba(0,0,0,0.6)',
      ...style,
    }}>
      {/* Top row: title left-aligned, VP badge + cost badge top-right */}
      <div style={{ position: 'relative', textAlign: 'left', minHeight: 22 }}>
        <div style={{ fontSize: 15.5, fontWeight: 'bold', lineHeight: 1.3, paddingRight: card.current_vp !== undefined ? 78 : 36, fontFamily: CARD_TITLE_FONT, letterSpacing: 0.2, textShadow: '0 1px 2px rgba(0,0,0,0.6)' }}>
          {card.is_upgraded && card.name_upgraded ? card.name_upgraded : card.name}
          {card.is_upgraded && !card.name.endsWith('+') && !(card.name_upgraded?.endsWith('+')) && <span style={{ color: '#ffd700' }}> +</span>}
        </div>
        <div style={{
          position: 'absolute',
          top: 0,
          right: 0,
          display: 'flex',
          gap: 4,
          alignItems: 'center',
        }}>
          {card.current_vp !== undefined && (
            <Tooltip content={
              card.current_vp >= 0
                ? `This card is currently worth ${card.current_vp} VP`
                : `This card costs you ${Math.abs(card.current_vp)} VP`
            }>
              <div style={{
                cursor: 'help',
                fontSize: 12,
                fontWeight: 'bold',
                color: card.current_vp > 0 ? '#ffd700' : card.current_vp < 0 ? '#ff6666' : '#888',
                background: 'linear-gradient(180deg, #30305a, #20203e)',
                borderRadius: 999,
                padding: '1px 7px',
                border: `1px solid ${card.current_vp > 0 ? '#ffd700' : card.current_vp < 0 ? '#ff6666' : '#555'}`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
                lineHeight: 1.3,
              }}>
                <IconValue icon="vp" value={`${card.current_vp > 0 ? '+' : ''}${card.current_vp}`} size={12} iconFirst={false} gap={2} decorative />
              </div>
            </Tooltip>
          )}
          {hasCost ? (
            <Tooltip content={
              isDiscounted
                ? `Cost: ${displayCost} (reduced from ${card.buy_cost})`
                : `Cost to purchase: ${displayCost} resources`
            }>
              <div style={{
                cursor: 'help',
                fontSize: 12,
                fontWeight: 'bold',
                // Minted-coin cost badge (green when discounted).
                color: isDiscounted ? '#0f3a1a' : '#2a1d05',
                background: isDiscounted
                  ? 'linear-gradient(180deg, #a6ffb8 0%, #4fd472 55%, #2e9e4e 100%)'
                  : 'linear-gradient(180deg, #ffe9a8 0%, #e8c46a 50%, #b88a32 100%)',
                borderRadius: 999,
                padding: '1px 7px',
                border: `1px solid ${isDiscounted ? '#c8ffd4' : '#f6dc94'}`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.5)',
                lineHeight: 1.3,
              }}>
                <CostLabel cost={displayCost} suffix={isDiscounted ? '*' : ''} size={12} />
              </div>
            </Tooltip>
          ) : (
            <div style={{
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
      </div>

      {/* Card art — tries image file, falls back to the card-type sigil */}
      <CardArtSlot key={card.definition_id} cardId={card.definition_id} cardName={card.name} cardType={card.card_type} typeColor={typeColor} />

      {/* Archetype — Type line */}
      <div style={{
        textAlign: 'center',
        fontSize: 9.5,
        color: '#a3a1b8',
        letterSpacing: 1.1,
        textTransform: 'uppercase',
      }}>
        {ARCHETYPE_LABEL[card.archetype] || card.archetype}{' '}
        <span style={{ color: '#555' }}>—</span>{' '}
        <span style={{ color: typeColor }}>
          {getCardDisplayType(card)}
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
        background: 'linear-gradient(180deg, rgba(12, 12, 32, 0.9), rgba(18, 18, 44, 0.9))',
        borderRadius: 8,
        border: '1px solid rgba(232, 196, 106, 0.13)',
        boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.45)',
        padding: '8px 10px',
        fontSize: 11,
        lineHeight: 1.5,
        color: '#d4d2e2',
        flex: 1,
      }}>
        {abilityParts.map((text, i) => (
          <div key={i}>{renderDescription(text, catalog, card.definition_id)}</div>
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
            {statNotes.map((note, i) => {
              const isUnique = note === 'Unique';
              const tooltipText = STAT_NOTE_TOOLTIPS[note];
              const pill = (
                <span style={{
                  fontSize: 9,
                  padding: '1px 6px',
                  borderRadius: 8,
                  border: `1px solid ${isUnique ? '#ffd700' : '#555'}`,
                  color: isUnique ? '#ffd700' : '#aaa',
                  fontWeight: isUnique ? 'bold' : undefined,
                  cursor: tooltipText ? 'help' : undefined,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                }}>
                  {STAT_NOTE_ICONS[note] && <Icon name={STAT_NOTE_ICONS[note]} size={10} trim decorative />}
                  {note}
                </span>
              );
              return tooltipText ? (
                <Tooltip key={i} content={tooltipText}>{pill}</Tooltip>
              ) : (
                <span key={i}>{pill}</span>
              );
            })}
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
              background: 'linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0) 50%), rgba(15, 15, 35, 0.96)',
              border: '1px solid rgba(232, 196, 106, 0.2)',
              boxShadow: '0 4px 12px rgba(0,0,0,0.45)',
              borderRadius: 7,
              padding: '4px 8px',
              fontSize: 10,
              lineHeight: 1.4,
              color: '#bbb',
            }}>
              <span style={{ color: 'var(--cc-gold-bright)', fontWeight: 'bold' }}>{keyword}:</span>{' '}
              {definition}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
