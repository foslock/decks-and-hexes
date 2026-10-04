import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import LobbyBrowser, { BROWSE_POLL_MS } from '../components/LobbyBrowser';

const lobby = {
  code: 'ABCD', host_name: 'Hosty', host_color: '#e6194b', grid_size: 'medium',
  card_pack: 'everything', card_pack_name: 'Everything', players: 3, humans: 2, cpus: 1,
  max_players: 6, full: false, starting: false,
};
const game = {
  code: 'WXYZ', host_name: 'Gamer', host_color: '#3cb44b', grid_size: 'small',
  card_pack: 'everything', card_pack_name: 'Everything', players: 2, humans: 1, cpus: 1,
  round: 4, max_rounds: 20, vp_target: 12, leaders: [{ name: 'Ethan', color: '#3cb44b', vp: 6 }],
};

function mockFetch(body: unknown) {
  return vi.fn(async () => ({ ok: true, json: async () => body }) as Response);
}

describe('LobbyBrowser', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('lists open lobbies with host, map, pack and players, and joins by code', async () => {
    vi.stubGlobal('fetch', mockFetch({ open: [lobby], in_progress: [game] }));
    const onJoin = vi.fn(async () => {});
    render(<LobbyBrowser onJoin={onJoin} onClose={() => {}} />);
    expect(await screen.findByText('Hosty')).toBeInTheDocument();
    expect(screen.getByText('Medium map')).toBeInTheDocument();
    expect(screen.getByText('3 of 6 players (1 bot)')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Open\s*Games \(1\)/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onJoin).toHaveBeenCalledWith('ABCD');
  });

  it('shows games in progress with the round and the leader', async () => {
    vi.stubGlobal('fetch', mockFetch({ open: [], in_progress: [game] }));
    render(<LobbyBrowser onJoin={async () => {}} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'In Progress (1)' }));
    expect(screen.getByText('Gamer')).toBeInTheDocument();
    expect(screen.getByText('Ethan')).toBeInTheDocument();
    expect(screen.getByText('6 / 12 VP')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('polls every few seconds and throttles manual refresh to once a second', async () => {
    const fetchMock = mockFetch({ open: [], in_progress: [] });
    vi.stubGlobal('fetch', fetchMock);
    render(<LobbyBrowser onJoin={async () => {}} onClose={() => {}} />);
    await screen.findByText(/No open games/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(BROWSE_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Right after a fetch, Refresh does nothing; a second later it works.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1100); });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('disables Join for full or starting lobbies', async () => {
    vi.stubGlobal('fetch', mockFetch({ open: [{ ...lobby, full: true }], in_progress: [] }));
    render(<LobbyBrowser onJoin={async () => {}} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Full' })).toBeDisabled();
  });
});
