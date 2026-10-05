import { useRef, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Player } from '../types/game';
import type { VpBreakdown } from '../utils/vpBreakdown';
import Icon from '../icons/Icon';
import { CostLabel, IconValue } from '../icons/Num';
import CardName from './CardName';
import { useShownResources } from './ResourceCounter';

/** Renders text that shrinks (via transform scaleX) to fit a fixed max width. */
function ShrinkText({ text, maxWidth, style }: { text: string; maxWidth: number; style?: React.CSSProperties }) {
  const innerRef = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const natural = el.scrollWidth;
    setScale(natural > maxWidth ? maxWidth / natural : 1);
  }, [text, maxWidth]);

  return (
    <span style={{ display: 'inline-block', width: maxWidth, flexShrink: 0, overflow: 'hidden' }}>
      <span
        ref={innerRef}
        style={{
          display: 'inline-block',
          whiteSpace: 'nowrap',
          transformOrigin: 'left center',
          transform: scale < 1 ? `scaleX(${scale})` : undefined,
          ...style,
        }}
      >
        {text}
      </span>
    </span>
  );
}

/** Stat value with an instant-hover styled tooltip, portalled to body so it's never clipped. */
function StatTip({ label, children, color }: { label: string; children: ReactNode; color?: string }) {
  const [show, setShow] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!show || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left + rect.width / 2,
      top: rect.top,
    });
  }, [show]);

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', cursor: 'var(--cc-cursor-arrow)', color }}
      onPointerEnter={() => setShow(true)}
      onPointerLeave={() => { setShow(false); setPos(null); }}
    >
      {children}
      {show && pos && createPortal(
        <span style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          transform: 'translate(-50%, calc(-100% - 6px))',
          whiteSpace: 'nowrap',
          background: '#111122',
          border: '1px solid #555',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          color: '#ddd',
          fontWeight: 'bold',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          zIndex: 20000,
          pointerEvents: 'none',
        }}>
          {label}
        </span>,
        document.body
      )}
    </span>
  );
}

/** VP stat with detailed breakdown tooltip (Tiles / VP Hexes / Cards). */
function VpStatTip({ breakdown, children }: { breakdown: VpBreakdown; children: ReactNode }) {
  const [show, setShow] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!show || !anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left + rect.width / 2,
      top: rect.top,
    });
  }, [show]);

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', cursor: 'var(--cc-cursor-arrow)' }}
      onPointerEnter={() => setShow(true)}
      onPointerLeave={() => { setShow(false); setPos(null); }}
    >
      {children}
      {show && pos && createPortal(
        <div ref={(el) => {
          // Clamp to viewport after first render
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.left < 4) el.style.left = `${pos.left - r.left + 4}px`;
          }
        }} style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          transform: 'translate(-50%, calc(-100% - 6px))',
          background: '#1a1a3a',
          border: '1px solid #4a4a6a',
          borderRadius: 8,
          padding: '8px 12px',
          fontSize: 12,
          color: '#ccc',
          pointerEvents: 'none',
          zIndex: 20000,
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          <div style={{ fontWeight: 'bold', color: '#ffd700', marginBottom: 4, fontSize: 11 }}>VP Breakdown</div>
          <div>Tiles: {breakdown.tileCount}</div>
          <div>VP Hexes: {breakdown.bonusTiles}</div>
          <div>Cards: {breakdown.cards}</div>
        </div>,
        document.body
      )}
    </span>
  );
}

interface BuyPurchase {
  card_id: string;
  definition_id?: string;
  card_name: string;
  source: string;
  cost: number;
  card_type?: string;
}

import { CARD_TITLE_FONT, CARD_TYPE_COLORS, DEBT_CARD_COLOR } from '../constants/cardColors';
import { cardTrimTier, metalGradient } from '../constants/cardTrim';

/** One purchase in the player panel, dressed like a sliver of the compact
 *  card: a cost-tiered metal trim, a navy body washed with the card type's
 *  colour, the name in the card title face and the cost on a gold coin. */
function PurchaseChip({ p, onHover, onLeave }: {
  p: BuyPurchase;
  onHover?: (e: React.MouseEvent, cardId: string, definitionId?: string) => void;
  onLeave?: () => void;
}) {
  const wash = p.card_name === 'Debt'
    ? DEBT_CARD_COLOR
    : p.card_type ? (CARD_TYPE_COLORS[p.card_type] || '#555') : (p.source === 'upgrade' ? '#ffaa4a' : '#555');
  const tier = cardTrimTier({ buy_cost: p.cost, starter: false });
  return (
    <span
      onMouseEnter={onHover ? (e) => onHover(e, p.card_id, p.definition_id) : undefined}
      onMouseLeave={onLeave}
      style={{
        display: 'inline-flex',
        padding: 1.5,
        borderRadius: 6,
        background: metalGradient(tier, 145),
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.45), 0 0 0 1px rgba(0,0,0,0.55), 0 2px 5px rgba(0,0,0,0.45)',
        cursor: onHover ? 'var(--cc-cursor-pointer)' : undefined,
        maxWidth: '100%',
      }}
    >
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        minWidth: 0,
        padding: '1px 2px 1px 6px',
        borderRadius: 4.5,
        background: `linear-gradient(90deg, ${wash}66 0%, ${wash}22 60%, rgba(0,0,0,0) 100%), #17172f`,
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6)',
      }}>
        <span style={{
          fontFamily: CARD_TITLE_FONT, fontWeight: 700, fontSize: 11, lineHeight: 1.35,
          color: '#fff6e2', textShadow: '0 1px 1px rgba(0,0,0,0.85)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
        }}>
          <CardName name={p.card_name} />
        </span>
        <span style={{
          flexShrink: 0,
          fontSize: 9.5,
          fontWeight: 'bold',
          lineHeight: 1.35,
          padding: '0 4px',
          borderRadius: 999,
          color: '#2a1d05',
          background: 'linear-gradient(180deg, #ffe9a8 0%, #e8c46a 50%, #b88a32 100%)',
          border: '1px solid #f6dc94',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), 0 1px 2px rgba(0,0,0,0.55)',
        }}>
          <CostLabel cost={p.cost} size={9.5} />
        </span>
      </span>
    </span>
  );
}

interface PlayerHudProps {
  player: Player;
  isActive: boolean;
  isCurrent: boolean;
  isFirstPlayer?: boolean;
  isCurrentBuyer?: boolean;
  phase: string;
  totalCards: number;
  tileCount: number;
  purchases?: BuyPurchase[];
  onPurchaseHover?: (e: React.MouseEvent, cardId: string, definitionId?: string) => void;
  onPurchaseLeave?: () => void;
  vpTarget?: number;
  vpBreakdown?: VpBreakdown;
}

// Player colors are now dynamic — read from player.color field

function getStatus(player: Player, phase: string, isCurrentBuyer?: boolean): { label: string; color: string } {
  if (player.has_left) return { label: 'Left', color: '#666' };
  if (phase === 'play') {
    if (player.has_submitted_play) return { label: 'Ready', color: '#4aff6a' };
    return { label: 'Playing', color: '#ffaa4a' };
  }
  if (phase === 'buy') {
    if (isCurrentBuyer) return { label: 'Buying', color: '#ffaa4a' };
    if (player.has_ended_turn) return { label: 'Done', color: '#4aff6a' };
    return { label: 'Waiting', color: '#888' };
  }
  if (phase === 'reveal') return { label: 'Resolving', color: '#aa88ff' };
  const raw = phase.replace(/_/g, ' ');
  return { label: raw.charAt(0).toUpperCase() + raw.slice(1), color: '#888' };
}

export default function PlayerHud({ player, isActive, isCurrent, isFirstPlayer, isCurrentBuyer, phase, totalCards, tileCount, purchases, onPurchaseHover, onPurchaseLeave, vpTarget, vpBreakdown }: PlayerHudProps) {
  const status = getStatus(player, phase, isCurrentBuyer);
  // Your own bank counts up with the coins flying into the bottom counter.
  const resources = useShownResources(player.id, player.resources);
  const hasReachedVpTarget = vpTarget != null && player.vp >= vpTarget;
  const [showVpTooltip, setShowVpTooltip] = useState(false);
  const hudRef = useRef<HTMLDivElement>(null);

  const borderStyle = player.has_left
    ? '1px solid #2a2a2a'
    : hasReachedVpTarget
      ? '2px solid #ffd700'
      : isCurrentBuyer
        ? '2px solid #ffaa4a'
        : isCurrent
          ? '2px solid #4a9eff'
          : '1px solid #333';

  // Pick the right animation — VP target glow takes priority
  const animation = hasReachedVpTarget
    ? 'vpTargetGlow 2s ease-in-out infinite'
    : isCurrentBuyer
      ? 'pulse 2s ease-in-out infinite'
      : undefined;

  return (
    <>
    {hasReachedVpTarget && (
      <style>{`
        @keyframes vpTargetGlow {
          0%, 100% { box-shadow: 0 0 6px rgba(255, 215, 0, 0.3); }
          50% { box-shadow: 0 0 16px rgba(255, 215, 0, 0.7), 0 0 6px rgba(255, 215, 0, 0.4); }
        }
      `}</style>
    )}
    <div
      ref={hudRef}
      data-player-hud={player.id}
      onPointerEnter={hasReachedVpTarget ? () => setShowVpTooltip(true) : undefined}
      onPointerLeave={hasReachedVpTarget ? () => setShowVpTooltip(false) : undefined}
      className="cc-hud-player"
      style={{
        padding: '8px 10px',
        // Glass plate with a soft player-colored tint fading in from the left.
        background: player.has_left
          ? '#111'
          : `linear-gradient(90deg, ${player.color || '#666'}26, transparent 50%),` +
            `linear-gradient(180deg, rgba(255,255,255,${isActive ? 0.075 : 0.04}) 0%, rgba(255,255,255,0) 55%),` +
            (isActive ? 'rgba(34, 34, 72, 0.92)' : 'rgba(20, 20, 44, 0.85)'),
        border: borderStyle,
        borderRadius: 10,
        boxShadow: isActive
          ? `inset 0 1px 0 rgba(255,255,255,0.06), 0 6px 18px rgba(0,0,0,0.45), 0 0 0 1px ${player.color || '#666'}22`
          : 'inset 0 1px 0 rgba(255,255,255,0.04), 0 3px 10px rgba(0,0,0,0.35)',
        opacity: player.has_left ? 0.45 : isActive ? 1 : 0.7,
        filter: player.has_left ? 'grayscale(0.8)' : undefined,
        animation,
        position: 'relative',
        transition: 'opacity 200ms ease, box-shadow 200ms ease',
      }}
    >
      {/* VP target tooltip — portalled to body so it's never clipped */}
      {showVpTooltip && hasReachedVpTarget && hudRef.current && createPortal(
        <span style={{
          position: 'fixed',
          left: hudRef.current.getBoundingClientRect().right + 8,
          top: hudRef.current.getBoundingClientRect().top + hudRef.current.getBoundingClientRect().height / 2,
          transform: 'translateY(-50%)',
          whiteSpace: 'nowrap',
          background: '#111122',
          border: '1px solid #ffd700',
          borderRadius: 6,
          padding: '4px 10px',
          fontSize: 11,
          color: '#ffd700',
          fontWeight: 'bold',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          zIndex: 20000,
          pointerEvents: 'none',
        }}>
          <Icon name="vp" size={11} decorative style={{ verticalAlign: '-0.12em', marginRight: 4 }} />{player.name} has reached the VP target — game ends after this round
        </span>,
        document.body
      )}
      {/* Name row */}
      <div style={{ fontWeight: 'bold', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{
          display: 'inline-block',
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: `radial-gradient(circle at 35% 30%, rgba(255,255,255,0.55), rgba(255,255,255,0) 45%), ${player.color || '#666'}`,
          boxShadow: `0 0 0 1.5px rgba(0,0,0,0.5), 0 0 8px ${player.color || '#666'}88`,
          flexShrink: 0,
        }} />
        <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden' }}>
          <span
            style={{
              display: 'inline-block',
              whiteSpace: 'nowrap',
              fontSize: 13,
              letterSpacing: 0.2,
              color: 'var(--cc-text)',
              maxWidth: '100%',
              transformOrigin: 'left center',
              transform: 'scaleX(var(--name-scale, 1))',
            }}
            ref={(el) => {
              if (el) {
                const scale = Math.min(1, el.parentElement!.clientWidth / el.scrollWidth);
                el.style.setProperty('--name-scale', String(scale));
              }
            }}
          >
            {player.name}
            {player.is_cpu && (
              <span
                title={player.cpu_difficulty ? `Bot (${player.cpu_difficulty})` : 'Bot'}
                style={{
                  marginLeft: 5, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', verticalAlign: '0.15em',
                  color: 'var(--cc-text-faint)', border: '1px solid var(--cc-panel-border-strong)', borderRadius: 3, padding: '0 3px',
                }}
              >BOT</span>
            )}
          </span>
        </span>
        {/* Always reserve space for the 1st badge so width doesn't shift */}
        <span
          title={isFirstPlayer ? 'First player — resolves first this round' : undefined}
          style={{
            fontSize: 9,
            padding: '1px 5px',
            borderRadius: 6,
            background: isFirstPlayer ? 'linear-gradient(180deg, #ffe39a, #d4a542)' : 'transparent',
            color: isFirstPlayer ? '#2a1d05' : 'transparent',
            boxShadow: isFirstPlayer ? 'inset 0 1px 0 rgba(255,255,255,0.5)' : undefined,
            fontWeight: 'bold',
            letterSpacing: 0.5,
            lineHeight: 1.4,
            flexShrink: 0,
          }}
        >
          1st
        </span>
        {/* Status badge, right-aligned */}
        <span style={{
          marginLeft: 'auto',
          fontSize: 10,
          padding: '1px 6px',
          borderRadius: 6,
          background: `${status.color}22`,
          border: `1px solid ${status.color}44`,
          color: status.color,
          fontWeight: 'bold',
          letterSpacing: 0.3,
          whiteSpace: 'nowrap',
        }}>
          {status.label}
        </span>
      </div>

      {/* Stats row */}
      <div style={{ fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, color: 'var(--cc-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
        {vpBreakdown ? (
          <VpStatTip breakdown={vpBreakdown}>
            <IconValue icon="vp" value={player.vp} size={12} decorative style={hasReachedVpTarget ? {
              color: '#ffd700',
              textShadow: '0 0 6px rgba(255, 255, 255, 0.6)',
            } : undefined} />
          </VpStatTip>
        ) : (
          <StatTip label="Victory Points">
            <IconValue icon="vp" value={player.vp} size={12} decorative style={hasReachedVpTarget ? {
              color: '#ffd700',
              textShadow: '0 0 6px rgba(255, 255, 255, 0.6)',
            } : undefined} />
          </StatTip>
        )}
        <StatTip label="Resources"><span data-hud-resources={player.id}><IconValue icon="resource" value={resources} size={12} decorative /></span></StatTip>
        <StatTip label="Tiles Occupied"><IconValue icon="tile" value={tileCount} size={12} decorative /></StatTip>
        <StatTip label="Total Deck Size"><IconValue icon="drawPile" value={totalCards} size={12} decorative /></StatTip>
      </div>

      {/* Purchases made this buy phase */}
      {purchases && purchases.length > 0 && (
        <div style={{ marginTop: 5, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {purchases.map((p, i) => (
            <PurchaseChip key={i} p={p} onHover={onPurchaseHover} onLeave={onPurchaseLeave} />
          ))}
        </div>
      )}
    </div>
    </>
  );
}
