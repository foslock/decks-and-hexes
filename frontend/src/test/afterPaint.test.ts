import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterPaint } from '../utils/afterPaint';

describe('afterPaint', () => {
  let frames: FrameRequestCallback[] = [];
  const frame = () => { const run = frames; frames = []; run.forEach(f => f(performance.now())); };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    frames = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frames.push(cb); return frames.length; });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames = []; });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('waits two frames — one painted — then runs once', () => {
    const fn = vi.fn();
    afterPaint(fn);
    frame();
    expect(fn).not.toHaveBeenCalled();
    frame();
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs on a timer in a hidden tab (no frames come)', () => {
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const fn = vi.fn();
    afterPaint(fn, 250);
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    vis.mockRestore();
  });

  it('waits for the frames in a visible tab — up to the safety limit', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const fn = vi.fn();
    afterPaint(fn, 250, 2000);
    vi.advanceTimersByTime(1999);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can be called off', () => {
    const fn = vi.fn();
    const cancel = afterPaint(fn);
    cancel();
    frame();
    frame();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});
