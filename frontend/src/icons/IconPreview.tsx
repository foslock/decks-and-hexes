import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { BASE } from '../api/client';
import type { Card } from '../types/game';
import { buildCardSubtitle, parseSubtitle, type SubtitlePart } from '../components/cardSubtitle';
import { renderSubtitle } from '../components/SubtitlePartRenderer';
import { getUpgradedPreview, hasUpgradePreview } from '../hooks/upgradePreview';
import { CARD_TITLE_FONT, getCardDisplayColor, miniCardBackground, MINI_CARD_SHADOW } from '../constants/cardColors';
import Icon from './Icon';
import { CostLabel, IconValue } from './Num';
import { GLYPHS, ICON_NAMES, type GlyphGroup, type IconName } from './glyphs';
import { drawGlyph } from './canvasGlyph';
import { BoardLabelRow, TEMP_DEF, defenseRow, row, type LabelRow } from '../components/BoardLabel';

/**
 * Dev icon gallery (?preview=icons):
 *  1. Every glyph at 11/12/14/16/24 px on the dark card surface and on a
 *     light surface, plus a 64 px construction view on the 16-unit grid.
 *  2. Pixel loupe — actual 1× / 2× rasterisation, magnified.
 *  3. Number + glyph units at 11/12/13 px.
 *  4. Every purchasable card's hand chip (134×52, 13 px subtitle, same
 *     auto-fit as CardHand), base and upgraded.
 *  5. The floating HTML labels the 3D board draws over tiles.
 */

const SIZES = [11, 12, 14, 16, 24];
const DARK_BG = '#23233a';
const DARK_INK = '#e9e4d6';
const LIGHT_BG = '#f2efe6';
const LIGHT_INK = '#2a2840';
const GROUP_ORDER: GlyphGroup[] = ['stat', 'card', 'zone', 'board', 'modifier', 'sigil', 'ui'];
const GROUP_LABEL: Record<GlyphGroup, string> = {
  stat: 'Core stats',
  card: 'Card flow',
  zone: 'Piles & search',
  board: 'Board',
  modifier: 'Modifiers & players',
  sigil: 'Card-type sigils',
  ui: 'UI chrome',
};
const ARCHETYPES = ['shared', 'vanguard', 'swarm', 'fortress'];

const sectionTitle: CSSProperties = {
  fontFamily: 'var(--cc-font-display)', color: 'var(--cc-gold)', fontSize: 20, margin: '32px 0 6px', letterSpacing: 0.5,
};
const note: CSSProperties = { color: 'var(--cc-text-dim)', fontSize: 13, margin: '0 0 12px', maxWidth: 820, lineHeight: 1.45 };
const th: CSSProperties = { padding: '4px 8px', fontWeight: 600, borderBottom: '1px solid var(--cc-panel-border)' };
const swatch: CSSProperties = { width: 42, height: 38, textAlign: 'center', verticalAlign: 'middle', borderBottom: '1px solid rgba(0,0,0,0.25)' };

export default function IconPreview() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetch(`${BASE}/cards`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: Record<string, Card>) => setCards(Object.values(data)))
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const purchasable = useMemo(() => {
    if (!cards) return [];
    const terms = query.toLowerCase().split(',').map(t => t.trim()).filter(Boolean);
    return cards
      .filter(c => c.card_type !== 'token' && c.buy_cost != null)
      .filter(c => terms.length === 0 || terms.some(q => c.name.toLowerCase().includes(q) || c.definition_id.includes(q)))
      .sort((a, b) =>
        ARCHETYPES.indexOf(a.archetype) - ARCHETYPES.indexOf(b.archetype)
        || (a.buy_cost ?? 0) - (b.buy_cost ?? 0)
        || a.name.localeCompare(b.name));
  }, [cards, query]);

  return (
    <div style={{ height: '100dvh', overflowY: 'auto', background: 'var(--cc-bg)', color: 'var(--cc-text)', fontFamily: 'var(--cc-font-body)' }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 16px 64px' }}>
        <h1 className="cc-title" style={{ fontSize: 30, margin: '0 0 4px' }}>Icon Gallery</h1>
        <p style={note}>
          {ICON_NAMES.length} hand-authored single-color glyphs on a 16-unit grid (<code>src/icons/glyphs.ts</code>), rendered as
          inline SVG in the DOM (<code>&lt;Icon&gt;</code>) everywhere, including the floating labels on the 3D board.
        </p>
        <nav style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13, marginBottom: 8 }}>
          {[['glyphs', 'Glyphs'], ['loupe', 'Pixel loupe'], ['numbers', 'Numbers'], ['cards', 'All cards'], ['board', 'Board']].map(([id, label]) => (
            <a key={id} href={`#${id}`} style={{ color: 'var(--cc-gold)', textDecoration: 'none' }}>{label}</a>
          ))}
        </nav>

        <GlyphGrid />
        <PixelLoupe />
        <NumberSamples />

        <h2 id="cards" style={sectionTitle}>All card subtitles</h2>
        <p style={note}>
          Hand-card chips at real size (134×52 px, 13 px subtitle) with CardHand's horizontal auto-fit. The number under each chip
          is the squeeze factor (1.00 = none). Upgraded versions follow their base card.
        </p>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: 'var(--cc-text-dim)', marginBottom: 10 }}>
          Filter
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="names, comma-separated"
            style={{ background: '#15152e', color: 'var(--cc-text)', border: '1px solid var(--cc-panel-border-strong)', borderRadius: 6, padding: '3px 6px', fontSize: 13, width: 220 }} />
        </label>
        {loadError && <p style={{ color: 'var(--cc-danger)' }}>Could not load /api/cards ({loadError}) — is the backend running?</p>}
        {!cards && !loadError && <p style={note}>Loading card catalog…</p>}
        {cards && ARCHETYPES.map(arch => {
          const list = purchasable.filter(c => c.archetype === arch);
          if (list.length === 0) return null;
          return (
            <div key={arch} style={{ marginBottom: 14 }}>
              <h3 style={{ fontFamily: 'var(--cc-font-display)', fontSize: 15, margin: '14px 0 8px', textTransform: 'capitalize' }}>
                {arch} <span style={{ color: 'var(--cc-text-faint)', fontSize: 12 }}>({list.length})</span>
              </h3>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {list.flatMap(card => {
                  const up = hasUpgradePreview(card) ? getUpgradedPreview(card) : null;
                  return [<MiniHandCard key={card.definition_id} card={card} />, up && <MiniHandCard key={`${card.definition_id}+`} card={up} />];
                })}
              </div>
            </div>
          );
        })}

        <BoardSample />
      </div>
    </div>
  );
}

// ── 1. Glyph grid ─────────────────────────────────────────────────────────

function GlyphGrid() {
  return (
    <>
      <h2 id="glyphs" style={sectionTitle}>Glyphs</h2>
      <p style={note}>
        Dark card surface, then light surface, at 11 / 12 / 14 / 16 / 24 px; an inline 13 px sample; a 64 px construction view.
        Duotone accent layers render at 42% of the ink color.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, fontSize: 12, minWidth: 1060 }}>
          <thead>
            <tr style={{ color: 'var(--cc-text-faint)', textAlign: 'left' }}>
              <th style={th}>Glyph</th>
              {SIZES.map(s => <th key={`d${s}`} style={{ ...th, textAlign: 'center' }}>{s}</th>)}
              {SIZES.map(s => <th key={`l${s}`} style={{ ...th, textAlign: 'center' }}>{s}</th>)}
              <th style={th}>In text</th>
              <th style={th}>64 px / grid</th>
            </tr>
          </thead>
          <tbody>
            {GROUP_ORDER.map(group => (
              <GroupRows key={group} group={group} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function GroupRows({ group }: { group: GlyphGroup }) {
  const names = ICON_NAMES.filter(n => GLYPHS[n].group === group);
  return (
    <>
      <tr>
        <td colSpan={3 + SIZES.length * 2} style={{ padding: '14px 8px 4px', fontFamily: 'var(--cc-font-display)', color: 'var(--cc-gold)', fontSize: 13 }}>
          {GROUP_LABEL[group]}
        </td>
      </tr>
      {names.map(name => (
        <tr key={name}>
          <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--cc-panel-border)', minWidth: 170 }}>
            <div style={{ fontWeight: 700 }}>{GLYPHS[name].label}</div>
            <code style={{ color: 'var(--cc-text-faint)', fontSize: 11 }}>{name}</code>
          </td>
          {SIZES.map((s, i) => (
            <td key={`d${s}`} style={{ ...swatch, background: DARK_BG, borderLeft: i === 0 ? '1px solid var(--cc-panel-border)' : undefined }}>
              <Icon name={name} size={s} color={DARK_INK} />
            </td>
          ))}
          {SIZES.map((s, i) => (
            <td key={`l${s}`} style={{ ...swatch, background: LIGHT_BG, borderLeft: i === 0 ? '2px solid var(--cc-bg)' : undefined }}>
              <Icon name={name} size={s} color={LIGHT_INK} />
            </td>
          ))}
          <td style={{ padding: '4px 10px', borderBottom: '1px solid var(--cc-panel-border)', color: '#aaa', whiteSpace: 'nowrap' }}>
            <IconValue icon={name} value="+2" size={13} iconFirst={false} decorative />
            <span style={{ margin: '0 6px', opacity: 0.6 }}>·</span>
            <IconValue icon={name} value={3} size={13} decorative />
          </td>
          <td style={{ padding: 4, borderBottom: '1px solid var(--cc-panel-border)' }}>
            <ConstructionView name={name} />
          </td>
        </tr>
      ))}
    </>
  );
}

function ConstructionView({ name }: { name: IconName }) {
  const lines: ReactNode[] = [];
  for (let i = 1; i < 16; i++) {
    const strong = i === 8;
    lines.push(<line key={`v${i}`} x1={i} y1={0} x2={i} y2={16} stroke={strong ? '#5a5a90' : '#33335a'} strokeWidth={0.05} />);
    lines.push(<line key={`h${i}`} x1={0} y1={i} x2={16} y2={i} stroke={strong ? '#5a5a90' : '#33335a'} strokeWidth={0.05} />);
  }
  return (
    <div style={{ position: 'relative', width: 64, height: 64, background: '#15152e', borderRadius: 4, color: DARK_INK }}>
      <svg viewBox="0 0 16 16" width={64} height={64} style={{ position: 'absolute', inset: 0 }} aria-hidden>{lines}</svg>
      <Icon name={name} size={64} decorative style={{ position: 'absolute', inset: 0, opacity: 0.92 }} />
    </div>
  );
}

// ── 2. Pixel loupe ────────────────────────────────────────────────────────

function LoupeCanvas({ name, px, dpr, cell }: { name: IconName; px: number; dpr: number; cell: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const device = Math.round(px * dpr);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = device;
    c.height = device;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = DARK_BG;
    ctx.fillRect(0, 0, device, device);
    drawGlyph(ctx, name, device, { color: '#ece4d0' });
  }, [name, device]);
  return <canvas ref={ref} style={{ width: device * cell, height: device * cell, imageRendering: 'pixelated', borderRadius: 2 }} />;
}

function PixelLoupe() {
  return (
    <>
      <h2 id="loupe" style={sectionTitle}>Pixel loupe</h2>
      <p style={note}>Each glyph rasterised at 11 px and 12 px on a 1× display (6× zoom) and at 12 px on a 2× display (3× zoom).</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(268px, 1fr))', gap: 8 }}>
        {ICON_NAMES.map(name => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 6, background: 'rgba(255,255,255,0.025)', border: '1px solid var(--cc-panel-border)', borderRadius: 6 }}>
            <LoupeCanvas name={name} px={11} dpr={1} cell={6} />
            <LoupeCanvas name={name} px={12} dpr={1} cell={6} />
            <LoupeCanvas name={name} px={12} dpr={2} cell={3} />
            <code style={{ fontSize: 10, color: 'var(--cc-text-faint)', marginLeft: 2, wordBreak: 'break-all' }}>{name}</code>
          </div>
        ))}
      </div>
    </>
  );
}

// ── 3. Numbers ────────────────────────────────────────────────────────────

const NUMBER_SAMPLES: string[][] = [
  ['{power}3', '+1{card}', '+1{action}'],
  ['+2{resource}', '+1{nextRound}{card}', '+1{action}'],
  ['{fortify}2 · 2{tile}', '+1{action}'],
  ['{power}2/4{stack}', '(+1{action})'],
  ['{opponent}-1{card}', '{trash}2{then}+1{card}, +1{action}'],
  ['{immune}Immune', '+10{resource}', '-1{action}', '{unique}'],
];

function NumberSamples() {
  const parts = (srcs: string[]): SubtitlePart[] => srcs.map(src => ({ tokens: parseSubtitle(src) }));
  return (
    <>
      <h2 id="numbers" style={sectionTitle}>Numbers</h2>
      <p style={note}>
        Bold Philosopher, lining, fixed-width digits (each digit in a 0.58 em cell — Philosopher has no tabular figures), centred on
        the glyph's vertical middle, ~1 px from it, in the same single color.
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {[11, 12, 13].map(sz => (
          <div key={sz} style={{ background: DARK_BG, borderRadius: 8, padding: '8px 12px', color: '#aaa' }}>
            <div style={{ fontSize: 11, color: 'var(--cc-text-faint)', marginBottom: 6 }}>{sz} px</div>
            {NUMBER_SAMPLES.map((srcs, i) => (
              <div key={i} style={{ fontSize: sz, height: Math.round(sz * 1.6), display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
                {renderSubtitle(parts(srcs), { fontSize: sz })}
              </div>
            ))}
          </div>
        ))}
        <div style={{ background: 'var(--cc-panel)', border: '1px solid var(--cc-panel-border)', borderRadius: 8, padding: '8px 12px' }}>
          <div style={{ fontSize: 11, color: 'var(--cc-text-faint)', marginBottom: 6 }}>HUD (12 px) / cost / counter</div>
          <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--cc-text-dim)', marginBottom: 10 }}>
            <IconValue icon="vp" value={12} size={12} color="#ffd700" />
            <IconValue icon="resource" value={7} size={12} />
            <IconValue icon="tile" value={9} size={12} />
            <IconValue icon="drawPile" value={18} size={12} />
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', color: '#aaa' }}>
            <CostLabel cost={4} size={13} />
            <CostLabel cost={10} size={15} color="var(--cc-gold)" />
            <IconValue icon="action" value={3} size={20} color="#ffe7a8" />
          </div>
        </div>
      </div>
    </>
  );
}

// ── 4. Card chips ─────────────────────────────────────────────────────────

function MiniHandCard({ card }: { card: Card }) {
  const color = getCardDisplayColor(card);
  const parts = buildCardSubtitle(card);
  const [scale, setScale] = useState(1);
  return (
    <div>
      <div style={{
        width: 134, height: 52, padding: 6, boxSizing: 'border-box', borderRadius: 8,
        border: `2px solid ${color}`, background: miniCardBackground(color), boxShadow: MINI_CARD_SHADOW, color: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ fontWeight: 'bold', fontSize: 14, fontFamily: CARD_TITLE_FONT, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <FitSpan>{card.name}</FitSpan>
          </div>
          <span style={{ fontSize: 13, flexShrink: 0, color: '#aaa', whiteSpace: 'nowrap' }}><CostLabel cost={card.buy_cost} size={13} /></span>
        </div>
        <div style={{ fontSize: 13, color: '#aaa', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <FitSpan onScale={setScale}>{renderSubtitle(parts, { fontSize: 13, passiveVp: card.passive_vp })}</FitSpan>
        </div>
      </div>
      <div style={{ fontSize: 10, color: scale < 0.85 ? '#ff9a7a' : 'var(--cc-text-faint)', marginTop: 2, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {scale.toFixed(2)}×
      </div>
    </div>
  );
}

/** Mirrors CardHand's ref-based horizontal auto-fit. */
function FitSpan({ children, onScale }: { children: ReactNode; onScale?: (s: number) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const measure = () => {
      const el = ref.current;
      if (!el || !el.parentElement) return;
      el.style.transform = 'none';
      const s = Math.min(1, el.parentElement.clientWidth / el.scrollWidth);
      el.style.transform = `scaleX(${s})`;
      onScale?.(s);
    };
    measure();
    document.fonts?.ready.then(measure);
  });
  return <span ref={ref} style={{ display: 'inline-block', maxWidth: '100%', transformOrigin: 'left center' }}>{children}</span>;
}

// ── 5. Board label sample ────────────────────────────────────────────────

function BoardSample() {
  const samples: { label: string; fill: string; rows: LabelRow[] }[] = [
    { label: 'VP (connected)', fill: '#3a7abf', rows: [row([{ icon: 'vp' }], 18, '#ffd700')] },
    { label: 'VP ×3', fill: '#3a7abf', rows: [row([{ icon: 'vp' }, { icon: 'vp' }, { icon: 'vp' }], 15, '#fff066')] },
    { label: 'VP (not connected)', fill: '#4a5a3a', rows: [row([{ icon: 'vpOutline' }], 18, '#9a9a9a')] },
    { label: 'Permanent + round', fill: '#a83040', rows: [defenseRow(2, 3, false, 14)] },
    { label: 'Defense (round)', fill: '#2e8a3a', rows: [defenseRow(0, 3, false, 14)] },
    { label: 'Immune', fill: '#2e8a3a', rows: [defenseRow(0, 0, true, 14)] },
    { label: 'Planned claim', fill: '#4a5a3a', rows: [row([{ icon: 'power' }, { text: '4' }], 18)] },
    { label: 'Target opponent', fill: '#8868a8', rows: [row([{ icon: 'opponent' }], 16, '#ff6666')] },
    { label: 'Rubble', fill: '#8868a8', rows: [row([{ icon: 'rubble' }], 18, '#ff6666')] },
    { label: 'Abandon', fill: '#a83040', rows: [row([{ icon: 'abandon' }], 20, '#ff9944')] },
    { label: 'Preview', fill: '#4a5a3a', rows: [row([{ icon: 'power' }, { text: '+3' }], 18, '#fff', 0.75)] },
  ];
  const stepX = 92;
  return (
    <>
      <h2 id="board" style={sectionTitle}>Board tile labels</h2>
      <p style={note}>
        Floating HTML labels the 3D board positions over each tile every frame (<code>BoardLabelRow</code>). Blue
        ({TEMP_DEF}) marks this-round defense.
      </p>
      <div style={{ overflowX: 'auto', background: '#101024', border: '1px solid var(--cc-panel-border)', borderRadius: 10, padding: '8px 0' }}>
        <div style={{ display: 'flex' }}>
          {samples.map(t => <div key={t.label} style={{ width: stepX, flexShrink: 0, fontSize: 10, color: 'var(--cc-text-faint)', textAlign: 'center' }}>{t.label}</div>)}
        </div>
        <div style={{ display: 'flex' }}>
          {samples.map(t => (
            <div key={t.label} style={{ width: stepX, height: 84, flexShrink: 0, display: 'grid', placeItems: 'center' }}>
              <div style={{ width: 64, height: 56, clipPath: 'polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)', background: t.fill, opacity: 0.85, display: 'grid', placeItems: 'center' }}>
                <div className="cc-board-label" style={{ position: 'static' }}>
                  {t.rows.map((r, i) => <BoardLabelRow key={i} r={r} scale={1} />)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
