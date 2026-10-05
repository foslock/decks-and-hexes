import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: string;
  /** Delay in ms before showing. Default 0 (instant). */
  delay?: number;
  /** Position relative to trigger. Default 'above'. */
  position?: 'above' | 'below';
  /** Extra styles for the wrapper div around children. */
  wrapperStyle?: React.CSSProperties;
  children: ReactNode;
}

export default function Tooltip({ content, delay = 0, position: placement = 'above', wrapperStyle, children }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const show = useCallback((e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCoords({
      x: rect.left + rect.width / 2,
      y: placement === 'below' ? rect.bottom : rect.top,
    });

    if (delay > 0) {
      timerRef.current = setTimeout(() => setVisible(true), delay);
    } else {
      setVisible(true);
    }
  }, [delay, placement]);

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
        style={{ display: 'inline-block', ...wrapperStyle }}
      >
        {children}
      </div>
      {visible && createPortal(
        <div
          style={{
            position: 'fixed',
            left: coords.x,
            ...(placement === 'below'
              ? { top: coords.y + 8, transform: 'translateX(-50%)' }
              : { top: coords.y - 8, transform: 'translate(-50%, -100%)' }),
            background: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0) 50%), rgba(14, 14, 32, 0.97)',
            border: '1px solid rgba(232, 196, 106, 0.28)',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 12,
            lineHeight: 1.45,
            color: '#e4e2ef',
            maxWidth: 260,
            zIndex: 60000,
            pointerEvents: 'none',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 6px 18px rgba(0,0,0,0.55)',
            whiteSpace: 'normal',
            animation: 'cc-tooltip-in 140ms ease-out both',
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
 * A button that asks for a second click when `needsConfirm` is true: the
 * first click arms it — it turns into a "Confirm" button with its warning
 * showing — and a second click goes ahead. Clicking anywhere else, Escape, or
 * `needsConfirm` going false puts it back. Otherwise it's a plain button.
 */
export interface ConfirmButtonHandle {
  /** What a click does (the keyboard's Enter): arm, or go ahead. */
  press: () => void;
}

export const ConfirmButton = forwardRef<ConfirmButtonHandle, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  onConfirm: () => void;
  needsConfirm: boolean;
  warning: string;
  tooltip?: string;
  /** The armed button's label and look. */
  confirmLabel?: ReactNode;
  armedStyle?: React.CSSProperties;
  armedClassName?: string;
}>(function ConfirmButton({
  children,
  onConfirm,
  needsConfirm,
  warning,
  tooltip,
  confirmLabel = 'Confirm',
  armedStyle,
  armedClassName,
  className,
  style,
  ...buttonProps
}, ref) {
  const [armed, setArmed] = useState(false);
  const [hover, setHover] = useState(false);
  const [showTip, setShowTip] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const tipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPosition({ x: rect.right, y: rect.top });
  };

  const press = useCallback(() => {
    if (!needsConfirm) {
      onConfirmRef.current();
      return;
    }
    if (!armed) {
      place();
      setArmed(true);
      return;
    }
    setArmed(false);
    onConfirmRef.current();
  }, [needsConfirm, armed]);

  useImperativeHandle(ref, () => ({ press }), [press]);

  // Nothing left to confirm: back to the plain button.
  useEffect(() => {
    if (!needsConfirm) setArmed(false);
  }, [needsConfirm]);

  // Armed: a click anywhere else (or Escape) stands it down.
  useEffect(() => {
    if (!armed) return;
    const onDown = (e: PointerEvent) => {
      if (buttonRef.current && e.target instanceof Node && buttonRef.current.contains(e.target)) return;
      setArmed(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setArmed(false); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [armed]);

  useEffect(() => () => { if (tipTimerRef.current) clearTimeout(tipTimerRef.current); }, []);

  const handleEnter = () => {
    setHover(true);
    place();
    // The plain button's tooltip waits a moment; the warning shows at once.
    if (!needsConfirm && tooltip) tipTimerRef.current = setTimeout(() => setShowTip(true), 1000);
  };
  const handleLeave = (e: React.PointerEvent<HTMLButtonElement>) => {
    setHover(false);
    setShowTip(false);
    if (tipTimerRef.current) clearTimeout(tipTimerRef.current);
    buttonProps.onPointerLeave?.(e);
  };

  const bubble = armed || (hover && needsConfirm) ? warning : showTip ? tooltip : null;

  return (
    <>
      <button
        {...buttonProps}
        ref={buttonRef}
        onClick={press}
        onPointerEnter={handleEnter}
        onPointerLeave={handleLeave}
        className={armed && armedClassName ? armedClassName : className}
        style={{ ...style, ...(armed ? armedStyle : null), position: 'relative', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        {armed ? confirmLabel : children}
      </button>
      {bubble && createPortal(
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
          {bubble}
          {needsConfirm && (
            <span style={{ fontSize: 10, color: '#aa8833', marginLeft: 6 }}>
              {armed ? '— Click Confirm to go ahead' : '— Asks you to confirm'}
            </span>
          )}
        </div>,
        document.body
      )}
    </>
  );
});
