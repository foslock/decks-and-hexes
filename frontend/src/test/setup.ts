// Mock ResizeObserver for components that use it (e.g. CardHand)
globalThis.ResizeObserver = class ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

import '@testing-library/jest-dom/vitest';
