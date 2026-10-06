import { describe, expect, it } from 'vitest';
import { MAX_LEAD_MS, measureOutputDelay, soundLead, USUAL_DELAY_MS } from '../audio/outputDelay';

const ctx = (o: Partial<AudioContext> & { ts?: AudioTimestamp }) => ({
  state: 'running', currentTime: 10, baseLatency: 0.005, outputLatency: 0.02,
  getOutputTimestamp: () => o.ts ?? { contextTime: 0, performanceTime: 0 },
  ...o,
}) as unknown as AudioContext;

describe('measureOutputDelay', () => {
  it('reads it from what the output is playing', () => {
    // The frame at 9.97 s is heard at 1000 ms; one started now (10 s, at 1000 ms) 30 ms later.
    expect(measureOutputDelay(ctx({ ts: { contextTime: 9.97, performanceTime: 1000 } }), 1000)).toBeCloseTo(30);
  });

  it('takes the reported latency when it is larger (Bluetooth headphones)', () => {
    const airpods = ctx({ outputLatency: 0.168, ts: { contextTime: 9.97, performanceTime: 1000 } } as Partial<AudioContext>);
    expect(measureOutputDelay(airpods, 1000)).toBeCloseTo(173);
  });

  it('falls back to the reported latency, and knows nothing about a stopped context', () => {
    expect(measureOutputDelay(ctx({}), 0)).toBeCloseTo(25);
    expect(measureOutputDelay(ctx({ state: 'suspended' } as Partial<AudioContext>), 0)).toBeNull();
  });
});

describe('soundLead', () => {
  it('makes up only what the output adds beyond the usual', () => {
    expect(soundLead(null)).toBe(0);
    expect(soundLead(25)).toBe(0);
    expect(soundLead(173)).toBe(173 - USUAL_DELAY_MS);
    expect(soundLead(5000)).toBe(MAX_LEAD_MS);
  });
});
