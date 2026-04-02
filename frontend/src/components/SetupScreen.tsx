import { useState } from 'react';

interface SetupScreenProps {
  onStart: (config: {
    gridSize: string;
    players: { id: string; name: string; archetype: string }[];
    testMode?: boolean;
  }) => void;
}

const ARCHETYPES = [
  { id: 'vanguard', name: 'Vanguard', icon: '⚔️', desc: 'Fast & Strong — 4 slots, 4 hand' },
  { id: 'swarm', name: 'Swarm', icon: '🐝', desc: 'Fast & Cheap — 4 slots, 5 hand' },
  { id: 'fortress', name: 'Fortress', icon: '🏰', desc: 'Cheap & Strong — 3 slots, 3 hand' },
];

const GRID_SIZES = [
  { id: 'small', name: 'Small (37 tiles)', players: '2-3' },
  { id: 'medium', name: 'Medium (61 tiles)', players: '3-4' },
  { id: 'large', name: 'Large (91 tiles)', players: '4-6' },
];

export default function SetupScreen({ onStart }: SetupScreenProps) {
  const [gridSize, setGridSize] = useState('small');
  const [playerCount, setPlayerCount] = useState(2);
  const [players, setPlayers] = useState([
    { name: 'Player 1', archetype: 'vanguard' },
    { name: 'Player 2', archetype: 'swarm' },
  ]);
  const [testMode, setTestMode] = useState(false);

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

      <button
        onClick={handleStart}
        style={{
          width: '100%',
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
  );
}
