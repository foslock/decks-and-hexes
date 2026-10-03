import { describe, expect, it } from 'vitest';

/**
 * Guard: the UI uses the Card Clash icon set (src/icons) instead of emoji.
 * Fails if an emoji, pictograph, dingbat or Braille "icon" sneaks back into
 * the frontend — in code, strings, JSX text, CSS or comments, as a literal
 * character, an HTML entity or a JS escape. Plain typographic characters
 * (→ ← × ≤ · — and box-drawing in diagrams) are allowed.
 *
 * Add a glyph to src/icons/glyphs.ts and render <Icon name=… /> instead.
 */

const BANNED = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE0F}\u{2191}\u{2193}-\u{21FF}\u{2800}-\u{28FF}]/u;
const isBannedCodePoint = (cp: number) => BANNED.test(String.fromCodePoint(cp));
const ENTITY = /&#(x[0-9a-f]+|\d+);/gi;
/** JS/CSS escapes: \u{1F916}, \uD83E (any high surrogate = astral char), \2694 in CSS. */
const ESCAPE = /\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi;
/** This file names the banned ranges as escapes on purpose. */
const SELF = '/src/test/noEmoji.test.ts';

/** Deliberate exceptions as "path:line". Keep this empty. */
const ALLOWLIST = new Set<string>();

// Vite inlines every matching file's raw text at transform time.
const FILES: Record<string, string> = {
  ...import.meta.glob('/src/**/*.{ts,tsx,css}', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('/public/**/*.{svg,json,webmanifest}', { query: '?raw', import: 'default', eager: true }),
  ...import.meta.glob('/index.html', { query: '?raw', import: 'default', eager: true }),
} as Record<string, string>;

describe('no emoji in the frontend', () => {
  it('src/, public/ and index.html contain no emoji, pictographs or dingbats', () => {
    const files = Object.keys(FILES);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('/index.html');

    const hits: string[] = [];
    for (const rel of files) {
      FILES[rel].split('\n').forEach((line, i) => {
        const where = `${rel}:${i + 1}`;
        if (ALLOWLIST.has(where)) return;
        const literal = BANNED.exec(line);
        if (literal) hits.push(`${where}  "${literal[0]}"  ${line.trim().slice(0, 100)}`);
        if (rel !== SELF) {
          for (const m of line.matchAll(ESCAPE)) {
            const cp = parseInt(m[1] ?? m[2], 16);
            const astral = cp >= 0xd800 && cp <= 0xdbff;
            if (astral || isBannedCodePoint(cp)) hits.push(`${where}  ${m[0]}  ${line.trim().slice(0, 100)}`);
          }
        }
        for (const m of line.matchAll(ENTITY)) {
          const cp = m[1][0].toLowerCase() === 'x' ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10);
          if (isBannedCodePoint(cp)) hits.push(`${where}  ${m[0]}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
    expect(hits, `Emoji found — use <Icon> from src/icons instead:\n${hits.join('\n')}`).toEqual([]);
  });
});
