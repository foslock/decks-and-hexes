import type { ReactNode } from 'react';
import type { Card, ResolutionEffect, ResolutionStep } from '../../types/game';
import type { BoardFx } from '../../board3d/boardTypes';
import type { CameraShot } from '../../board3d/engine';
import type { SoundApi } from '../../audio/useSound';
import { BARRICADE, DEBT, EXPLORE, GATHER, LEVY, MERCENARY, RUBBLE, SIEGE_TOWER, SPOILS, WATCHTOWER } from './tutorialCards';
import {
  BASE_RIVAL, BASE_YOU, CENTER_VP, FINAL_STAR, FRONT, LAND, RIVAL, RIVAL_COLOR, STAR, YOU, YOU_COLOR,
  board, cardGain, claimStep, copy, defenseStep, frontier, makeWorld, parseKey, type World,
} from './tutorialWorld';
import { axialToPixel } from '../../utils/hexGeometry';

/** Where a pop-up number or a flying card starts / ends. */
export type Anchor =
  | { tile: string }
  | { hud: 'vp' | 'rivalVp' | 'actions' | 'resources' }
  | { pile: 'draw' | 'discard' }
  | { shop: string };

/** What a scene's script can do. Every call is cancelled (it throws) when
 *  the player moves to another scene. */
export interface TutorialCtx {
  /** Pause; scaled by the animation speed setting. */
  wait(ms: number): Promise<void>;
  get(): World;
  set(patch: Partial<World> | ((w: World) => Partial<World>)): void;
  /** Glide the camera; resolves when it arrives. */
  fly(shot: CameraShot): Promise<void>;
  /** Deal cards from the draw pile into the hand. */
  deal(cards: Card[]): Promise<void>;
  /** Play a hand card: lift it, aim at the tile, fly it onto the board.
   *  No tile: an engine card (it resolves at once). */
  play(cardId: string, tile?: string, opts?: { from?: string; temp?: number; perm?: number }): Promise<void>;
  /** The rival plays a card face down: it goes out of sight (to their chip in
   *  the top bar) and only lands on its tile at the reveal. */
  rivalPlay(card: Card, tile: string, from: string): Promise<void>;
  /** "Reveal" — the rival's hidden plays land on their tiles and every
   *  face-down card turns over. */
  reveal(): Promise<void>;
  /** Run the real resolve animation for these steps (and what card effects
   *  do on their tiles). */
  resolve(steps: ResolutionStep[], effects?: ResolutionEffect[]): Promise<void>;
  banner(text: string, sub?: string, opts?: { hold?: number; stay?: boolean; big?: boolean }): Promise<void>;
  pop(text: string, at: Anchor, tone?: 'gold' | 'blue' | 'green' | 'red'): void;
  /** Fly a card (null = card back) between two anchors. */
  flyCard(card: Card | null, from: Anchor, to: Anchor, opts?: { duration?: number; arc?: number; fromScale?: number; toScale?: number }): Promise<void>;
  /** A gold VP star flies from one anchor to another. */
  flyStar(from: Anchor, to: Anchor): Promise<void>;
  fx(): BoardFx | null;
  /** Play one of the game's sound effects. */
  sfx(name: Exclude<keyof SoundApi, 'claimSmash' | 'phaseCall'>): void;
}

export interface Scene {
  id: string;
  /** Small caps over the title ("Round 1", "A few rounds later"). */
  eyebrow: string;
  title: string;
  body: ReactNode;
  /** A how-to-do-it-in-the-game hint (desktop only). */
  tip?: string;
  start: () => World;
  run: (ctx: TutorialCtx) => Promise<void>;
}

const px = (k: string) => { const [q, r] = parseKey(k); return axialToPixel(q, r); };

// ── Hands (distinct copies so each card has its own id) ─────────────────
const E1 = copy(EXPLORE, 1), E2 = copy(EXPLORE, 2), E3 = copy(EXPLORE, 3);
const G1 = copy(GATHER, 1), G2 = copy(GATHER, 2);
const OPENING_HAND = [E1, G1, E2, G2, E3];
const levy = copy(LEVY, 'a');
const watchtower = copy(WATCHTOWER, 'a');
const barricade = copy(BARRICADE, 'a');
const merc = copy(MERCENARY, 'a');
const merc2 = copy(MERCENARY, 'b');
const siege = copy(SIEGE_TOWER, 'a');
/** The Debts Mercenary and Siege Tower bring you. */
const debtStar = copy(DEBT, 'star'), debtRaid = copy(DEBT, 'raid'), debtWin = copy(DEBT, 'win');
const lastHand = [copy(EXPLORE, 'f1'), copy(EXPLORE, 'f2'), merc2, copy(GATHER, 'f3'), copy(GATHER, 'f4')];
const filler = (tag: string) => [copy(EXPLORE, `${tag}1`), copy(GATHER, `${tag}2`), copy(EXPLORE, `${tag}3`), copy(GATHER, `${tag}4`)];

// ── Boards at each point of the story ───────────────────────────────────
const youMid = [...LAND.youStart, ...LAND.youFirst, ...LAND.youMid];
const rivalMid = [...LAND.rivalStart, ...LAND.rivalMid];
const youLate = [...youMid, FRONT, STAR, ...LAND.youLate];
const rivalLate = [...LAND.rivalStart, '1,-3', '2,-3', '-1,-3', ...LAND.rivalLate];

const boardStart = () => board(LAND.youStart, LAND.rivalStart);
const boardMid = () => board(youMid, rivalMid);
const boardFront = () => board([...youMid, FRONT], rivalMid);
const boardWalled = () => board([...youMid, FRONT], rivalMid, { [FRONT]: 2 });
const boardStar = () => board([...youMid, FRONT, STAR], rivalMid, { [FRONT]: 2 });
const boardLate = () => board(youLate, rivalLate, { [FRONT]: 2 });

/** A small pause to let a beat land before the next. */
const BEAT = 650;

export const SCENES: Scene[] = [
  {
    id: 'welcome',
    eyebrow: 'Welcome',
    title: 'Welcome to Card Clash',
    body: <>Card Clash is a race for territory. Each round, everyone plays cards <b>at the same time</b> to claim land, defend it and earn <b>Victory Points</b> (VP). Here's how a game works.</>,
    start: () => makeWorld({ tiles: boardStart() }),
    // A slow sweep across the island; the bases are pointed out next.
    run: async (ctx) => {
      await ctx.fly({ zoom: 0.94, tilt: 0.64, rotation: 0.5, seconds: 4.2 });
      await ctx.fly({ zoom: 0.96, tilt: 0.58, rotation: 0.2, seconds: 4 });
    },
  },
  {
    id: 'base',
    eyebrow: 'The board',
    title: 'Your base',
    body: <>This castle is your <b>base</b> — it can never be captured. You start with it and the tile beside it, and you can claim tiles <b>next to land you own</b>, like the glowing ones. Your rival starts across the island.</>,
    start: () => makeWorld({ tiles: boardStart() }),
    run: async (ctx) => {
      await ctx.fly({ keys: [BASE_YOU, '0,3'], zoom: 2.3, tilt: 0.72, rotation: -0.25, seconds: 2.4, arc: 0.12 });
      const b = px(BASE_YOU);
      ctx.fx()?.pillar(b.x, b.y, YOU_COLOR, 1400);
      ctx.fx()?.shockwave(b.x, b.y, YOU_COLOR, 1.1, 800);
      ctx.sfx('spotlightYou');
      await ctx.wait(700);
      ctx.set(w => ({ highlight: frontier(w.tiles, YOU) }));
      ctx.sfx('tileGlow');
      await ctx.wait(2200);
      await ctx.fly({ keys: [BASE_RIVAL, '0,-3'], zoom: 2.1, tilt: 0.7, rotation: 0.2, seconds: 2.6, arc: 0.3 });
      const r = px(BASE_RIVAL);
      ctx.fx()?.pillar(r.x, r.y, RIVAL_COLOR, 1400);
      ctx.sfx('spotlightRival');
      await ctx.wait(1500);
      await ctx.fly({ keys: [BASE_YOU, '0,3'], zoom: 2.15, tilt: 0.66, rotation: -0.1, seconds: 2.4, arc: 0.3 });
    },
  },
  {
    id: 'cards',
    eyebrow: 'Round 1',
    title: 'Cards and actions',
    body: <>Each round you draw <b>5 cards</b> and get <b>5 actions</b>; playing a card costs 1 action. Every deck starts with <b>Explore</b> and <b>Gather</b>. Gather earns 2 <b>resources</b>, which you'll spend on new cards.</>,
    tip: 'Cards that gain resources or actions take effect the moment you play them.',
    start: () => makeWorld({ tiles: boardStart(), showHand: true, phase: 'Play phase' }),
    run: async (ctx) => {
      await ctx.fly({ keys: ['0,3', '0,2'], zoom: 2.0, tilt: 0.56, rotation: 0, seconds: 1.8, lower: 0.4 });
      await ctx.deal(OPENING_HAND);
      await ctx.wait(800);
      await ctx.play(G1.id);
      await ctx.wait(BEAT);
    },
  },
  {
    id: 'claim',
    eyebrow: 'Round 1',
    title: 'Claim land',
    body: <><b>Explore</b> claims an empty tile next to yours. Its power is 0 — but empty land has <b>0 defense</b>, and a tie on empty land goes to the attacker. Play as many cards as your actions allow, then reveal.</>,
    tip: 'In a game, drag a card onto a glowing tile, then press Submit Play.',
    start: () => makeWorld({
      tiles: boardStart(), showHand: true, phase: 'Play phase',
      hand: [E1, E2, G2, E3], drawCount: 5, actions: 4, resources: 2,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: ['0,3', '-1,3', '1,2'], zoom: 2.4, tilt: 0.6, rotation: 0.12, seconds: 1.8, lower: 0.8 });
      ctx.set(w => ({ highlight: frontier(w.tiles, YOU) }));
      ctx.sfx('tileGlow');
      await ctx.wait(500);
      await ctx.play(E1.id, '-1,3', { from: '0,3' });
      await ctx.play(E2.id, '1,2', { from: '0,3' });
      ctx.set({ highlight: [] });
      await ctx.wait(BEAT);
      await ctx.reveal();
      await ctx.resolve([
        claimStep('-1,3', [{ pid: YOU, power: 0, from: '0,3' }], { winner: YOU }),
        claimStep('1,2', [{ pid: YOU, power: 0, from: '0,3' }], { winner: YOU }),
      ]);
      ctx.set({ phase: null });
    },
  },
  {
    id: 'clash',
    eyebrow: 'A few rounds later',
    title: 'Everyone plays at once',
    body: <>Everyone places cards <b>face down at the same time</b>. You <b>won't know which tiles your rival plays on</b> — or what — until every card is revealed together. When players claim the same tile, the <b>higher power wins</b>. <b>Levy</b> has power 1 and gives back the action it cost.</>,
    tip: 'Your rival can\'t see where you play until the reveal, either.',
    start: () => makeWorld({
      tiles: boardMid(), round: 4, showHand: true, phase: 'Play phase',
      hand: [levy, ...filler('c')], drawCount: 6, discard: [E1, G1], resources: 3,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: [FRONT, '2,1', '2,-1'], zoom: 2.3, tilt: 0.62, rotation: -0.35, seconds: 2.4, arc: 0.2, lower: 1.3 });
      ctx.set({ highlight: [FRONT] });
      ctx.sfx('tileGlow');
      await ctx.wait(500);
      await ctx.play(levy.id, FRONT, { from: '2,1' });
      ctx.set({ highlight: [] });
      await ctx.wait(800);
      await ctx.rivalPlay(copy(EXPLORE, 'r1'), FRONT, '2,-1');
      await ctx.wait(1100);
      await ctx.reveal();
      await ctx.resolve([
        claimStep(FRONT, [{ pid: YOU, power: 1, from: '2,1' }, { pid: RIVAL, power: 0, from: '2,-1' }], { winner: YOU }),
      ]);
      ctx.set({ phase: null });
    },
  },
  {
    id: 'defend',
    eyebrow: 'The next round',
    title: 'Defend your land',
    body: <>Your rival strikes back with Levy (power 1). <b>Watchtower</b> gives your tile <b>+2 defense</b> this round. To capture a tile, power must <b>beat</b> its defense — <b>ties go to the defender</b>.</>,
    start: () => makeWorld({
      tiles: boardFront(), round: 5, showHand: true, phase: 'Play phase',
      hand: [watchtower, ...filler('d')], drawCount: 4, discard: [E1, G1, levy], resources: 4,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: [FRONT, '2,-1'], zoom: 2.6, tilt: 0.7, rotation: 0.35, seconds: 2.2, lower: 1.2 });
      await ctx.rivalPlay(copy(LEVY, 'r'), FRONT, '2,-1');
      await ctx.wait(500);
      await ctx.play(watchtower.id, FRONT, { temp: 2 });
      await ctx.wait(BEAT);
      await ctx.reveal();
      await ctx.resolve([
        defenseStep(FRONT, YOU, 0, 2),
        claimStep(FRONT, [{ pid: RIVAL, power: 1, from: '2,-1' }], { defender: YOU, defense: 2, defenderFrom: '2,1', winner: YOU }),
      ]);
      ctx.set({ phase: null });
      await ctx.wait(900);
      // The round ends: Watchtower's defense wears off.
      ctx.set(w => ({ tiles: { ...w.tiles, [FRONT]: { ...w.tiles[FRONT], defense_power: 0 } } }));
    },
  },
  {
    id: 'walls',
    eyebrow: 'Round 6',
    title: 'Build walls',
    body: <><b>Barricade</b> adds +2 defense that lasts until the tile is captured. Lasting defense raises <b>walls</b> — the stronger the defense, the bigger the wall. The big hex in the center starts heavily walled.</>,
    start: () => makeWorld({
      tiles: boardFront(), round: 6, showHand: true, phase: 'Play phase',
      hand: [barricade, ...filler('w')], drawCount: 9, resources: 2,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: [FRONT], zoom: 2.9, tilt: 0.86, rotation: -0.5, seconds: 2.2, lower: 0.9 });
      await ctx.play(barricade.id, FRONT, { perm: 2 });
      await ctx.wait(BEAT);
      await ctx.reveal();
      await ctx.resolve([defenseStep(FRONT, YOU, 2, 0)]);
      ctx.set({ phase: null });
      await ctx.wait(700);
      await ctx.fly({ keys: [FRONT], zoom: 2.8, tilt: 0.8, rotation: 0.55, seconds: 3.4 });
      await ctx.fly({ keys: [CENTER_VP], zoom: 2.4, tilt: 0.86, rotation: 0.2, seconds: 2.6, arc: 0.15 });
    },
  },
  {
    id: 'stars',
    eyebrow: 'Round 7',
    title: 'Win star hexes',
    body: <><b>Star hexes</b> score VP while they connect to your base through your land: <b>1 VP</b>, or <b>2 VP</b> for the big center hex. They're defended (2 or 3), so bring power — <b>Mercenary</b> has power 3, but it gives you a <b>Debt</b>: a card that takes 3 resources to trash.</>,
    start: () => makeWorld({
      tiles: boardWalled(), round: 7, showHand: true, phase: 'Play phase',
      hand: [merc, ...filler('s')], drawCount: 4, discard: [barricade, levy], resources: 4,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: [STAR, '-1,3'], zoom: 2.45, tilt: 0.66, rotation: 0.4, seconds: 2.6, arc: 0.2, lower: 1.0 });
      const s = px(STAR);
      ctx.fx()?.pillar(s.x, s.y, 0xffd24a, 1300);
      ctx.sfx('spotlightStar');
      await ctx.wait(800);
      await ctx.play(merc.id, STAR, { from: '-1,3' });
      await ctx.wait(BEAT);
      await ctx.reveal();
      await ctx.resolve(
        [claimStep(STAR, [{ pid: YOU, power: 3, from: '-1,3' }], { winner: YOU })],
        [cardGain(STAR, YOU, debtStar, 'Mercenary')],
      );
      ctx.set({ phase: null, paths: [STAR] });
      await ctx.wait(600);
      ctx.pop('+1 VP', { tile: STAR }, 'gold');
      await ctx.flyStar({ tile: STAR }, { hud: 'vp' });
      await ctx.wait(900);
      await ctx.fly({ keys: [CENTER_VP], zoom: 2.25, tilt: 0.8, rotation: 0.1, seconds: 2.8, arc: 0.15 });
      const c = px(CENTER_VP);
      ctx.fx()?.pillar(c.x, c.y, 0xffd24a, 1500);
      ctx.fx()?.shockwave(c.x, c.y, 0xffd24a, 1.3, 900);
      ctx.sfx('spotlightStar');
      await ctx.wait(1200);
    },
  },
  {
    id: 'score',
    eyebrow: 'Scoring',
    title: 'Land is points too',
    body: <>Every <b>3 tiles</b> you own are worth <b>1 VP</b>. Your 9 tiles make 3 VP, plus 1 VP for your connected star: <b>4 VP</b>. Keep your land connected — a star cut off from your base scores nothing.</>,
    start: () => makeWorld({
      tiles: boardStar(), round: 7, showHand: true, paths: [STAR],
      hand: filler('s'), drawCount: 4, discard: [barricade, levy, merc, debtStar], resources: 4,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: [BASE_YOU, '1,1', '-2,3', '2,0'], zoom: 1.75, tilt: 0.5, rotation: 0, seconds: 2.2 });
      const groups = [[BASE_YOU, '0,3', '1,3'], ['-1,3', '0,2', '1,2'], ['2,1', FRONT, STAR]];
      for (const g of groups) {
        ctx.set({ pulse: g });
        ctx.sfx('vpGain');
        ctx.pop('+1 VP', { tile: g[1] }, 'gold');
        await ctx.wait(1100);
      }
      ctx.set({ pulse: [STAR], highlight: [STAR] });
      ctx.sfx('spotlightStar');
      ctx.pop('+1 VP', { tile: STAR }, 'gold');
      await ctx.wait(1500);
      ctx.set({ pulse: [], highlight: [] });
    },
  },
  {
    id: 'buy',
    eyebrow: 'Buy phase',
    title: 'Build your deck',
    body: <>After each round comes the <b>buy phase</b>. Unspent resources carry over. Buy cards from the shared market or your archetype's own market — they go to your <b>discard pile</b> and turn up in later hands.</>,
    tip: 'Upgrades cost 5 resources and make a card permanently stronger.',
    start: () => makeWorld({
      tiles: boardStar(), round: 7, showHand: true, phase: 'Buy phase', paths: [STAR],
      hand: filler('s'), drawCount: 4, discard: [barricade, levy, merc, debtStar], resources: 6,
    }),
    run: async (ctx) => {
      await ctx.fly({ zoom: 1.0, tilt: 0.5, rotation: -0.15, seconds: 2 });
      ctx.set({ shop: { cards: [copy(LEVY, 'shop'), copy(WATCHTOWER, 'shop'), copy(MERCENARY, 'shop')], hot: null, bought: [] } });
      await ctx.wait(1500);
      const pick = `${MERCENARY.definition_id}-shop`;
      ctx.set(w => ({ shop: w.shop && { ...w.shop, hot: pick } }));
      await ctx.wait(1100);
      ctx.sfx('cardPurchase');
      const price = MERCENARY.buy_cost ?? 0;
      ctx.set(w => ({ resources: w.resources - price, shop: w.shop && { ...w.shop, bought: [pick] } }));
      ctx.pop(`-${price}`, { hud: 'resources' }, 'red');
      await ctx.flyCard(copy(MERCENARY, 'bought'), { shop: pick }, { pile: 'discard' }, { duration: 750, arc: 90 });
      ctx.set(w => ({ discard: [...w.discard, copy(MERCENARY, 'bought')] }));
      await ctx.wait(1300);
      ctx.set({ shop: null, phase: null });
    },
  },
  {
    id: 'raid',
    eyebrow: 'Late in the game',
    title: 'Raid a base',
    body: <>Bases have <b>3 defense</b> and can never be taken — but a successful <b>raid</b> wins you a <b>Spoils</b> card (+1 VP) and leaves the defender a useless <b>Rubble</b> card. <b>Siege Tower</b> has power 6 — and, like Mercenary, brings you a Debt.</>,
    start: () => makeWorld({
      tiles: boardLate(), round: 11, showHand: true, phase: 'Play phase', paths: [STAR],
      hand: [siege, ...filler('k')], drawCount: 8, discard: [merc, barricade], resources: 3,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: [BASE_RIVAL, '1,-4'], zoom: 2.45, tilt: 0.72, rotation: 0.25, seconds: 3.0, arc: 0.3, lower: 1.1 });
      await ctx.play(siege.id, BASE_RIVAL, { from: '1,-4' });
      await ctx.wait(BEAT);
      await ctx.reveal();
      await ctx.resolve(
        [claimStep(BASE_RIVAL, [{ pid: YOU, power: 6, from: '1,-4' }], { defender: RIVAL, defense: 3, defenderFrom: '0,-3', winner: YOU, baseRaid: true })],
        [cardGain(BASE_RIVAL, YOU, debtRaid, 'Siege Tower')],
      );
      ctx.set({ phase: null });
      await ctx.wait(300);
      const spoils = ctx.flyCard(copy(SPOILS, 'won'), { tile: BASE_RIVAL }, { hud: 'vp' }, { duration: 1000, arc: 120, fromScale: 0.42, toScale: 0.12 });
      await ctx.wait(250);
      await ctx.flyCard(copy(RUBBLE, 'lost'), { tile: BASE_RIVAL }, { hud: 'rivalVp' }, { duration: 1000, arc: 80, fromScale: 0.42, toScale: 0.12 });
      await spoils;
      ctx.set(w => ({ bonusVp: w.bonusVp + 1 }));
      ctx.sfx('vpGain');
      ctx.pop('+1 VP', { hud: 'vp' }, 'gold');
      await ctx.wait(BEAT);
    },
  },
  {
    id: 'win',
    eyebrow: 'The final round',
    title: 'Claim victory',
    body: <>Reach the <b>VP target</b> — 10 on this map — and you win when the round ends. If several players get there together, the highest VP wins. That's all you need to know. Good luck!</>,
    start: () => makeWorld({
      tiles: boardLate(), round: 12, showHand: true, phase: 'Play phase', paths: [STAR], bonusVp: 1,
      hand: lastHand,
      drawCount: 3, discard: [siege, debtRaid, barricade, levy], resources: 4,
    }),
    run: async (ctx) => {
      await ctx.fly({ keys: ['1,1', '-2,2', FINAL_STAR], zoom: 1.5, tilt: 0.55, rotation: 0, seconds: 2.6, arc: 0.15, lower: 0.7 });
      await ctx.play(lastHand[0].id, '1,1', { from: '1,2' });
      await ctx.play(lastHand[1].id, '-2,2', { from: '-1,2' });
      await ctx.play(merc2.id, FINAL_STAR, { from: FRONT });
      await ctx.wait(BEAT);
      await ctx.reveal();
      await ctx.resolve([
        claimStep('1,1', [{ pid: YOU, power: 0, from: '1,2' }], { winner: YOU }),
        claimStep('-2,2', [{ pid: YOU, power: 0, from: '-1,2' }], { winner: YOU }),
        claimStep(FINAL_STAR, [{ pid: YOU, power: 3, from: FRONT }], { winner: YOU }),
      ], [cardGain(FINAL_STAR, YOU, debtWin, 'Mercenary')]);
      ctx.set({ phase: null, paths: [STAR, FINAL_STAR] });
      await ctx.wait(500);
      ctx.set({ victory: true });
      ctx.sfx('victoryJingle');
      const fx = ctx.fx();
      const b = px(BASE_YOU);
      fx?.pillar(b.x, b.y, YOU_COLOR, 2400);
      fx?.shockwave(b.x, b.y, 0xffd24a, 2.2, 1400);
      for (const k of [STAR, FINAL_STAR]) { const p = px(k); fx?.pillar(p.x, p.y, 0xffd24a, 2000); }
      void ctx.banner('Victory!', '10 VP — you win the game', { stay: true, big: true });
      await ctx.fly({ zoom: 1.0, tilt: 0.6, rotation: 0.9, seconds: 6 });
    },
  },
];
