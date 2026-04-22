import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '../types/game';
import CardFull, { CARD_FULL_WIDTH } from './CardFull';

/** Width of the hover preview after scaling (CARD_FULL_WIDTH * scale). */
const PREVIEW_SCALE = 0.8;
const PREVIEW_GAP = 10;

interface CardNameRefProps {
  /** Matched text from the description (preserves the original casing). */
  text: string;
  /** The card the text refers to. */
  card: Card;
}

/**
 * Inline span that renders a referenced card name with a dotted underline.
 * On hover, shows a smaller CardFull preview on the side opposite the parent
 * card's keyword-hint panel. The trigger climbs the DOM for `[data-card-full]`
 * and reads `data-hints-side` to pick the opposite.
 */
export default function CardNameRef({ text, card }: CardNameRefProps) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ style: CSSProperties; origin: 'top left' | 'top right' } | null>(null);

  const show = useCallback(() => {
    const node = spanRef.current;
    if (!node) return;
    const parent = node.closest('[data-card-full]') as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect();
    if (!parentRect) return;

    const hintsSide = parent?.getAttribute('data-hints-side') ?? 'right';
    const opposite: 'left' | 'right' = hintsSide === 'left' ? 'right' : 'left';

    const previewWidth = CARD_FULL_WIDTH * PREVIEW_SCALE;
    const fitsOpposite = opposite === 'right'
      ? window.innerWidth - parentRect.right >= previewWidth + PREVIEW_GAP
      : parentRect.left >= previewWidth + PREVIEW_GAP;
    const side: 'left' | 'right' = fitsOpposite ? opposite : (opposite === 'right' ? 'left' : 'right');

    if (side === 'right') {
      setPos({
        style: { left: parentRect.right + PREVIEW_GAP, top: parentRect.top },
        origin: 'top left',
      });
    } else {
      setPos({
        style: { right: window.innerWidth - parentRect.left + PREVIEW_GAP, top: parentRect.top },
        origin: 'top right',
      });
    }
  }, []);

  const hide = useCallback(() => setPos(null), []);

  useEffect(() => () => setPos(null), []);

  return (
    <>
      <span
        ref={spanRef}
        onPointerEnter={show}
        onPointerLeave={hide}
        style={{
          borderBottom: '1px dotted #aaa',
          cursor: 'help',
        }}
      >
        {text}
      </span>
      {pos && createPortal(
        <div
          style={{
            position: 'fixed',
            ...pos.style,
            zIndex: 60000,
            pointerEvents: 'none',
            transform: `scale(${PREVIEW_SCALE})`,
            transformOrigin: pos.origin,
          }}
        >
          <CardFull card={card} />
        </div>,
        document.body,
      )}
    </>
  );
}
