import { useEffect, useMemo, useRef, useState } from 'react';
import type { Card } from '../types/game';
import { BASE } from '../api/client';
import CardFull from './CardFull';
import { getUpgradedPreview } from '../hooks/upgradePreview';
import CardHand, { type DragTargetInfo, type IncomingDiscard, type PlayTarget, type UndoReturn } from './CardHand';

/**
 * Dev page (?preview=cards): every card face in the catalog, base and
 * upgraded, for checking the card design and that every ability fits.
 */
export default function CardsPreview() {
  const [cards, setCards] = useState<Card[]>([]);
  const [upgraded, setUpgraded] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch(`${BASE}/cards`)
      .then(r => r.json())
      .then((data: Record<string, Card>) => setCards(Object.values(data)))
      .catch(() => setCards([]));
  }, []);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return cards
      .filter(c => !f || c.name.toLowerCase().includes(f) || c.archetype.includes(f) || c.card_type.includes(f))
      .sort((a, b) => a.archetype.localeCompare(b.archetype) || (a.buy_cost ?? -1) - (b.buy_cost ?? -1) || a.name.localeCompare(b.name))
      .map(c => (upgraded ? getUpgradedPreview(c) : c));
  }, [cards, upgraded, filter]);

  return (
    <div style={{ minHeight: '100dvh', overflow: 'auto', height: '100dvh', background: '#0e0e22', color: '#fff', padding: 24, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--cc-font-display)', fontSize: 22 }}>Cards ({shown.length})</h1>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={upgraded} onChange={e => setUpgraded(e.target.checked)} /> Upgraded
        </label>
        <input
          placeholder="Filter by name, archetype, type"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ padding: '4px 8px', background: '#1a1a38', border: '1px solid #444', borderRadius: 6, color: '#fff' }}
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {shown.map(c => <CardFull key={c.definition_id + (upgraded ? '+' : '')} card={c} />)}
      </div>
    </div>
  );
}

let instanceSeq = 0;
const instance = (c: Card): Card => ({ ...c, id: `${c.definition_id}#${++instanceSeq}` });
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Dev page (?preview=hand): the hand, piles and every card animation on a
 * stand-in board — draw, play to a tile (drag one onto the gold hex), undo,
 * discard, trash, shuffle, end of turn and purchases.
 */
export function HandPreview() {
  const [catalog, setCatalog] = useState<Card[]>([]);
  const [deck, setDeck] = useState<Card[]>([]);
  const [hand, setHand] = useState<Card[]>([]);
  const [discard, setDiscard] = useState<Card[]>([]);
  const [inPlay, setInPlay] = useState<Card[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [lastPlayed, setLastPlayed] = useState<PlayTarget | null>(null);
  const [trashedIds, setTrashedIds] = useState<Set<string>>(new Set());
  const [discardAll, setDiscardAll] = useState(false);
  const [incoming, setIncoming] = useState<IncomingDiscard[]>([]);
  const [shopOpen, setShopOpen] = useState(false);
  const [undo, setUndo] = useState<UndoReturn | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [tiles, setTiles] = useState(4);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTargetInfo | null>(null);
  const tileRef = useRef<HTMLDivElement>(null);
  const undoSeq = useRef(0);

  useEffect(() => {
    fetch(`${BASE}/cards`)
      .then(r => r.json())
      .then((data: Record<string, Card>) => {
        const all = Object.values(data).filter(c => c.card_type !== 'token');
        setCatalog(all);
        const starters = all.filter(c => c.starter);
        const picks = shuffled(all.filter(c => !c.starter)).slice(0, 8);
        const d = shuffled([...starters, ...starters, ...picks].map(instance));
        setDeck(d.slice(5));
        setHand(d.slice(0, 5));
      })
      .catch(() => {});
  }, []);

  const tileCenter = () => {
    const r = tileRef.current?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, r } : null;
  };

  // Latest piles, so delayed draws (after end of turn) see current state.
  const piles = useRef({ deck, discard });
  piles.current = { deck, discard };
  const draw = (n: number) => {
    let d = [...piles.current.deck];
    let disc = [...piles.current.discard];
    const drawn: Card[] = [];
    for (let i = 0; i < n; i++) {
      if (d.length === 0) { d = shuffled(disc); disc = []; }
      const c = d.pop();
      if (!c) break;
      drawn.push(c);
    }
    setDeck(d);
    setDiscard(disc);
    setHand(h => [...h, ...drawn]);
  };
  const removeFromHand = (idx: number) => {
    const card = hand[idx];
    setHand(h => h.filter((_, i) => i !== idx));
    setSelected(null);
    return card;
  };
  const play = (idx: number) => {
    const t = tileCenter();
    const card = hand[idx];
    if (!card) return;
    setLastPlayed({ cardId: card.id, screenX: t?.x ?? null, screenY: t?.y ?? null });
    removeFromHand(idx);
    setInPlay(p => [...p, card]);
  };
  const pick = () => (selected !== null && hand[selected] ? selected : hand.length - 1);

  const subtitleContext = useMemo(() => ({ tileCount: tiles, handSize: hand.length, claimsWonLastRound: 2, playedCardNames: inPlay.map(c => c.name), hasPlayedClaimThisRound: inPlay.some(c => c.card_type === 'claim') }), [tiles, hand.length, inPlay]);
  const btn: React.CSSProperties = { padding: '5px 10px', background: '#24244a', color: '#fff', border: '1px solid #555', borderRadius: 6, cursor: 'pointer', fontSize: 12 };

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0e0e22', color: '#fff' }}>
      <div style={{ flex: 1, position: 'relative', minHeight: 0, background: 'radial-gradient(ellipse at 50% 45%, #2b3a22 0%, #16201a 55%, #0e0e22 100%)' }}>
        <div style={{ position: 'absolute', top: 10, left: 10, right: 10, display: 'flex', flexWrap: 'wrap', gap: 6, zIndex: 5 }}>
          <button style={btn} onClick={() => draw(1)}>Draw 1</button>
          <button style={btn} onClick={() => draw(3)}>Draw 3</button>
          <button style={btn} onClick={() => play(pick())}>Play to tile</button>
          <button style={btn} onClick={() => {
            const card = inPlay[inPlay.length - 1];
            const t = tileCenter();
            if (!card || !t) return;
            setInPlay(p => p.slice(0, -1));
            setUndo({ cardId: card.id, screenX: t.x, screenY: t.y, key: ++undoSeq.current });
            setHand(h => [...h, card]);
          }}>Undo</button>
          <button style={btn} onClick={() => { const c = removeFromHand(pick()); if (c) setDiscard(d => [...d, c]); }}>Discard</button>
          <button style={btn} onClick={() => { const i = pick(); const c = hand[i]; if (!c) return; setTrashedIds(new Set([c.id])); removeFromHand(i); }}>Trash</button>
          <button style={btn} onClick={() => setDiscardAll(true)}>End turn</button>
          <button style={btn} onClick={() => setDeck(d => shuffled(d))}>Shuffle deck</button>
          <button style={btn} onClick={() => { const d = deck; setDeck(shuffled(discard)); setDiscard(d); }}>Swap piles</button>
          <button style={btn} onClick={() => { setDiscard(d => [...d, ...deck]); setDeck([]); }}>Empty deck</button>
          <button style={btn} onClick={() => {
            const c = instance(catalog[Math.floor(Math.random() * catalog.length)]);
            setDiscard(d => [...d, c]);
            setIncoming(list => [...list, { key: c.id, card: c }]);
          }}>Buy</button>
          <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={shopOpen} onChange={e => setShopOpen(e.target.checked)} />Shop open</label>
          <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={disabled} onChange={e => setDisabled(e.target.checked)} />Disabled</label>
          <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>Tiles <input type="range" min={0} max={20} value={tiles} onChange={e => setTiles(Number(e.target.value))} />{tiles}</label>
          <span style={{ fontSize: 12, opacity: 0.6 }}>In play: {inPlay.map(c => c.name).join(', ') || '—'}</span>
        </div>
        {/* Stand-in target tile */}
        <div ref={tileRef} style={{
          position: 'absolute', left: '50%', top: '42%', width: 110, height: 96, transform: 'translate(-50%, -50%)',
          clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)',
          background: dragging !== null ? (dragTarget?.valid ? '#e8c46a' : '#8a7440') : '#6b5a33',
        }} />
      </div>
      <div style={{ padding: '0 8px', flexShrink: 0, position: 'relative', zIndex: 30 }}>
        <CardHand
          playerId="preview"
          cards={hand}
          selectedIndex={selected}
          onSelect={setSelected}
          onDragPlay={(idx, x, y) => {
            const t = tileCenter();
            if (t && x >= t.r.left && x <= t.r.right && y >= t.r.top && y <= t.r.bottom) play(idx);
          }}
          onDoubleClick={play}
          onDragStart={setDragging}
          onDragEnd={() => { setDragging(null); setDragTarget(null); }}
          onDragMove={(x, y) => {
            const t = tileCenter();
            const over = !!t && x >= t.r.left && x <= t.r.right && y >= t.r.top && y <= t.r.bottom;
            setDragTarget(over ? { valid: true, x: t!.x, y: t!.y } : { valid: false });
          }}
          disabled={disabled}
          deckSize={deck.length}
          discardCount={discard.length}
          discardCards={discard}
          deckCards={deck}
          inPlayCards={inPlay}
          discardAll={discardAll}
          onDiscardAllComplete={() => {
            const next = [...discard, ...hand];
            piles.current = { deck, discard: next };
            setDiscard(next);
            setHand([]);
            setDiscardAll(false);
            setInPlay([]);
            setTimeout(() => draw(5), 50);
          }}
          lastPlayedTarget={lastPlayed}
          trashedCardIds={trashedIds}
          subtitleContext={subtitleContext}
          cardTargetsTile={(c) => c.card_type === 'claim' || c.card_type === 'defense'}
          dragTarget={dragTarget}
          undoReturn={undo}
          incomingDiscards={incoming}
          holdIncoming={shopOpen}
          onIncomingLanded={(key) => setIncoming(list => list.filter(i => i.key !== key))}
          isPlayPhase
          upgradeCreditsAvailable={1}
        />
      </div>
    </div>
  );
}
