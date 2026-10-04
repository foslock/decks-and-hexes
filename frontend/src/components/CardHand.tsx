import { useRef, useCallback, useState, useEffect, useLayoutEffect, useMemo, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import { useAnimated, useAnimationOff, useAnimationSpeed } from './SettingsContext';
import CardFull from './CardFull';
import CardBack from './CardBack';
import { plainCardName } from './CardName';
import { useShiftKey } from '../hooks/useShiftKey';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import type { CardSubtitleContext } from './cardSubtitle';
import { isCardEmpowered } from './cardEmpowered';
import Icon from '../icons/Icon';
import { useSound } from '../audio/useSound';
import { CardViewPopup } from './CardViewPopup';
import CardPile, { discardTopSpin, DRAW_PILE_SPIN } from './hand/CardPile';
import TargetArrow, { type ArrowState } from './hand/TargetArrow';
import TrashBurn from './hand/TrashBurn';
import FlightCard, { turnOver, type Flight as BaseFlight } from './hand/FlightCard';
import {
  CARD_H, CARD_W, PILE_SCALE, PILE_TILT,
  easeIn, easeInOut, easeOut, enterKeyframes, flightKeyframes, poseTransform, runAnimation, type Pose,
} from './hand/cardMotion';
import { handSizing, handStripHeight, layoutHand, nearestSlot, reconcileHandOrder, shiftLayout, stripAt } from './hand/handLayout';

export { CardViewPopup };

export interface PlayTarget {
  cardId: string;
  /** Screen pixel position for the target tile, or null for non-targeting cards */
  screenX: number | null;
  screenY: number | null;
  /** Drag release position (kept for callers; the flight starts from the held card) */
  dragX?: number;
  dragY?: number;
  /** Cursor velocity at release (px/ms) */
  dragVelocityX?: number;
  dragVelocityY?: number;
  /** The card's size where it lands (its copy on the board / queue). When
   *  set, the flight ends upright at screenX/screenY at this scale so the
   *  board copy takes over seamlessly; otherwise it settles onto the tile. */
  landScale?: number;
}

/** Trash/discard selection mode state passed from GameScreen */
export interface TrashSelectionMode {
  /** Index of the card being played (grayed out, not selectable) */
  playedCardIndex: number;
  /** Indices currently selected for trashing/discarding */
  selectedIndices: Set<number>;
  /** Minimum cards that must be selected (0 for "up to") */
  minCards: number;
  /** Maximum cards that can be selected */
  maxCards: number;
  /** Display label: "Trash" or "Discard" */
  label: string;
}

/** A card coming back to the hand from the board (undo): it flies back
 *  from the tile it was played on. `key` makes each undo distinct. */
export interface UndoReturn {
  cardId: string;
  screenX: number;
  screenY: number;
  key: number;
}

/** What the board says about the tile under a dragged card. */
export interface DragTargetInfo {
  valid: boolean;
  /** Screen position of the hovered tile's center (the arrow snaps to it). */
  x?: number;
  y?: number;
}

/** A card already in the discard pile's data that should be shown flying
 *  into it (purchases). */
export interface IncomingDiscard {
  key: string;
  card: Card;
  /** Where it was bought (the shop tile's screen rect): it lifts off from
   *  there. Without one it pops up above the hand first. */
  from?: { left: number; top: number; width: number; height: number };
}

interface CardHandProps {
  playerId: string;
  cards: Card[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onDragPlay: (cardIndex: number, screenX: number, screenY: number, dragVelocityX?: number, dragVelocityY?: number) => void;
  onDoubleClick?: (cardIndex: number) => void;
  onDragStart?: (cardIndex: number) => void;
  onDragEnd?: () => void;
  /** Fires on every drag move with the effective cursor position (after any
   *  touch-input vertical offset has been applied). Lets the parent drive the
   *  hex highlight from the same coordinates the drop will use. */
  onDragMove?: (clientX: number, clientY: number) => void;
  disabled: boolean;
  // Deck / discard data
  deckSize: number;
  discardCount: number;
  discardCards: Card[];
  deckCards: Card[];
  /** Cards in the trash pile — used to disable tutor cards that search the trash
   *  (and to apply card-type filters like "search trash for a Defense card"). */
  trashCards?: Card[];
  inPlayCards?: Card[];
  /** When set to true, all hand cards animate to discard pile. Fires onDiscardAllComplete when done. */
  discardAll?: boolean;
  /** Callback when the discard-all animation finishes (or immediately if animation is off). */
  onDiscardAllComplete?: () => void;
  /** Where the last played card should animate toward */
  lastPlayedTarget?: PlayTarget | null;
  /** Force the shuffle animation on the draw pile (used during intro sequence) */
  forceShuffleAnim?: boolean;
  /** Trash/discard selection mode */
  trashMode?: TrashSelectionMode | null;
  /** Toggle a card's trash selection (during trash mode) */
  onTrashToggle?: (cardIndex: number) => void;
  /** When true, close any open draw/discard popups */
  closePopups?: boolean;
  /** Card IDs that are being trashed (rip-and-burn instead of discard) */
  trashedCardIds?: Set<string>;
  /** Game context for resolving dynamic card subtitle values */
  subtitleContext?: CardSubtitleContext;
  /** Power the next Claim gets from queued buffs (War Banner) — Claims in hand glow while > 0. */
  claimBuffBonus?: number;
  /** When true, claim cards are banned (Snowy Holiday) — shown dimmed and unplayable */
  claimBanned?: boolean;
  /** Player's current resources — used to dim cards with play_resource_cost when insufficient */
  playerResources?: number;
  /** Actions remaining (available - used) — used to dim cards that cost more actions than available */
  actionsRemaining?: number;
  /** Called when the user hovers over a card (index) or leaves all cards (null). */
  onCardHover?: (index: number | null) => void;
  /**
   * Card IDs that should NOT play the entering (draw-pile) animation when
   * they first appear in the hand. Used by the tutor/search UI: after its
   * fly animation lands a card in the hand zone, the card already looks
   * like it's there.
   */
  suppressEnterAnimFor?: Set<string>;
  /**
   * When true, skip the shuffle-detection heuristic for one update cycle.
   * Tutor/search effects move cards between zones (e.g. discard → hand) which
   * shrink the discard pile WITHOUT a real reshuffle.
   */
  suppressShuffleDetection?: boolean;
  /** Called whenever the visual card order changes (indices into the `cards` prop). */
  onOrderChange?: (order: number[]) => void;
  /** Number of unspent upgrade credits the player has. When > 0, upgradeable cards
   *  in hand show a "Hold to Upgrade" badge on select/hover. */
  upgradeCreditsAvailable?: number;
  /** Called when the player completes a press-and-hold on the upgrade badge for
   *  a card (1.5s hold). Receives the raw hand-card index. */
  onUpgradeCard?: (cardIndex: number) => void;
  /** True when the game is in the Play phase. The upgrade badge only shows
   *  during Play — upgrading is not a legal action in Reveal/Buy/Upkeep. */
  isPlayPhase?: boolean;
  /** Predicate: does this card target a tile when played? Tile-targeting
   *  cards aim with a green/red arrow; the rest aim with a neutral one. */
  cardTargetsTile?: (card: Card) => boolean;
  /** The board's verdict on the tile under the dragged card. */
  dragTarget?: DragTargetInfo | null;
  /** A card returning from the board (undo) — flies back from its tile. */
  undoReturn?: UndoReturn | null;
  /** Cards to fly into the discard pile (purchases) — straight away, over
   *  the shop if it's open. */
  incomingDiscards?: IncomingDiscard[];
  /** An incoming card finished landing on the discard pile. */
  onIncomingLanded?: (key: string) => void;
}

const DRAG_THRESHOLD = 12;
// On touch input, lift the effective drag cursor above the finger so the
// targeted hex isn't hidden under the player's fingertip. The drop target,
// hex highlight and arrow tip all use this offset.
const TOUCH_DRAG_Y_OFFSET = 56;
/** Width of each pile column beside the hand. */
const PILE_COL = 100;

// Press-and-hold "Hold to Upgrade" pill rendered above upgradeable hand cards.
// Fills left-to-right over HOLD_MS; completing fires onComplete().
function UpgradeHoldBadge({
  label,
  animated,
  onHoverChange,
  onComplete,
}: {
  label: string;
  animated: boolean;
  onHoverChange: (hovering: boolean) => void;
  onComplete: () => void;
}) {
  const HOLD_MS = 1500;
  // Fill animation completes slightly before the upgrade fires so the user
  // gets to see the bar fully filled before the card transforms.
  const FILL_MS = 1300;
  const [pressing, setPressing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const startPress = useCallback((e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (timerRef.current) return;
    setPressing(true);
    const duration = animated ? HOLD_MS : 0;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPressing(false);
      onComplete();
    }, duration);
  }, [animated, onComplete]);

  const cancelPress = useCallback(() => {
    clearTimer();
    setPressing(false);
  }, [clearTimer]);

  return (
    <div
      data-upgrade-badge
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => { onHoverChange(false); cancelPress(); }}
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 'calc(100% + 6px)',
        transform: 'translateX(-50%)',
        padding: '3px 10px',
        background: '#3a2f00',
        border: '1px solid #ffd84a',
        borderRadius: 7,
        color: '#ffe566',
        fontSize: 12,
        fontWeight: 'bold',
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        zIndex: 20,
        userSelect: 'none',
        WebkitUserSelect: 'none',
        touchAction: 'none',
        animation: animated && !pressing ? 'upgradeBadgePulse 1.8s ease-in-out infinite' : 'none',
      }}
    >
      {/* Fill bar — sweeps left→right while held. */}
      <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: pressing ? '100%' : '0%',
          background: 'rgba(255, 216, 74, 0.55)',
          transition: animated
            ? (pressing ? `width ${FILL_MS}ms linear` : 'width 120ms ease-out')
            : 'none',
        }} />
      </div>
      <span style={{ position: 'relative' }}>{label}</span>
      {/* Transparent bridge over the gap to the card top, so the card+badge
          hover survives slow mouse transits. */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: '100%', height: 8 }} />
    </div>
  );
}

// ── Flights ─────────────────────────────────────────────────────

type FlightKind = 'discard' | 'discardAll' | 'play' | 'incoming' | 'transfer' | 'swapBack' | 'riffle';
type Flight = BaseFlight<FlightKind>;

interface EnterSpec {
  start: Pose;
  delay: number;
  duration: number;
  /** Starts face down (drawn from the deck) and turns over in flight. */
  flip: boolean;
  arc: number;
  fadeIn: boolean;
}

/** Is a tutor card unplayable because its source zone has nothing it can find? */
function searchZoneEmpty(card: Card, zones: { discard: Card[]; draw: Card[]; trash?: Card[] }): boolean {
  const eff = card.effects?.find(e => e.type === 'search_zone');
  if (!eff) return false;
  const source = String(eff.metadata?.source ?? 'discard');
  const filter = eff.metadata?.filter as { card_type?: string; name?: string } | undefined;
  const sourceCards = source === 'discard' ? zones.discard : source === 'draw' ? zones.draw : source === 'trash' ? zones.trash : undefined;
  if (!sourceCards) return false;
  if (sourceCards.length === 0) return true;
  if (!filter) return false;
  const expectedType = filter.card_type?.toLowerCase();
  return !sourceCards.some(c =>
    (!expectedType || c.card_type.toLowerCase() === expectedType) && (!filter.name || c.name === filter.name));
}

// ── Main CardHand Component ─────────────────────────────────────

/**
 * The player's hand and piles along the bottom of the screen.
 *
 *  - Draw pile (left) and discard pile (right) are 3D stacks of cards with
 *    their counts; click to browse.
 *  - The hand is a fan of full card faces that overlap when crowded and sit
 *    partly below the screen edge. Hovering a card raises it to full size.
 *  - Dragging a card out of the hand draws an aiming arrow from the card to
 *    the pointer; dropping plays it and the card flies to its tile. Dragging
 *    within the hand reorders it.
 *  - Cards fly in from the draw pile (turning face up), out to the discard
 *    pile (face up), to the board when played, back when undone, and rip
 *    and burn when trashed.
 */
export default function CardHand({
  playerId,
  cards,
  selectedIndex,
  onSelect,
  onDragPlay,
  onDoubleClick,
  onDragStart,
  onDragEnd,
  onDragMove,
  disabled,
  deckSize,
  discardCount,
  discardCards,
  deckCards,
  trashCards,
  inPlayCards,
  discardAll,
  onDiscardAllComplete,
  lastPlayedTarget,
  forceShuffleAnim,
  trashMode,
  onTrashToggle,
  closePopups,
  trashedCardIds,
  subtitleContext,
  claimBuffBonus = 0,
  claimBanned,
  playerResources,
  actionsRemaining,
  onCardHover,
  suppressEnterAnimFor,
  suppressShuffleDetection,
  onOrderChange,
  upgradeCreditsAvailable = 0,
  onUpgradeCard,
  isPlayPhase = false,
  cardTargetsTile,
  dragTarget,
  undoReturn,
  incomingDiscards,
  onIncomingLanded,
}: CardHandProps) {
  const animated = useAnimated();
  const animationOff = useAnimationOff();
  const animSpeed = useAnimationSpeed();
  const speed = animSpeed || 1;
  const sound = useSound();
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const shiftHeld = useShiftKey();

  // ── Sizing ──
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const sizing = useMemo(() => handSizing(viewport.w, viewport.h), [viewport]);
  const stripH = handStripHeight(sizing);
  // Phones: smaller piles in narrower columns leave the hand room.
  const pileZoom = viewport.w < 640 ? 0.7 : 1;
  const pileCol = Math.round(PILE_COL * pileZoom);
  const handRef = useRef<HTMLDivElement>(null);
  const [handWidth, setHandWidth] = useState(() => Math.max(160, window.innerWidth - 2 * (PILE_COL + 8) - 24));
  useLayoutEffect(() => {
    const el = handRef.current;
    if (!el) return;
    const measure = () => { if (el.clientWidth > 0) setHandWidth(el.clientWidth); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Order: the player's arrangement of the hand, by card id ──
  const [orderIds, setOrderIds] = useState<string[]>(() => cards.map(c => c.id));
  // Re-arranged during render (not in an effect) so a drawn card's flight
  // already aims at its slot on the right.
  const handIds = cards.map(c => c.id);
  const inPlayIds = inPlayCards?.map(c => c.id) ?? [];
  const [orderBasis, setOrderBasis] = useState({ hand: handIds, inPlay: inPlayIds, discarding: !!discardAll });
  if (orderBasis.hand.join('\n') !== handIds.join('\n') || orderBasis.inPlay.join('\n') !== inPlayIds.join('\n')
    || orderBasis.discarding !== !!discardAll) {
    // Once the hand has gone to the discard pile, nothing in it is held.
    const held = new Set(orderBasis.discarding ? [] : [...orderBasis.hand, ...orderBasis.inPlay]);
    setOrderBasis({ hand: handIds, inPlay: inPlayIds, discarding: !!discardAll });
    setOrderIds(prev => reconcileHandOrder(prev, held, handIds, new Set(inPlayIds)));
  }
  // Indices into `cards` in display order. Ids of cards in play keep their
  // place, so an undone card slides back into its old slot.
  const order = useMemo(() => {
    const idx = new Map(cards.map((c, i) => [c.id, i]));
    const out: number[] = [];
    const seen = new Set<string>();
    for (const id of orderIds) {
      const i = idx.get(id);
      if (i !== undefined && !seen.has(id)) { out.push(i); seen.add(id); }
    }
    cards.forEach((c, i) => { if (!seen.has(c.id)) { out.push(i); seen.add(c.id); } });
    return out;
  }, [orderIds, cards]);
  const onOrderChangeRef = useRef(onOrderChange);
  onOrderChangeRef.current = onOrderChange;
  const orderKey = order.join(',');
  useEffect(() => { onOrderChangeRef.current?.(order); }, [orderKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Interaction state ──
  const [hovered, setHovered] = useState<number | null>(null);
  const [badgeHover, setBadgeHover] = useState<number | null>(null);
  const dragRef = useRef<{
    localIdx: number; startX: number; startY: number; pointerType: string;
    active: boolean; lastX: number; lastT: number; vx: number;
  } | null>(null);
  const [drag, setDrag] = useState<{ localIdx: number; mode: 'reorder' | 'target'; x: number; y: number; insertAt: number; pointerX: number; pointerY: number } | null>(null);
  /** A card dropped on the board stays held up until the play resolves. */
  const [pendingPlayId, setPendingPlayId] = useState<string | null>(null);
  const [showDeckPopup, setShowDeckPopup] = useState(false);
  const [showDiscardPopup, setShowDiscardPopup] = useState(false);

  useEffect(() => {
    if (closePopups) {
      setShowDeckPopup(false);
      setShowDiscardPopup(false);
    }
  }, [closePopups]);

  // ── Animation state ──
  const [entering, setEntering] = useState<Map<string, EnterSpec>>(new Map());
  const pendingEnterRef = useRef<Map<string, EnterSpec>>(new Map());
  const [flights, setFlights] = useState<Flight[]>([]);
  const [burns, setBurns] = useState<{ key: string; card: Card; pose: Pose }[]>([]);
  const [flashes, setFlashes] = useState<{ key: string; x: number; y: number }[]>([]);
  /** Cards still sitting on the draw pile while their draw flight waits. */
  const [drawBonus, setDrawBonus] = useState(0);
  /** Cards in the discard data that are still flying there. */
  const [discardHold, setDiscardHold] = useState(0);
  /** Cards that landed on the discard pile ahead of the data (end-of-turn discard). */
  const [discardExtra, setDiscardExtra] = useState<Card[]>([]);
  /** Hand cards hidden while their stand-ins fly (end-of-turn discard). */
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [shuffle, setShuffle] = useState<{
    fromDiscard: number; toDiscard: number; fromDeck: number; toDeck: number;
    /** Discard cards before the shuffle (the pile shows them as they leave). */
    faces: Card[]; newDiscardFaces: Card[];
    /** Cards flying discard → draw: how many have left / arrived. */
    total: number; lifted: number; landed: number;
  } | null>(null);
  const flightSeq = useRef(0);

  const wrapRefs = useRef(new Map<string, HTMLDivElement>());
  const flipRefs = useRef(new Map<string, HTMLDivElement>());
  const drawPileRef = useRef<HTMLButtonElement>(null);
  const discardPileRef = useRef<HTMLButtonElement>(null);
  const posesRef = useRef(new Map<string, Pose>());
  const prevCardsRef = useRef<Card[]>(cards);
  const prevPlayerIdRef = useRef(playerId);
  const inPlayIdsRef = useRef<Set<string>>(new Set(inPlayCards?.map(c => c.id) ?? []));
  inPlayIdsRef.current = new Set(inPlayCards?.map(c => c.id) ?? []);
  const prevInPlayIdsRef = useRef<Set<string>>(new Set(inPlayCards?.map(c => c.id) ?? []));
  const deferredDrawnRef = useRef<Set<string>>(new Set());

  // ── Layout ──
  const displayOrder = useMemo(() => {
    if (!drag || drag.mode !== 'reorder') return order;
    const next = [...order];
    const [moved] = next.splice(drag.localIdx, 1);
    next.splice(drag.insertAt, 0, moved);
    return next;
  }, [order, drag]);
  const pendingPlayDisplay = pendingPlayId ? displayOrder.findIndex(ci => cards[ci]?.id === pendingPlayId) : -1;
  const liftedDisplay = drag
    ? (drag.mode === 'reorder' ? drag.insertAt : drag.localIdx)
    : pendingPlayDisplay >= 0 ? pendingPlayDisplay : null;
  const selectedDisplay = selectedIndex != null ? displayOrder.indexOf(selectedIndex) : -1;
  const raised = useMemo(() => {
    if (!trashMode) return undefined;
    const s = new Set<number>();
    displayOrder.forEach((ci, di) => { if (trashMode.selectedIndices.has(ci)) s.add(di); });
    return s;
  }, [trashMode, displayOrder]);
  // Touch has no hover: the tapped (selected) card rises to full size instead.
  const [touchMode, setTouchMode] = useState(false);
  const inspect = hovered ?? (touchMode && selectedDisplay >= 0 ? selectedDisplay : null);
  const hoverActive = inspect !== null && !drag && entering.size === 0 && inspect < displayOrder.length ? inspect : null;
  // Keep the fan clear of the HUD in the screen's bottom corners (action
  // counter, Submit button): past this width cards overlap instead.
  const layoutW = Math.min(handWidth, Math.max(320, viewport.w - 520));
  const layoutX = (handWidth - layoutW) / 2;
  const layout = useMemo(() => shiftLayout(layoutHand({
    count: displayOrder.length,
    width: layoutW,
    height: stripH,
    sizing,
    hovered: hoverActive,
    selected: selectedDisplay >= 0 ? selectedDisplay : null,
    lifted: liftedDisplay,
    liftedX: drag?.mode === 'reorder' ? drag.x - layoutX : null,
    raised,
  }), layoutX), [displayOrder.length, layoutW, layoutX, stripH, sizing, hoverActive, selectedDisplay, liftedDisplay, drag, raised]);
  const restLayout = useMemo(
    () => shiftLayout(layoutHand({ count: order.length, width: layoutW, height: stripH, sizing }), layoutX),
    [order.length, layoutW, layoutX, stripH, sizing],
  );

  const toScreen = useCallback((p: Pose): Pose => {
    const r = handRef.current?.getBoundingClientRect();
    return { ...p, x: p.x + (r?.left ?? 0), y: p.y + (r?.top ?? 0) };
  }, []);

  // Remember every card's on-screen pose so a departing card can take off
  // from exactly where it was.
  useLayoutEffect(() => {
    displayOrder.forEach((ci, di) => {
      const card = cards[ci];
      const p = layout.poses[di];
      if (card && p) posesRef.current.set(card.id, toScreen(p));
    });
  });

  const pileZoomRef = useRef(pileZoom);
  pileZoomRef.current = pileZoom;
  /** Pose of a pile's top card (where draws take off and discards land). */
  const pilePose = useCallback((kind: 'draw' | 'discard', topCardId?: string): Pose | null => {
    const btn = kind === 'draw' ? drawPileRef.current : discardPileRef.current;
    const top = btn?.querySelector('[data-pile-top]');
    if (!top) return null;
    const r = top.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      rot: 0,
      scale: PILE_SCALE * pileZoomRef.current,
      tilt: PILE_TILT,
      spin: kind === 'draw' ? DRAW_PILE_SPIN : discardTopSpin(topCardId),
    };
  }, []);

  const launch = useCallback((f: Omit<Flight, 'key'>) => {
    const key = `f${++flightSeq.current}`;
    setFlights(prev => [...prev, { ...f, key }]);
    return key;
  }, []);

  // ── Hover: driven by x along the resting hand, like holding real cards ──
  const latest = useRef({ restLayout, hovered, order, displayOrder });
  latest.current = { restLayout, hovered, order, displayOrder };
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragRef.current?.active || e.pointerType === 'touch') return;
      const hand = handRef.current;
      const overCard = (e.target as Element | null)?.closest?.('[data-hand-card]');
      if (!hand || !overCard || !hand.contains(overCard)) {
        setHovered(h => (h === null ? h : null));
        return;
      }
      const r = hand.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const { restLayout: rl } = latest.current;
      let next: number | null;
      if (y >= rl.bandTop) {
        next = stripAt(rl.strips, x);
      } else {
        // Above the resting hand only a raised card can be under the pointer
        // (the hovered one, or a selected one) — keep whichever it is.
        const di = Number(overCard.getAttribute('data-display-idx'));
        next = Number.isFinite(di) ? di : null;
      }
      setHovered(h => (h === next ? h : next));
    };
    const onOut = (e: PointerEvent) => { if (!e.relatedTarget) setHovered(null); };
    window.addEventListener('pointermove', onMove);
    document.addEventListener('pointerout', onOut);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
    };
  }, []);
  const onCardHoverRef = useRef(onCardHover);
  onCardHoverRef.current = onCardHover;
  useEffect(() => {
    onCardHoverRef.current?.(hoverActive !== null ? displayOrder[hoverActive] ?? null : null);
  }, [hoverActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag & click ──
  const handlePointerDown = useCallback((e: ReactPointerEvent, displayIdx: number) => {
    setTouchMode(e.pointerType === 'touch');
    if (disabled && !trashMode) return;
    if (e.button !== 0) return;
    if ((e.target as Element).closest('[data-upgrade-badge]')) return;
    e.preventDefault();
    // With a mouse, the card you're "holding" is the one the hover picked.
    const di = e.pointerType !== 'touch' && hovered !== null ? hovered : displayIdx;
    dragRef.current = {
      localIdx: di, startX: e.clientX, startY: e.clientY, pointerType: e.pointerType,
      active: false, lastX: e.clientX, lastT: performance.now(), vx: 0,
    };
  }, [disabled, trashMode, hovered]);

  const handlers = useRef({ onDragStart, onDragEnd, onDragMove, onDragPlay, onSelect, onTrashToggle, trashMode, order, cards, restLayout });
  handlers.current = { onDragStart, onDragEnd, onDragMove, onDragPlay, onSelect, onTrashToggle, trashMode, order, cards, restLayout };
  const dragStateRef = useRef(drag);
  dragStateRef.current = drag;

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const h = handlers.current;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
        if (h.trashMode) return; // selection mode: presses only toggle
        d.active = true;
        setHovered(null);
        h.onDragStart?.(h.order[d.localIdx]);
      }
      const now = performance.now();
      const dt = now - d.lastT;
      if (dt > 0 && dt < 200) d.vx = (e.clientX - d.lastX) / dt;
      d.lastX = e.clientX;
      d.lastT = now;
      const effY = d.pointerType === 'touch' ? e.clientY - TOUCH_DRAG_Y_OFFSET : e.clientY;
      const hand = handRef.current;
      const r = hand?.getBoundingClientRect();
      const x = e.clientX - (r?.left ?? 0);
      const y = e.clientY - (r?.top ?? 0);
      const inHand = !!r && y >= h.restLayout.bandTop && x >= -30 && x <= r.width + 30;
      setDrag({
        localIdx: d.localIdx,
        mode: inHand ? 'reorder' : 'target',
        x: Math.max(0, Math.min(r?.width ?? x, x)),
        y,
        insertAt: inHand ? nearestSlot(h.restLayout.poses, x) : d.localIdx,
        pointerX: e.clientX,
        pointerY: effY,
      });
      h.onDragMove?.(e.clientX, effY);
    };
    const finish = (e: PointerEvent, cancelled: boolean) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const h = handlers.current;
      if (!d.active) {
        if (cancelled) return;
        const cardIdx = h.order[d.localIdx];
        if (cardIdx === undefined) return;
        if (h.trashMode) {
          if (cardIdx !== h.trashMode.playedCardIndex) h.onTrashToggle?.(cardIdx);
        } else {
          h.onSelect(cardIdx);
        }
        return;
      }
      const st = dragStateRef.current;
      setDrag(null);
      h.onDragEnd?.();
      if (cancelled || !st) return;
      if (st.mode === 'reorder') {
        if (st.insertAt !== d.localIdx) {
          setOrderIds(() => {
            const ids = h.order.map(i => h.cards[i].id);
            const [moved] = ids.splice(d.localIdx, 1);
            ids.splice(st.insertAt, 0, moved);
            return ids;
          });
        }
      } else {
        const cardIdx = h.order[d.localIdx];
        const card = h.cards[cardIdx];
        if (card) setPendingPlayId(card.id);
        const effY = d.pointerType === 'touch' ? e.clientY - TOUCH_DRAG_Y_OFFSET : e.clientY;
        h.onDragPlay(cardIdx, e.clientX, effY, d.vx, 0);
      }
    };
    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, []);

  // A dropped card that never leaves the hand (illegal target, or a choice
  // prompt opened) settles back after a moment.
  useEffect(() => {
    if (!pendingPlayId) return;
    const t = setTimeout(() => setPendingPlayId(null), 900);
    return () => clearTimeout(t);
  }, [pendingPlayId]);

  // ── Shuffle ──
  const prevDeckSizeRef = useRef(deckSize);
  const prevDiscardCountRef = useRef(discardCount);
  const prevDeckOrderRef = useRef<string[]>(deckCards.map(c => c.id));
  const prevDiscardCardsRef = useRef<Card[]>(discardCards);
  const prevCardsForShuffleRef = useRef(cards);
  const shuffleTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => shuffleTimers.current.forEach(clearTimeout), []);
  const RIFFLE_CARDS = 10;
  const riffleDuration = Math.round(980 * speed);

  /** The draw pile splits into two packets that lift and fan apart, then the
   *  cards drop back in alternately — left, right, left — like a riffle. */
  const riffle = useCallback(() => {
    const pile = pilePose('draw');
    if (!pile) return;
    soundRef.current.deckShuffle();
    // The draw pile hugs the screen edge: riffle a little inboard of it so
    // both packets stay on screen.
    const cx = Math.max(90, Math.min(window.innerWidth - 90, pile.x));
    for (let i = 0; i < RIFFLE_CARDS; i++) {
      const side = i % 2 ? 1 : -1;
      const k = Math.floor(i / 2);
      const lifted: Pose = {
        x: cx + side * (30 + k * 5), y: pile.y - 34 - k * 5,
        rot: side * (13 - k * 2), scale: pile.scale * 1.18, tilt: 26, spin: 0,
      };
      const back = 0.4 + (i / RIFFLE_CARDS) * 0.44;
      const frames: Keyframe[] = [
        ...flightKeyframes(pile, lifted, { ease: easeOut, samples: 4 }).map(f => ({ ...f, offset: (f.offset as number) * 0.28 })),
        { offset: back, transform: poseTransform(lifted), opacity: 1 },
        ...flightKeyframes(lifted, pile, { ease: easeIn, samples: 3 }).slice(1).map(f => ({ ...f, offset: back + (f.offset as number) * 0.13 })),
        { offset: 1, transform: poseTransform(pile), opacity: 1 },
      ];
      launch({ kind: 'riffle', card: null, frames, delay: k * Math.round(28 * speed), duration: riffleDuration });
    }
  }, [pilePose, launch, speed, riffleDuration]);

  /** Deal the cards that were drawn out of a freshly shuffled deck. */
  const finishShuffleRef = useRef<() => void>(() => {});

  /**
   * Shuffle choreography:
   *  - reshuffle: the discard pile's cards lift off one by one, turn face
   *    down in the air and stream onto the draw pile; then a riffle.
   *  - swap (Heady Brew): the same, while the old draw pile crosses the
   *    other way and lands face up as the new discard pile.
   *  - riffle: the draw pile is shuffled in place.
   */
  const startShuffle = useCallback((kind: 'reshuffle' | 'swap' | 'riffle', st: {
    fromDiscard: number; toDiscard: number; fromDeck: number; toDeck: number; faces: Card[]; newDiscardFaces: Card[];
  }) => {
    shuffleTimers.current.forEach(clearTimeout);
    shuffleTimers.current = [];
    const discardPose = pilePose('discard');
    const drawPose = pilePose('draw');
    const transfer = kind === 'riffle' || !discardPose || !drawPose ? 0 : Math.max(1, Math.min(10, st.fromDiscard));
    setShuffle({ ...st, total: transfer, lifted: 0, landed: 0 });
    const stagger = Math.round(80 * speed);
    const duration = Math.round(580 * speed);
    if (transfer > 0) {
      soundRef.current.deckShuffle();
      for (let i = 0; i < transfer; i++) {
        const face = st.faces[st.faces.length - 1 - i] ?? null;
        const delay = i * stagger;
        launch({
          kind: 'transfer',
          card: face,
          frames: flightKeyframes({ ...discardPose!, spin: discardTopSpin(face?.id) }, drawPose!, {
            arc: 90 + (i % 3) * 16, ease: easeInOut, swell: t => 1 + 0.35 * Math.sin(Math.PI * t),
          }),
          flipFrames: face ? turnOver(true, 0.12, 0.58) : undefined,
          delay,
          duration,
        });
        shuffleTimers.current.push(setTimeout(() => setShuffle(s => (s ? { ...s, lifted: s.lifted + 1 } : s)), delay));
      }
      if (kind === 'swap') {
        const crossing = Math.min(8, st.fromDeck);
        for (let i = 0; i < crossing; i++) {
          const face = st.newDiscardFaces[st.newDiscardFaces.length - 1 - i] ?? null;
          launch({
            kind: 'swapBack',
            card: face,
            frames: flightKeyframes(drawPose!, { ...discardPose!, spin: discardTopSpin(face?.id) }, {
              arc: 40, ease: easeInOut, swell: t => 1 + 0.3 * Math.sin(Math.PI * t),
            }),
            flipFrames: face ? turnOver(false, 0.4, 0.85) : undefined,
            delay: i * stagger + Math.round(stagger / 2),
            duration,
          });
        }
      }
    }
    const riffleAt = transfer > 0 ? (transfer - 1) * stagger + duration - Math.round(60 * speed) : 0;
    shuffleTimers.current.push(setTimeout(riffle, riffleAt));
    shuffleTimers.current.push(setTimeout(() => finishShuffleRef.current(), riffleAt + riffleDuration + Math.round(160 * speed)));
  }, [pilePose, launch, speed, riffle, riffleDuration]);

  // Force shuffle animation from parent (intro sequence)
  useEffect(() => {
    if (forceShuffleAnim && !animationOff) {
      startShuffle('riffle', { fromDiscard: discardCount, toDiscard: discardCount, fromDeck: deckSize, toDeck: deckSize, faces: [], newDiscardFaces: [] });
    }
  }, [forceShuffleAnim]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shuffle detection. Declared before the hand-change effect so it marks
  // cards drawn out of a fresh deck as deferred (they're dealt once the
  // shuffle finishes) before that runs.
  useLayoutEffect(() => {
    const prevDeck = prevDeckSizeRef.current;
    const prevDiscard = prevDiscardCountRef.current;
    const prevOrder = prevDeckOrderRef.current;
    const prevDiscardCards = prevDiscardCardsRef.current;
    const currOrder = deckCards.map(c => c.id);
    prevDeckSizeRef.current = deckSize;
    prevDiscardCountRef.current = discardCount;
    prevDeckOrderRef.current = currOrder;
    prevDiscardCardsRef.current = discardCards;
    const prev = prevCardsForShuffleRef.current;
    prevCardsForShuffleRef.current = cards;

    // Tutor/search just committed: zone moves (discard → hand, picks put on
    // top of the draw pile) aren't shuffles.
    if (suppressShuffleDetection || animationOff) return;

    const prevDeckIds = new Set(prevOrder);
    const newCardIds = cards.filter(c => !prev.some(p => p.id === c.id)).map(c => c.id);
    const deckGotNewIds = currOrder.some(id => !prevDeckIds.has(id));
    const deckReplenished = deckSize > prevDeck || deckGotNewIds;
    const discardMovedToDraw = prevDiscard > 0 && discardCount < prevDiscard;
    // Heady Brew: the old draw pile became the discard pile.
    const swapped = deckGotNewIds && prevDeckIds.size > 0 && discardCards.some(c => prevDeckIds.has(c.id));
    // Same cards, new order, nothing drawn: shuffled in place.
    const reordered = currOrder.length > 1 && currOrder.length === prevOrder.length
      && !deckGotNewIds && currOrder.some((id, i) => id !== prevOrder[i]);

    if (swapped || (discardMovedToDraw && deckReplenished)) {
      if (newCardIds.length > 0) deferredDrawnRef.current = new Set(newCardIds);
      startShuffle(swapped ? 'swap' : 'reshuffle', {
        fromDiscard: prevDiscard,
        toDiscard: discardCount,
        fromDeck: prevDeck,
        toDeck: deckSize + deferredDrawnRef.current.size,
        faces: prevDiscardCards,
        newDiscardFaces: discardCards,
      });
    } else if (reordered && newCardIds.length === 0 && !shuffle) {
      startShuffle('riffle', { fromDiscard: discardCount, toDiscard: discardCount, fromDeck: deckSize, toDeck: deckSize, faces: [], newDiscardFaces: [] });
    } else if (newCardIds.length > 0 && shuffle) {
      // Cards drawn mid-shuffle wait for it to finish too.
      deferredDrawnRef.current = new Set([...deferredDrawnRef.current, ...newCardIds]);
    }
  }, [deckSize, discardCount, cards, deckCards, discardCards, animationOff, suppressShuffleDetection]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Queue cards to fly in from the draw pile, staggered. */
  const queueDraws = useCallback((drawn: Card[]) => {
    if (drawn.length === 0) return;
    const start = pilePose('draw');
    if (!start) return;
    const stagger = Math.round(170 * speed);
    const specs = new Map<string, EnterSpec>();
    drawn.forEach((card, i) => {
      const delay = i * stagger;
      specs.set(card.id, { start, delay, duration: Math.round(560 * speed), flip: true, arc: 70, fadeIn: false });
      if (delay <= 0) soundRef.current.cardDraw();
      else setTimeout(() => soundRef.current.cardDraw(), delay);
      setTimeout(() => setDrawBonus(b => Math.max(0, b - 1)), delay);
    });
    setDrawBonus(b => b + drawn.length);
    for (const [id, s] of specs) pendingEnterRef.current.set(id, s);
    setEntering(prev => new Map([...prev, ...specs]));
  }, [pilePose, speed]);

  finishShuffleRef.current = () => {
    setShuffle(null);
    const deferred = deferredDrawnRef.current;
    deferredDrawnRef.current = new Set();
    if (deferred.size > 0 && animated) queueDraws(cards.filter(c => deferred.has(c.id)));
  };

  // ── Hand changes: cards arriving and leaving ──
  useLayoutEffect(() => {
    const playerSwitched = prevPlayerIdRef.current !== playerId;
    prevPlayerIdRef.current = playerId;
    if (playerSwitched) {
      prevCardsRef.current = cards;
      setEntering(new Map());
      setFlights([]);
      setDrawBonus(0);
      setDiscardHold(0);
      return;
    }

    const prev = prevCardsRef.current;
    const prevInPlayIds = prevInPlayIdsRef.current;
    prevCardsRef.current = cards;
    prevInPlayIdsRef.current = inPlayIdsRef.current;

    const prevHandIds = new Set(prev.map(c => c.id));
    const currIds = new Set(cards.map(c => c.id));
    const removed = prev.filter(c => !currIds.has(c.id));
    const arrived = cards.filter(c => !prevHandIds.has(c.id));
    if (arrived.length === 0 && removed.length === 0) return;
    if (pendingPlayId && removed.some(c => c.id === pendingPlayId)) setPendingPlayId(null);
    if (!animated) return;

    // Arrivals. Undone cards fly back from their tile; cards returning from
    // the board without an undo target, or placed by the tutor UI, just
    // appear; everything else was drawn.
    const drawn: Card[] = [];
    for (const card of arrived) {
      if (undoReturn && undoReturn.cardId === card.id) {
        const start: Pose = { x: undoReturn.screenX, y: undoReturn.screenY, rot: 0, scale: 0.14, tilt: 40, opacity: 0 };
        const spec: EnterSpec = { start, delay: 0, duration: Math.round(520 * speed), flip: false, arc: 40, fadeIn: true };
        pendingEnterRef.current.set(card.id, spec);
        setEntering(p => new Map(p).set(card.id, spec));
        continue;
      }
      if (prevInPlayIds.has(card.id) || suppressEnterAnimFor?.has(card.id)) continue;
      if (deferredDrawnRef.current.has(card.id)) continue; // waits for the shuffle
      drawn.push(card);
    }
    queueDraws(drawn);

    // Departures
    let played = false;
    let discarded = 0;
    for (const card of removed) {
      const from = posesRef.current.get(card.id);
      if (!from) continue;
      if (trashedCardIds?.has(card.id)) {
        setBurns(b => [...b, { key: `b${++flightSeq.current}`, card, pose: from }]);
        continue;
      }
      if (lastPlayedTarget && lastPlayedTarget.cardId === card.id) {
        played = true;
        const hasTarget = lastPlayedTarget.screenX !== null && lastPlayedTarget.screenY !== null;
        const handoff = hasTarget && lastPlayedTarget.landScale != null;
        const to: Pose = handoff
          ? { x: lastPlayedTarget.screenX!, y: lastPlayedTarget.screenY!, rot: 0, scale: lastPlayedTarget.landScale! }
          : hasTarget
            ? { x: lastPlayedTarget.screenX!, y: lastPlayedTarget.screenY!, rot: 0, scale: 0.12, tilt: 42 }
            : { x: from.x, y: from.y - 160, rot: 0, scale: from.scale * 0.5 };
        launch({
          kind: 'play',
          card,
          frames: flightKeyframes(from, to, {
            arc: hasTarget ? 60 : 20,
            ease: easeInOut,
            swell: t => 1 + 0.1 * Math.sin(Math.PI * Math.min(1, t * 1.6)),
            opacity: handoff ? undefined : (t => (t < 0.72 ? 1 : 1 - (t - 0.72) / 0.28)),
          }),
          delay: 0,
          duration: Math.round(520 * speed),
          flashAt: hasTarget ? { x: lastPlayedTarget.screenX!, y: lastPlayedTarget.screenY! } : undefined,
        });
        continue;
      }
      const to = pilePose('discard', card.id);
      if (!to) continue;
      discarded++;
      launch({
        kind: 'discard',
        card,
        frames: flightKeyframes(from, to, { arc: 80, ease: easeInOut }),
        delay: (discarded - 1) * Math.round(90 * speed),
        duration: Math.round(560 * speed),
      });
    }
    if (discarded > 0) setDiscardHold(h => h + discarded);
    if (played) soundRef.current.cardPlay();
    else if (discarded > 0) soundRef.current.cardDiscard();
  }, [cards, animated, playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start queued enter flights once their slots (and card backs) are rendered.
  useLayoutEffect(() => {
    if (pendingEnterRef.current.size === 0) return;
    for (const [id, spec] of [...pendingEnterRef.current]) {
      const wrap = wrapRefs.current.get(id);
      const di = displayOrder.findIndex(ci => cards[ci]?.id === id);
      if (!wrap || di < 0) continue;
      if (spec.flip && !flipRefs.current.get(id)) continue;
      pendingEnterRef.current.delete(id);
      const slot = toScreen(layout.poses[di]);
      const timing: KeyframeAnimationOptions = { duration: spec.duration, delay: spec.delay, easing: 'linear', fill: 'backwards' };
      const runs = [runAnimation(wrap, enterKeyframes(slot, spec.start, {
        arc: spec.arc,
        ease: easeInOut,
        opacity: spec.fadeIn ? (t => Math.min(1, t / 0.3)) : undefined,
        swell: spec.flip ? (t => 1 + 0.18 * Math.sin(Math.PI * t)) : undefined,
      }), timing)];
      if (spec.flip) {
        runs.push(runAnimation(flipRefs.current.get(id)!, [
          { offset: 0, transform: 'perspective(900px) rotateY(180deg)' },
          { offset: 0.22, transform: 'perspective(900px) rotateY(180deg)' },
          { offset: 0.72, transform: 'perspective(900px) rotateY(0deg)' },
          { offset: 1, transform: 'perspective(900px) rotateY(0deg)' },
        ], { ...timing, easing: 'ease-in-out' }));
      }
      Promise.all(runs).then(() => {
        setEntering(p => {
          if (!p.has(id)) return p;
          const next = new Map(p);
          next.delete(id);
          return next;
        });
      });
    }
  });

  // ── End of turn: the whole hand goes to the discard pile ──
  const discardAllFiredRef = useRef(false);
  useEffect(() => {
    if (!discardAll) {
      discardAllFiredRef.current = false;
      setDiscardExtra(e => (e.length ? [] : e));
      setHiddenIds(s => (s.size ? new Set() : s));
      return;
    }
    if (discardAllFiredRef.current) return;
    discardAllFiredRef.current = true;
    const finish = () => {
      // Clear before the parent swaps state in, so the emptied hand isn't
      // seen as a second round of departures.
      prevCardsRef.current = [];
      onDiscardAllComplete?.();
    };
    if (animationOff || cards.length === 0) { finish(); return; }
    const ordered = displayOrder.map(ci => cards[ci]).filter(Boolean);
    const stagger = Math.round(80 * speed);
    const duration = Math.round(520 * speed);
    let pending = 0;
    ordered.forEach((card, i) => {
      const from = posesRef.current.get(card.id);
      const to = pilePose('discard', card.id);
      if (!from || !to) return;
      pending++;
      launch({
        kind: 'discardAll',
        card,
        frames: flightKeyframes(from, to, { arc: 80, ease: easeInOut }),
        delay: i * stagger,
        duration,
      });
    });
    if (pending === 0) { finish(); return; }
    soundRef.current.cardDiscard();
    setHiddenIds(new Set(ordered.map(c => c.id)));
    discardAllFinishRef.current = { remaining: pending, finish };
  }, [discardAll]); // eslint-disable-line react-hooks/exhaustive-deps
  const discardAllFinishRef = useRef<{ remaining: number; finish: () => void } | null>(null);

  // ── Purchases: fly into the discard pile as soon as they're bought ──
  const launchedIncomingRef = useRef<Set<string>>(new Set());
  const onIncomingLandedRef = useRef(onIncomingLanded);
  onIncomingLandedRef.current = onIncomingLanded;
  useEffect(() => {
    if (!incomingDiscards || incomingDiscards.length === 0) return;
    const fresh = incomingDiscards.filter(i => !launchedIncomingRef.current.has(i.key));
    if (fresh.length === 0) return;
    if (animationOff) {
      fresh.forEach(i => onIncomingLandedRef.current?.(i.key));
      return;
    }
    const to = pilePose('discard');
    const hand = handRef.current?.getBoundingClientRect();
    if (!to || !hand) {
      fresh.forEach(i => onIncomingLandedRef.current?.(i.key));
      return;
    }
    fresh.forEach((item, i) => {
      launchedIncomingRef.current.add(item.key);
      const land = { ...to, spin: discardTopSpin(item.card.id) };
      const at = (p: Pose, dy = 0) =>
        `translate(${p.x - CARD_W / 2}px, ${p.y - CARD_H / 2 + dy}px) rotate(${p.rot}deg) perspective(520px) rotateX(0deg) rotateZ(0deg) scale(${p.scale})`;
      let pop: Keyframe[];
      let hold: number;
      let duration: number;
      if (item.from) {
        // Bought from the shop: the card lifts off its tile, grows into a
        // readable face for a beat, then arcs down onto the pile.
        const f = item.from;
        const x = f.left + f.width / 2;
        const y = f.top + f.height / 2;
        const start: Pose = { x, y, rot: 0, scale: f.width / CARD_W };
        const show: Pose = { x, y: y - 24, rot: -2, scale: Math.max(0.5, Math.min(0.62, f.width / CARD_W)) };
        hold = 0.28;
        duration = 1000;
        pop = [
          { offset: 0, transform: at({ ...start, scale: start.scale * 0.6 }), opacity: 0 },
          { offset: 0.12, transform: at(show), opacity: 1 },
          { offset: hold, transform: at(show), opacity: 1 },
        ];
        flightKeyframes(show, land, { arc: 70, ease: easeInOut, samples: 8 })
          .slice(1)
          .forEach(k => pop.push({ ...k, offset: hold + (k.offset as number) * (1 - hold) }));
      } else {
        // Each purchase pops up above the hand, holds a beat, then drops onto the pile.
        const show: Pose = { x: hand.left + hand.width / 2 + (i - (fresh.length - 1) / 2) * 120, y: hand.top - 150, rot: (i - (fresh.length - 1) / 2) * 3, scale: 0.62 };
        hold = 0.42;
        duration = 1250;
        pop = [
          { offset: 0, transform: at({ ...show, scale: show.scale * 0.5 }, 40), opacity: 0 },
          { offset: 0.18, transform: at(show), opacity: 1 },
          { offset: hold, transform: at(show), opacity: 1 },
        ];
        flightKeyframes(show, land, { arc: 60, ease: easeInOut, samples: 8 })
          .slice(1)
          .forEach(k => pop.push({ ...k, offset: hold + (k.offset as number) * (1 - hold) }));
      }
      launch({
        kind: 'incoming',
        card: item.card,
        frames: pop,
        delay: i * Math.round(220 * speed),
        duration: Math.round(duration * speed),
      });
      incomingKeyByFlight.current.set(`f${flightSeq.current}`, item.key);
    });
  }, [incomingDiscards, animationOff]); // eslint-disable-line react-hooks/exhaustive-deps
  const incomingKeyByFlight = useRef(new Map<string, string>());

  const onFlightDone = useCallback((f: Flight) => {
    setFlights(prev => prev.filter(x => x.key !== f.key));
    if (f.kind === 'discard') {
      setDiscardHold(h => Math.max(0, h - 1));
    } else if (f.kind === 'discardAll' && f.card) {
      const card = f.card;
      setDiscardExtra(e => [...e, card]);
      const fin = discardAllFinishRef.current;
      if (fin && --fin.remaining <= 0) {
        discardAllFinishRef.current = null;
        setTimeout(fin.finish, 60);
      }
    } else if (f.kind === 'incoming') {
      const key = incomingKeyByFlight.current.get(f.key);
      incomingKeyByFlight.current.delete(f.key);
      if (key) {
        launchedIncomingRef.current.delete(key);
        onIncomingLandedRef.current?.(key);
      }
      soundRef.current.cardDiscard();
    } else if (f.kind === 'transfer') {
      setShuffle(s => (s ? { ...s, landed: s.landed + 1 } : s));
    } else if (f.kind === 'play' && f.flashAt) {
      const key = `x${f.key}`;
      const at = f.flashAt;
      setFlashes(prev => [...prev, { key, ...at }]);
      setTimeout(() => setFlashes(prev => prev.filter(x => x.key !== key)), 450 * speed);
    }
  }, [speed]);

  // ── Pile displays ──
  const incomingCount = incomingDiscards?.length ?? 0;
  const liftT = shuffle && shuffle.total > 0 ? shuffle.lifted / shuffle.total : 1;
  const landT = shuffle && shuffle.total > 0 ? shuffle.landed / shuffle.total : 1;
  const displayDeck = shuffle ? Math.round(shuffle.fromDeck + (shuffle.toDeck - shuffle.fromDeck) * landT) : deckSize + drawBonus;
  const discardShown = shuffle
    ? Math.round(shuffle.fromDiscard + (shuffle.toDiscard - shuffle.fromDiscard) * liftT)
    : Math.max(0, discardCount - discardHold - incomingCount);
  // While the old discard pile is still leaving, show its cards.
  const discardSource = shuffle && liftT < 1 ? shuffle.faces : discardCards;
  const visibleDiscard = useMemo(
    () => [...discardSource.slice(0, Math.min(discardShown, discardSource.length)), ...discardExtra],
    [discardSource, discardShown, discardExtra],
  );
  const displayDiscardCount = discardShown + discardExtra.length;

  // ── Aiming arrow ──
  const dragCard = drag ? cards[order[drag.localIdx]] : undefined;
  let arrow: { from: { x: number; y: number }; to: { x: number; y: number }; state: ArrowState } | null = null;
  if (drag?.mode === 'target' && dragCard && liftedDisplay !== null && layout.poses[liftedDisplay]) {
    const p = toScreen(layout.poses[liftedDisplay]);
    const targets = cardTargetsTile ? cardTargetsTile(dragCard) : true;
    const snap = targets && dragTarget?.valid && dragTarget.x != null && dragTarget.y != null;
    arrow = {
      from: { x: p.x, y: p.y - (CARD_H * p.scale) / 2 + 14 },
      to: snap ? { x: dragTarget!.x!, y: dragTarget!.y! } : { x: drag.pointerX, y: drag.pointerY },
      state: !targets || dragTarget === undefined ? 'neutral' : dragTarget?.valid ? 'valid' : 'invalid',
    };
  }

  const upgradeBadgeOk = isPlayPhase && upgradeCreditsAvailable > 0 && !trashMode && !disabled;

  return (
    <>
      <div
        data-hand-root
        style={{ position: 'relative', height: stripH, display: 'flex', alignItems: 'flex-end', gap: 8, touchAction: 'none' }}
      >
        {/* Draw pile + shuffle label */}
        <div style={{ position: 'relative', width: pileCol, flexShrink: 0, alignSelf: 'flex-end', paddingBottom: 4, zIndex: 2 }}>
          <div style={{
            position: 'absolute',
            bottom: '100%',
            left: 4,
            marginBottom: 4,
            whiteSpace: 'nowrap',
            background: 'rgba(14, 14, 34, 0.92)',
            border: '1px solid rgba(232, 196, 106, 0.6)',
            borderRadius: 8,
            padding: '5px 12px',
            fontSize: 13,
            fontWeight: 'bold',
            letterSpacing: 1,
            pointerEvents: 'none',
            opacity: shuffle ? 1 : 0,
            transition: 'opacity 0.25s ease',
            boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          }}>
            {'Shuffling...'.split('').map((ch, i) => (
              <span key={i} style={{ color: '#8a88a6', animation: shuffle ? `cc-pile-shuffle-wave 1.1s ease-in-out ${i * 0.07}s infinite` : 'none' }}>{ch}</span>
            ))}
          </div>
          <CardPile
            ref={drawPileRef}
            kind="draw"
            label="Draw"
            count={displayDeck}
            busy={!!shuffle}
            title="View cards in draw pile"
            onClick={() => setShowDeckPopup(true)}
            zoom={pileZoom}
          />
        </div>

        {/* The hand */}
        <div
          ref={handRef}
          data-hand-zone
          style={{ position: 'relative', flex: 1, minWidth: 0, height: '100%', zIndex: 3 }}
        >
          {cards.length === 0 && !shuffle && flights.length === 0 && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: stripH * 0.38, textAlign: 'center', color: '#666483', fontStyle: 'italic', fontSize: 13, pointerEvents: 'none' }}>
              No cards in hand
            </div>
          )}
          {displayOrder.map((cardIdx, di) => {
            const card = cards[cardIdx];
            const pose = layout.poses[di];
            if (!card || !pose) return null;
            const localIdx = drag?.mode === 'reorder' ? order.indexOf(cardIdx) : di;
            const enter = entering.get(card.id);
            const hidden = hiddenIds.has(card.id) || deferredDrawnRef.current.has(card.id);
            const isHovered = hoverActive === di;
            const isLifted = liftedDisplay === di;
            const isSelected = selectedIndex === cardIdx && !isLifted;
            const isTrashPlayed = trashMode?.playedCardIndex === cardIdx;
            const isTrashSelected = trashMode?.selectedIndices.has(cardIdx) ?? false;
            const playCostEff = card.effects?.find(e => e.type === 'play_resource_cost');
            const cantAfford = !!playCostEff && playerResources !== undefined &&
              playerResources < ((card.is_upgraded && playCostEff.upgraded_value != null) ? playCostEff.upgraded_value : playCostEff.value);
            const notEnoughActions = actionsRemaining !== undefined && actionsRemaining < (card.action_cost ?? 1);
            const dimmed = (claimBanned && card.card_type === 'claim') || cantAfford || notEnoughActions
              || searchZoneEmpty(card, { discard: discardCards, draw: deckCards, trash: trashCards });
            const empowered = !dimmed && !disabled && isCardEmpowered(card, subtitleContext, claimBuffBonus);
            const showUpgraded = isHovered && (shiftHeld || badgeHover === di);
            const faceCard = showUpgraded ? getUpgradedPreview(card) : card;
            const showBadge = upgradeBadgeOk && hasUpgradePreview(card) && (isSelected || isHovered) && !enter && !isLifted;
            return (
              <div
                key={card.id}
                data-hand-card
                data-card-slot={localIdx}
                data-display-idx={di}
                role="button"
                tabIndex={-1}
                aria-label={plainCardName(card.name)}
                onPointerDown={(e) => handlePointerDown(e, di)}
                onDoubleClick={() => {
                  if (!disabled && !trashMode && onDoubleClick) {
                    setHovered(null);
                    onDoubleClick(cardIdx);
                  }
                }}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: CARD_W,
                  height: CARD_H,
                  transform: `translate(${pose.x - CARD_W / 2}px, ${pose.y - CARD_H / 2}px) rotate(${pose.rot}deg) scale(${pose.scale})`,
                  zIndex: enter ? 1100 + di : pose.z,
                  transition: animated && !(isLifted && drag?.mode === 'reorder')
                    ? 'transform 0.2s cubic-bezier(0.2, 0.8, 0.3, 1), filter 0.2s ease'
                    : 'none',
                  opacity: 1,
                  visibility: hidden ? 'hidden' : undefined,
                  filter: dimmed ? 'brightness(0.5) saturate(0.65)' : undefined,
                  cursor: trashMode ? (isTrashPlayed ? 'default' : 'pointer') : disabled ? 'not-allowed' : drag ? 'grabbing' : 'grab',
                  pointerEvents: enter || hidden ? 'none' : 'auto',
                  userSelect: 'none',
                  WebkitUserSelect: 'none',
                  touchAction: 'none',
                  ['--cc-glare-o' as string]: isHovered || isLifted ? 0.9 : 0,
                }}
              >
                <div
                  ref={el => { if (el) wrapRefs.current.set(card.id, el); else wrapRefs.current.delete(card.id); }}
                  className={[
                    empowered ? 'cc-hand-empowered' : '',
                    isSelected || isLifted ? 'cc-hand-selected' : '',
                  ].join(' ')}
                  style={{ position: 'relative', width: '100%', height: '100%' }}
                >
                  <div
                    ref={el => { if (el) flipRefs.current.set(card.id, el); else flipRefs.current.delete(card.id); }}
                    style={{ position: 'relative', width: '100%', height: '100%', transformStyle: 'preserve-3d' }}
                  >
                    <div style={{ position: 'relative', width: '100%', height: '100%', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
                      <CardFull
                        card={faceCard}
                        subtitleContext={subtitleContext}
                        showDynamic
                        artZoom={false}
                        showKeywordHints={isHovered && !drag}
                      />
                      {/* Dark veil outside the player's turn */}
                      <div data-disabled-overlay style={{
                        position: 'absolute',
                        inset: 0,
                        borderRadius: 14,
                        background: 'rgba(8, 8, 20, 0.5)',
                        pointerEvents: 'none',
                        opacity: (disabled && !trashMode && !discardAll) ? 1 : 0,
                        transition: animated ? 'opacity 0.25s ease' : 'none',
                      }} />
                      {/* Picked for trashing / discarding */}
                      {isTrashSelected && (
                        <div style={{
                          position: 'absolute', inset: 0, borderRadius: 14, pointerEvents: 'none',
                          background: 'rgba(120, 20, 20, 0.45)',
                          boxShadow: 'inset 0 0 0 4px #ff4444, 0 0 18px rgba(255, 68, 68, 0.6)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <div style={{ color: '#fff', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.9))', display: 'flex' }}>
                            <Icon name={trashMode?.label === 'Discard' ? 'discard' : 'trash'} size={64} decorative />
                          </div>
                        </div>
                      )}
                      {/* The card being played while picking what to trash */}
                      {isTrashPlayed && (
                        <div style={{
                          position: 'absolute', inset: 0, borderRadius: 14, pointerEvents: 'none',
                          background: 'rgba(0, 0, 0, 0.55)',
                          boxShadow: 'inset 0 0 0 3px #4aff6a',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <span style={{ fontSize: 18, fontWeight: 'bold', color: '#4aff6a', background: 'rgba(0,0,0,0.6)', padding: '4px 12px', borderRadius: 6, letterSpacing: 1 }}>PLAYING</span>
                        </div>
                      )}
                    </div>
                    {enter?.flip && (
                      <div style={{ position: 'absolute', inset: 0, transform: 'rotateY(180deg)', backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' }}>
                        <CardBack />
                      </div>
                    )}
                  </div>
                </div>
                {showBadge && (
                  <UpgradeHoldBadge
                    label={upgradeCreditsAvailable > 1 ? `Hold to Upgrade (${upgradeCreditsAvailable})` : 'Hold to Upgrade'}
                    animated={animated}
                    onHoverChange={(hov) => {
                      if (hov) setBadgeHover(di);
                      else setBadgeHover(prev => (prev === di ? null : prev));
                    }}
                    onComplete={() => onUpgradeCard?.(cardIdx)}
                  />
                )}
              </div>
            );
          })}
        </div>

        {/* Discard pile */}
        <div style={{ position: 'relative', width: pileCol, flexShrink: 0, alignSelf: 'flex-end', paddingBottom: 4, zIndex: 2 }}>
          <CardPile
            ref={discardPileRef}
            kind="discard"
            label="Discard"
            count={displayDiscardCount}
            cards={visibleDiscard}
            title="View discard pile"
            onClick={() => setShowDiscardPopup(true)}
            style={{ opacity: displayDiscardCount === 0 ? 0.7 : 1 }}
            zoom={pileZoom}
          />
        </div>
      </div>

      {arrow && <TargetArrow from={arrow.from} to={arrow.to} state={arrow.state} />}

      {/* Cards in flight, burning cards, and landing flashes */}
      {(flights.length > 0 || burns.length > 0 || flashes.length > 0) && createPortal(
        <>
          {flights.map(f => <FlightCard key={f.key} flight={f} onDone={onFlightDone} />)}
          {flashes.map(fl => (
            <div key={fl.key} style={{
              position: 'fixed', left: fl.x, top: fl.y, width: 90, height: 90, borderRadius: '50%', pointerEvents: 'none', zIndex: 9989,
              background: 'radial-gradient(closest-side, rgba(255, 244, 200, 0.95), rgba(255, 200, 90, 0.5) 45%, rgba(255, 170, 60, 0) 100%)',
              animation: `cc-land-flash ${Math.round(420 * speed)}ms ease-out forwards`,
            }} />
          ))}
        </>,
        document.body,
      )}
      {burns.map(b => (
        <TrashBurn key={b.key} card={b.card} pose={b.pose} speed={speed} onDone={() => setBurns(prev => prev.filter(x => x.key !== b.key))} />
      ))}

      {/* Draw pile viewer popup */}
      {showDeckPopup && createPortal(
        <CardViewPopup
          title="Draw Pile"
          icon="drawPile"
          cards={[{ label: 'Draw Pile', items: deckCards }]}
          onClose={() => setShowDeckPopup(false)}
          note="Not shown in draw order"
        />,
        document.body,
      )}

      {/* Discard viewer popup */}
      {showDiscardPopup && createPortal(
        <CardViewPopup
          title="Discard Pile"
          icon="discard"
          cards={[{ label: 'Discard Pile', items: [...discardCards].reverse() }]}
          onClose={() => setShowDiscardPopup(false)}
          preserveOrder
          note="Shown in discard order, most recent first"
        />,
        document.body,
      )}
    </>
  );
}
