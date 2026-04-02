import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnimationMode } from './SettingsContext';

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
            whiteSpace: 'normal',
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
 * On click/tap it shows a warning tooltip. The user must press and hold for
 * `holdDuration` ms (default 3000) to actually trigger `onConfirm`.
 * A progress bar fills the button during the hold.
 * When `requireHold` is false, it acts as a normal click button.
 */
export function HoldToSubmitButton({
  children,
  onConfirm,
  requireHold,
  holdDuration = 1000,
  warning,
  tooltip,
  style,
  ...buttonProps
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onConfirm: () => void;
  requireHold: boolean;
  holdDuration?: number;
  warning: string;
  tooltip?: string;
}) {
  const animMode = useAnimationMode();
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showWarning, setShowWarning] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const startTimeRef = useRef<number>(0);
  const rafRef = useRef<number>(0);
  const holdingRef = useRef(false);
  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedRef = useRef(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const clearWarningTimer = useCallback(() => {
    if (warningTimerRef.current) {
      clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
  }, []);

  const stopHold = useCallback(() => {
    holdingRef.current = false;
    setHolding(false);
    setProgress(0);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  }, []);

  const tick = useCallback(() => {
    if (!holdingRef.current) return;
    const elapsed = Date.now() - startTimeRef.current;
    const p = Math.min(elapsed / holdDuration, 1);
    setProgress(p);
    if (p >= 1) {
      confirmedRef.current = true;
      holdingRef.current = false;
      setHolding(false);
      setProgress(0);
      rafRef.current = 0;
      onConfirmRef.current();
    } else {
      rafRef.current = requestAnimationFrame(tick);
    }
  }, [holdDuration]);

  const startHold = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!requireHold) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setPosition({ x: rect.left + rect.width / 2, y: rect.top });
    setShowWarning(true);
    clearWarningTimer();
    confirmedRef.current = false;
    startTimeRef.current = Date.now();
    holdingRef.current = true;
    setHolding(true);
    setProgress(0);
    rafRef.current = requestAnimationFrame(tick);
  }, [requireHold, tick, clearWarningTimer]);

  const endHold = useCallback(() => {
    stopHold();
  }, [stopHold]);

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
    setPosition({ x: rect.left + rect.width / 2, y: rect.top });
    if (requireHold) {
      // Show warning immediately on hover when hold is required
      setShowWarning(true);
    } else if (tooltip) {
      warningTimerRef.current = setTimeout(() => setShowWarning(true), 1000);
    }
  }, [requireHold, tooltip]);

  const handleLeave = useCallback(() => {
    if (!holding) {
      clearWarningTimer();
      setShowWarning(false);
    }
  }, [holding, clearWarningTimer]);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearWarningTimer();
    };
  }, [clearWarningTimer]);

  const progressTransition = animMode === 'normal' ? 'width 0.1s linear' : 'none';

  return (
    <>
      <button
        {...buttonProps}
        onClick={handleClick}
        onPointerDown={startHold}
        onPointerUp={endHold}
        onPointerLeave={(e) => { endHold(); handleLeave(); buttonProps.onPointerLeave?.(e); }}
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
        {requireHold && (
          <div style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            background: 'rgba(255,255,255,0.25)',
            width: `${progress * 100}%`,
            transition: progressTransition,
            pointerEvents: 'none',
            borderRadius: 'inherit',
          }} />
        )}
        <span style={{ position: 'relative' }}>{children}</span>
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
            maxWidth: 240,
            zIndex: 20000,
            pointerEvents: 'none',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            whiteSpace: 'normal',
            textAlign: 'center',
          }}
        >
          {requireHold ? warning : (tooltip || '')}
          {requireHold && (
            <div style={{ fontSize: 10, color: '#aa8833', marginTop: 3 }}>
              Hold button for 1 second to confirm
            </div>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
