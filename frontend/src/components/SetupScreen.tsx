import { useState, useEffect } from 'react';
import { BASE } from '../api/client';
import CardBrowser from './CardBrowser';
import HowToPlay from './HowToPlay';
import HeroAnimation from './HeroAnimation';
import packageJson from '../../package.json';

interface SetupScreenProps {
  onCreateLobby: () => void;
  onJoinLobby: (code: string) => Promise<void>;
}

export default function SetupScreen({ onCreateLobby, onJoinLobby }: SetupScreenProps) {
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const [showHowToPlay, setShowHowToPlay] = useState(false);
  const [showJoinDialog, setShowJoinDialog] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [backendVersion, setBackendVersion] = useState<string | null>(null);

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
    <div style={{ height: '100dvh', minWidth: 350, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      <style>{`
        .lobby-btn { transition: box-shadow 0.2s ease; box-shadow: none; }
        .lobby-btn:hover { box-shadow: 0 0 16px rgba(74, 158, 255, 0.35); }
        .lobby-btn-green:hover { box-shadow: 0 0 16px rgba(58, 142, 94, 0.5); }
        @keyframes title-glow {
          0%, 100% { text-shadow: 0 0 20px rgba(74, 158, 255, 0.3), 0 0 40px rgba(74, 120, 255, 0.15); }
          50% { text-shadow: 0 0 30px rgba(74, 158, 255, 0.5), 0 0 60px rgba(74, 120, 255, 0.25), 0 0 80px rgba(74, 100, 255, 0.1); }
        }
      `}</style>
      {/* Title */}
      <div style={{ textAlign: 'center', marginTop: 60, flexShrink: 0, padding: '0 24px' }}>
        <h1 style={{ fontSize: 52, fontWeight: 900, marginBottom: 8, letterSpacing: 4, fontFamily: "'Cinzel', serif", textTransform: 'uppercase', animation: 'title-glow 3s ease-in-out infinite' }}>
          Card Clash
        </h1>
        <div style={{ fontSize: 14, color: '#666' }}>
          Simultaneous deck-building territory control
        </div>
      </div>

      {/* Hero animation — fills space between title and buttons */}
      <div style={{ flex: 1, minHeight: 350, minWidth: 350, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px 0' }}>
        <HeroAnimation />
      </div>

      {/* Bottom buttons — pinned to bottom */}
      <div style={{ flexShrink: 0, maxWidth: 480, width: '100%', margin: '0 auto', padding: '0 24px', boxSizing: 'border-box' }}>
      {/* Create / Join Lobby */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
        <button
          className="lobby-btn lobby-btn-green"
          onClick={() => onCreateLobby()}
          style={{
            padding: 16,
            background: '#2a6e3e', border: '1px solid #3a8e5e',
            borderRadius: 8, color: '#fff', fontSize: 22,
            fontWeight: 'bold', cursor: 'pointer',
          }}
        >
          Create
        </button>
        {!showJoinDialog ? (
          <button
            className="lobby-btn"
            onClick={() => setShowJoinDialog(true)}
            style={{
              padding: 16,
              background: '#2a4a6e', border: '1px solid #3a6a8e',
              borderRadius: 8, color: '#fff', fontSize: 22,
              fontWeight: 'bold', cursor: 'pointer',
            }}
          >
            Join
          </button>
        ) : (
          <div style={{
            display: 'flex', gap: 4, alignItems: 'center',
            background: '#2a4a6e', border: '1px solid #3a6a8e',
            borderRadius: 8, padding: '4px 8px',
            minWidth: 0, overflow: 'hidden',
          }}>
            <input
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
              style={{
                flex: 1, minWidth: 0, padding: '10px', textAlign: 'center',
                background: '#1a2a3e', border: '1px solid #555',
                borderRadius: 4, color: '#fff', fontSize: 18,
                fontFamily: 'monospace', letterSpacing: 4,
              }}
            />
            <button
              onClick={attemptJoin}
              disabled={joinCode.length === 0}
              style={{
                flexShrink: 0, padding: '10px 14px',
                background: joinCode.length > 0 ? '#4a9eff' : '#333',
                border: 'none', borderRadius: 4, color: '#fff',
                fontSize: 14, fontWeight: 'bold',
                cursor: joinCode.length > 0 ? 'pointer' : 'not-allowed',
              }}
            >
              Join
            </button>
            <button
              onClick={() => { setShowJoinDialog(false); setJoinCode(''); setJoinError(null); }}
              style={{
                flexShrink: 0, padding: '10px', background: 'transparent',
                border: 'none', color: '#888', cursor: 'pointer', fontSize: 14,
              }}
            >
              &#10005;
            </button>
          </div>
        )}
      </div>
      {joinError && (
        <div style={{
          fontSize: 12, color: '#ff6666', textAlign: 'center',
          padding: '6px 12px', marginBottom: 8,
          background: '#2a1a1a', border: '1px solid #552222',
          borderRadius: 6,
        }}>
          {joinError}
        </div>
      )}

      {/* How to Play / Card Browser */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <button
          onClick={() => setShowHowToPlay(true)}
          style={{
            flex: 1, padding: 14,
            background: '#2a2a3e', border: '1px solid #555',
            borderRadius: 8, color: '#fff', fontSize: 14,
            fontWeight: 'bold', cursor: 'pointer',
          }}
        >
          How to Play
        </button>
        <button
          onClick={() => setShowCardBrowser(true)}
          style={{
            flex: 1, padding: 14,
            background: '#2a2a3e', border: '1px solid #555',
            borderRadius: 8, color: '#fff', fontSize: 14,
            fontWeight: 'bold', cursor: 'pointer',
          }}
        >
          Card Browser
        </button>
      </div>
      </div>

      {/* Version & copyright footer */}
      <div style={{
        flexShrink: 0, padding: '12px 0 16px',
        fontSize: 10, color: '#444', textAlign: 'center',
      }}>
        <a href="https://github.com/foslock/decks-and-hexes/issues" target="_blank" rel="noopener noreferrer" style={{ color: '#667', textDecoration: 'none' }}>Provide Feedback</a>
        <span style={{ margin: '0 6px' }}>&middot;</span>
        <span>v{packageJson.version}{backendVersion ? ` / v${backendVersion}` : ''}</span>
        <span style={{ margin: '0 6px' }}>&middot;</span>
        <span>&copy; 2026 J. Foster Lockwood</span>
      </div>

      {showHowToPlay && (
        <HowToPlay onClose={() => setShowHowToPlay(false)} />
      )}
      {showCardBrowser && (
        <CardBrowser onClose={() => setShowCardBrowser(false)} />
      )}
    </div>
  );
}
