import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  __resetCardImagePreloadForTests,
  cardImageUrl,
  isCardImageMissing,
  isCardImageReady,
  onCardImageReady,
  preloadCardImages,
} from '../utils/cardImagePreload';

/** Minimal Image stand-in: records src assignments and lets tests decide
 *  which URLs "load" and which "fail". */
class FakeImage {
  static instances: FakeImage[] = [];
  static failing = new Set<string>();
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  decoding = '';
  fetchPriority = '';
  private _src = '';
  constructor() { FakeImage.instances.push(this); }
  set src(v: string) { this._src = v; }
  get src() { return this._src; }
  decode() { return Promise.resolve(); }
  settle() {
    if (FakeImage.failing.has(this._src)) this.onerror?.();
    else this.onload?.();
  }
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('cardImagePreload', () => {
  const OriginalImage = globalThis.Image;

  beforeEach(() => {
    __resetCardImagePreloadForTests();
    FakeImage.instances = [];
    FakeImage.failing = new Set();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).Image = FakeImage;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.Image = OriginalImage;
    vi.useRealTimers();
  });

  it('loads the compressed WebP first', async () => {
    preloadCardImages(['neutral_gather'], 'high');
    expect(FakeImage.instances[0].src).toBe('/cards/neutral_gather.webp');
    FakeImage.instances[0].settle();
    await flush();
    expect(isCardImageReady('neutral_gather')).toBe(true);
  });

  it('falls back to the PNG when the WebP is missing, then marks missing art', async () => {
    FakeImage.failing.add('/cards/foo.webp');
    FakeImage.failing.add('/cards/foo.png');
    preloadCardImages(['foo'], 'high');
    FakeImage.instances[0].settle();
    expect(FakeImage.instances[1].src).toBe('/cards/foo.png');
    expect(cardImageUrl('foo')).toBe('/cards/foo.png');
    FakeImage.instances[1].settle();
    await flush();
    expect(isCardImageMissing('foo')).toBe(true);
  });

  it('caps high-priority concurrency and drains the queue', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `card_${i}`);
    preloadCardImages(ids, 'high');
    expect(FakeImage.instances.length).toBe(6);
    FakeImage.instances.slice(0, 6).forEach(img => img.settle());
    await flush();
    expect(FakeImage.instances.length).toBe(10);
  });

  it('does not re-request an image that is already loaded or queued', async () => {
    preloadCardImages(['a', 'a'], 'high');
    preloadCardImages(['a'], 'idle');
    expect(FakeImage.instances.length).toBe(1);
  });

  it('notifies ready listeners', async () => {
    const cb = vi.fn();
    onCardImageReady('b', cb);
    preloadCardImages(['b'], 'high');
    FakeImage.instances[0].settle();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('resolves catalog aliases to their art file', () => {
    expect(cardImageUrl('rubble')).toBe('/cards/neutral_rubble.webp');
  });

  it('schedules idle loads only after the high-priority queue drains', async () => {
    preloadCardImages(['hi'], 'high');
    preloadCardImages(['idle_1', 'idle_2'], 'idle');
    expect(FakeImage.instances.map(i => i.src)).toEqual(['/cards/hi.webp']);
    FakeImage.instances[0].settle();
    await flush();
    vi.advanceTimersByTime(300);
    await flush();
    expect(FakeImage.instances.length).toBeGreaterThan(1);
  });
});
