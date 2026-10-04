import Icon from '../icons/Icon';
import { Num } from '../icons/Num';
import type { IconName } from '../icons/glyphs';

// Board labels: icon + number rows floating over tiles (defense, VP stars,
// planned power). Positioned by the 3D board each frame; styled by
// `.cc-board-label` in game.css.

export interface Seg { icon?: IconName; text?: string; color?: string; size?: number }
export interface LabelRow { segs: Seg[]; size: number; color: string; alpha?: number }

export const TEMP_DEF = '#66ccff';
export const ACTION_SIZE = 18;
export const TILE_SIZE = 14;

export function row(segs: Seg[], size: number, color = '#fff', alpha?: number): LabelRow {
  return { segs, size, color, alpha };
}

/** Label color for a tile's owner: their player color, lifted a little
 *  toward white so it reads over the board. White for neutral tiles. */
export function ownerLabelColor(color: number | undefined): string {
  if (color == null) return '#fff';
  const lift = (v: number) => Math.round(v + (255 - v) * 0.25);
  const n = (lift((color >> 16) & 0xff) << 16) | (lift((color >> 8) & 0xff) << 8) | lift(color & 0xff);
  return `#${n.toString(16).padStart(6, '0')}`;
}

/** Permanent defense (fortify, in `color`) plus this round's bonus (blue) or immunity. */
export function defenseRow(persist: number, temp: number, immune: boolean, size: number, alpha?: number, color = '#fff'): LabelRow {
  const segs: Seg[] = [];
  if (persist > 0) {
    segs.push({ icon: 'fortify' }, { text: String(persist) });
    if (immune) segs.push({ icon: 'immune', color: TEMP_DEF });
    else if (temp > 0) segs.push({ text: `+${temp}`, color: TEMP_DEF });
  } else if (immune) {
    segs.push({ icon: 'immune', color: TEMP_DEF }, { text: 'Immune', color: TEMP_DEF, size: Math.round(size * 0.8) });
  } else {
    segs.push({ icon: 'defense', color: TEMP_DEF }, { text: `+${temp}`, color: TEMP_DEF });
  }
  return row(segs, size, color, alpha);
}

export function BoardLabelRow({ r, scale }: { r: LabelRow; scale: number }) {
  const size = Math.round(r.size * scale);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1,
      color: r.color, opacity: r.alpha ?? 1, fontSize: size, lineHeight: 1, whiteSpace: 'nowrap',
    }}>
      {r.segs.map((s, i) => s.icon
        ? <Icon key={i} name={s.icon} size={Math.round((s.size ?? r.size) * scale)} color={s.color} decorative />
        : <Num key={i} value={s.text ?? ''} size={Math.round((s.size ?? r.size) * scale)} color={s.color} />)}
    </div>
  );
}
