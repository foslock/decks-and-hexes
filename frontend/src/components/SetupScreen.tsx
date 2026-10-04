import { useState, useEffect, useCallback } from 'react';
import { BASE } from '../api/client';
import CardBrowser from './CardBrowser';
import Icon from '../icons/Icon';
import HowToPlay from './HowToPlay';
import TutorialOverlay from './tutorial/TutorialOverlay';
import HeroAnimation from './HeroAnimation';
import LobbyBrowser from './LobbyBrowser';
import packageJson from '../../package.json';
import { appHasBooted, signalAppReady, waitForFonts } from '../utils/appReady';

/** Set once a player has seen (or skipped) the How to Play tour. */
export const TUTORIAL_SEEN_KEY = 'cardclash_tutorial_seen';

function tutorialSeen(): boolean {
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) === '1'; } catch { return true; }
}

interface SetupScreenProps {
  onCreateLobby: () => void;
  onJoinLobby: (code: string) => Promise<void>;
}

/** Ambient embers drifting up behind the title screen (fixed layout so the
 *  pattern is stable between renders). left %, duration s, delay s, drift px. */
const EMBERS: [number, number, number, number][] = [
  [6, 15, -2, 40], [14, 19, -11, -30], [23, 13, -6, 25], [31, 17, -14, -45],
  [42, 21, -3, 35], [55, 16, -9, -25], [63, 14, -1, 50], [71, 20, -16, -35],
  [79, 15, -7, 30], [88, 18, -12, -40], [94, 13, -4, 20], [48, 22, -18, -20],
];

function HomeEmbers() {
  return (
    <div className="cc-scr-embers" aria-hidden="true">
      {EMBERS.map(([left, dur, delay, drift], i) => (
        <span
          key={i}
          className="cc-scr-ember"
          style={{
            left: `${left}%`,
            animationDuration: `${dur}s`,
            animationDelay: `${delay}s`,
            ['--drift' as string]: `${drift}px`,
            ...(i % 3 === 0 ? { width: 2, height: 2 } : null),
          }}
        />
      ))}
    </div>
  );
}

export default function SetupScreen({ onCreateLobby, onJoinLobby }: SetupScreenProps) {
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const [showHowToPlay, setShowHowToPlay] = useState(false);
  const [showTutorial, setShowTutorial] = useState(false);
  /** Join opens the game browser (open games, or join by code). */
  const [showBrowser, setShowBrowser] = useState(false);
  const [backendVersion, setBackendVersion] = useState<string | null>(null);

  // Boot gate: the whole home intro (title, diorama, buttons) waits until the
  // fonts, card art and 3D board are ready, then starts in one go as the
  // loading bar fades out. Coming back home later skips the wait.
  const [ready, setReady] = useState(() => appHasBooted());
  const [fontsReady, setFontsReady] = useState(() => appHasBooted());
  const [heroReady, setHeroReady] = useState(() => appHasBooted());
  const handleHeroReady = useCallback(() => setHeroReady(true), []);
  useEffect(() => {
    if (fontsReady) return;
    let live = true;
    void waitForFonts().then(() => { if (live) setFontsReady(true); });
    return () => { live = false; };
  }, [fontsReady]);
  useEffect(() => {
    if (ready) return;
    if (fontsReady && heroReady) {
      // Flip on the next frame so the bar's fade and the intro share a paint.
      const raf = requestAnimationFrame(() => {
        setReady(true);
        signalAppReady();
      });
      return () => cancelAnimationFrame(raf);
    }
    // Never hold the home screen hostage to a slow asset.
    const t = setTimeout(() => { setReady(true); signalAppReady(); }, 8000);
    return () => clearTimeout(t);
  }, [ready, fontsReady, heroReady]);

  // New players get the How to Play tour as soon as the home screen is up.
  useEffect(() => {
    if (!ready || tutorialSeen()) return;
    const t = setTimeout(() => setShowTutorial(true), 900);
    return () => clearTimeout(t);
  }, [ready]);
  const closeTutorial = useCallback(() => {
    setShowTutorial(false);
    try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch { /* private mode */ }
  }, []);

  useEffect(() => {
    fetch(`${BASE}/version`)
      .then(r => r.json())
      .then(d => setBackendVersion(d.version))
      .catch(() => setBackendVersion(null));
  }, []);


  return (
    <div className={`cc-scr-backdrop cc-scr-home${ready ? '' : ' is-booting'}`} aria-busy={!ready}>
      <HomeEmbers />

      {/* Title */}
      <header className="cc-scr-home-header">
        <h1 className="cc-title cc-scr-home-title">Card Clash</h1>
        <div className="cc-scr-ornament" aria-hidden="true"><i /></div>
        <div className="cc-scr-home-tagline">
          Simultaneous deck-building territory control
        </div>
      </header>

      {/* Hero animation — fills space between title and buttons */}
      <div className="cc-scr-home-hero">
        <HeroAnimation start={ready} onReady={handleHeroReady} paused={showTutorial} />
      </div>

      {/* Bottom buttons — pinned to bottom */}
      <div className="cc-scr-home-actions">
        {/* Create / Join Lobby */}
        <div className="cc-scr-home-row">
          <button
            className="cc-btn-primary cc-scr-btn-xl"
            onClick={() => onCreateLobby()}
          >
            Create
          </button>
          <button
            className="cc-btn-secondary cc-scr-btn-xl"
            onClick={() => setShowBrowser(true)}
          >
            Join
          </button>
        </div>

        {/* How to Play / Card Browser */}
        <div className="cc-scr-home-secondary">
          <button
            className="cc-btn-secondary cc-scr-btn-md"
            onClick={() => setShowTutorial(true)}
          >
            <span className="cc-scr-btn-icon" aria-hidden="true"><Icon name="passive" size={15} decorative /></span>
            How to Play
          </button>
          <button
            className="cc-btn-secondary cc-scr-btn-md"
            onClick={() => setShowCardBrowser(true)}
          >
            <span className="cc-scr-btn-icon" aria-hidden="true"><Icon name="drawPile" size={15} decorative /></span>
            Card Browser
          </button>
        </div>
      </div>

      {/* Version & copyright footer */}
      <footer className="cc-scr-home-footer">
        <a href="https://github.com/foslock/decks-and-hexes/issues" target="_blank" rel="noopener noreferrer">Provide Feedback</a>
        <span className="cc-scr-dot-sep" aria-hidden="true" />
        <span className="cc-scr-version">v{packageJson.version}{backendVersion ? ` / v${backendVersion}` : ''}</span>
        <span className="cc-scr-dot-sep is-last" aria-hidden="true" />
        <span className="cc-scr-copyright">
          &copy; 2026{' '}
          <a href="https://www.fosterlockwood.com" target="_blank" rel="noopener noreferrer">J. Foster Lockwood</a>
        </span>
      </footer>

      {showTutorial && (
        <TutorialOverlay
          onClose={closeTutorial}
          onPlay={() => { closeTutorial(); onCreateLobby(); }}
          onRules={() => setShowHowToPlay(true)}
          covered={showHowToPlay}
        />
      )}
      {showHowToPlay && (
        <HowToPlay onClose={() => setShowHowToPlay(false)} />
      )}
      {showCardBrowser && (
        <CardBrowser onClose={() => setShowCardBrowser(false)} />
      )}
      {showBrowser && (
        <LobbyBrowser onJoin={onJoinLobby} onCreate={onCreateLobby} onClose={() => setShowBrowser(false)} />
      )}
    </div>
  );
}
