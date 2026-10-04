import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import Tooltip from './Tooltip';
import { extractKeywordsFromText, KEYWORDS } from './Keywords';
import { renderDescription } from './renderDescription';
import { useCardCatalog } from '../cardCatalog';
import { useTooltips } from './SettingsContext';
import { CARD_TITLE_FONT, getCardDisplayColor, getCardDisplayType } from '../constants/cardColors';
import { cardTrimTier, metalGradient, mixHex, TRIM_INK, TRIM_METALS } from '../constants/cardTrim';
import { buildCardSubtitle, type CardSubtitleContext, type SubtitlePart } from './cardSubtitle';
import { renderSubtitle } from './SubtitlePartRenderer';
import CardName, { plainCardName } from './CardName';
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
/** Every full card is the same size: a 63 × 88 trading-card ratio. */
export const CARD_FULL_HEIGHT = 308;
/** Kept for callers that position previews; full cards are fixed-height now. */
export const CARD_FULL_MIN_HEIGHT = CARD_FULL_HEIGHT;

/** Thickness of the metallic trim around the card (px). */
const TRIM = 7;
const OUTER_RADIUS = 14;
const ART_HEIGHT = 112;

interface CardFullProps {
  card: Card;
  /** Override the displayed buy cost (for dynamic pricing in shop) */
  effectiveCost?: number | null;
  /** Show remaining copies badge */
  remaining?: number | null;
  style?: React.CSSProperties;
  /** Show keyword definitions next to the card after a delay */
  showKeywordHints?: boolean;
  /** Live game context for the stat plaque (resolves tile-scaling power etc.). */
  subtitleContext?: CardSubtitleContext;
  /** Pre-built stat plaque parts; overrides `subtitleContext`. */
  subtitleParts?: SubtitlePart[];
  /** Highlight values resolved from live game context in the stat plaque. */
  showDynamic?: boolean;
  /** Press-and-hold the art to view it full screen. Off where a press means
   *  something else (dragging a card out of the hand). */
  artZoom?: boolean;
}

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

/** Split ability text into sentences ("Claim: Power 3. Draw 1 card." → 2). */
function splitSentences(text: string): string[] {
  return text.replace(/([.!?])\s+(?=[A-Z(])/g, '$1\u0000').split('\u0000').map(s => s.trim()).filter(Boolean);
}

/** Layout attempts for ability text, tried in order until one fits the box:
 *  short text fills the box at up to TEXT_MAX px, one sentence per line when
 *  there's room, then flowing text, shrinking the type only as far as it
 *  has to. */
const TEXT_MAX = 15;
const TEXT_MIN = 9;
const FIT_STEPS: { split: boolean; size: number }[] = [];
for (let size = TEXT_MAX; size >= TEXT_MIN; size -= 0.5) {
  FIT_STEPS.push({ split: true, size });
  if (size <= 12) FIT_STEPS.push({ split: false, size });
}
/** Every card shares the same box, so a fit depends only on its content. */
const fitCache = new Map<string, number>();

/** The ability box: centered text that picks the roomiest layout that fits. */
function AbilityText({ text, notes, fitKey, catalogRender }: {
  text: string;
  notes: React.ReactNode;
  fitKey: string;
  catalogRender: (s: string) => React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Binary search for the first (roomiest) step that fits: [lo, hi] narrows
  // to a single step, measuring the midpoint each pass.
  const initial = (key: string) => {
    const cached = fitCache.get(key);
    return cached !== undefined ? { lo: cached, hi: cached } : { lo: 0, hi: FIT_STEPS.length - 1 };
  };
  const [search, setSearch] = useState(() => initial(fitKey));
  const sentences = useMemo(() => splitSentences(text), [text]);

  // Re-fit from scratch when the content changes (e.g. the card is upgraded).
  const lastKey = useRef(fitKey);
  if (lastKey.current !== fitKey) {
    lastKey.current = fitKey;
    setSearch(initial(fitKey));
  }
  const step = Math.floor((search.lo + search.hi) / 2);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content || box.clientHeight === 0) return;
    if (search.lo === search.hi) {
      fitCache.set(fitKey, search.lo);
      return;
    }
    const fits = content.scrollHeight <= box.clientHeight + 0.5;
    setSearch(fits ? { lo: search.lo, hi: step } : { lo: step + 1, hi: search.hi });
  }, [search, step, fitKey]);

  const { split, size } = FIT_STEPS[step];
  const lines = split && sentences.length > 1 ? sentences : [text];
  return (
    <div ref={boxRef} style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <div ref={contentRef} style={{ fontSize: size, lineHeight: 1.38, textAlign: 'center', textWrap: 'balance' } as React.CSSProperties}>
        {text && lines.map((line, i) => (
          <div key={i} style={{ marginTop: i > 0 ? 2 : 0 }}>{catalogRender(line)}</div>
        ))}
        {notes}
      </div>
    </div>
  );
}

/** Card name, shrunk (and if need be squeezed) to fit on one line. */
function FittedName({ children, maxSize, length }: { children: React.ReactNode; maxSize: number; length: number }) {
  // Philosopher bold averages ~0.5em per glyph; start near the right size so
  // the squeeze below is a last resort.
  const size = Math.max(12, Math.min(maxSize, 158 / Math.max(1, length * 0.5)));
  return (
    <div style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', fontSize: size }}>
      <span
        style={{ display: 'inline-block', transformOrigin: 'left center', transform: 'scaleX(var(--cc-name-squeeze, 1))' }}
        ref={(el) => {
          if (!el?.parentElement) return;
          const avail = el.parentElement.clientWidth;
          if (!avail) return;
          el.style.setProperty('--cc-name-squeeze', String(Math.min(1, avail / el.scrollWidth)));
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** Art slot that loads a card image (WebP, then PNG), falling back to the
 *  card-type sigil.
 *  Drop a .png in public/cards/ named by definition id and run
 *  frontend/scripts/optimize_images.py to generate its compressed .webp.
 *  Art that was preloaded (see utils/cardImagePreload) paints immediately;
 *  anything else shows a soft shimmer and fades in when it arrives. */
function CardArtSlot({ cardId, cardName, cardType, typeColor, zoomable, upgraded }: {
  cardId: string; cardName: string; cardType: string; typeColor: string; zoomable: boolean; upgraded: boolean;
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
          if (hasImage && zoomable) {
            e.preventDefault();
            setShowFull(true);
          }
        }}
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 5,
          background: hasImage && !loaded
            ? 'linear-gradient(100deg, #151530 30%, #20204a 50%, #151530 70%) 0 0 / 300% 100%'
            : '#151530',
          animation: hasImage && !loaded ? 'cc-art-shimmer 1.2s linear infinite' : undefined,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          userSelect: 'none',
          overflow: 'hidden',
          cursor: hasImage && zoomable ? 'zoom-in' : undefined,
        }}
      >
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
        {/* Upgraded cards are printed holo: a rainbow film drifts over the art. */}
        {upgraded && <div aria-hidden className="cc-card-holo" />}
        {/* Vignette so the art sits inside the frame rather than on top of it. */}
        <div aria-hidden style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          boxShadow: 'inset 0 0 18px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.45)',
          borderRadius: 'inherit',
        }} />
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

/**
 * Unified full card face used everywhere cards are displayed in detail: the
 * hand, shop, deck/discard viewers, zoom, previews.
 *
 * Laid out like a printed trading card at a fixed 63 × 88 ratio: a metallic
 * trim (tiered by cost, see constants/cardTrim), name and cost across the
 * top, framed art with the card's stat plaque on its lower edge, the
 * archetype — type line, and the ability box. Ability text is fitted to the
 * box so every card is the same size.
 */
export default function CardFull({
  card, effectiveCost, remaining, style, showKeywordHints,
  subtitleContext, subtitleParts, showDynamic, artZoom = true,
}: CardFullProps) {
  const typeColor = getCardDisplayColor(card);
  const typeInk = mixHex(typeColor, '#ffffff', 0.38);
  const tier = cardTrimTier(card);
  const metal = TRIM_METALS[tier];
  const displayCost = effectiveCost ?? card.buy_cost;
  const tooltipsEnabled = useTooltips();
  const catalog = useCardCatalog();

  // Keyword hints state — fade in after delay
  const keywords = useMemo(() => extractKeywords(card), [card]);
  const [hintsVisible, setHintsVisible] = useState(false);
  /** Where the keyword hints go: beside the card, or stacked above it when
   *  neither side has room (phones) — below it instead when there's no room
   *  above either (a card previewed near the top of the screen). */
  const [hintsSide, setHintsSide] = useState<'right' | 'left' | 'above' | 'below'>('right');
  /** Side hints run down from the card's top, or up from its bottom when
   *  they'd otherwise spill off the bottom of the screen. */
  const [hintsFromBottom, setHintsFromBottom] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const hintsRef = useRef<HTMLDivElement>(null);

  const shouldShowHints = showKeywordHints && tooltipsEnabled;

  useEffect(() => {
    if (!shouldShowHints || keywords.length === 0) {
      setHintsVisible(false);
      return;
    }
    // Phones never have room beside a full-size card: stack the hints above.
    // Elsewhere, measure as they appear — a card zooming in (hand hover) has
    // reached its final size by then — and once more just after, in case it
    // was still settling (e.g. back from a drag).
    const measure = () => {
      const el = cardRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const k = rect.width / CARD_FULL_WIDTH; // the card may be scaled
      const need = (180 + 8) * k;
      const spaceRight = window.innerWidth - rect.right;
      const hintsH = (hintsRef.current?.getBoundingClientRect().height ?? 0) + 8 * k;
      const margin = 8;
      let side: 'right' | 'left' | 'above' | 'below' = window.innerWidth < 640
        ? 'above'
        : spaceRight >= need ? 'right' : rect.left >= need ? 'left' : 'above';
      // No room above (e.g. a preview near the top of the screen): below it,
      // or wherever there's more room.
      if (side === 'above' && rect.top - hintsH < margin && window.innerHeight - rect.bottom > rect.top) side = 'below';
      setHintsSide(side);
      setHintsFromBottom(
        (side === 'right' || side === 'left') && rect.top + hintsH > window.innerHeight - margin && rect.bottom - hintsH >= margin,
      );
    };
    const show = setTimeout(() => { measure(); setHintsVisible(true); }, 1000);
    const settle = setTimeout(measure, 1400);
    return () => { clearTimeout(show); clearTimeout(settle); };
  }, [shouldShowHints, keywords]);
  const hintsOnLeft = hintsSide === 'left';
  const hasCost = displayCost !== null && displayCost !== undefined;
  const isDiscounted = displayCost !== null && card.buy_cost !== null && displayCost < card.buy_cost;

  const displayDescription = (card.is_upgraded && card.upgrade_description ? card.upgrade_description : card.description) || '';
  const displayName = plainCardName(card.is_upgraded && card.name_upgraded ? card.name_upgraded : card.name);
  const statNotes = buildStatNotes(card);
  const plaque = useMemo(
    () => subtitleParts ?? buildCardSubtitle(card, subtitleContext),
    [card, subtitleContext, subtitleParts],
  );
  const fitKey = `${displayDescription}|${statNotes.join(',')}|${plaque.length > 0 ? 'p' : ''}`;

  const notes = statNotes.length > 0 ? (
    <div style={{
      marginTop: displayDescription ? 6 : 0,
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: 4,
      lineHeight: 1.2,
    }}>
      {statNotes.map((note, i) => {
        const isUnique = note === 'Unique';
        const tooltipText = STAT_NOTE_TOOLTIPS[note];
        const pill = (
          <span style={{
            fontSize: 9,
            padding: '1px 6px',
            borderRadius: 8,
            border: `1px solid ${isUnique ? '#ffd700' : 'rgba(255,255,255,0.2)'}`,
            background: 'rgba(0,0,0,0.25)',
            color: isUnique ? '#ffd700' : '#b8b6c8',
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
  ) : null;

  return (
    <div ref={cardRef} data-card-full="true" data-hints-side={hintsSide} style={{
      width: CARD_FULL_WIDTH,
      height: CARD_FULL_HEIGHT,
      boxSizing: 'border-box',
      position: 'relative',
      flexShrink: 0,
      padding: TRIM,
      borderRadius: OUTER_RADIUS,
      background: metalGradient(tier, 145),
      color: '#fff',
      fontFamily: 'var(--cc-font-body)',
      // Bevel on the metal + a dark rim and drop shadow so it reads as a
      // physical card wherever it sits.
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.6), 0 10px 26px rgba(0,0,0,0.55)',
      ...style,
    }}>
      {/* Inner panel */}
      <div style={{
        position: 'relative',
        height: '100%',
        boxSizing: 'border-box',
        borderRadius: OUTER_RADIUS - TRIM + 2,
        padding: '5px 7px 7px',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background:
          `linear-gradient(180deg, ${typeColor}52 0%, ${typeColor}1a 26%, rgba(0,0,0,0) 44%),` +
          `repeating-linear-gradient(-45deg, ${typeColor}12 0 2px, rgba(0,0,0,0) 2px 9px),` +
          'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(0,0,0,0.28) 100%),' +
          '#17172f',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.7), inset 0 0 0 2px rgba(255,255,255,0.05)',
      }}>
        {/* Title row: name left, VP + cost badges right */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 27, flexShrink: 0 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', fontFamily: CARD_TITLE_FONT, fontWeight: 'bold', letterSpacing: 0.2, color: '#fff6e2', textShadow: '0 1px 2px rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.4)' }}>
            <FittedName maxSize={17} length={displayName.length + (card.is_upgraded ? 1.5 : 0)}>
              <CardName name={displayName} upgraded={card.is_upgraded} />
            </FittedName>
          </div>
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
                flexShrink: 0,
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
                fontSize: 12.5,
                fontWeight: 'bold',
                // Minted-coin cost badge (green when discounted).
                color: isDiscounted ? '#0f3a1a' : '#2a1d05',
                background: isDiscounted
                  ? 'linear-gradient(180deg, #a6ffb8 0%, #4fd472 55%, #2e9e4e 100%)'
                  : 'linear-gradient(180deg, #ffe9a8 0%, #e8c46a 50%, #b88a32 100%)',
                borderRadius: 999,
                padding: '1px 7px',
                border: `1px solid ${isDiscounted ? '#c8ffd4' : '#f6dc94'}`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.2), 0 1px 3px rgba(0,0,0,0.6)',
                lineHeight: 1.3,
                flexShrink: 0,
              }}>
                <CostLabel cost={displayCost} suffix={isDiscounted ? '*' : ''} size={12.5} />
              </div>
            </Tooltip>
          ) : null}
        </div>

        {/* Framed art, with the stat plaque set into its lower edge */}
        <div style={{ position: 'relative', flexShrink: 0, marginTop: 2 }}>
          <div style={{
            position: 'relative',
            height: ART_HEIGHT,
            padding: 2.5,
            borderRadius: 7,
            background: metalGradient(tier, 160),
            boxShadow: '0 2px 5px rgba(0,0,0,0.55)',
          }}>
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <CardArtSlot
                key={card.definition_id}
                cardId={card.definition_id}
                cardName={card.name}
                cardType={card.card_type}
                typeColor={typeColor}
                zoomable={artZoom}
                upgraded={card.is_upgraded}
              />
            </div>
          </div>
          {plaque.length > 0 && (
            <div style={{
              position: 'absolute',
              left: '50%',
              bottom: -11,
              transform: 'translateX(-50%)',
              maxWidth: '92%',
              padding: 1.5,
              borderRadius: 999,
              background: metalGradient(tier, 90),
              boxShadow: '0 2px 6px rgba(0,0,0,0.6)',
              zIndex: 2,
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2px 9px',
                borderRadius: 999,
                background: 'linear-gradient(180deg, #24244a 0%, #121228 100%)',
                color: '#ecebf5',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1)',
              }}>
                {renderSubtitle(plaque, { fontSize: 13, passiveVp: card.passive_vp, showDynamic })}
              </div>
            </div>
          )}
        </div>

        {/* Archetype — Type line between two gilded rules */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginTop: plaque.length > 0 ? 15 : 6,
          flexShrink: 0,
          fontSize: 9,
          lineHeight: 1,
          letterSpacing: 1.3,
          textTransform: 'uppercase',
          color: '#b3b0c8',
          whiteSpace: 'nowrap',
        }}>
          <span aria-hidden style={{ flex: 1, height: 1, background: `linear-gradient(90deg, rgba(0,0,0,0), ${metal[1]}aa)` }} />
          <span>
            {ARCHETYPE_LABEL[card.archetype] || card.archetype}
            <span style={{ color: '#5d5b78' }}> · </span>
            <span style={{ color: typeInk, fontWeight: 'bold' }}>{getCardDisplayType(card)}</span>
            {card.starter && <><span style={{ color: '#5d5b78' }}> · </span><span style={{ color: '#8d8aa6', fontStyle: 'italic' }}>Starter</span></>}
            {remaining != null && <><span style={{ color: '#5d5b78' }}> · </span><span style={{ color: '#8d8aa6' }}>×{remaining}</span></>}
          </span>
          <span aria-hidden style={{ flex: 1, height: 1, background: `linear-gradient(270deg, rgba(0,0,0,0), ${metal[1]}aa)` }} />
        </div>

        {/* Ability box */}
        <div style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          marginTop: 5,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 7,
          padding: '6px 9px',
          color: '#e2e0ee',
          background: 'linear-gradient(180deg, rgba(8, 8, 24, 0.82), rgba(20, 20, 46, 0.82))',
          border: '1px solid rgba(232, 196, 106, 0.16)',
          boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.5)',
          overflow: 'hidden',
        }}>
          {/* Faint type sigil watermark */}
          <div aria-hidden style={{ position: 'absolute', right: -10, bottom: -14, opacity: 0.07, pointerEvents: 'none' }}>
            <Icon name={fallbackSigil(card.definition_id, card.card_type)} size={84} color={typeInk} decorative />
          </div>
          <AbilityText
            text={displayDescription}
            notes={notes}
            fitKey={fitKey}
            catalogRender={(s) => renderDescription(s, catalog, card.definition_id)}
          />
        </div>
      </div>

      {/* Laminate: a fixed diagonal sheen plus a glare a parent can steer with
          --cc-glare-x / --cc-glare-y / --cc-glare-o (hand hover, zoom). */}
      <div aria-hidden className="cc-card-sheen" />
      <div aria-hidden className="cc-card-glare" />
      {/* Hairline where the metal meets the panel */}
      <div aria-hidden style={{
        position: 'absolute', inset: TRIM - 1, borderRadius: OUTER_RADIUS - TRIM + 3, pointerEvents: 'none',
        boxShadow: `0 0 0 1px ${TRIM_INK[tier]}55`,
      }} />

      {/* Keyword hint panel — fades in next to card */}
      {shouldShowHints && keywords.length > 0 && (
        <div ref={hintsRef} style={{
          position: 'absolute',
          ...(hintsSide === 'above'
            ? { bottom: '100%', left: 0, width: CARD_FULL_WIDTH, paddingBottom: 8, flexDirection: 'column-reverse' as const }
            : hintsSide === 'below'
              ? { top: '100%', left: 0, width: CARD_FULL_WIDTH, paddingTop: 8, flexDirection: 'column' as const }
              : {
                  ...(hintsFromBottom ? { bottom: 0 } : { top: 0 }),
                  ...(hintsOnLeft ? { right: CARD_FULL_WIDTH + 8 } : { left: CARD_FULL_WIDTH + 8 }),
                  width: 180,
                  flexDirection: (hintsFromBottom ? 'column-reverse' : 'column') as 'column' | 'column-reverse',
                }),
          boxSizing: 'border-box',
          display: 'flex',
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
