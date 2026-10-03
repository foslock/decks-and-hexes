import { useEffect, useRef } from 'react';

interface GameLogProps {
  entries: string[];
}

export default function GameLog({ entries }: GameLogProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bottomRef.current && typeof bottomRef.current.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries.length]);

  return (
    <div className="cc-ov-inset cc-ov-minilog">
      {entries.map((entry, i) => (
        <div key={i} className="cc-ov-minilog-row">
          {entry.startsWith('===') ? (
            <strong>{entry}</strong>
          ) : (
            entry
          )}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
