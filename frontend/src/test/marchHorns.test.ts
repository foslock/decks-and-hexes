import { describe, expect, it } from 'vitest';
import { CHORDS, newMarchState, nextHorns, PROGRESSIONS } from '../audio/music';
import { mulberry32, setRandomSource } from '../audio/synth';

/** G major: the key of the bugle calls (a bugle in G). */
const G_MAJOR = new Set(['G', 'A', 'B', 'C', 'D', 'E', 'F#']);

describe('march horns', () => {
  it('play only chords in G major', () => {
    for (const prog of PROGRESSIONS) {
      for (const chord of prog) {
        for (const n of CHORDS[chord]) expect(G_MAJOR.has(n.replace(/\d/g, ''))).toBe(true);
      }
    }
  });

  it('come in after the drums, rest after two progressions, never repeat one, and end a run on G', () => {
    setRandomSource(mulberry32(11));
    try {
      const st = newMarchState();
      expect(st.horns.prog).toBe(-1); // the first eight bars are drums alone
      const blocks: number[] = [];
      for (let i = 0; i < 400; i++) {
        st.intensity = i % 3;
        nextHorns(st);
        blocks.push(st.horns.prog);
      }
      expect(blocks[0]).toBeGreaterThanOrEqual(0); // the horns come in on the ninth bar
      let run = 0;
      blocks.forEach((p, i) => {
        run = p >= 0 ? run + 1 : 0;
        expect(run).toBeLessThanOrEqual(2);
        if (p >= 0 && i > 0) expect(p).not.toBe(blocks[i - 1]);
        if (p >= 0 && (blocks[i + 1] ?? -1) < 0 && i + 1 < blocks.length) expect(PROGRESSIONS[p][3]).toBe('G');
      });
      // They play a good share of the time, and rest too.
      const playing = blocks.filter(p => p >= 0).length / blocks.length;
      expect(playing).toBeGreaterThan(0.3);
      expect(playing).toBeLessThan(0.75);
    } finally {
      setRandomSource(null);
    }
  });
});
