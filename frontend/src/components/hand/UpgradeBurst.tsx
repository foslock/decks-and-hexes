import { useMemo, type CSSProperties } from 'react';

/** How long the burst plays (ms) — the hand clears it after this. */
export const UPGRADE_BURST_MS = 1300;

/**
 * A card just upgraded: a white-gold flash over the face, light rays wheeling
 * out from behind it, a ring of light racing outward, gold sparks thrown off
 * the card and a sheen sweeping across the new face. Drawn inside the card
 * (it rotates and scales with it); styles in cards.css (cc-upgrade-*).
 */
export default function UpgradeBurst() {
  const sparks = useMemo(() => Array.from({ length: 16 }, (_, i) => {
    const a = (i / 16) * Math.PI * 2 + Math.random() * 0.35;
    const d = 120 + Math.random() * 90;
    return {
      ['--dx' as string]: `${Math.cos(a) * d}px`,
      ['--dy' as string]: `${Math.sin(a) * d * 1.15}px`,
      ['--s' as string]: `${0.6 + Math.random() * 0.8}`,
      animationDelay: `${Math.round(Math.random() * 120)}ms`,
    } as CSSProperties;
  }), []);
  return (
    <div className="cc-upgrade-burst" aria-hidden>
      <div className="cc-upgrade-rays" />
      <div className="cc-upgrade-ring" />
      <div className="cc-upgrade-flash" />
      <div className="cc-upgrade-sheen" />
      {sparks.map((style, i) => <span key={i} className="cc-upgrade-spark" style={style} />)}
    </div>
  );
}
