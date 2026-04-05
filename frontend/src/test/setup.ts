// Mock CanvasRenderingContext2D for PixiJS (not available in jsdom)
if (typeof globalThis.CanvasRenderingContext2D === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CanvasRenderingContext2D = class CanvasRenderingContext2D {};
}

// Mock ResizeObserver for components that use it (e.g. CardHand)
globalThis.ResizeObserver = class ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Suppress PixiJS canvas errors in jsdom (getContext returns null).
// Mock getContext so PixiJS doesn't throw during component mount.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(HTMLCanvasElement.prototype as any).getContext = function (_type: string) {
  return {
    canvas: document.createElement('canvas'),
    imageSmoothingEnabled: true,
    fillRect() {},
    clearRect() {},
    getImageData() { return { data: new Uint8ClampedArray(0) }; },
    putImageData() {},
    drawImage() {},
    save() {},
    restore() {},
    scale() {},
    translate() {},
    rotate() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    stroke() {},
    clip() {},
    fillText() {},
    strokeText() {},
    measureText() { return { width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0, fontBoundingBoxAscent: 0, fontBoundingBoxDescent: 0 }; },
    setTransform() {},
    resetTransform() {},
    transform() {},
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    rect() {},
    roundRect() {},
    ellipse() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    arcTo() {},
    isPointInPath() { return false; },
    isPointInStroke() { return false; },
    createImageData() { return { data: new Uint8ClampedArray(0), width: 0, height: 0 }; },
    setLineDash() {},
    getLineDash() { return []; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
  };
};

import '@testing-library/jest-dom/vitest';
