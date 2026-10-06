import { useEffect, useRef, useState } from 'react';
import { soundEngine } from './SoundEngine';
import { measure, renderSound, type Levels } from './offlineRender';
import type { SoundName } from './sounds';

/**
 * Sound audition page (?preview=sounds): play every sound, fire the
 * frequently-repeated ones in rapid bursts, and measure levels offline.
 */

interface Entry {
  name: SoundName;
  desc: string;
  /** Burst: [count, interval ms] for sounds that repeat quickly in game. */
  burst?: [number, number];
}

const GROUPS: { title: string; note?: string; entries: Entry[]; ramp?: boolean }[] = [
  {
    title: 'Cards',
    entries: [
      { name: 'cardDraw', desc: 'Card slides off the deck and settles in hand (fires per card during a deal).', burst: [6, 250] },
      { name: 'cardPlay', desc: 'Air swish, card laid on the felt with a soft table knock.', burst: [4, 300] },
      { name: 'cardDiscard', desc: 'Airy flick onto the discard pile, soft landing.', burst: [5, 400] },
      { name: 'cardTrash', desc: 'Paper rip with a dark poof — removed from the game.' },
      { name: 'deckShuffle', desc: 'Riffle, bridge cascade, two squaring taps.' },
    ],
  },
  {
    title: 'Economy & magic',
    entries: [
      { name: 'cardPurchase', desc: 'Gold coins cascade into a leather purse.', burst: [3, 350] },
      { name: 'upgradeCharge', desc: 'Holding the upgrade badge: a tone climbing two octaves, an airy rush, quickening glassy plinks (fades if released early).' },
      { name: 'upgradeCard', desc: 'Upgraded: warm thump and crack, a G-major bell bloom over a brass ta-da, a shower of gold glints.' },
    ],
  },
  {
    title: 'Board & claims',
    entries: [
      { name: 'tileSelect', desc: 'Small wooden marker tapped onto the map.', burst: [5, 110] },
      { name: 'resolveTileOccupied', desc: 'Banner snaps taut, planted with a war drum.', burst: [4, 700] },
      { name: 'resolveDefenseFortify', desc: 'Shield raised: resonant clang over a solid thunk.' },
      { name: 'resolveContested', desc: 'Tense clash: swing, "ba-DUM" drums, crossing blades.' },
    ],
  },
  {
    title: 'Claim smash (power 0 → 8+)',
    ramp: true,
    note: 'A claim\'s number smashing into the defense — one per power level, each heavier than the last.',
    entries: [
      { name: 'claimSmash0', desc: 'Power 0: a feeble wooden poke.' },
      { name: 'claimSmash1', desc: 'Power 1: a light jab — knock and a thin ring.' },
      { name: 'claimSmash2', desc: 'Power 2: a blade strike over a small drum.' },
      { name: 'claimSmash3', desc: 'Power 3: crossing swords and a scrape.' },
      { name: 'claimSmash4', desc: 'Power 4: a war-drum blow through a shield clang.' },
      { name: 'claimSmash5', desc: 'Power 5: a mace — crushing double clang, splinters.' },
      { name: 'claimSmash6', desc: 'Power 6: a war hammer — crack, timpani, ringing plate, stone chips.' },
      { name: 'claimSmash7', desc: 'Power 7: a siege ram — sub boom, low brass, tumbling stone.' },
      { name: 'claimSmash8', desc: 'Power 8+: a cataclysm — thunderclap, aftershock, brass chord, falling stone.' },
    ],
  },
  {
    title: 'Base raid',
    entries: [
      { name: 'resolveBaseRaidFortify', desc: 'Ominous build, grinding stone, portcullis slams down.' },
      { name: 'resolveBaseRaidRam', desc: 'Battering ram on a wooden gate (3 hits per raid).', burst: [3, 420] },
      { name: 'resolveBaseRaidShatter', desc: 'Wall gives way: crack, boom, tumbling debris.' },
      { name: 'resolveBaseRaidHold', desc: 'Defence holds: great shield rings, open-fifth horns.' },
    ],
  },
  {
    title: 'Countdown & UI',
    entries: [
      { name: 'countdownTick', desc: 'War drum + woodblock tick (3, 2, 1).', burst: [3, 1000] },
      { name: 'countdownGo', desc: 'Big drum, bright brass stab, bell.' },
      { name: 'buttonClick', desc: 'Subtle UI tick.', burst: [5, 90] },
    ],
  },
  {
    title: 'Jingles',
    entries: [
      { name: 'beginJingle', desc: 'Horn call over drums — the match begins.' },
      { name: 'victoryJingle', desc: 'Triumphant C-major fanfare with strings and timpani.' },
      { name: 'defeatJingle', desc: 'Somber C-minor horn line over dark strings.' },
    ],
  },
  {
    title: 'Optional extras',
    note: 'Available on soundEngine / useSound but not yet wired into the game.',
    entries: [
      { name: 'hoverTick', desc: 'Barely-there hover tick (cards, market items).', burst: [5, 70] },
      { name: 'coinSpend', desc: 'Coin flicked from the purse (re-roll, retain, debt).', burst: [3, 250] },
      { name: 'vpGain', desc: 'Warm two-bell chime for gaining VP / claiming an objective.' },
      { name: 'phaseChange', desc: 'Soft rising whoosh onto a low drum (phase transitions).' },
      { name: 'invalidAction', desc: 'Dull double knock for a rejected move.' },
    ],
  },
];

const ALL: SoundName[] = GROUPS.flatMap((g) => g.entries.map((e) => e.name));

export default function SoundPreview() {
  const [volume, setVolume] = useState(0.8);
  const [levels, setLevels] = useState<Partial<Record<SoundName, Levels>>>({});
  const [measuring, setMeasuring] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  /** How late sounds are heard right now, and how far ahead they start to make up for it. */
  const [delay, setDelay] = useState<{ now: number | null; lead: number }>({ now: null, lead: 0 });
  useEffect(() => {
    const t = setInterval(() => setDelay({ now: soundEngine.outputDelay(), lead: soundEngine.leadMs }), 500);
    return () => clearInterval(t);
  }, []);
  /** Sync check: a dot flashes on each beat with a tick cued to land on it. */
  const dotRef = useRef<HTMLSpanElement>(null);
  const syncCheck = () => {
    for (let i = 0; i < 8; i++) {
      const at = 400 + i * 600;
      soundEngine.cue('tileSelect', at);
      timers.current.push(setTimeout(() => dotRef.current?.animate(
        [{ transform: 'scale(1.6)', opacity: 1 }, { transform: 'scale(1)', opacity: 0.25 }],
        { duration: 300, easing: 'ease-out' },
      ), at));
    }
  };

  useEffect(() => {
    soundEngine.setEnabled(true);
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    soundEngine.setVolume(volume);
  }, [volume]);

  const play = (name: SoundName) => soundEngine.play(name);
  const burst = (name: SoundName, count: number, interval: number) => {
    for (let i = 0; i < count; i++) timers.current.push(setTimeout(() => play(name), i * interval));
  };

  const measureAll = async () => {
    setMeasuring(true);
    try {
      for (const name of ALL) {
        const m = measure(await renderSound(name));
        setLevels((prev) => ({ ...prev, [name]: m }));
      }
    } finally {
      setMeasuring(false);
    }
  };

  return (
    <div style={{ minHeight: '100dvh', background: 'var(--cc-bg)', color: 'var(--cc-text)', fontFamily: 'var(--cc-font-body)', padding: '24px 16px 48px', boxSizing: 'border-box' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <h1 className="cc-title" style={{ fontSize: 30, margin: '0 0 4px' }}>Sound Audition</h1>
        <p style={{ color: 'var(--cc-text-dim)', margin: '0 0 16px', fontSize: 14 }}>
          Every game sound, synthesized live. Bursts mimic in-game repetition; levels are measured from an offline render at volume 1.0
          (peak dBFS / K-weighted 100 ms loudness).
        </p>

        <div className="cc-panel" style={{ padding: '12px 16px', marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 240px' }}>
            <span style={{ fontSize: 13, color: 'var(--cc-text-dim)' }}>Master volume</span>
            <input
              type="range" min={0} max={1} step={0.01} value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--cc-gold)' }}
              aria-label="Master volume"
            />
            <span style={{ fontVariantNumeric: 'tabular-nums', width: 36, textAlign: 'right', fontSize: 13 }}>{Math.round(volume * 100)}%</span>
          </label>
          <button className="cc-btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }} onClick={measureAll} disabled={measuring}>
            {measuring ? 'Measuring…' : 'Measure levels'}
          </button>
          {/* Output delay: from a sound starting to it being heard. Over
              ~80 ms it's noticeable; Bluetooth / AirPlay add 150 ms or more. */}
          <div style={{ flex: '1 1 100%', fontSize: 12, color: 'var(--cc-text-dim)', fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>
              Output delay:{' '}
              <strong style={{ color: 'var(--cc-text)' }}>{delay.now != null ? `${Math.round(delay.now)} ms` : '— (play a sound)'}</strong>
              {delay.lead > 0 && <> · sounds tied to the screen start <strong style={{ color: 'var(--cc-gold)' }}>{Math.round(delay.lead)} ms</strong> early</>}
              <span style={{ color: 'var(--cc-text-faint)' }}> — Bluetooth headphones add ~150–250 ms.</span>
            </span>
            <button className="cc-btn-secondary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={syncCheck}>Sync check</button>
            <span ref={dotRef} aria-hidden style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--cc-gold)', opacity: 0.25, display: 'inline-block' }} />
          </div>
        </div>

        {GROUPS.map((group) => (
          <section key={group.title} className="cc-panel" style={{ padding: '12px 16px', marginBottom: 14 }}>
            <h2 style={{ fontFamily: 'var(--cc-font-display)', fontSize: 15, letterSpacing: '0.06em', color: 'var(--cc-gold)', margin: '2px 0 8px' }}>{group.title}</h2>
            {group.note && <p style={{ fontSize: 12, color: 'var(--cc-text-faint)', margin: '-4px 0 8px' }}>{group.note}</p>}
            {group.ramp && (
              <button
                className="cc-btn-secondary"
                style={{ padding: '6px 14px', fontSize: 13, marginBottom: 8 }}
                onClick={() => group.entries.forEach((e, i) => timers.current.push(setTimeout(() => play(e.name), i * 900)))}
              >
                Play all in order
              </button>
            )}
            {group.entries.map((e) => {
              const lv = levels[e.name];
              return (
                <div key={e.name} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 12px', padding: '8px 0', borderTop: '1px solid var(--cc-panel-border)' }}>
                  <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                    <code style={{ fontSize: 13, color: 'var(--cc-text)' }}>{e.name}</code>
                    <div style={{ fontSize: 12.5, color: 'var(--cc-text-dim)', marginTop: 2 }}>{e.desc}</div>
                  </div>
                  {lv && (
                    <span style={{ fontSize: 11.5, color: 'var(--cc-text-faint)', fontVariantNumeric: 'tabular-nums' }}>
                      {lv.peakDb.toFixed(1)} dBFS / {lv.loudness.toFixed(1)} LU
                    </span>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="cc-btn-secondary" style={{ padding: '6px 14px', fontSize: 13 }} onClick={() => play(e.name)}>Play</button>
                    {e.burst && (
                      <button className="cc-btn-secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={() => burst(e.name, e.burst![0], e.burst![1])}>
                        {e.burst[0]}× rapid
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
