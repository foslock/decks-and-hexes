import { useEffect, useState } from 'react';
import type { SoloCampaigns, SoloLevel } from '../../types/game';
import * as api from '../../api/client';
import SoloMapPreview from './SoloMapPreview';

/**
 * Dev page (`?preview=solo-maps`): every solo level's map as its campaign
 * plays it, locked or not — for drawing levels in data/solo_levels.yaml.
 * `&level=<id>&campaign=<archetype>` opens one straight away.
 */
export default function SoloMapsPreview() {
  const [data, setData] = useState<SoloCampaigns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SoloLevel | null>(null);

  useEffect(() => {
    api.getSoloCampaigns()
      .then(d => {
        setData(d);
        const params = new URLSearchParams(window.location.search);
        const id = params.get('level');
        const camp = params.get('campaign');
        const lv = d.campaigns.flatMap(c => c.levels).find(l => l.id === id && (!camp || l.archetype === camp));
        if (lv) setOpen(lv);
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load the campaigns.'));
  }, []);

  return (
    <div style={{ minHeight: '100vh', padding: 24, background: 'var(--cc-bg, #0b0b18)', color: 'var(--cc-text)' }}>
      <h1 className="cc-title" style={{ fontSize: 28, margin: '0 0 16px' }}>Solo maps</h1>
      {error && <p>{error}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16 }}>
        {data?.campaigns.map(c => (
          <section key={c.archetype}>
            <h2 style={{ fontFamily: 'var(--cc-font-display)', color: 'var(--cc-gold)', fontSize: 16 }}>{c.title}</h2>
            <ol style={{ margin: 0, paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {c.levels.map(lv => (
                <li key={lv.id}>
                  <button type="button" className="cc-btn-secondary" style={{ padding: '4px 10px', fontSize: 13 }} onClick={() => setOpen(lv)}>
                    {lv.title}
                  </button>
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--cc-text-dim)' }}>{lv.objective.text}</span>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
      {open && <SoloMapPreview level={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
