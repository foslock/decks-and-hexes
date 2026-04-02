import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { SettingsProvider } from '../components/SettingsContext';
import PlayerHud from '../components/PlayerHud';
import CardHand from '../components/CardHand';
import MarketPanel from '../components/MarketPanel';
import GameLog from '../components/GameLog';
import SetupScreen from '../components/SetupScreen';
import { makePlayer, makeCard, makeGameState } from './fixtures';

function WithSettings({ children }: { children: ReactNode }) {
  return <SettingsProvider>{children}</SettingsProvider>;
}

describe('PlayerHud', () => {
  const hudProps = { phase: 'plan', totalCards: 8, tileCount: 2, vpTarget: 10 };

  it('renders player name and archetype', () => {
    const player = makePlayer({ name: 'Alice', archetype: 'vanguard' });
    render(<PlayerHud player={player} isActive={true} isCurrent={true} {...hudProps} />);
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
  });

  it('shows VP count', () => {
    const player = makePlayer({ vp: 5 });
    render(<PlayerHud player={player} isActive={true} isCurrent={false} {...hudProps} />);
    expect(screen.getByText(/5/)).toBeInTheDocument();
  });

  it('shows resources', () => {
    const player = makePlayer({ resources: 7 });
    render(<PlayerHud player={player} isActive={true} isCurrent={false} {...hudProps} />);
    expect(screen.getByText(/7/)).toBeInTheDocument();
  });

  it('shows status for submitted plan', () => {
    const player = makePlayer({ has_submitted_plan: true, planned_action_count: 3 });
    render(<PlayerHud player={player} isActive={true} isCurrent={true} {...hudProps} />);
    expect(screen.getByText(/Ready/)).toBeInTheDocument();
  });

  it('shows Planning status when not submitted', () => {
    const player = makePlayer({ has_submitted_plan: false });
    render(<PlayerHud player={player} isActive={true} isCurrent={false} {...hudProps} />);
    expect(screen.getByText(/Planning/)).toBeInTheDocument();
  });

  it('reduces opacity when not active', () => {
    const player = makePlayer();
    const { container } = render(<PlayerHud player={player} isActive={false} isCurrent={false} {...hudProps} />);
    const div = container.firstChild as HTMLElement;
    expect(div.style.opacity).toBe('0.7');
  });
});

describe('CardHand', () => {
  const cards = [
    makeCard({ id: 'c0', name: 'Advance', card_type: 'claim', power: 1 }),
    makeCard({ id: 'c1', name: 'Gather', card_type: 'engine', resource_gain: 2, power: 0 }),
    makeCard({ id: 'c2', name: 'Blitz', card_type: 'claim', power: 4, action_return: 0 }),
  ];

  it('renders all cards', () => {
    render(<WithSettings><CardHand playerId="p0" cards={cards} selectedIndex={null} onSelect={() => {}} onDragPlay={() => {}} onCardDetail={() => {}} disabled={false} deckSize={0} discardCount={0} discardCards={[]} deckCards={[]} /></WithSettings>);
    expect(screen.getByText('Advance')).toBeInTheDocument();
    expect(screen.getByText('Gather')).toBeInTheDocument();
    expect(screen.getByText('Blitz')).toBeInTheDocument();
  });

  it('calls onSelect when card clicked', async () => {
    const onSelect = vi.fn();
    render(<WithSettings><CardHand playerId="p0" cards={cards} selectedIndex={null} onSelect={onSelect} onDragPlay={() => {}} onCardDetail={() => {}} disabled={false} deckSize={0} discardCount={0} discardCards={[]} deckCards={[]} /></WithSettings>);
    await userEvent.click(screen.getByText('Advance'));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('shows empty message when no cards', () => {
    render(<WithSettings><CardHand playerId="p0" cards={[]} selectedIndex={null} onSelect={() => {}} onDragPlay={() => {}} onCardDetail={() => {}} disabled={false} deckSize={0} discardCount={0} discardCards={[]} deckCards={[]} /></WithSettings>);
    expect(screen.getByText(/No cards in hand/)).toBeInTheDocument();
  });

  it('shows dark overlay when disabled', () => {
    const { container } = render(<WithSettings><CardHand playerId="p0" cards={cards} selectedIndex={null} onSelect={() => {}} onDragPlay={() => {}} onCardDetail={() => {}} disabled={true} deckSize={0} discardCount={0} discardCards={[]} deckCards={[]} /></WithSettings>);
    const cardElements = container.querySelectorAll('[role="button"]');
    expect(cardElements.length).toBe(3);
    cardElements.forEach((el) => {
      // Cards should have full opacity (no transparency through overlapping cards)
      expect((el as HTMLElement).style.opacity).toBe('1');
      // A dark overlay div should be visible inside the card
      const overlay = (el as HTMLElement).querySelector('div[style*="position: absolute"]');
      expect(overlay).toBeTruthy();
      expect((overlay as HTMLElement).style.opacity).toBe('1');
    });
  });

  it('shows power in stats line', () => {
    render(<WithSettings><CardHand playerId="p0" cards={cards} selectedIndex={null} onSelect={() => {}} onDragPlay={() => {}} onCardDetail={() => {}} disabled={false} deckSize={0} discardCount={0} discardCards={[]} deckCards={[]} /></WithSettings>);
    expect(screen.getByText('Power 1')).toBeInTheDocument();
    expect(screen.getByText('Power 4')).toBeInTheDocument();
  });

  it('shows resource gain for engine cards', () => {
    render(<WithSettings><CardHand playerId="p0" cards={cards} selectedIndex={null} onSelect={() => {}} onDragPlay={() => {}} onCardDetail={() => {}} disabled={false} deckSize={0} discardCount={0} discardCards={[]} deckCards={[]} /></WithSettings>);
    expect(screen.getByText(/\+2 Resources/)).toBeInTheDocument();
  });
});

describe('MarketPanel', () => {
  const archetypeMarket = [
    makeCard({ id: 'arch_1', name: 'Overrun', buy_cost: 5, power: 5 }),
    makeCard({ id: 'arch_2', name: 'Strike Team', buy_cost: 3, power: 3 }),
  ];
  const neutralMarket = [
    { card: makeCard({ id: 'n1', name: 'Mercenary', buy_cost: 3, power: 3 }), remaining: 5 },
    { card: makeCard({ id: 'n2', name: 'Land Grant', buy_cost: 2, card_type: 'engine' }), remaining: 3 },
  ];

  it('renders archetype and neutral markets', () => {
    render(
      <MarketPanel
        archetypeMarket={archetypeMarket}
        neutralMarket={neutralMarket}
        playerResources={5}
        onBuyArchetype={() => {}}
        onBuyNeutral={() => {}}
        onBuyUpgrade={() => {}}
        onReroll={() => {}}
        onCardDetail={() => {}}
        disabled={false}
      />
    );
    expect(screen.getByText('Overrun')).toBeInTheDocument();
    expect(screen.getByText('Mercenary')).toBeInTheDocument();
    expect(screen.getByText('Land Grant')).toBeInTheDocument();
  });

  it('calls onBuyArchetype when Buy button clicked', async () => {
    const onBuy = vi.fn();
    render(
      <MarketPanel
        archetypeMarket={archetypeMarket}
        neutralMarket={neutralMarket}
        playerResources={10}
        onBuyArchetype={onBuy}
        onBuyNeutral={() => {}}
        onBuyUpgrade={() => {}}
        onReroll={() => {}}
        onCardDetail={() => {}}
        disabled={false}
      />
    );
    // Each market card has a Buy button
    const buyButtons = screen.getAllByText('Buy');
    // Click the Buy for Strike Team (second archetype card)
    await userEvent.click(buyButtons[1]);
    expect(onBuy).toHaveBeenCalledWith('arch_2');
  });

  it('calls onCardDetail when card name clicked in market', async () => {
    const onDetail = vi.fn();
    render(
      <MarketPanel
        archetypeMarket={archetypeMarket}
        neutralMarket={neutralMarket}
        playerResources={10}
        onBuyArchetype={() => {}}
        onBuyNeutral={() => {}}
        onBuyUpgrade={() => {}}
        onReroll={() => {}}
        onCardDetail={onDetail}
        disabled={false}
      />
    );
    await userEvent.click(screen.getByText('Overrun'));
    expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 'arch_1', name: 'Overrun' }));
  });

  it('calls onReroll when reroll button clicked', async () => {
    const onReroll = vi.fn();
    render(
      <MarketPanel
        archetypeMarket={archetypeMarket}
        neutralMarket={neutralMarket}
        playerResources={5}
        onBuyArchetype={() => {}}
        onBuyNeutral={() => {}}
        onBuyUpgrade={() => {}}
        onReroll={onReroll}
        onCardDetail={() => {}}
        disabled={false}
      />
    );
    await userEvent.click(screen.getByText(/Re-roll/));
    expect(onReroll).toHaveBeenCalled();
  });

  it('disables reroll when insufficient resources', () => {
    render(
      <MarketPanel
        archetypeMarket={archetypeMarket}
        neutralMarket={neutralMarket}
        playerResources={1}
        onBuyArchetype={() => {}}
        onBuyNeutral={() => {}}
        onBuyUpgrade={() => {}}
        onReroll={() => {}}
        onCardDetail={() => {}}
        disabled={false}
      />
    );
    const rerollBtn = screen.getByText(/Re-roll/);
    expect(rerollBtn).toBeDisabled();
  });

  it('disables buy upgrade when insufficient resources', () => {
    render(
      <MarketPanel
        archetypeMarket={[]}
        neutralMarket={[]}
        playerResources={3}
        onBuyArchetype={() => {}}
        onBuyNeutral={() => {}}
        onBuyUpgrade={() => {}}
        onReroll={() => {}}
        onCardDetail={() => {}}
        disabled={false}
      />
    );
    const upgradeBtn = screen.getByText(/Buy Upgrade/);
    expect(upgradeBtn).toBeDisabled();
  });
});

describe('GameLog', () => {
  it('renders log entries', () => {
    const entries = ['Game started', '=== Round 1 ===', 'Alice plays Advance'];
    render(<GameLog entries={entries} />);
    expect(screen.getByText('Game started')).toBeInTheDocument();
    expect(screen.getByText('Alice plays Advance')).toBeInTheDocument();
  });

  it('renders phase headers in bold', () => {
    render(<GameLog entries={['=== Round 1 ===']} />);
    const el = screen.getByText('=== Round 1 ===');
    expect(el.tagName).toBe('STRONG');
  });
});

describe('SetupScreen', () => {
  it('renders setup form', () => {
    render(<SetupScreen onStart={() => {}} />);
    expect(screen.getByText('HexDraft')).toBeInTheDocument();
    expect(screen.getByText('Start Game')).toBeInTheDocument();
  });

  it('shows grid size options', () => {
    render(<SetupScreen onStart={() => {}} />);
    expect(screen.getByText(/Small/)).toBeInTheDocument();
    expect(screen.getByText(/Medium/)).toBeInTheDocument();
    expect(screen.getByText(/Large/)).toBeInTheDocument();
  });

  it('calls onStart with config', async () => {
    const onStart = vi.fn();
    render(<SetupScreen onStart={onStart} />);
    await userEvent.click(screen.getByText('Start Game'));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      gridSize: 'small',
      players: expect.arrayContaining([
        expect.objectContaining({ archetype: 'vanguard' }),
        expect.objectContaining({ archetype: 'swarm' }),
      ]),
    }));
  });

  it('allows changing player count', async () => {
    render(<SetupScreen onStart={() => {}} />);
    // Click the "3" button to add a player
    const threeBtn = screen.getByText('3');
    await userEvent.click(threeBtn);
    // Should now have 3 player name inputs
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(3);
  });

  it('allows changing player name', async () => {
    const onStart = vi.fn();
    render(<SetupScreen onStart={onStart} />);
    const inputs = screen.getAllByRole('textbox');
    await userEvent.clear(inputs[0]);
    await userEvent.type(inputs[0], 'Gandalf');
    await userEvent.click(screen.getByText('Start Game'));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({
      players: expect.arrayContaining([
        expect.objectContaining({ name: 'Gandalf' }),
      ]),
    }));
  });
});
