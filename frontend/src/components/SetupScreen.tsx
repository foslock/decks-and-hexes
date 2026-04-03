import { useState } from 'react';
import { useSettings, type AnimationMode } from './SettingsContext';
import CardBrowser from './CardBrowser';

interface SetupScreenProps {
  onStart: (config: {
    gridSize: string;
    players: { id: string; name: string; archetype: string }[];
    testMode?: boolean;
    speed?: string;
  }) => void;
}

const ARCHETYPES = [
  { id: 'vanguard', name: 'Vanguard', icon: '⚔️', desc: 'Fast & Strong — 4 slots, 4 hand' },
  { id: 'swarm', name: 'Swarm', icon: '🐝', desc: 'Fast & Cheap — 4 slots, 5 hand' },
  { id: 'fortress', name: 'Fortress', icon: '🏰', desc: 'Cheap & Strong — 3 slots, 3 hand' },
];

const GRID_SIZES = [
  { id: 'small', name: 'Small (61 tiles)', players: '2-3', tiles: 61, radius: 4 },
  { id: 'medium', name: 'Medium (91 tiles)', players: '3-4', tiles: 91, radius: 5 },
  { id: 'large', name: 'Large (127 tiles)', players: '4-6', tiles: 127, radius: 6 },
];

const SPEEDS = [
  { id: 'fast', name: 'Fast', mult: 0.66 },
  { id: 'normal', name: 'Normal', mult: 1.0 },
  { id: 'slow', name: 'Slow', mult: 1.33 },
];

function computeVpTarget(gridId: string, playerCount: number, speedId: string): number {
  const grid = GRID_SIZES.find(g => g.id === gridId) || GRID_SIZES[0];
  const speed = SPEEDS.find(s => s.id === speedId) || SPEEDS[1];
  const tilesPerVp = grid.radius - 1; // Small=3, Medium=4, Large=5
  const divisor = Math.max(1, Math.floor(tilesPerVp * playerCount * 0.75));
  const base = Math.floor(grid.tiles / divisor);
  return Math.max(3, Math.round(base * speed.mult));
}

export default function SetupScreen({ onStart }: SetupScreenProps) {
  const { settings, setAnimationMode, setTooltips } = useSettings();
  const [gridSize, setGridSize] = useState('small');
  const [playerCount, setPlayerCount] = useState(3);
  const [players, setPlayers] = useState([
    { name: 'Player 1', archetype: 'vanguard' },
    { name: 'Player 2', archetype: 'swarm' },
    { name: 'Player 3', archetype: 'fortress' },
  ]);
  const [testMode, setTestMode] = useState(false);
  const [speed, setSpeed] = useState('normal');
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const vpTarget = computeVpTarget(gridSize, playerCount, speed);

  const updatePlayerCount = (count: number) => {
    setPlayerCount(count);
    const newPlayers = [];
    for (let i = 0; i < count; i++) {
      newPlayers.push(
        players[i] || {
          name: `Player ${i + 1}`,
          archetype: ARCHETYPES[i % ARCHETYPES.length].id,
        },
      );
    }
    setPlayers(newPlayers);
  };

  const updatePlayer = (index: number, field: string, value: string) => {
    const updated = [...players];
    updated[index] = { ...updated[index], [field]: value };
    setPlayers(updated);
  };

  const handleStart = () => {
    onStart({
      gridSize,
      players: players.map((p, i) => ({
        id: `player_${i}`,
        name: p.name,
        archetype: p.archetype,
      })),
      testMode: testMode || undefined,
      speed,
    });
  };

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: 24 }}>
      <h1 style={{ textAlign: 'center', marginBottom: 32 }}>
        HexDraft
      </h1>

      <div style={{ marginBottom: 24 }}>
        <h3>Grid Size</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {GRID_SIZES.map((size) => (
            <button
              key={size.id}
              onClick={() => setGridSize(size.id)}
              style={{
                flex: 1,
                padding: '12px 8px',
                background: gridSize === size.id ? '#3a3a6e' : '#2a2a3e',
                border: gridSize === size.id ? '2px solid #4a9eff' : '1px solid #444',
                borderRadius: 8,
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 'bold' }}>{size.name}</div>
              <div style={{ fontSize: 12, color: '#aaa' }}>{size.players} players</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h3>Game Speed <span style={{ fontSize: 13, fontWeight: 'normal', color: '#aaa', marginLeft: 8 }}>VP Target: {vpTarget}</span></h3>
        <div style={{ display: 'flex', gap: 8 }}>
          {SPEEDS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSpeed(s.id)}
              style={{
                flex: 1,
                padding: '10px 8px',
                background: speed === s.id ? '#3a3a6e' : '#2a2a3e',
                border: speed === s.id ? '2px solid #4a9eff' : '1px solid #444',
                borderRadius: 8,
                color: '#fff',
                cursor: 'pointer',
                fontWeight: speed === s.id ? 'bold' : 'normal',
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h3>
          Players{' '}
          <span style={{ display: 'inline-flex', gap: 4, marginLeft: 8 }}>
            {[2, 3, 4, 5, 6].map((n) => (
              <button
                key={n}
                onClick={() => updatePlayerCount(n)}
                style={{
                  width: 28,
                  height: 28,
                  background: playerCount === n ? '#4a9eff' : '#2a2a3e',
                  border: '1px solid #555',
                  borderRadius: 4,
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                {n}
              </button>
            ))}
          </span>
        </h3>

        {players.map((player, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 8,
              marginBottom: 8,
              alignItems: 'center',
            }}
          >
            <input
              value={player.name}
              onChange={(e) => updatePlayer(i, 'name', e.target.value)}
              style={{
                flex: 1,
                padding: '8px 12px',
                background: '#2a2a3e',
                border: '1px solid #444',
                borderRadius: 6,
                color: '#fff',
                fontSize: 14,
              }}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              {ARCHETYPES.map((arch) => (
                <button
                  key={arch.id}
                  onClick={() => updatePlayer(i, 'archetype', arch.id)}
                  title={arch.desc}
                  style={{
                    padding: '6px 10px',
                    background: player.archetype === arch.id ? '#3a3a6e' : '#2a2a3e',
                    border: player.archetype === arch.id ? '2px solid #4a9eff' : '1px solid #444',
                    borderRadius: 6,
                    color: '#fff',
                    cursor: 'pointer',
                    fontSize: 16,
                  }}
                >
                  {arch.icon}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Test Mode toggle */}
      <label style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 0',
        cursor: 'pointer',
        fontSize: 13,
        color: testMode ? '#ffaa4a' : '#666',
      }}>
        <input
          type="checkbox"
          checked={testMode}
          onChange={(e) => setTestMode(e.target.checked)}
          style={{ accentColor: '#ffaa4a' }}
        />
        Test Mode
        {testMode && <span style={{ fontSize: 11, color: '#888' }}>— free cards, unlimited actions, stat editing</span>}
      </label>

      {/* Settings */}
      <div style={{ marginBottom: 24 }}>
        <h3>Settings</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#aaa', minWidth: 90 }}>Animations:</span>
            {(['normal', 'simplified', 'off'] as AnimationMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setAnimationMode(mode)}
                style={{
                  padding: '4px 12px',
                  fontSize: 12,
                  background: settings.animationMode === mode ? '#4a9eff' : '#2a2a3e',
                  border: '1px solid #555',
                  borderRadius: 4,
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {mode === 'normal' ? 'Normal' : mode === 'simplified' ? 'Simplified' : 'Off'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, color: '#aaa', minWidth: 90 }}>Tooltips:</span>
            {([true, false] as const).map((on) => (
              <button
                key={String(on)}
                onClick={() => setTooltips(on)}
                style={{
                  padding: '4px 12px',
                  fontSize: 12,
                  background: settings.tooltips === on ? '#4a9eff' : '#2a2a3e',
                  border: '1px solid #555',
                  borderRadius: 4,
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                {on ? 'On' : 'Off'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 0 }}>
        <button
          onClick={() => setShowCardBrowser(true)}
          style={{
            flex: 1,
            padding: 16,
            background: '#2a2a3e',
            border: '1px solid #555',
            borderRadius: 8,
            color: '#fff',
            fontSize: 15,
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          Card Browser
        </button>
        <button
          onClick={handleStart}
          style={{
            flex: 2,
            padding: 16,
            background: testMode ? '#ffaa4a' : '#4a9eff',
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: 18,
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          {testMode ? 'Start Test Game' : 'Start Game'}
        </button>
      </div>

      {showCardBrowser && (
        <CardBrowser onClose={() => setShowCardBrowser(false)} />
      )}
    </div>
  );
}
