// Mock ResizeObserver for components that use it (e.g. CardHand)
globalThis.ResizeObserver = class ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Suppress PixiJS canvas errors in jsdom (getContext returns null)
const _origListener = process.listeners('unhandledRejection');
process.on('unhandledRejection', (reason: unknown) => {
  if (reason instanceof TypeError && String(reason.message).includes('imageSmoothingEnabled')) {
    return; // Swallow PixiJS canvas init errors in jsdom
  }
  // Re-throw anything else
  throw reason;
});

import '@testing-library/jest-dom/vitest';
