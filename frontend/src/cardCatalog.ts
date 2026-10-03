import { useEffect, useState } from 'react';
import { BASE } from './api/client';
import type { Card } from './types/game';
import { preloadCardImages, STARTER_CARD_IDS } from './utils/cardImagePreload';

let nameMap: Map<string, Card> | null = null;
let catalogCards: Card[] = [];
let namePattern: RegExp | null = null;
let loadStarted = false;
const subscribers = new Set<() => void>();

function buildIndex(data: Record<string, Card>) {
  catalogCards = Object.values(data);
  const map = new Map<string, Card>();
  const names: string[] = [];
  for (const card of Object.values(data)) {
    if (card.card_type === 'token') continue;
    const key = card.name.toLowerCase();
    if (!map.has(key)) {
      map.set(key, card);
      names.push(card.name);
    }
  }
  names.sort((a, b) => b.length - a.length);
  nameMap = map;
  namePattern = names.length > 0
    ? new RegExp(
        `\\b(${names.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
        'gi',
      )
    : null;
}

function ensureLoaded(): void {
  if (nameMap || loadStarted) return;
  loadStarted = true;
  fetch(`${BASE}/cards`)
    .then(res => (res.ok ? res.json() : Promise.reject(new Error('load failed'))))
    .then((data: Record<string, Card>) => {
      buildIndex(data);
      subscribers.forEach(cb => cb());
    })
    .catch(() => {
      // Swallow — card-name previews just won't appear.
      loadStarted = false;
    });
}

/**
 * Queue every card's art for idle-time preloading once the catalog is
 * available. Starters go first at high priority (they're in every opening
 * hand), then shared-market cards, then *archetype*'s cards, then the rest.
 */
export function preloadCatalogArt(archetype?: string): void {
  preloadCardImages(STARTER_CARD_IDS, 'high');
  const run = () => {
    const rank = (c: Card) =>
      c.archetype === 'shared' || c.archetype === 'neutral' ? 0
        : c.archetype === archetype ? 1 : 2;
    const ids = catalogCards
      .filter(c => c.card_type !== 'token' && c.definition_id)
      .sort((a, b) => rank(a) - rank(b))
      .map(c => c.definition_id);
    preloadCardImages(ids, 'idle');
  };
  if (nameMap) {
    run();
    return;
  }
  const cb = () => { subscribers.delete(cb); run(); };
  subscribers.add(cb);
  ensureLoaded();
}

export interface CardCatalog {
  getCardByName: (name: string) => Card | undefined;
  namePattern: RegExp | null;
}

export function useCardCatalog(): CardCatalog {
  const [, tick] = useState(0);
  useEffect(() => {
    ensureLoaded();
    if (nameMap) return; // already loaded — no need to subscribe
    const cb = () => tick(t => t + 1);
    subscribers.add(cb);
    return () => { subscribers.delete(cb); };
  }, []);
  return {
    getCardByName: (name: string) => nameMap?.get(name.toLowerCase()),
    namePattern,
  };
}
