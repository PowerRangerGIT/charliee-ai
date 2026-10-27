// Puente mínimo y seguro entre renderers y main. Solo canales con prefijo conocido.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const ALLOWED = /^(overlay|engine|settings|app):/;

function check(channel: string) {
  if (!ALLOWED.test(channel)) throw new Error(`Canal IPC no permitido: ${channel}`);
}

const api = {
  invoke: (channel: string, ...args: unknown[]) => {
    check(channel);
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel: string, ...args: unknown[]) => {
    check(channel);
    ipcRenderer.send(channel, ...args);
  },
  on: (channel: string, callback: (...args: any[]) => void) => {
    check(channel);
    const listener = (_e: IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld('clicky', api);

export type ClickyBridge = typeof api;
