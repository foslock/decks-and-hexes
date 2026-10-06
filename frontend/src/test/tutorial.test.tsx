import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Card, HexTile, ResolutionEffect, ResolutionStep } from '../types/game';
import { SettingsProvider } from '../components/SettingsContext';
import TutorialOverlay from '../components/tutorial/TutorialOverlay';
import { SCENES, type Scene, type TutorialCtx } from '../components/tutorial/tutorialScenes';
import {
  RIVAL, STAR, VP_TARGET, YOU, frontier, neighbours, pathToBase, scoreVp, type World,
} from '../components/tutorial/tutorialWorld';

const scene = (id: string) => SCENES.find(s => s.id === id)!;

/** Who should win a claim on `tile`, by the game's rules: highest power;
 *  the owner adds the tile's defense and wins ties; a neutral tile's own
 *  defense holds only if no claim reaches it. */
function expectedWinner(tile: HexTile, claims: { player_id: string; power: number }[]): string | null {
  const power = new Map<string, number>();
  for (const c of claims) power.set(c.player_id, (power.get(c.player_id) ?? 0) + c.power);
  if (tile.owner) power.set(tile.owner, (power.get(tile.owner) ?? 0) + tile.defense_power);
  const max = Math.max(...power.values());
  if (!tile.owner && max < tile.defense_power) return null;
  const top = [...power.keys()].filter(k => power.get(k) === max);
  if (top.length === 1) return top[0];
  return tile.owner && top.includes(tile.owner) ? tile.owner : null;
}

/** Run a scene's script against a stand-in context that checks every move
 *  is legal (card in hand, actions to spare, adjacency, ownership) and every
 *  resolution matches the rules. Returns the final world. */
async function dryRun(s: Scene): Promise<World> {
  let w = s.start();
  const plays: { pid: string; tile: string; card: Card }[] = [];
  const set = (patch: Partial<World> | ((x: World) => Partial<World>)) => {
    w = { ...w, ...(typeof patch === 'function' ? patch(w) : patch) };
  };
  const ctx: TutorialCtx = {
    wait: async () => {},
    get: () => w,
    set,
    fly: async () => {},
    deal: async (cards) => set(x => ({ hand: [...x.hand, ...cards] })),
    play: async (id, tile, opts = {}) => {
      const card = w.hand.find(c => c.id === id);
      expect(card, `${s.id}: ${id} is in the hand`).toBeTruthy();
      expect(w.actions, `${s.id}: actions for ${id}`).toBeGreaterThanOrEqual(card!.action_cost);
      if (tile) {
        const t = w.tiles[tile];
        if (card!.card_type === 'defense') {
          expect(t.owner, `${s.id}: ${card!.name} on your own tile`).toBe(YOU);
        } else {
          expect(t.owner, `${s.id}: ${card!.name} claims a tile you don't own`).not.toBe(YOU);
          expect(neighbours(tile).some(n => w.tiles[n]?.owner === YOU), `${s.id}: ${tile} is next to your land`).toBe(true);
        }
        if (opts.from) {
          expect(w.tiles[opts.from].owner).toBe(YOU);
          expect(neighbours(opts.from)).toContain(tile);
        }
        plays.push({ pid: YOU, tile, card: card! });
      }
      set(x => ({
        hand: x.hand.filter(c => c.id !== id),
        actions: x.actions - card!.action_cost + card!.action_return,
        resources: x.resources + card!.resource_gain,
      }));
    },
    rivalPlay: async (card, tile, from) => {
      expect(w.tiles[from].owner).toBe(RIVAL);
      expect(neighbours(from)).toContain(tile);
      plays.push({ pid: RIVAL, tile, card });
    },
    reveal: async () => {},
    resolve: async (steps: ResolutionStep[], effects: ResolutionEffect[] = []) => {
      // A card that gains a Debt as it resolves (Mercenary, Siege Tower)
      // shows it on its tile, and nothing else gives one.
      const debts = plays.filter(p => steps.some(st => st.tile_key === p.tile) && p.card.effects?.some(e => e.type === 'gain_debt'));
      expect(effects.filter(e => e.type === 'card' && e.card_name === 'Debt').map(e => [e.player_id, e.tile_key, e.source_card]), `${s.id}: Debts`)
        .toEqual(debts.map(p => [p.pid, p.tile, p.card.name]));
      for (const step of steps) {
        const t = w.tiles[step.tile_key];
        if (step.outcome === 'defense_applied') {
          expect(plays.some(p => p.tile === step.tile_key && p.card.card_type === 'defense')).toBe(true);
          const perm = step.defense_permanent ?? 0, temp = step.defense_temporary ?? 0;
          set(x => ({ tiles: { ...x.tiles, [step.tile_key]: { ...t, permanent_defense_bonus: perm - t.base_defense, defense_power: perm + temp } } }));
          continue;
        }
        for (const c of step.claimants) {
          const played = plays.filter(p => p.pid === c.player_id && p.tile === step.tile_key && p.card.card_type === 'claim');
          expect(c.power, `${s.id}: ${c.player_id}'s power on ${step.tile_key}`).toBe(played.reduce((a, p) => a + p.card.power, 0));
        }
        if (t.owner) expect(step.defender_power, `${s.id}: defense on ${step.tile_key}`).toBe(t.defense_power);
        const winner = expectedWinner(t, step.claimants);
        expect(step.winner_id, `${s.id}: winner on ${step.tile_key}`).toBe(winner);
        expect(step.is_base_raid ?? false).toBe(t.is_base);
        if (winner && winner !== t.owner && !t.is_base) {
          set(x => ({ tiles: { ...x.tiles, [step.tile_key]: { ...t, owner: winner } } }));
        }
      }
    },
    banner: async () => {},
    pop: () => {},
    flyCard: async () => {},
    flyStar: async () => {},
    fx: () => null,
    sfx: () => {},
  };
  await s.run(ctx);
  return w;
}

const owners = (w: World) => Object.fromEntries(Object.entries(w.tiles).map(([k, t]) => [k, [t.owner, t.permanent_defense_bonus]]));

describe('tutorial scenes', () => {
  it('every scene plays legal moves and resolves by the rules', async () => {
    for (const s of SCENES) await dryRun(s);
  });

  it('each scene picks up where the one before left off', async () => {
    for (const [a, b] of [['clash', 'defend'], ['defend', 'walls'], ['walls', 'stars'], ['stars', 'score'], ['score', 'buy'], ['raid', 'win']]) {
      const end = await dryRun(scene(a));
      expect(owners(scene(b).start()), `${a} → ${b}`).toEqual(owners(end));
    }
    const claimEnd = await dryRun(scene('claim'));
    for (const [k, t] of Object.entries(claimEnd.tiles)) {
      if (t.owner === YOU) expect(scene('clash').start().tiles[k].owner).toBe(YOU);
    }
  });

  it('the numbers the narration quotes add up', async () => {
    // "You can claim tiles next to land you own, like the glowing ones."
    expect(frontier(scene('base').start().tiles, YOU)).toHaveLength(5);
    // "Your 9 tiles make 3 VP, plus 1 VP for your connected star: 4 VP."
    const score = scoreVp(scene('score').start().tiles, YOU);
    expect(score).toEqual({ tiles: 9, tileVp: 3, starVp: 1, total: 4 });
    expect(pathToBase(scene('score').start().tiles, YOU, STAR)?.length).toBeGreaterThan(1);
    // The raid's Spoils, then the final round reaches the target exactly.
    const raid = await dryRun(scene('raid'));
    expect(raid.bonusVp).toBe(1);
    const win = await dryRun(scene('win'));
    expect(scoreVp(win.tiles, YOU, win.bonusVp).total).toBe(VP_TARGET);
    expect(scoreVp(win.tiles, RIVAL).total).toBeLessThan(VP_TARGET);
  });
});

describe('TutorialOverlay', () => {
  it('steps through scenes with Next / Back and the dots, and closes on Escape', () => {
    const onClose = vi.fn();
    const onPlay = vi.fn();
    render(<SettingsProvider><TutorialOverlay onClose={onClose} onPlay={onPlay} /></SettingsProvider>);
    expect(screen.getByText('Welcome to Card Clash')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Your base')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Back'));
    expect(screen.getByText('Welcome to Card Clash')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('Your base')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: `Step ${SCENES.length}: Claim victory` }));
    fireEvent.click(screen.getByText('Play a game'));
    expect(onPlay).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
