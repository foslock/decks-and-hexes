import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

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
  const triggerRef = useRef<HTMLDivElement>(null);

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
      <div
        ref={triggerRef}
        onPointerEnter={show}
        onPointerLeave={hide}
        style={{ display: 'inline-block' }}
      >
        {children}
      </div>
      {visible && createPortal(
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
        </div>,
        document.body
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
  tooltipDelay = 1000,
  ...buttonProps
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: string; tooltipDelay?: number }) {
  const [showWarning, setShowWarning] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPosition({ x: rect.left + rect.width / 2, y: rect.top });
    if (tooltipDelay > 0) {
      timerRef.current = setTimeout(() => setShowWarning(true), tooltipDelay);
    } else {
      setShowWarning(true);
    }
  }, [tooltipDelay]);

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
      {showWarning && createPortal(
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
            whiteSpace: 'pre-line',
            textAlign: 'center',
          }}
        >
          {message}
        </div>,
        document.body
      )}
    </>
  );
}

/**
 * A button that requires hold-to-confirm when `requireHold` is true.
 * The user must press and hold; a white outline grows around the button over
 * `animDuration` ms (driven purely by CSS transition), then after a short
 * buffer the action confirms at `holdDuration` ms total.
 * When `requireHold` is false, it acts as a normal click button.
 */
export interface HoldToSubmitHandle {
  startKeyboardHold: () => void;
  stopKeyboardHold: () => void;
}

export const HoldToSubmitButton = forwardRef<HoldToSubmitHandle, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onConfirm: () => void;
  requireHold: boolean;
  holdDuration?: number;
  animDuration?: number;
  warning: string;
  tooltip?: string;
}>(function HoldToSubmitButton({
  children,
  onConfirm,
  requireHold,
  holdDuration = 1200,
  animDuration = 1000,
  warning,
  tooltip,
  style,
  ...buttonProps
}, ref) {
  // 'idle' → 'holding' (outline animates via CSS) → 'filled' (outline complete, waiting for buffer) → 'idle'
  const [phase, setPhase] = useState<'idle' | 'holding' | 'filled'>('idle');
  const [showWarning, setShowWarning] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedRef = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const clearTimers = useCallback(() => {
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    if (confirmTimerRef.current) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const holdStartTimeRef = useRef<number>(0);
  const isKeyboardHoldRef = useRef(false);

  const stopHold = useCallback(() => {
    clearTimers();
    setPhase('idle');
    isKeyboardHoldRef.current = false;
  }, [clearTimers]);

  const beginHold = useCallback((posX?: number, posY?: number) => {
    if (!requireHold) return;
    if (posX !== undefined && posY !== undefined) {
      setPosition({ x: posX, y: posY });
    } else if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPosition({ x: rect.right, y: rect.top });
    }
    setShowWarning(true);
    clearTimers();
    confirmedRef.current = false;
    holdStartTimeRef.current = Date.now();

    setPhase('holding');
    confirmTimerRef.current = setTimeout(() => {
      confirmedRef.current = true;
      setPhase('idle');
      isKeyboardHoldRef.current = false;
      onConfirmRef.current();
    }, holdDuration);
  }, [requireHold, holdDuration, clearTimers]);

  const startHold = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!requireHold) return;
    const rect = e.currentTarget.getBoundingClientRect();
    beginHold(rect.right, rect.top);
  }, [requireHold, beginHold]);

  useImperativeHandle(ref, () => ({
    startKeyboardHold: () => {
      isKeyboardHoldRef.current = true;
      beginHold();
    },
    stopKeyboardHold: () => {
      if (!isKeyboardHoldRef.current) return;
      // If held long enough (past animation), confirm immediately instead of cancelling
      const elapsed = Date.now() - holdStartTimeRef.current;
      if (elapsed >= animDuration && !confirmedRef.current) {
        confirmedRef.current = true;
        clearTimers();
        setPhase('idle');
        isKeyboardHoldRef.current = false;
        onConfirmRef.current();
      } else {
        stopHold();
      }
    },
  }), [beginHold, stopHold, animDuration, clearTimers]);

  const handleClick = useCallback(() => {
    if (!requireHold) {
      onConfirm();
      return;
    }
    if (confirmedRef.current) {
      confirmedRef.current = false;
    }
  }, [requireHold, onConfirm]);

  const handleEnter = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setPosition({ x: rect.right, y: rect.top });
    if (requireHold) {
      setShowWarning(true);
    } else if (tooltip) {
      warningTimerRef.current = setTimeout(() => setShowWarning(true), 1000);
    }
  }, [requireHold, tooltip]);

  const handleLeave = useCallback(() => {
    if (phase === 'idle') {
      clearTimers();
      setShowWarning(false);
    }
  }, [phase, clearTimers]);

  useEffect(() => {
    return () => { clearTimers(); };
  }, [clearTimers]);

  // The outline is fully clipped when idle, fully revealed when holding/filled.
  // CSS transition on clip-path handles the smooth left-to-right reveal.
  const outlineRevealed = phase === 'holding' || phase === 'filled';

  return (
    <>
      <button
        {...buttonProps}
        ref={buttonRef}
        onClick={handleClick}
        onPointerDown={startHold}
        onPointerUp={stopHold}
        onPointerLeave={(e) => { stopHold(); handleLeave(); buttonProps.onPointerLeave?.(e); }}
        onPointerEnter={handleEnter}
        style={{
          ...style,
          position: 'relative',
          overflow: 'hidden',
          userSelect: 'none',
          WebkitUserSelect: 'none',
          touchAction: 'none',
        }}
      >
        {/* White outline that reveals left-to-right via CSS transition */}
        {requireHold && (
          <div style={{
            position: 'absolute',
            inset: 0,
            border: '2px solid rgba(255,255,255,0.85)',
            borderRadius: 'inherit',
            pointerEvents: 'none',
            clipPath: outlineRevealed ? 'inset(0 0% 0 0)' : 'inset(0 100% 0 0)',
            transition: outlineRevealed
              ? `clip-path ${animDuration}ms linear`
              : 'none',
          }} />
        )}
        <span style={{ position: 'relative' }}>{children}</span>
      </button>
      {showWarning && createPortal(
        <div
          style={{
            position: 'fixed',
            right: `calc(100vw - ${position.x}px)`,
            top: position.y - 6,
            transform: 'translateY(-100%)',
            background: '#332200',
            border: '1px solid #aa7722',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            lineHeight: 1.3,
            color: '#ffcc66',
            width: 200,
            zIndex: 20000,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            whiteSpace: 'normal',
            textAlign: 'left',
          }}
        >
          {requireHold ? warning : (tooltip || '')}
          {requireHold && (
            <span style={{ fontSize: 10, color: '#aa8833', marginLeft: 6 }}>
              — Hold to confirm
            </span>
          )}
        </div>,
        document.body
      )}
    </>
  );
});
