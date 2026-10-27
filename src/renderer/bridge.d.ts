import type { ClickyBridge } from '../preload/preload';

declare global {
  interface Window {
    clicky: ClickyBridge;
  }
}

export {};
