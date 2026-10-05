import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Icon from '../icons/Icon';
import { Num } from '../icons/Num';

/**
 * The upgrade credit counter beside the bank: the upgraded arrow and how many
 * credits you hold ("2 upgrade credits" on hover / tap), with a +X / −X float
 * whenever it changes — spending one on a card, buying one in the shop. It
 * folds away while you hold none (after a last spend's float has risen).
 */

interface Float { id: number; amount: number; offsetX: number }

interface Props {
  value: number;
  /** Whose credits: switching players resets without animating. */
  playerId: string;
  visible: boolean;
}

export default function UpgradeCreditCounter({ value, playerId, visible }: Props) {
  const [floats, setFloats] = useState<Float[]>([]);
  const [bump, setBump] = useState(0);
  const [labelOpen, setLabelOpen] = useState(false);
  const pointerRef = useRef('mouse');
  const labelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const seq = useRef(0);
  const lastSeen = useRef(value);
  const lastPlayer = useRef(playerId);

  useLayoutEffect(() => {
    if (lastPlayer.current !== playerId) {
      lastPlayer.current = playerId;
      lastSeen.current = value;
      return;
    }
    const delta = value - lastSeen.current;
    lastSeen.current = value;
    if (delta === 0) return;
    const id = ++seq.current;
    setFloats(f => [...f, { id, amount: delta, offsetX: (Math.random() - 0.5) * 14 }]);
    if (delta > 0) setBump(b => b + 1);
    const t = setTimeout(() => { timers.current.delete(t); setFloats(f => f.filter(x => x.id !== id)); }, 950);
    timers.current.add(t);
  }, [value, playerId]);

  useEffect(() => { setFloats([]); }, [playerId]);
  useEffect(() => () => {
    for (const t of timers.current) clearTimeout(t);
    if (labelTimer.current) clearTimeout(labelTimer.current);
  }, []);

  const toggleLabel = () => {
    if (labelTimer.current) clearTimeout(labelTimer.current);
    labelTimer.current = null;
    setLabelOpen(open => {
      if (!open) labelTimer.current = setTimeout(() => setLabelOpen(false), 3000);
      return !open;
    });
  };

  // Out while you hold any — or while a last spend's −1 is still rising.
  const out = visible && (value > 0 || floats.length > 0);
  const has = value > 0;
  return (
    <div aria-hidden={!out} style={{
      display: 'flex',
      maxWidth: out ? 260 : 0,
      marginLeft: out ? 8 : 0,
      opacity: out ? 1 : 0,
      overflow: out ? 'visible' : 'hidden',
      pointerEvents: out ? undefined : 'none',
      transition: 'max-width 0.3s ease, margin-left 0.3s ease, opacity 0.25s ease',
    }}>
      <div
        role="button"
        tabIndex={out ? 0 : -1}
        aria-label={`${value} upgrade credit${value !== 1 ? 's' : ''}`}
        aria-expanded={labelOpen}
        onPointerDown={(e) => { pointerRef.current = e.pointerType; }}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setLabelOpen(true); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setLabelOpen(false); }}
        onClick={() => { if (pointerRef.current !== 'mouse') toggleLabel(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLabel(); } }}
        style={{
          position: 'relative',
          pointerEvents: 'auto',
          cursor: 'var(--cc-cursor-arrow)',
          boxSizing: 'border-box',
          height: 42,
          display: 'flex', alignItems: 'center',
          padding: '0 13px',
          background: 'linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 60%), rgba(14, 14, 34, 0.85)',
          border: `1px solid ${has ? 'rgba(232, 196, 106, 0.35)' : 'rgba(255,255,255,0.08)'}`,
          borderRadius: 10,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 12px rgba(0,0,0,0.4)',
          outline: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{
          position: 'absolute', bottom: '100%', left: 0,
          paddingBottom: 8,
          opacity: labelOpen ? 1 : 0,
          transition: 'opacity 0.15s ease',
          pointerEvents: 'none',
        }}>
          <div style={{
            padding: '4px 10px',
            background: '#111122',
            border: '1px solid #555',
            borderRadius: 6,
            color: '#ccc',
            fontSize: 12,
            whiteSpace: 'nowrap',
          }}>
            Hold Upgrade on a card in your hand to spend one.
          </div>
        </div>
        <span style={{
          display: 'inline-flex', alignItems: 'center',
          fontSize: 22, lineHeight: 1, fontWeight: 900, fontFamily: 'var(--cc-font-display)',
          fontVariantNumeric: 'tabular-nums',
          color: has ? '#ffe7a8' : '#555',
          textShadow: has ? '0 0 10px rgba(232, 196, 106, 0.45), 0 1px 2px rgba(0,0,0,0.6)' : 'none',
          position: 'relative',
        }}>
          <span key={bump} className={bump ? 'cc-res-bump' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="upgraded" size={19} title="Upgrade credits" />
            <Num value={value} style={{ fontFamily: 'inherit', fontWeight: 900, top: 0 }} />
          </span>
          {floats.map(f => (
            <span key={f.id} className="cc-res-float" style={{ left: f.offsetX, color: f.amount > 0 ? '#4ade80' : '#ff6b6b' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                {f.amount > 0 ? `+${f.amount}` : `−${-f.amount}`}
                <Icon name="upgraded" size={15} decorative />
              </span>
            </span>
          ))}
        </span>
        {/* "upgrade credits" folds away until hovered or tapped */}
        <span aria-hidden style={{
          display: 'inline-block',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          maxWidth: labelOpen ? 130 : 0,
          marginLeft: labelOpen ? 8 : 0,
          opacity: labelOpen ? 1 : 0,
          transition: 'max-width 0.2s ease, margin-left 0.2s ease, opacity 0.15s ease',
          fontSize: 13,
          lineHeight: 1,
          color: has ? '#aaa' : '#555',
        }}>
          upgrade credit{value !== 1 ? 's' : ''}
        </span>
      </div>
    </div>
  );
}
