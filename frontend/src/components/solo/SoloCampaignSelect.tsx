import { useEffect, useState } from 'react';
import type { SoloCampaigns } from '../../types/game';
import * as api from '../../api/client';
import LocalSettingsMenu from '../LocalSettingsMenu';
import Icon from '../../icons/Icon';
import { campaignProgress, frontier, loadProgress } from './soloProgress';
import { SOLO_ARCHETYPES } from './SoloLevelPanel';
import SoloLoading from './SoloLoading';

interface SoloCampaignSelectProps {
  onBack: () => void;
  onChoose: (archetype: string) => void;
}

/**
 * Pick a campaign: Vanguard, Swarm or Fortress, each its own run of levels
 * from its own corner of the overworld, always played as that archetype.
 * To switch, come back here.
 */
export default function SoloCampaignSelect({ onBack, onChoose }: SoloCampaignSelectProps) {
  const [data, setData] = useState<SoloCampaigns | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress] = useState(loadProgress);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    api.getSoloCampaigns()
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : 'Could not load the campaigns.'); });
    return () => { live = false; };
  }, [attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div className="cc-solo-root cc-solo-select">
      <LocalSettingsMenu />
      <header className="cc-solo-head">
        <button type="button" className="cc-btn-secondary cc-solo-back" onClick={onBack}>
          <Icon name="chevron" size={12} decorative style={{ transform: 'rotate(180deg)' }} /> Home
        </button>
        <div className="cc-solo-title">
          <h1 className="cc-title">Solo Campaigns</h1>
          <div className="cc-solo-sub">Choose your side</div>
        </div>
        <span className="cc-solo-next-spacer" />
      </header>
      {!data && (
        <SoloLoading
          message="Gathering the banners"
          error={error}
          onRetry={error ? () => setAttempt(n => n + 1) : undefined}
        />
      )}
      <div className="cc-solo-select-grid">
        {data?.campaigns.map(c => {
          const arch = SOLO_ARCHETYPES.find(a => a.id === c.archetype);
          const ids = c.levels.map(l => l.id);
          const done = frontier(ids, campaignProgress(progress, c.archetype));
          const all = done >= ids.length;
          const next = c.levels[Math.min(done, ids.length - 1)];
          return (
            <button
              type="button"
              key={c.archetype}
              className={`cc-solo-camp is-${c.archetype}${progress.last === c.archetype ? ' is-last' : ''}`}
              onClick={() => onChoose(c.archetype)}
            >
              {arch && <img className="cc-solo-camp-emblem" src={arch.emblem} alt="" draggable={false} />}
              <span className="cc-solo-camp-title">{c.title}</span>
              <span className="cc-solo-camp-blurb">{c.blurb}</span>
              <span className="cc-solo-camp-meter" aria-hidden="true">
                {ids.map((id, i) => <i key={id} className={i < done ? 'is-done' : i === done ? 'is-next' : ''} />)}
              </span>
              <span className="cc-solo-camp-progress">
                {all ? 'Campaign complete' : done === 0 ? `${ids.length} levels` : `${done} of ${ids.length} cleared`}
              </span>
              <span className="cc-solo-camp-cta">
                {all ? 'Revisit' : done === 0 ? 'Begin' : `Continue: ${next.title}`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
