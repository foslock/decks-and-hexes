import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SettingsProvider } from '../components/SettingsContext';
import PlayerEffectPopups from '../components/PlayerEffectPopups';
import type { GridTransform } from '../utils/hexGeometry';
import type { PlayerEffect } from '../types/game';
import { makeCard, makeTile } from './fixtures';

function WithSettings({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}

const transform: GridTransform = { scale: 1, offsetX: 0, offsetY: 0, rotation: 0, pivotX: 0, pivotY: 0 };
const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
const tiles = {
  '2,0': makeTile(2, 0, { is_base: true, base_owner: 'player_1', owner: 'player_1' }),
};

const effect = (overrides: Partial<PlayerEffect> = {}): PlayerEffect => ({
  source_player_id: 'player_0',
  target_player_id: 'player_1',
  card_name: 'Embargo',
  effect: 'Cannot buy next turn',
  effect_type: 'buy_restriction',
  value: 1,
  ...overrides,
});

function renderPopups(effects: PlayerEffect[]) {
  return render(
    <WithSettings>
      <PlayerEffectPopups
        effects={effects}
        gridTransform={transform}
        gridRect={rect}
        tiles={tiles}
        playerNames={{ player_0: 'Alice', player_1: 'Bob' }}
        activePlayerId="player_1"
        animSpeed={0}
      />
    </WithSettings>,
  );
}

describe('player effect callouts', () => {
  it('shows the card, the effect and the source player on each callout', () => {
    const { container } = renderPopups([effect(), effect({ card_name: 'Tithe', effect: '+2 Resources', effect_type: 'gain_resources' })]);
    const callouts = container.querySelectorAll('[data-effect-callout]');
    expect(callouts.length).toBe(2);
    expect(callouts[0]).toHaveTextContent('Embargo');
    expect(callouts[0]).toHaveTextContent('Cannot buy next turn');
    expect(callouts[0]).toHaveTextContent('Alice');
    expect(callouts[1]).toHaveTextContent('+2 Resources');
  });

  it('flies a mini copy of an added card from its source tile', () => {
    const added = makeCard({ id: 'lg', definition_id: 'neutral_land_grant', name: 'Land Grant', card_type: 'passive' });
    const { container } = renderPopups([effect({
      card_name: 'Surveyor', effect: '+1 Land Grant', effect_type: 'grant_land_grants',
      source_q: 0, source_r: 0, added_card_name: 'Land Grant', added_card_count: 1, added_card: added,
    })]);
    // The flight carries the full card face (scaled down), not a text chip.
    const fly = [...container.querySelectorAll<HTMLElement>('div')].find(d => d.style.animation.startsWith('flyCard_'));
    expect(fly).toBeTruthy();
    expect(fly!.querySelector('[style*="scale(0.24)"]')).toBeTruthy();
    expect(fly).toHaveTextContent('Land Grant');
  });
});
