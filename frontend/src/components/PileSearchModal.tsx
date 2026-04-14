import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card, PendingSearch, SearchSelection, SearchZoneTarget } from '../types/game';
import CardFull, { CARD_FULL_WIDTH, CARD_FULL_MIN_HEIGHT } from './CardFull';
import HandStyleCard, { HAND_CARD_WIDTH as CARD_WIDTH } from './HandStyleCard';
import { IrreversibleButton } from './Tooltip';

const SOURCE_LABELS: Record<PendingSearch['source'], { header: string; verb: string }> = {
  discard: { header: 'Search your discard pile', verb: 'take' },
  draw: { header: 'Look at your draw pile', verb: 'retrieve' },
  trash: { header: 'Search the trash', verb: 'recover' },
};

// Short labels used inside the per-card pills (limited horizontal space).
// The longer "draw pile" terminology is kept for the modal subtitle via
// TARGET_DESTINATION_PHRASE below.
const TARGET_LABELS: Record<SearchZoneTarget, string> = {
  hand: 'Hand',
  top_of_draw: 'Top of draw',
  discard: 'Discard',
  trash: 'Trash',
};

/** Sentence fragment naming a destination; used in the modal subtitle when
 *  there's a single destination so it can replace the static per-card pill. */
const TARGET_DESTINATION_PHRASE: Record<SearchZoneTarget, string> = {
  hand: 'to your hand',
  top_of_draw: 'to the top of your draw pile',
  discard: 'to your discard pile',
  trash: 'to the trash',
};

const TARGET_COLORS: Record<SearchZoneTarget, string> = {
  hand: '#4aff6a',
  top_of_draw: '#4ab8ff',
  discard: '#aaaaaa',
  trash: '#ff6666',
};

/**
 * A selectable compact card in the modal. Shows a full-card preview on hover,
 * portaled above/below the compact tile (mirrors CardBrowser's compact card).
 */
function SelectableCompactCard({
  card,
  isSelected,
  selectionIndex,
  selectionTarget,
  targetColor,
  allowedTargets,
  onToggle,
  onChangeTarget,
  targetColors,
  targetLabels,
}: {
  card: Card;
  isSelected: boolean;
  selectionIndex: number | null;
  selectionTarget: SearchZoneTarget | null;
  targetColor: string | undefined;
  allowedTargets: SearchZoneTarget[];
  onToggle: () => void;
  onChangeTarget: (target: SearchZoneTarget) => void;
  targetColors: Record<SearchZoneTarget, string>;
  targetLabels: Record<SearchZoneTarget, string>;
}) {
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);

  const multiTarget = allowedTargets.length > 1;

  return (
    <div
      data-search-card-id={card.id}
      onPointerEnter={(e) => setHoverRect((e.currentTarget as HTMLElement).getBoundingClientRect())}
      onPointerLeave={() => setHoverRect(null)}
      style={{
        position: 'relative',
        width: CARD_WIDTH,
        // Reserve space for the destination pills only in multi-target mode.
        // Single-target mode names the destination in the modal subtitle
        // instead, so no per-card pill is rendered.
        paddingBottom: multiTarget ? 40 : 0,
        cursor: 'pointer',
      }}
      onClick={() => onToggle()}
    >
      <div
        style={{
          outline: targetColor ? `2px solid ${targetColor}` : 'none',
          outlineOffset: 2,
          borderRadius: 6,
        }}
      >
        <HandStyleCard card={card} border="" />
      </div>

      {/* Selection index badge */}
      {isSelected && selectionIndex !== null && targetColor && (
        <div
          style={{
            position: 'absolute',
            top: -8,
            left: -8,
            background: targetColor,
            color: '#000',
            fontWeight: 'bold',
            fontSize: 12,
            width: 22,
            height: 22,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 2px 6px rgba(0,0,0,0.6)',
            zIndex: 2,
          }}
        >
          {selectionIndex + 1}
        </div>
      )}

      {/* Per-card target picker (multi-target). Extends horizontally beyond
          the card so pills sit side-by-side; the outer grid has matching gap. */}
      {isSelected && multiTarget && selectionTarget && (
        <div
          style={{
            position: 'absolute',
            bottom: 4,
            left: -14,
            right: -14,
            display: 'flex',
            gap: 4,
            justifyContent: 'center',
            flexWrap: 'nowrap',
            pointerEvents: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {allowedTargets.map((target) => (
            <button
              key={target}
              onClick={(e) => {
                e.stopPropagation();
                onChangeTarget(target);
              }}
              style={{
                background:
                  selectionTarget === target ? targetColors[target] : 'transparent',
                color: selectionTarget === target ? '#000' : targetColors[target],
                border: `1px solid ${targetColors[target]}`,
                borderRadius: 3,
                padding: '3px 7px',
                fontSize: 10,
                fontWeight: 'bold',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              → {targetLabels[target]}
            </button>
          ))}
        </div>
      )}


      {/* Full-card hover preview, portaled above/below so it's not clipped
          by the modal's scroll container. z-index sits above the modal. */}
      {hoverRect && createPortal(
        <div
          style={{
            position: 'fixed',
            left: Math.max(
              8,
              Math.min(
                hoverRect.left + hoverRect.width / 2 - CARD_FULL_WIDTH / 2,
                window.innerWidth - CARD_FULL_WIDTH - 8
              )
            ),
            ...(hoverRect.top > CARD_FULL_MIN_HEIGHT + 16
              ? { bottom: window.innerHeight - hoverRect.top + 8 }
              : { top: hoverRect.bottom + 8 }),
            pointerEvents: 'none',
            zIndex: 20000,
          }}
        >
          <CardFull card={card} showKeywordHints />
        </div>,
        document.body
      )}
    </div>
  );
}

export interface PileSearchModalProps {
  pending: PendingSearch;
  /** Cards in the source pile, in backend-ordered sequence. */
  cards: Card[];
  onConfirm: (selections: SearchSelection[], sourceRects: Map<string, DOMRect>) => void;
  onCancel: () => void;
  /**
   * When true, the Cancel button is always enabled (pre-play mode: the player
   * hasn't committed the card yet and can back out). When false (default),
   * Cancel is only enabled if `pending.min_count === 0`.
   */
  cancelAlwaysEnabled?: boolean;
  /**
   * When true, Cancel is hidden entirely and Confirm allows zero selections
   * (when `min_count === 0`). Used for draw-pile peeks: the player has
   * already gained information about the deck the moment the modal opened,
   * so they can no longer back out without committing.
   */
  forceCommit?: boolean;
  /** Localized message shown under the header. */
  instructionOverride?: string;
}

interface SelectionEntry {
  cardId: string;
  target: SearchZoneTarget;
}

export default function PileSearchModal({
  pending,
  cards,
  onConfirm,
  onCancel,
  cancelAlwaysEnabled,
  forceCommit,
  instructionOverride,
}: PileSearchModalProps) {
  /**
   * Selection order matters (first-picked cards go to the top of draw first, etc.)
   * so we use an array keyed by card instance id, not a Set.
   */
  const [selections, setSelections] = useState<SelectionEntry[]>([]);

  const { header, verb } = SOURCE_LABELS[pending.source];
  const allowed = pending.allowed_targets;
  const defaultTarget: SearchZoneTarget = allowed[0];

  // Filter cards to only those present in the snapshot. Each card instance
  // has a unique id via _copy_card, so duplicates are preserved.
  //
  // For draw-pile searches, shuffle the displayed order so the player can't
  // infer the actual draw sequence from the modal layout — otherwise tutoring
  // the deck would also reveal which cards come up next, which is information
  // the search effect doesn't grant.
  //
  // The shuffle is stable across re-renders by keying useMemo on the snapshot
  // ids, so opening the modal once gives a single deterministic-per-session
  // arrangement; opening it again (next time the effect fires) reshuffles.
  const eligibleCards = useMemo(() => {
    const snapshot = new Set(pending.snapshot_card_ids);
    const filtered = cards.filter((c) => snapshot.has(c.id));
    if (pending.source === 'draw') {
      // Fisher–Yates in place on a fresh copy.
      const out = filtered.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    }
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.snapshot_card_ids, pending.source]);

  const handleToggle = useCallback(
    (cardId: string) => {
      setSelections((prev) => {
        const existingIdx = prev.findIndex((s) => s.cardId === cardId);
        if (existingIdx >= 0) {
          // Already selected — clicking deselects.
          return prev.filter((_, i) => i !== existingIdx);
        }
        if (prev.length >= pending.count) {
          // At the cap — evict the least-recently-selected card and add the
          // new one. Saves the player a deselect-then-reselect roundtrip.
          return [...prev.slice(1), { cardId, target: defaultTarget }];
        }
        return [...prev, { cardId, target: defaultTarget }];
      });
    },
    [pending.count, defaultTarget]
  );

  const handleChangeTarget = useCallback((cardId: string, target: SearchZoneTarget) => {
    setSelections((prev) => prev.map((s) => (s.cardId === cardId ? { ...s, target } : s)));
  }, []);

  const handleConfirm = useCallback(() => {
    // Defense in depth: outside forceCommit mode, the UI prevents submitting
    // zero cards (the player should use Cancel). In forceCommit mode (draw
    // peek) Cancel is hidden, so empty submissions ARE allowed when the
    // effect's min_count permits it.
    if (selections.length === 0 && !forceCommit) return;
    // Capture source rects for all selected cards before closing the modal,
    // so the fly animation can originate from each card's visual position.
    const rects = new Map<string, DOMRect>();
    for (const sel of selections) {
      const el = document.querySelector<HTMLElement>(
        `[data-search-card-id="${sel.cardId}"]`
      );
      if (el) rects.set(sel.cardId, el.getBoundingClientRect());
    }
    onConfirm(
      selections.map((s) => ({ card_id: s.cardId, target: s.target })),
      rects
    );
  }, [selections, onConfirm]);

  // Confirm normally requires at least 1 selection (use Cancel to bail out
  // with zero). But in forceCommit mode (draw-pile peek) Cancel is hidden,
  // so Confirm must accept 0 selections when min_count allows it — otherwise
  // the player would be stuck on a card with nothing they want.
  const canConfirm = forceCommit
    ? selections.length >= pending.min_count
    : selections.length > 0 && selections.length >= pending.min_count;
  const canCancel = !forceCommit && (cancelAlwaysEnabled || pending.min_count === 0);

  // When there's only one destination, the instruction names the destination
  // explicitly (e.g. "Select up to 1 card to move to your hand.") and the
  // per-card pills below each card are suppressed — the subtitle already
  // conveys where everything will go.
  const cardNoun = `card${pending.count === 1 ? '' : 's'}`;
  const quantifier =
    pending.count === pending.min_count
      ? `Select ${pending.count}`
      : `Select up to ${pending.count}`;
  const defaultInstruction =
    allowed.length === 1
      ? `${quantifier} ${cardNoun} to move ${TARGET_DESTINATION_PHRASE[allowed[0]]}.`
      : `${quantifier} ${cardNoun} to ${verb}.`;

  return createPortal(
    <div
      // Stop any pointer events from reaching the underlying HexGrid / HUD.
      // Mouse enter/leave/move on the overlay swallows hover on the grid too.
      onPointerDownCapture={(e) => e.stopPropagation()}
      onPointerMoveCapture={(e) => e.stopPropagation()}
      onPointerUpCapture={(e) => e.stopPropagation()}
      onWheelCapture={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.78)',
        zIndex: 5000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
        // Explicit pointer-events to block pass-through even with transparent areas
        pointerEvents: 'auto',
      }}
    >
      {/* Header */}
      <div
        style={{
          color: '#fff',
          fontSize: 22,
          fontWeight: 'bold',
          marginBottom: 6,
          textShadow: '0 2px 6px rgba(0,0,0,0.9)',
        }}
      >
        {header}
      </div>
      <div
        style={{
          color: '#ccc',
          fontSize: 14,
          marginBottom: 16,
          textAlign: 'center',
          maxWidth: 680,
        }}
      >
        {instructionOverride ?? defaultInstruction}
        {pending.source === 'draw' && (
          <div style={{ marginTop: 4, color: '#999', fontSize: 12, fontStyle: 'italic' }}>
            Cards are not shown in draw order.
            {forceCommit && ' Your play is committed — you can no longer cancel.'}
          </div>
        )}
        {allowed.length > 1 && (
          <div style={{ marginTop: 4, color: '#999', fontSize: 12 }}>
            Choose a destination for each selected card.
          </div>
        )}
      </div>

      {/* Card grid. When cards have multi-target destination pills, we use
          a larger horizontal gap so the pills (which extend ±14px beyond
          each card) don't overlap neighbors. Generous vertical padding
          around the grid gives room for the selection badge (top:-8) and
          outline (offset:2) to sit without being clipped by the scroll
          container — `overflow: auto` on either axis clips both axes. */}
      {eligibleCards.length === 0 ? (
        <div style={{ color: '#999', fontSize: 14 }}>
          No eligible cards in the {pending.source === 'draw' ? 'draw pile' : pending.source}.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: allowed.length > 1 ? 32 : 12,
            rowGap: allowed.length > 1 ? 16 : 12,
            justifyContent: 'center',
            maxWidth: 'min(1100px, 96vw)',
            maxHeight: '65vh',
            overflowY: 'auto',
            padding: '16px 20px',
          }}
        >
          {eligibleCards.map((card) => {
            const selectionIdx = selections.findIndex((s) => s.cardId === card.id);
            const selection = selectionIdx >= 0 ? selections[selectionIdx] : null;
            const isSelected = !!selection;
            const targetColor = selection ? TARGET_COLORS[selection.target] : undefined;
            return (
              <SelectableCompactCard
                key={card.id}
                card={card}
                isSelected={isSelected}
                selectionIndex={isSelected ? selectionIdx : null}
                selectionTarget={selection?.target ?? null}
                targetColor={targetColor}
                allowedTargets={allowed}
                onToggle={() => handleToggle(card.id)}
                onChangeTarget={(target) => handleChangeTarget(card.id, target)}
                targetColors={TARGET_COLORS}
                targetLabels={TARGET_LABELS}
              />
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div
        style={{
          marginTop: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'rgba(20,20,30,0.92)',
          padding: '10px 16px',
          borderRadius: 8,
          border: '1px solid #444',
        }}
      >
        <span style={{ color: '#fff', fontSize: 14 }}>
          {selections.length} of {pending.count} selected
          {pending.min_count === 0 && ' (optional)'}
        </span>
        {!forceCommit && (
          <button
            onClick={onCancel}
            disabled={!canCancel}
            style={{
              background: 'transparent',
              color: canCancel ? '#aaa' : '#555',
              border: `1px solid ${canCancel ? '#aaa' : '#333'}`,
              borderRadius: 4,
              padding: '6px 14px',
              fontSize: 13,
              cursor: canCancel ? 'pointer' : 'not-allowed',
            }}
          >
            Cancel
          </button>
        )}
        <IrreversibleButton
          onClick={handleConfirm}
          disabled={!canConfirm}
          tooltip="Selected cards will move to their chosen destinations."
          style={{
            background: canConfirm ? '#4aff6a' : '#2a4a2e',
            color: canConfirm ? '#000' : '#555',
            border: 'none',
            borderRadius: 4,
            padding: '8px 18px',
            fontSize: 14,
            fontWeight: 'bold',
            cursor: canConfirm ? 'pointer' : 'not-allowed',
          }}
        >
          Confirm
        </IrreversibleButton>
      </div>
    </div>,
    document.body
  );
}
