import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Card, SoloLevel } from '../../types/game';
import { BASE } from '../../api/client';
import CompactCardFace from '../CompactCardFace';
import CardFull, { CARD_FULL_HEIGHT, CARD_FULL_WIDTH } from '../CardFull';
import { CardDetailOverlay } from '../BoardCards';
import Icon from '../../icons/Icon';
import type { LevelClear } from './soloProgress';
import SoloMapPreview from './SoloMapPreview';

export const SOLO_ARCHETYPES = [
  { id: 'vanguard', name: 'Vanguard', emblem: '/assets/howtoplay/vanguard.webp', desc: 'Aggressive, high-power claims.' },
  { id: 'swarm', name: 'Swarm', emblem: '/assets/howtoplay/swarm.webp', desc: 'Wide expansion with many small claims.' },
  { id: 'fortress', name: 'Fortress', emblem: '/assets/howtoplay/fortress.webp', desc: 'Strong defenses and heavy claims.' },
];

const DIFFICULTY_NAMES: Record<string, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

// Every card, by id (the level's pool is ids). Fetched once.
let cardsById: Record<string, Card> | null = null;
let cardsLoading: Promise<Record<string, Card>> | null = null;

function loadCards(): Promise<Record<string, Card>> {
  if (cardsById) return Promise.resolve(cardsById);
  if (!cardsLoading) {
    cardsLoading = fetch(`${BASE}/cards`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Could not load the cards.'))))
      .then((data: Record<string, Card>) => { cardsById = data; return data; })
      .finally(() => { cardsLoading = null; });
  }
  return cardsLoading;
}

function useCards(): Record<string, Card> | null {
  const [cards, setCards] = useState(cardsById);
  useEffect(() => {
    if (cards) return;
    let live = true;
    loadCards().then(c => { if (live) setCards(c); }).catch(() => { /* faces just don't show */ });
    return () => { live = false; };
  }, [cards]);
  return cards;
}

/** Desktop briefings show full cards, five to a row; phones compact ones. */
const WIDE_QUERY = '(min-width: 761px)';
const PER_ROW = 5;
const CARD_GAP = 10;

function useWide(): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia(WIDE_QUERY).matches; } catch { return true; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(WIDE_QUERY); } catch { return; }
    const onChange = () => setWide(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/** A row of up to five full cards, scaled to fit the row's width. */
function FullCardRow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      const cell = (el.clientWidth - CARD_GAP * (PER_ROW - 1)) / PER_ROW;
      setScale(Math.max(0.4, Math.min(1, cell / CARD_FULL_WIDTH)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="cc-solo-fullcards"
      style={{
        ['--card-scale' as string]: scale,
        ['--card-w' as string]: `${CARD_FULL_WIDTH * scale}px`,
        ['--card-h' as string]: `${CARD_FULL_HEIGHT * scale}px`,
        gap: CARD_GAP,
      }}
    >
      {children}
    </div>
  );
}

interface SoloLevelPanelProps {
  level: SoloLevel;
  index: number;
  best?: LevelClear;
  onClose: () => void;
  onStart: (level: SoloLevel) => Promise<void>;
}

/** A level's briefing: objective, what it introduces, rules, cards and
 *  rivals, a look at the map; start it as the campaign's archetype. */
export default function SoloLevelPanel({ level, index, best, onClose, onStart }: SoloLevelPanelProps) {
  const cards = useCards();
  const archetype = level.archetype;
  const me = SOLO_ARCHETYPES.find(a => a.id === archetype);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<Card | null>(null);
  const [preview, setPreview] = useState(false);
  const wide = useWide();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || preview) return;
      if (zoomed) setZoomed(null); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, zoomed, preview]);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(level);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  const obj = level.objective;
  const face = (id: string, spot = false) => {
    const card = cards?.[id];
    if (!card) return <div key={id} className={wide ? 'cc-solo-fullcard-ph' : 'cc-solo-card-ph'} />;
    return (
      <button
        type="button"
        key={id}
        className={`${wide ? 'cc-solo-fullcard' : 'cc-solo-card'}${spot ? ' is-spotlight' : ''}`}
        onClick={() => setZoomed(card)}
        title={`${card.name} — click for details`}
      >
        {wide ? (
          <span className="cc-solo-fullcard-face"><CardFull card={card} /></span>
        ) : (
          <CompactCardFace card={card} width={132} size="sm" />
        )}
      </button>
    );
  };
  const row = (ids: string[]) => (wide
    ? <FullCardRow>{ids.map(id => face(id, level.spotlight.includes(id)))}</FullCardRow>
    : <div className="cc-solo-cards">{ids.map(id => face(id, level.spotlight.includes(id)))}</div>);

  return (
    <div onClick={onClose} className="cc-scr-modal-backdrop" style={{ zIndex: 5000 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="cc-panel cc-scr-modal cc-solo-panel"
        role="dialog"
        aria-label={`Level ${index + 1}: ${level.title}`}
      >
        <div className="cc-scr-modal-head">
          <div style={{ minWidth: 0 }}>
            <div className="cc-scr-modal-sub">Level {index + 1}{best ? ` · cleared in round ${best.round}` : ''}</div>
            <div className="cc-scr-modal-title">{level.title}</div>
          </div>
          <button onClick={onClose} className="cc-scr-close" aria-label="Close" style={{ marginLeft: 'auto' }}>
            <Icon name="close" size={14} decorative />
          </button>
        </div>

        <div className="cc-scr-modal-body cc-solo-panel-body">
          <p className="cc-solo-intro">{level.intro}</p>

          <section className="cc-solo-objective">
            <div className="cc-solo-label">Objective</div>
            <div className="cc-solo-goal">{obj.goal}</div>
            <div className="cc-solo-deadline">
              <Icon name="round" size={12} decorative />
              {obj.rounds === null ? ' No time limit' : obj.type === 'survive' ? ` ${obj.rounds} rounds` : ` by the end of round ${obj.rounds}`}
              {obj.bot_vp != null && <> · lose if a rival reaches {obj.bot_vp} VP first</>}
            </div>
          </section>

          {level.shared_with.length > 0 && (
            <p className="cc-solo-shared">
              <Icon name="swap" size={12} decorative /> The same fight is a level of the{' '}
              {level.shared_with.map(a => SOLO_ARCHETYPES.find(x => x.id === a)?.name ?? a).join(' and ')} campaign,
              {' '}played from the other side.
            </p>
          )}

          {level.spotlight.length > 0 && (
            <section>
              <div className="cc-solo-label">Introduces</div>
              {row(level.spotlight)}
            </section>
          )}

          {level.hints.length > 0 && (
            <section>
              <div className="cc-solo-label">Field notes</div>
              <ul className="cc-solo-hints">
                {level.hints.map((h, i) => <li key={i}>{h}</li>)}
              </ul>
            </section>
          )}

          <section className="cc-solo-facts">
            <span><b>{level.map.name}</b> · {level.map.tiles} tiles</span>
            {level.map.vp_hexes > 0 && <span><Icon name="vp" size={11} decorative /> {level.map.vp_hexes} VP hexes</span>}
            {level.map.mountains > 0 && <span>{level.map.mountains} mountains</span>}
            {(level.map.water ?? 0) > 0 && <span>{level.map.water} water</span>}
            {(level.map.scorched ?? 0) > 0 && <span>{level.map.scorched} scorched</span>}
            <span>{level.market === 'random' ? `Random market: ${level.market_size} cards a round` : 'Every card on show'}</span>
            {level.bots.length > 0 && <span>{level.debt ? 'Debt for the VP leader from round 5' : 'No Debt'}</span>}
          </section>

          {level.bots.length > 0 && (
            <section>
              <div className="cc-solo-label">Rivals</div>
              <div className="cc-solo-bots">
                {level.bots.map((b, i) => {
                  const arch = SOLO_ARCHETYPES.find(a => a.id === b.archetype);
                  return (
                    <span key={i} className="cc-solo-bot">
                      {arch && <img src={arch.emblem} alt="" draggable={false} />}
                      <b>{b.name}</b> {arch?.name} · {DIFFICULTY_NAMES[b.difficulty] ?? b.difficulty}
                    </span>
                  );
                })}
              </div>
            </section>
          )}

          <section className="cc-solo-playas">
            {me && <img src={me.emblem} alt="" draggable={false} />}
            <span>You play as <b>{me?.name ?? archetype}</b> — the {me?.name ?? archetype} campaign's archetype.</span>
          </section>

          <section>
            <div className="cc-solo-label">Cards to buy</div>
            <div className="cc-solo-sublabel">Shared market</div>
            {row(level.cards.shared)}
            <div className="cc-solo-sublabel">{SOLO_ARCHETYPES.find(a => a.id === archetype)?.name} cards</div>
            {row(level.cards.archetype[archetype] ?? [])}
          </section>
        </div>

        <div className="cc-scr-modal-foot">
          <button type="button" className="cc-btn-secondary cc-solo-preview" onClick={() => setPreview(true)} aria-label="Preview map">
            <Icon name="tile" size={13} decorative />
            <span className="cc-solo-preview-long">Preview map</span>
            <span className="cc-solo-preview-short">Map</span>
          </button>
          {error && <span className="cc-solo-error">{error}</span>}
          <button type="button" className="cc-btn-secondary" onClick={onClose} style={{ marginLeft: 'auto' }}>Back</button>
          <button type="button" className="cc-btn-primary cc-solo-start" onClick={start} disabled={starting}>
            {starting ? 'Starting…' : best ? 'Play again' : 'Start'}
          </button>
        </div>
      </div>
      {preview && <SoloMapPreview level={level} onClose={() => setPreview(false)} />}
      {zoomed && (
        // The overlay is portalled, but its clicks still bubble through
        // React to the briefing's backdrop: stop them here.
        <div className="cc-solo-zoom" onClick={(e) => e.stopPropagation()}>
          <CardDetailOverlay entries={[{ card: zoomed }]} onClose={() => setZoomed(null)} />
        </div>
      )}
    </div>
  );
}
