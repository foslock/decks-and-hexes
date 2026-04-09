import { useMemo, useEffect } from 'react';
import { useSettings } from '../components/SettingsContext';
import { soundEngine } from './SoundEngine';

const NO_OP = () => {};

const NO_OP_SOUNDS = {
  cardDraw: NO_OP,
  cardPlay: NO_OP,
  cardDiscard: NO_OP,
  cardPurchase: NO_OP,
  tileSelect: NO_OP,
  countdownTick: NO_OP,
  countdownGo: NO_OP,
  buttonClick: NO_OP,
  deckShuffle: NO_OP,
  victoryJingle: NO_OP,
  defeatJingle: NO_OP,
  resolveDefenseFortify: NO_OP,
  resolveTileOccupied: NO_OP,
  resolveContested: NO_OP,
  upgradeCard: NO_OP,
  beginJingle: NO_OP,
};

export type SoundApi = typeof NO_OP_SOUNDS;

export function useSound(): SoundApi {
  const { settings } = useSettings();
  const { soundEnabled, soundVolume } = settings;

  useEffect(() => {
    soundEngine.setEnabled(soundEnabled);
    soundEngine.setVolume(soundVolume);
  }, [soundEnabled, soundVolume]);

  return useMemo(() => {
    if (!soundEnabled) return NO_OP_SOUNDS;
    return {
      cardDraw: () => soundEngine.cardDraw(),
      cardPlay: () => soundEngine.cardPlay(),
      cardDiscard: () => soundEngine.cardDiscard(),
      cardPurchase: () => soundEngine.cardPurchase(),
      tileSelect: () => soundEngine.tileSelect(),
      countdownTick: () => soundEngine.countdownTick(),
      countdownGo: () => soundEngine.countdownGo(),
      buttonClick: () => soundEngine.buttonClick(),
      deckShuffle: () => soundEngine.deckShuffle(),
      victoryJingle: () => soundEngine.victoryJingle(),
      defeatJingle: () => soundEngine.defeatJingle(),
      resolveDefenseFortify: () => soundEngine.resolveDefenseFortify(),
      resolveTileOccupied: () => soundEngine.resolveTileOccupied(),
      resolveContested: () => soundEngine.resolveContested(),
      upgradeCard: () => soundEngine.upgradeCard(),
      beginJingle: () => soundEngine.beginJingle(),
    };
  }, [soundEnabled]);
}
