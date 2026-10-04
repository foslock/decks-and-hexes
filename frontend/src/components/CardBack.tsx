import type { CSSProperties } from 'react';
import { metalGradient } from '../constants/cardTrim';
import { CARD_FULL_HEIGHT, CARD_FULL_WIDTH } from './CardFull';

// A faint hex lattice for the back's field (flat-top hexes, gold hairlines).
const HEX_LATTICE = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="41.57" viewBox="0 0 24 41.57">'
  + '<path d="M6 0 L18 0 L24 10.39 L18 20.78 L6 20.78 L0 10.39 Z M6 20.78 L0 31.18 L6 41.57 M18 20.78 L24 31.18 L18 41.57" '
  + 'fill="none" stroke="#e8c46a" stroke-opacity="0.13" stroke-width="1"/></svg>',
)}")`;

/**
 * The back of every Card Clash card: a gilded frame around a deep indigo
 * field with a hex lattice and a crossed-swords crest. Same 220 × 308 box as
 * CardFull so the two can be flipped back-to-back.
 */
export default function CardBack({ style }: { style?: CSSProperties }) {
  return (
    <div style={{
      width: CARD_FULL_WIDTH,
      height: CARD_FULL_HEIGHT,
      boxSizing: 'border-box',
      padding: 7,
      borderRadius: 14,
      background: metalGradient('gold', 145),
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.55), inset 0 -1px 0 rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.6)',
      position: 'relative',
      ...style,
    }}>
      <div style={{
        position: 'relative',
        height: '100%',
        borderRadius: 9,
        overflow: 'hidden',
        background: `radial-gradient(ellipse 70% 55% at 50% 50%, rgba(80, 70, 160, 0.55) 0%, rgba(20, 18, 52, 0) 70%), ${HEX_LATTICE}, linear-gradient(160deg, #23204d 0%, #121130 55%, #0b0a20 100%)`,
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.7), inset 0 0 30px rgba(0,0,0,0.6)',
      }}>
        {/* Inner gilded border with clipped corners */}
        <div style={{
          position: 'absolute', inset: 9, borderRadius: 6,
          border: '1.5px solid rgba(232, 196, 106, 0.55)',
          boxShadow: 'inset 0 0 0 3px rgba(0,0,0,0.25), inset 0 0 0 4px rgba(232, 196, 106, 0.18)',
        }} />
        <svg viewBox="0 0 100 100" width="132" height="132" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }} aria-hidden>
          <defs>
            <linearGradient id="cc-back-gold" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fff3c4" />
              <stop offset="0.45" stopColor="#e2ae45" />
              <stop offset="0.7" stopColor="#fff0c0" />
              <stop offset="1" stopColor="#b4801f" />
            </linearGradient>
          </defs>
          {/* Outer and inner hex rings */}
          <polygon points="50,4 90,27 90,73 50,96 10,73 10,27" fill="rgba(10,9,30,0.55)" stroke="url(#cc-back-gold)" strokeWidth="2.6" />
          <polygon points="50,13 82,31.5 82,68.5 50,87 18,68.5 18,31.5" fill="none" stroke="url(#cc-back-gold)" strokeWidth="1" strokeOpacity="0.7" />
          {/* Crossed swords */}
          {[-1, 1].map(s => (
            <g key={s} transform={`rotate(${s * 40} 50 50)`}>
              <path d="M48.6 20 L51.4 20 L52.2 60 L47.8 60 Z" fill="url(#cc-back-gold)" />
              <path d="M50 14 L52.2 20 L47.8 20 Z" fill="url(#cc-back-gold)" />
              <rect x="40.5" y="60" width="19" height="3.6" rx="1.6" fill="url(#cc-back-gold)" />
              <rect x="48.3" y="63.6" width="3.4" height="11" rx="1.2" fill="#8a5a1c" />
              <circle cx="50" cy="77" r="2.8" fill="url(#cc-back-gold)" />
            </g>
          ))}
          <circle cx="50" cy="50" r="5" fill="#141230" stroke="url(#cc-back-gold)" strokeWidth="1.6" />
        </svg>
        {/* Gloss */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          background: 'linear-gradient(118deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.08) 44%, rgba(255,255,255,0) 58%)',
        }} />
      </div>
    </div>
  );
}
