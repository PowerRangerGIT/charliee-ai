// Actualizaciones desde GitHub Releases (electron-updater). La app instalada
// busca versiones nuevas al arrancar y cada pocas horas; si "Actualizar
// automáticamente" está activo, la descarga en segundo plano y la instala al
// cerrar (o al pulsar "Reiniciar para actualizar").

import { app, Notification } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'dev' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let state: UpdateState = { kind: 'idle' };
let onChange: (s: UpdateState) => void = () => {};
let pendingVersion = '';
let started = false;

function set(next: UpdateState) {
  state = next;
  onChange(state);
}

export function updateState() {
  return state;
}

export function describeUpdate(s: UpdateState): string {
  switch (s.kind) {
    case 'dev':
      return 'Las actualizaciones solo funcionan en la app instalada';
    case 'checking':
      return 'Buscando actualizaciones…';
    case 'up-to-date':
      return `Tienes la última versión (${app.getVersion()})`;
    case 'available':
      return `Versión ${s.version} disponible`;
    case 'downloading':
      return `Descargando ${s.version}: ${Math.round(s.percent)}%`;
    case 'ready':
      return `Versión ${s.version} lista: se instala al reiniciar`;
    case 'error':
      return `No pude buscar actualizaciones: ${s.message}`;
    default:
      return `Versión ${app.getVersion()}`;
  }
}

export function startUpdater(opts: { autoDownload: () => boolean; onChange: (s: UpdateState) => void }) {
  onChange = opts.onChange;
  if (!app.isPackaged) {
    set({ kind: 'dev' });
    return;
  }
  if (started) return;
  started = true;

  autoUpdater.autoDownload = opts.autoDownload();
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => set({ kind: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ kind: 'up-to-date' }));
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    pendingVersion = info.version;
    set(autoUpdater.autoDownload ? { kind: 'downloading', version: info.version, percent: 0 } : { kind: 'available', version: info.version });
    if (!autoUpdater.autoDownload) {
      notify(`Clicky Local ${info.version} disponible`, 'Ábrelo desde la bandeja para descargarla.');
    }
  });
  autoUpdater.on('download-progress', (p) => set({ kind: 'downloading', version: pendingVersion, percent: p.percent }));
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    set({ kind: 'ready', version: info.version });
    notify(`Clicky Local ${info.version} lista`, 'Se instalará al cerrar la app, o reinicia ahora desde la bandeja.');
  });
  autoUpdater.on('error', (err: Error) => set({ kind: 'error', message: err.message.split('\n')[0].slice(0, 160) }));

  setTimeout(() => void checkForUpdates(), 10_000);
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
}

/** Respeta el ajuste actual de descarga automática en cada búsqueda. */
export async function checkForUpdates(autoDownload?: boolean) {
  if (!app.isPackaged) {
    set({ kind: 'dev' });
    return;
  }
  if (state.kind === 'downloading' || state.kind === 'ready') return;
  if (autoDownload !== undefined) autoUpdater.autoDownload = autoDownload;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    // El evento 'error' del updater ya actualizó el estado.
  }
}

export async function downloadUpdate() {
  if (state.kind !== 'available') return;
  set({ kind: 'downloading', version: state.version, percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    set({ kind: 'error', message: err instanceof Error ? err.message.slice(0, 160) : String(err) });
  }
}

export function installUpdateNow() {
  if (state.kind !== 'ready') return;
  // isSilent=true: sin asistente; isForceRunAfter=true: vuelve a abrir Clicky.
  autoUpdater.quitAndInstall(true, true);
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}
