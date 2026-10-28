import type { CharlieeBridge } from '../preload/preload';

declare global {
  interface Window {
    charliee: CharlieeBridge;
  }
}

export {};
