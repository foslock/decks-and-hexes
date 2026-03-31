import { useEffect, useRef } from 'react';

interface GameLogProps {
  entries: string[];
}

export default function GameLog({ entries }: GameLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [entries.length]);

  return (
    <div
      style={{
        maxHeight: 200,
        overflowY: 'auto',
        background: '#111',
        borderRadius: 6,
        padding: 8,
        fontSize: 12,
        fontFamily: 'monospace',
        color: '#aaa',
      }}
    >
      {entries.map((entry, i) => (
        <div key={i} style={{ marginBottom: 2 }}>
          {entry.startsWith('===') ? (
            <strong style={{ color: '#4a9eff' }}>{entry}</strong>
          ) : (
            entry
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
