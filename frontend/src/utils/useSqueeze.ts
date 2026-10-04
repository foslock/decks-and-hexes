import { useLayoutEffect, useRef } from 'react';

/** Squeeze a single line horizontally when it would overflow its parent box.
 *  Attach the ref to an inline-block span inside an `overflow: hidden` box. */
export function useSqueeze(deps: unknown[]) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el?.parentElement) return;
    el.style.transform = '';
    const avail = el.parentElement.clientWidth;
    if (!avail) return;
    const k = Math.min(1, avail / el.scrollWidth);
    if (k < 1) el.style.transform = `scaleX(${k})`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}
