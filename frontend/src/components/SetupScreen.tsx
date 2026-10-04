import { useState, useEffect, useCallback } from 'react';
import { BASE } from '../api/client';
import CardBrowser from './CardBrowser';
import Icon from '../icons/Icon';
import HowToPlay from './HowToPlay';
import HeroAnimation from './HeroAnimation';
import LobbyBrowser from './LobbyBrowser';
import packageJson from '../../package.json';
import { appHasBooted, signalAppReady, waitForFonts } from '../utils/appReady';

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
  /** Join → choose (enter a code or browse) → code entry. */
  const [joinMode, setJoinMode] = useState<'closed' | 'choose' | 'code'>('closed');
  const showJoinDialog = joinMode === 'code';
  const setShowJoinDialog = (open: boolean) => setJoinMode(open ? 'code' : 'closed');
  const [showBrowser, setShowBrowser] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
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

  useEffect(() => {
    fetch(`${BASE}/version`)
      .then(r => r.json())
      .then(d => setBackendVersion(d.version))
      .catch(() => setBackendVersion(null));
  }, []);


  const attemptJoin = async () => {
    if (joinCode.length === 0) return;
    setJoinError(null);
    try {
      await onJoinLobby(joinCode);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/full/i.test(msg)) {
        setJoinError('Lobby is full and cannot be joined.');
      } else if (/not found/i.test(msg) || /invalid/i.test(msg) || /404/i.test(msg)) {
        setJoinError('Lobby not found. Check the code and try again.');
      } else {
        setJoinError(msg);
      }
    }
  };

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
        <HeroAnimation start={ready} onReady={handleHeroReady} />
      </div>

      {/* Bottom buttons — pinned to bottom */}
      <div className="cc-scr-home-actions">
        {/* Create / Join Lobby */}
        <div className="cc-scr-home-row">
          {joinMode === 'choose' ? (
            // Join: enter a code, or browse public games.
            <div className="cc-scr-join-choice">
              <button className="cc-btn-secondary cc-scr-btn-xl" onClick={() => setJoinMode('code')} autoFocus>
                Enter Code
              </button>
              <button className="cc-btn-primary cc-scr-btn-xl" onClick={() => setShowBrowser(true)}>
                Browse Games
              </button>
              <button
                className="cc-scr-join-cancel"
                onClick={() => setJoinMode('closed')}
                aria-label="Cancel"
              >
                <Icon name="close" size={12} decorative />
              </button>
            </div>
          ) : (
          <>
          <button
            className="cc-btn-primary cc-scr-btn-xl"
            onClick={() => onCreateLobby()}
          >
            Create
          </button>
          {!showJoinDialog ? (
            <button
              className="cc-btn-secondary cc-scr-btn-xl"
              onClick={() => { setJoinMode('choose'); setJoinError(null); }}
            >
              Join
            </button>
          ) : (
            <div className="cc-scr-join-box">
              <input
                className="cc-scr-join-input"
                value={joinCode}
                onChange={(e) => { setJoinCode(e.target.value.toUpperCase().slice(0, 4)); setJoinError(null); }}
                placeholder="CODE"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    attemptJoin();
                  } else if (e.key === 'Escape') {
                    setShowJoinDialog(false);
                    setJoinCode('');
                    setJoinError(null);
                  }
                }}
              />
              <button
                className="cc-btn-primary cc-scr-join-go"
                onClick={attemptJoin}
                disabled={joinCode.length === 0}
              >
                Join
              </button>
              <button
                className="cc-scr-join-cancel"
                onClick={() => { setShowJoinDialog(false); setJoinCode(''); setJoinError(null); }}
                aria-label="Cancel"
              >
                <Icon name="close" size={12} decorative />
              </button>
            </div>
          )}
          </>
          )}
        </div>
        {joinError && (
          <div className="cc-scr-error" style={{ marginBottom: 10 }}>
            {joinError}
          </div>
        )}

        {/* How to Play / Card Browser */}
        <div className="cc-scr-home-secondary">
          <button
            className="cc-btn-secondary cc-scr-btn-md"
            onClick={() => setShowHowToPlay(true)}
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

      {showHowToPlay && (
        <HowToPlay onClose={() => setShowHowToPlay(false)} />
      )}
      {showCardBrowser && (
        <CardBrowser onClose={() => setShowCardBrowser(false)} />
      )}
      {showBrowser && (
        <LobbyBrowser onJoin={onJoinLobby} onClose={() => setShowBrowser(false)} />
      )}
    </div>
  );
}
