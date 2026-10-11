import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SoloCampaigns, SoloLevel } from '../../types/game';
import GameBoard, { PLAYER_COLORS, cssHexToNumber, type BoardControls, type VpPath } from '../GameBoard';
import type { PlayerInfo } from '../../board3d/boardTypes';
import { useAnimationSpeed } from '../SettingsContext';
import LocalSettingsMenu from '../LocalSettingsMenu';
import Icon from '../../icons/Icon';
import * as api from '../../api/client';
import SoloLevelPanel, { SOLO_ARCHETYPES } from './SoloLevelPanel';
import SoloLoading from './SoloLoading';
import { baseRotation } from './SoloMapPreview';
import {
  SOLO_PLAYER_ID, campaignProgress, frontier, loadProgress, markShown, overworldTiles, roadChain, roadPoints,
  spotState, type LevelState,
} from './soloProgress';

/** Where the arrival lands: the angled view (the board's Tilt button). */
const ARRIVAL_TILT = 0.85;

/** Your color on the overworld (the solo games seat you in it too). */
export const SOLO_COLOR = '#4363d8';

interface SoloOverworldProps {
  /** The campaign: you play its levels as this archetype. */
  archetype: string;
  /** Back to the campaign choice. */
  onBack: () => void;
  /** Start a level; rejects with a message to show. */
  onStart: (level: SoloLevel) => Promise<void>;
}

/**
 * One campaign's overworld: the shared island, with this campaign's castle
 * in its corner and a road of level spots. Cleared levels are yours (towns
 * linked to your castle by road); your land reaches the next spot, which is
 * open; the rest are locked. Clearing a level grows the territory along the
 * road the next time the map opens.
 */
export default function SoloOverworld({ archetype, onBack, onStart }: SoloOverworldProps) {
  const [data, setData] = useState<SoloCampaigns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress] = useState(() => campaignProgress(loadProgress(), archetype));
  const [selected, setSelected] = useState<number | null>(null);
  const speed = useAnimationSpeed();
  const controlsRef = useRef<BoardControls | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    api.getSoloCampaigns()
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load the campaign.'); });
    return () => { live = false; };
  }, [attempt]);

  const camp = useMemo(() => data?.campaigns.find(c => c.archetype === archetype) ?? null, [data, archetype]);
  const ow = data?.overworld;
  const levelIds = useMemo(() => camp?.levels.map(l => l.id) ?? [], [camp]);
  const cleared = frontier(levelIds, progress);
  const stops = useMemo(() => (camp ? [...camp.spots, ...camp.soon] : []), [camp]);

  // The road you've built, and how much of it shows: levels cleared since
  // the map last opened grow it tile by tile.
  const chain = useMemo(() => (camp ? roadChain(camp, cleared) : []), [camp, cleared]);
  const shownFrom = useMemo(
    () => (camp ? roadChain(camp, Math.min(progress.shown, cleared)).length : 0),
    [camp, progress.shown, cleared],
  );
  const [grown, setGrown] = useState(0);

  // The arrival: the camera flies in from far off, straight at the island at
  // the angled view (the Tilt button's), through layers of cloud at
  // different heights that thin away as it passes, and comes to rest with
  // the whole island in view. The labels, plaques and level list wait for it, then the territory
  // grows. (Animations off: no arrival.)
  const ready = !!(camp && ow);
  const [arrived, setArrived] = useState(speed === 0);
  useEffect(() => {
    if (!ready) return;
    if (speed === 0) {
      setArrived(true);
      return;
    }
    const k = Math.max(0.6, speed);
    const timers: number[] = [];
    // Next frame: the board's engine is in place by then (StrictMode remounts
    // it after this effect's first run). The board is still faded out.
    const raf = requestAnimationFrame(() => {
      const c = controlsRef.current;
      if (!c) { setArrived(true); return; }
      c.setCloudCover(1);
      // The board fades in (1.2 s) on the first layer; then the camera
      // flies through one layer after another before the island opens up.
      c.arrive({
        tilt: ARRIVAL_TILT, endTilt: ARRIVAL_TILT, zoom: 0.3, seconds: 4.6 * k,
        passAt: [1.35, 1.75, 2.15, 2.55, 2.95].map(t => t * k),
      });
      // Whatever cloud is left at the edges fades as the camera settles.
      timers.push(window.setTimeout(() => c.setCloudCover(0, 1.0 * k), 3100 * k));
      timers.push(window.setTimeout(() => setArrived(true), 3900 * k));
    });
    return () => { cancelAnimationFrame(raf); timers.forEach(t => window.clearTimeout(t)); };
  // Once per opening (the campaign is fixed for this screen).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (!camp) return;
    setGrown(shownFrom);
    if (!arrived) return;
    if (chain.length <= shownFrom || speed === 0) {
      setGrown(chain.length);
      markShown(archetype, cleared);
      return;
    }
    const step = 220 * Math.max(0.5, speed);
    let n = shownFrom;
    let timer = 0;
    const next = () => {
      n += 1;
      setGrown(n);
      if (n < chain.length) timer = window.setTimeout(next, step);
      else markShown(archetype, cleared);
    };
    timer = window.setTimeout(next, 300 * Math.max(0.65, speed));
    return () => window.clearTimeout(timer);
  }, [camp, chain, shownFrom, cleared, speed, archetype, arrived]);

  const visible = chain.slice(0, Math.max(1, grown));
  const owned = useMemo(() => new Set(visible), [visible.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const tiles = useMemo(() => (ow && camp ? overworldTiles(ow, camp, owned) : {}), [ow, camp, owned]);
  // Turned as a game turns its board: this campaign's castle at the bottom.
  const rotation = useMemo(
    () => (ow && camp ? baseRotation(overworldTiles(ow, camp, []), SOLO_PLAYER_ID) : 0),
    [ow, camp],
  );

  const states = useMemo<LevelState[]>(
    () => stops.map((_, i) => spotState(i, levelIds, progress)),
    [stops, levelIds, progress],
  );
  // A level shows as cleared / open once the growing road reaches it.
  const shownState = (i: number): LevelState => {
    const s = states[i];
    if (!camp || s === 'locked' || s === 'soon') return s;
    if (s === 'cleared' && !owned.has(stops[i])) return 'locked';
    if (s === 'open') {
      const road = camp.segments[i];
      const beside = road.length > 1 ? road[road.length - 2] : (i === 0 ? camp.castle : stops[i - 1]);
      if (!owned.has(beside)) return 'locked';
    }
    return s;
  };

  const playerInfo = useMemo<Record<string, PlayerInfo>>(() => {
    PLAYER_COLORS[SOLO_PLAYER_ID] = cssHexToNumber(SOLO_COLOR);
    return { [SOLO_PLAYER_ID]: { name: 'You', archetype } };
  }, [archetype]);

  const connected = useMemo(() => new Set(stops.filter(k => owned.has(k))), [stops, owned]);
  const vpPaths = useMemo<VpPath[]>(() => {
    if (!ow || visible.length < 2) return [];
    return [{
      points: roadPoints(ow, visible), color: cssHexToNumber(SOLO_COLOR), alpha: 1,
      playerId: SOLO_PLAYER_ID, noPulse: true,
    }];
  }, [ow, visible.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const openSpots = useMemo(() => {
    const out = new Set<string>();
    stops.forEach((k, i) => { if (shownState(i) === 'open') out.add(k); });
    return out;
  }, [stops, owned, states]); // eslint-disable-line react-hooks/exhaustive-deps

  const nextOpen = states.findIndex(s => s === 'open');

  const select = useCallback((i: number) => {
    const s = states[i];
    if (s === 'open' || s === 'cleared') setSelected(i);
  }, [states]);

  const onTileClick = useCallback((q: number, r: number) => {
    const i = stops.indexOf(`${q},${r}`);
    if (i >= 0) select(i);
  }, [stops, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selected === null) onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, selected]);

  const renderBadge = (key: string, zoom: number) => {
    if (!camp) return null;
    const i = stops.indexOf(key);
    const level = camp.levels[i];
    const state = shownState(i);
    const clickable = state === 'open' || state === 'cleared';
    return (
      <button
        type="button"
        className={`cc-solo-badge is-${state}`}
        style={{ ['--z' as string]: Math.max(0.75, Math.min(1.25, zoom)) }}
        onClick={clickable ? () => select(i) : undefined}
        tabIndex={clickable ? 0 : -1}
        aria-label={level ? `Level ${i + 1}: ${level.title} (${state})` : 'Coming soon'}
      >
        <span className="cc-solo-badge-num">
          {state === 'cleared' ? <Icon name="check" size={11} decorative /> : state === 'locked' ? <LockGlyph /> : i + 1}
        </span>
        <span className="cc-solo-badge-name">{level ? level.title : 'Coming soon'}</span>
        {level && level.shared_with.length > 0 && (
          <span className="cc-solo-badge-shared" title="Shared with another campaign"><Icon name="swap" size={10} decorative /></span>
        )}
      </button>
    );
  };

  const arch = SOLO_ARCHETYPES.find(a => a.id === archetype);
  const levelCount = camp?.levels.length ?? 0;
  // The level you're on: the next open one, or the last once all are cleared.
  const current = nextOpen >= 0 && nextOpen < levelCount ? nextOpen : levelCount - 1;
  const selectedLevel = selected !== null ? camp?.levels[selected] : undefined;

  return (
    <div className={`cc-solo-root is-${archetype}${arrived ? ' is-arrived' : ''}`}>
      <LocalSettingsMenu />
      <header className="cc-solo-head">
        <button type="button" className="cc-btn-secondary cc-solo-back" onClick={onBack}>
          <Icon name="chevron" size={12} decorative style={{ transform: 'rotate(180deg)' }} /> Campaigns
        </button>
        <div className="cc-solo-title">
          <h1 className="cc-title">
            {arch && <img className="cc-solo-title-emblem" src={arch.emblem} alt="" draggable={false} />}
            <span className="cc-solo-title-text">{camp?.title ?? arch?.name ?? 'Solo'}</span>
          </h1>
        </div>
        <span className="cc-solo-next-spacer" />
      </header>

      <div className="cc-solo-board">
        {camp && ow ? (
          <div className="cc-solo-board-fade">
          <GameBoard
            tiles={tiles}
            onTileClick={onTileClick}
            playerInfo={playerInfo}
            vpPaths={vpPaths}
            connectedVpTiles={connected}
            vpGlyph="crown"
            gridRotation={rotation}
            highlightTiles={arrived ? openSpots : undefined}
            disableHover={!arrived}
            activePlayerId={SOLO_PLAYER_ID}
            tileCardKeys={stops}
            renderTileCards={renderBadge}
            controlsRef={controlsRef}
            paused={selected !== null}
            // The board's tile tooltips describe game rules (VP, defense,
            // raids), which don't apply to the overworld.
            suppressTileTooltips
            cameraLocked={!arrived}
            showCameraControls
          />
          </div>
        ) : null}
      </div>
      {!(camp && ow) && (
        <SoloLoading
          message="Charting the island"
          error={error ?? (data && !camp ? 'There is no such campaign.' : null)}
          onRetry={error ? () => setAttempt(n => n + 1) : undefined}
        />
      )}

      {camp && (
        // Just the level you're on; hover (or the toggle, on touch) shows them all.
        <nav
          className={`cc-solo-list${listOpen ? ' is-open' : ''}`}
          aria-label="Levels"
          onMouseLeave={() => setListOpen(false)}
        >
          <ol>
            {camp.levels.map((level, i) => {
              const state = states[i];
              const best = progress.cleared[level.id];
              return (
                <li key={level.id} className={i === current ? 'is-current' : undefined}>
                  <div className="cc-solo-list-fold">
                    <button
                      type="button"
                      className={`cc-solo-list-item is-${state}`}
                      disabled={state === 'locked'}
                      onClick={() => select(i)}
                    >
                      <span className="cc-solo-list-num">
                        {state === 'cleared' ? <Icon name="check" size={11} decorative /> : state === 'locked' ? <LockGlyph /> : i + 1}
                      </span>
                      <span className="cc-solo-list-text">
                        <span className="cc-solo-list-name">{level.title}</span>
                        <span className="cc-solo-list-goal">
                          {state === 'locked' ? 'Clear the level before it' : best ? `Cleared in round ${best.round}` : level.objective.goal}
                        </span>
                      </span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="cc-solo-list-toggle"
            aria-expanded={listOpen}
            onClick={() => setListOpen(o => !o)}
          >
            All {levelCount} levels
            <Icon name="chevron" size={10} decorative />
          </button>
        </nav>
      )}

      {selectedLevel && selected !== null && (
        <SoloLevelPanel
          level={selectedLevel}
          index={selected}
          best={progress.cleared[selectedLevel.id]}
          onClose={() => setSelected(null)}
          onStart={onStart}
        />
      )}
    </div>
  );
}

function LockGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
      <rect x="2" y="5.2" width="8" height="5.8" rx="1.2" fill="currentColor" />
      <path d="M3.8 5.4V3.9a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
