import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';

interface TooltipProps {
  content: string;
  /** Delay in ms before showing. Default 0 (instant). */
  delay?: number;
  children: ReactNode;
}

export default function Tooltip({ content, delay = 0, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const show = useCallback((e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPosition({ x: rect.left + rect.width / 2, y: rect.top });

    if (delay > 0) {
      timerRef.current = setTimeout(() => setVisible(true), delay);
    } else {
      setVisible(true);
    }
  }, [delay]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        onPointerEnter={show}
        onPointerLeave={hide}
        style={{ display: 'inline' }}
      >
        {children}
      </span>
      {visible && (
        <div
          style={{
            position: 'fixed',
            left: position.x,
            top: position.y - 8,
            transform: 'translate(-50%, -100%)',
            background: '#111122',
            border: '1px solid #555',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: 1.4,
            color: '#ddd',
            maxWidth: 260,
            zIndex: 20000,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            whiteSpace: 'normal',
          }}
        >
          {content}
        </div>
      )}
    </>
  );
}

/**
 * Wraps a button that performs an irreversible action.
 * Shows a "this action cannot be undone" tooltip after 1 second.
 */
export function IrreversibleButton({
  children,
  tooltip,
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: string }) {
  const [showWarning, setShowWarning] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPosition({ x: rect.left + rect.width / 2, y: rect.top });
    timerRef.current = setTimeout(() => setShowWarning(true), 1000);
  }, []);

  const handleLeave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setShowWarning(false);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const message = tooltip || 'This action cannot be undone.';

  return (
    <>
      <button
        {...buttonProps}
        onPointerEnter={handleEnter}
        onPointerLeave={handleLeave}
      >
        {children}
      </button>
      {showWarning && (
        <div
          style={{
            position: 'fixed',
            left: position.x,
            top: position.y - 8,
            transform: 'translate(-50%, -100%)',
            background: '#332200',
            border: '1px solid #aa7722',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            color: '#ffcc66',
            maxWidth: 220,
            zIndex: 20000,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            whiteSpace: 'normal',
            textAlign: 'center',
          }}
        >
          {message}
        </div>
      )}
    </>
  );
}
