// Boot handshake with the loading bar in index.html. The bar shows from the
// first paint; the app calls signalAppReady() once the first screen can
// animate in, and the bar fades out on that same frame.

declare global {
  interface Window {
    cardClashReady?: () => void;
  }
}

let signalled = false;

export function signalAppReady(): void {
  if (signalled) return;
  signalled = true;
  window.cardClashReady?.();
}

/** True once the boot loader has been dismissed (e.g. returning to home later). */
export function appHasBooted(): boolean {
  return signalled;
}

/** Resolve when the UI fonts are ready (capped so a blocked font CDN can't stall boot). */
export function waitForFonts(timeoutMs = 3000): Promise<void> {
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fonts?.load) return Promise.resolve();
  const loads = Promise.all([
    fonts.load("900 48px 'Cinzel'"),
    fonts.load("700 16px 'Philosopher'"),
    fonts.load("400 16px 'Philosopher'"),
  ]).then(() => fonts.ready).then(() => undefined, () => undefined);
  return Promise.race([loads, new Promise<void>(r => setTimeout(r, timeoutMs))]);
}

/** Resolve when the given images are decoded (capped). */
export function waitForImages(srcs: string[], timeoutMs = 4000): Promise<void> {
  const decodes = srcs.map(src => {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return img.decode ? img.decode().catch(() => undefined) : Promise.resolve();
  });
  return Promise.race([Promise.all(decodes).then(() => undefined), new Promise<void>(r => setTimeout(r, timeoutMs))]);
}
