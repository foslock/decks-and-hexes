import { useCallback, useEffect, useRef, useState } from 'react';
import { browseLobbies } from '../api/client';
import type { BrowseGame, BrowseLobby } from '../types/game';
import Icon from '../icons/Icon';
import type { IconName } from '../icons/glyphs';

/** How often the list refreshes on its own. */
export const BROWSE_POLL_MS = 5000;
/** The Refresh button works at most this often. */
export const BROWSE_MIN_REFRESH_MS = 1000;

const MAP_NAMES: Record<string, string> = {
  small: 'Small', medium: 'Medium', large: 'Large', mega: 'Mega', ultra: 'Ultra',
};

function Meta({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <span className="cc-ov-lb-meta">
      <Icon name={icon} size={12} decorative />
      {children}
    </span>
  );
}

function playersLabel(players: number, cpus: number): string {
  const p = `${players} player${players !== 1 ? 's' : ''}`;
  return cpus > 0 ? `${p} (${cpus} bot${cpus !== 1 ? 's' : ''})` : p;
}

function HostName({ name, color }: { name: string; color: string }) {
  return (
    <span className="cc-ov-lb-host">
      <span className="cc-ov-lb-dot" style={{ background: color || '#888', color: color || '#888' }} />
      <span className="cc-ov-lb-host-name">{name || 'Unknown host'}</span>
    </span>
  );
}

/**
 * Browse Games: public lobbies waiting for players (join with one click) and
 * public games in progress (round + who's leading). Refreshes every 5 s, and
 * on demand at most once a second.
 */
export default function LobbyBrowser({ onJoin, onClose }: {
  onJoin: (code: string) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'open' | 'progress'>('open');
  const [open, setOpen] = useState<BrowseLobby[] | null>(null);
  const [inProgress, setInProgress] = useState<BrowseGame[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [coolingDown, setCoolingDown] = useState(false);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<{ code: string; message: string } | null>(null);
  const lastFetchRef = useRef(0);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    lastFetchRef.current = Date.now();
    const seq = ++seqRef.current;
    try {
      const data = await browseLobbies();
      if (seq !== seqRef.current) return; // a newer request is in flight
      setOpen(data.open);
      setInProgress(data.in_progress);
      setError(null);
      setUpdatedAt(Date.now());
    } catch (e: unknown) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Pseudo-realtime: poll, and tick the "updated …" note.
  useEffect(() => {
    void load();
    const poll = setInterval(() => { void load(); }, BROWSE_POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(poll); clearInterval(tick); };
  }, [load]);

  const refresh = () => {
    if (coolingDown || Date.now() - lastFetchRef.current < BROWSE_MIN_REFRESH_MS) return;
    setCoolingDown(true);
    setTimeout(() => setCoolingDown(false), BROWSE_MIN_REFRESH_MS);
    void load();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const join = async (code: string) => {
    setJoining(code);
    setJoinError(null);
    try {
      await onJoin(code);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setJoinError({ code, message: /full/i.test(msg) ? 'That lobby just filled up.' : /not found|expired/i.test(msg) ? 'That lobby has closed.' : msg });
      void load();
    } finally {
      setJoining(null);
    }
  };

  const ago = updatedAt == null ? null : Math.max(0, Math.round((now - updatedAt) / 1000));
  const list = tab === 'open' ? open : inProgress;

  return (
    <div className="cc-ov-backdrop" onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 45000, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div className="cc-ov-modal cc-ov-lb" role="dialog" aria-label="Browse games" onClick={(e) => e.stopPropagation()}>
        <div className="cc-ov-header">
          <Icon name="allOpponents" size={22} decorative style={{ color: 'var(--cc-gold)', flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="cc-ov-title">Browse Games</div>
            <div className="cc-ov-subtitle">Public lobbies and games — updates every few seconds.</div>
          </div>
          <button className="cc-ov-close" onClick={onClose} aria-label="Close"><Icon name="close" size={14} decorative /></button>
        </div>

        <div className="cc-ov-lb-bar">
          <div className="cc-ov-lb-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'open'} className={`cc-ov-chip${tab === 'open' ? ' is-active' : ''}`} onClick={() => setTab('open')}>
              Open Games{open ? ` (${open.length})` : ''}
            </button>
            <button role="tab" aria-selected={tab === 'progress'} className={`cc-ov-chip${tab === 'progress' ? ' is-active' : ''}`} onClick={() => setTab('progress')}>
              In Progress{inProgress ? ` (${inProgress.length})` : ''}
            </button>
          </div>
          <div className="cc-ov-lb-refresh">
            {ago != null && <span className="cc-ov-lb-ago">{ago < 2 ? 'Updated just now' : `Updated ${ago}s ago`}</span>}
            <button className="cc-ov-chip" onClick={refresh} disabled={coolingDown} aria-label="Refresh">
              <Icon name="reroll" size={11} decorative style={{ marginRight: 4, verticalAlign: '-0.1em' }} />Refresh
            </button>
          </div>
        </div>

        <div className="cc-ov-lb-body">
          {error && !list && <div className="cc-ov-lb-empty" style={{ color: '#ff8b97' }}>Couldn't load games: {error}</div>}
          {!error && !list && <div className="cc-ov-lb-empty">Looking for games…</div>}
          {list && list.length === 0 && (
            <div className="cc-ov-lb-empty">
              {tab === 'open' ? 'No open games right now — create one and invite friends!' : 'No games in progress right now.'}
            </div>
          )}

          {tab === 'open' && open?.map(l => (
            <div key={l.code} className="cc-ov-lb-row" data-browse-code={l.code}>
              <div className="cc-ov-lb-main">
                <HostName name={l.host_name} color={l.host_color} />
                <div className="cc-ov-lb-metas">
                  <Meta icon="tile">{MAP_NAMES[l.grid_size] ?? l.grid_size} map</Meta>
                  <Meta icon="drawPile">{l.card_pack_name}</Meta>
                  <Meta icon="allOpponents">{playersLabel(l.players, l.cpus)}</Meta>
                </div>
                {joinError?.code === l.code && <div className="cc-ov-lb-row-error">{joinError.message}</div>}
              </div>
              <button
                className="cc-btn-primary cc-ov-lb-join"
                disabled={l.full || l.starting || joining !== null}
                onClick={() => join(l.code)}
              >
                {joining === l.code ? 'Joining…' : l.starting ? 'Starting' : l.full ? 'Full' : 'Join'}
              </button>
            </div>
          ))}

          {tab === 'progress' && inProgress?.map(g => {
            const leaders = g.leaders;
            return (
              <div key={g.code} className="cc-ov-lb-row" data-browse-code={g.code}>
                <div className="cc-ov-lb-main">
                  <HostName name={g.host_name} color={g.host_color} />
                  <div className="cc-ov-lb-metas">
                    <Meta icon="tile">{MAP_NAMES[g.grid_size] ?? g.grid_size} map</Meta>
                    <Meta icon="drawPile">{g.card_pack_name}</Meta>
                    <Meta icon="allOpponents">{playersLabel(g.players, g.cpus)}</Meta>
                  </div>
                  {leaders.length > 0 && (
                    <div className="cc-ov-lb-leader">
                      <Icon name="vp" size={12} decorative />
                      <span>{leaders.length > 1 ? 'Tied: ' : 'Leading: '}</span>
                      {leaders.map((p, i) => (
                        <span key={p.name + i}>
                          {i > 0 && ', '}
                          <b style={{ color: p.color || 'var(--cc-text)' }}>{p.name}</b>
                        </span>
                      ))}
                      <span className="cc-ov-lb-vp">{leaders[0].vp} / {g.vp_target} VP</span>
                    </div>
                  )}
                </div>
                <div className="cc-ov-lb-round">
                  <span>Round</span>
                  <b>{g.round}</b>
                  <span>of {g.max_rounds}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
