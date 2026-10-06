import { useMemo, useEffect } from 'react';
import { useSettings } from '../components/SettingsContext';
import { soundEngine, type HeldSound } from './SoundEngine';
import { smashSoundName, type SoundName } from './sounds';

const NO_OP = () => {};

const NO_OP_SOUNDS = {
  cardDraw: NO_OP,
  cardPlay: NO_OP,
  cardDiscard: NO_OP,
  cardTrash: NO_OP,
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
  resolveBaseRaidFortify: NO_OP,
  resolveBaseRaidRam: NO_OP,
  resolveBaseRaidShatter: NO_OP,
  resolveBaseRaidHold: NO_OP,
  upgradeCard: NO_OP,
  upgradeCharge: ((): HeldSound => ({ stop: NO_OP })) as () => HeldSound,
  beginJingle: NO_OP,
  tilePop: NO_OP as (delay?: number) => void,
  spotlightYou: NO_OP,
  spotlightRival: NO_OP,
  spotlightStar: NO_OP,
  tileGlow: NO_OP,
  tileAbandon: NO_OP,
  tileScorch: NO_OP,
  floodWave: NO_OP,
  powerBonus: NO_OP,
  coinGain: NO_OP,
  flagPlant: NO_OP,
  phaseCall: NO_OP as (step: 3 | 4 | 5) => void,
  claimSmash: NO_OP as (power: number) => void,
  /** A sound that belongs to something `inMs` from now on screen: heard
   *  right on it, even through slow (Bluetooth) headphones. */
  cue: NO_OP as (name: SoundName, inMs: number) => void,
  /** A claim smashing into a tile `inMs` from now (the end of its wind-up). */
  claimSmashIn: NO_OP as (power: number, inMs: number) => void,
  // Optional extras (not yet wired into components)
  hoverTick: NO_OP,
  coinSpend: NO_OP,
  vpGain: NO_OP,
  phaseChange: NO_OP,
  invalidAction: NO_OP,
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
      cardTrash: () => soundEngine.cardTrash(),
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
      resolveBaseRaidFortify: () => soundEngine.resolveBaseRaidFortify(),
      resolveBaseRaidRam: () => soundEngine.resolveBaseRaidRam(),
      resolveBaseRaidShatter: () => soundEngine.resolveBaseRaidShatter(),
      resolveBaseRaidHold: () => soundEngine.resolveBaseRaidHold(),
      upgradeCard: () => soundEngine.upgradeCard(),
      upgradeCharge: () => soundEngine.upgradeCharge(),
      beginJingle: () => soundEngine.beginJingle(),
      tilePop: (delay?: number) => soundEngine.tilePop(delay),
      spotlightYou: () => soundEngine.spotlightYou(),
      spotlightRival: () => soundEngine.spotlightRival(),
      spotlightStar: () => soundEngine.spotlightStar(),
      tileGlow: () => soundEngine.tileGlow(),
      tileAbandon: () => soundEngine.tileAbandon(),
      tileScorch: () => soundEngine.tileScorch(),
      floodWave: () => soundEngine.floodWave(),
      powerBonus: () => soundEngine.powerBonus(),
      coinGain: () => soundEngine.coinGain(),
      flagPlant: () => soundEngine.flagPlant(),
      phaseCall: (step: 3 | 4 | 5) => soundEngine.phaseCall(step),
      claimSmash: (power: number) => soundEngine.claimSmash(power),
      cue: (name: SoundName, inMs: number) => soundEngine.cue(name, inMs),
      claimSmashIn: (power: number, inMs: number) => soundEngine.cue(smashSoundName(power), inMs),
      hoverTick: () => soundEngine.hoverTick(),
      coinSpend: () => soundEngine.coinSpend(),
      vpGain: () => soundEngine.vpGain(),
      phaseChange: () => soundEngine.phaseChange(),
      invalidAction: () => soundEngine.invalidAction(),
    };
  }, [soundEnabled]);
}
