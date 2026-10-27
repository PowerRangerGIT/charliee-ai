// Proceso principal: bandeja del sistema, overlays por monitor, ventana
// "engine" oculta (micro/voz) y el pipeline completo:
// atajo → grabar → transcribir → captura + IA → señalar → hablar.

import { app, BrowserWindow, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { PointTarget, ProviderId, ProviderSettings, Settings, VoiceState } from '../shared/types';
import {
  captureAllScreens,
  coordinateModeFor,
  imagePointToDisplayLocal,
  sizeLimitFor,
  zoomCrop,
  type ScreenCapture,
} from './capture';
import { isFirstRun, loadSettings, saveSettings } from './config';
import { HOTKEY_LABELS, setHotkey, startHotkeyListener, stopHotkeyListener } from './hotkey';
import { chat, listModels, PROVIDER_LABELS, type ChatTurn } from './llm';
import { addMarks, elementBoxInImage, type AnnotateRequest, type Mark } from './marks';
import { companionSystemPrompt, parsePoint, refineSystemPrompt, type CoordinateMode, type PointParse } from './prompt';
import { encodeWav, synthesizeCloud, transcribeCloud } from './speech';
import { elementAtPoint, listVisibleControls, stopUiAutomation, warmUpUiAutomation } from './uia';
import {
  checkForUpdates,
  describeUpdate,
  downloadUpdate,
  installUpdateNow,
  startUpdater,
  updateState,
  type UpdateState,
} from './updater';

const DEV = process.argv.includes('--dev');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const MIN_RECORDING_SECONDS = 0.35;
const MAX_HISTORY = 10;

if (!app.requestSingleInstanceLock()) app.quit();

let settings: Settings;
let tray: Tray | null = null;
let engineWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
const overlays = new Map<number, BrowserWindow>();

let voiceState: VoiceState = 'idle';
let buddyEnabled = true;
let history: ChatTurn[] = [];
let currentAbort: AbortController | null = null;
let captionTimer: NodeJS.Timeout | null = null;

// --- Utilidades de difusión -------------------------------------------------------

function toOverlays(channel: string, payload?: unknown) {
  for (const win of overlays.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

function status(message: string) {
  console.log(`[clicky] ${message}`);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('app:status', message);
}

function setState(next: VoiceState) {
  voiceState = next;
  toOverlays('overlay:state', next);
}

function setCaption(text: string | null, clearAfterMs?: number) {
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = null;
  toOverlays('overlay:caption', text);
  if (text && clearAfterMs) captionTimer = setTimeout(() => toOverlays('overlay:caption', null), clearAfterMs);
}

function sendOverlayOptions() {
  toOverlays('overlay:options', { enabled: buddyEnabled, showCaption: settings.showCaption });
}

// --- Engine (RPC con la ventana oculta) ------------------------------------------

let engineSeq = 0;
const enginePending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let engineReady: Promise<void>;

function engine<T = unknown>(type: string, payload?: unknown): Promise<T> {
  return engineReady.then(
    () =>
      new Promise<T>((resolve, reject) => {
        const id = ++engineSeq;
        enginePending.set(id, { resolve, reject });
        engineWindow!.webContents.send('engine:cmd', { id, type, payload });
      }),
  );
}

ipcMain.on('engine:reply', (_e, msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
  const pending = enginePending.get(msg.id);
  if (!pending) return;
  enginePending.delete(msg.id);
  if (msg.ok) pending.resolve(msg.result);
  else pending.reject(new Error(msg.error));
});
ipcMain.on('engine:level', (_e, level: number) => toOverlays('overlay:level', level));
ipcMain.on('engine:status', (_e, message: string) => {
  status(message);
  if (voiceState === 'processing') setCaption(message);
});
ipcMain.on('engine:speech-start', () => {
  if (voiceState === 'processing') setState('responding');
});

function createEngineWindow() {
  engineWindow = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  engineReady = new Promise((resolve) => ipcMain.once('engine:ready', () => resolve()));
  engineWindow.loadFile(path.join(RENDERER_DIR, 'engine', 'index.html'));
  if (DEV) engineWindow.webContents.openDevTools({ mode: 'detach' });
}

// --- Overlays -----------------------------------------------------------------------

function createOverlays() {
  for (const win of overlays.values()) win.destroy();
  overlays.clear();

  for (const display of screen.getAllDisplays()) {
    const { bounds } = display;
    const win = new BrowserWindow({
      ...bounds,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      show: false,
      webPreferences: { preload: PRELOAD, backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(RENDERER_DIR, 'overlay', 'index.html'));
    win.webContents.once('did-finish-load', () => {
      // Con DPI mixto Windows a veces recoloca la ventana: reafirmamos bounds.
      win.setBounds(bounds);
      win.webContents.send('overlay:init', { displayId: display.id, bounds });
      win.webContents.send('overlay:state', voiceState);
      win.webContents.send('overlay:options', { enabled: buddyEnabled, showCaption: settings.showCaption });
      win.showInactive();
    });
    overlays.set(display.id, win);
  }
}

let lastCursor = { x: NaN, y: NaN };
function startCursorPolling() {
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (p.x === lastCursor.x && p.y === lastCursor.y) return;
    lastCursor = p;
    toOverlays('overlay:cursor', p);
  }, 16);
}

ipcMain.on('overlay:point-done', () => toOverlays('overlay:pointing-owner', null));

// --- Pipeline de voz --------------------------------------------------------------

function cancelCurrent() {
  currentAbort?.abort();
  currentAbort = null;
  void engine('stopSpeaking').catch(() => {});
  toOverlays('overlay:cancel-point');
}

async function onPushToTalkPress() {
  cancelCurrent();
  setCaption(null);
  setState('listening');
  try {
    await engine('startRecording');
  } catch (err) {
    fail(`No pude abrir el micrófono: ${errorText(err)}`);
  }
}

async function onPushToTalkRelease(cancelled: boolean) {
  if (voiceState !== 'listening') return;
  if (cancelled) {
    await engine('cancelRecording').catch(() => {});
    setState('idle');
    return;
  }

  const abort = new AbortController();
  currentAbort = abort;
  try {
    const { samples, sampleRate } = await engine<{ samples: Float32Array; sampleRate: number }>('stopRecording');
    if (samples.length < sampleRate * MIN_RECORDING_SECONDS) {
      setState('idle');
      return;
    }
    setState('processing');

    const transcript =
      settings.stt.mode === 'local'
        ? await engine<string>('transcribeLocal', {
            samples,
            model: settings.stt.localModel,
            language: settings.stt.language,
          })
        : await transcribeCloud(settings, encodeWav(samples, sampleRate), abort.signal);

    if (abort.signal.aborted) return;
    if (!transcript.trim() || /^\[.*\]$/.test(transcript.trim())) {
      // Whisper devuelve "[BLANK_AUDIO]" o similar con silencio.
      setState('idle');
      return;
    }
    status(`Tú: ${transcript}`);
    await respond(transcript, abort);
  } catch (err) {
    if (!abort.signal.aborted) fail(errorText(err));
  }
}

/** Manda la pregunta (+ capturas) a la IA, señala si hace falta y lo dice en voz alta. */
async function respond(userText: string, abort: AbortController): Promise<string> {
  setState('processing');
  const providerId = settings.provider;
  const provider = settings.providers[providerId];
  const mode = coordinateModeFor(providerId);

  // Captura y lista de controles de Windows en paralelo.
  const [captures, controls] = settings.sendScreenshot
    ? await Promise.all([
        captureAllScreens(sizeLimitFor(providerId, settings.screenshotMaxDimension), mode),
        settings.numberedMarks ? listVisibleControls() : Promise.resolve([]),
      ])
    : [[], []];
  if (abort.signal.aborted) return '';

  const cleanImages = captures.map((c) => c.image);
  const { marks, controlsText } = controls.length
    ? await addMarks(captures, controls, (req) => engine<Uint8Array>('annotate', req))
    : { marks: new Map<number, Mark>(), controlsText: '' };

  let system = companionSystemPrompt({ screenshots: captures.length > 0, marks: marks.size > 0, coordinates: mode });
  if (settings.extraInstructions.trim()) system += `\n\nextra instructions from the user:\n${settings.extraInstructions.trim()}`;

  const started = Date.now();
  const raw = await chat(providerId, provider, {
    system,
    history,
    userText: controlsText ? `${controlsText}\n\nthe user said: ${userText}` : userText,
    images: captures.map((c) => c.image),
    maxTokens: settings.maxTokens,
    signal: abort.signal,
  });
  if (abort.signal.aborted) return '';
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  status(`${PROVIDER_LABELS[providerId]} respondió en ${seconds}s${marks.size ? ` (${marks.size} controles marcados)` : ''}`);

  const parsed = parsePoint(raw);
  history = [...history, { user: userText, assistant: parsed.spokenText }].slice(-MAX_HISTORY);

  // El señalado (y su posible afinado) corre en paralelo con la voz.
  const pointing =
    (parsed.point || parsed.mark !== null) && captures.length
      ? pointAt({ captures, cleanImages, marks, parsed, mode, userText, abort })
          .then((final) => (settings.saveDebug ? saveDebug(captures, raw, final) : undefined))
          .catch((err) => status(`No pude señalar: ${errorText(err)}`))
      : settings.saveDebug
        ? saveDebug(captures, raw, null)
        : Promise.resolve();

  setCaption(parsed.spokenText);
  await speak(parsed.spokenText, abort);
  await pointing;
  if (abort.signal.aborted) return parsed.spokenText;

  setState('idle');
  setCaption(parsed.spokenText, 4000);
  if (currentAbort === abort) currentAbort = null;
  return parsed.spokenText;
}

interface PointRequest {
  captures: ScreenCapture[];
  /** Imágenes sin marcas, para el recorte con zoom. */
  cleanImages: ScreenCapture['image'][];
  marks: Map<number, Mark>;
  parsed: PointParse;
  mode: CoordinateMode;
  userText: string;
  abort: AbortController;
}

interface FinalPoint {
  capture: ScreenCapture;
  target: PointTarget;
  how: string;
}

/**
 * Lleva el compañero a lo que la IA quiso señalar:
 *  - [POINT:#N] → rectángulo exacto del control N.
 *  - Coordenadas → si no había marcas, encaja con el control de Windows bajo
 *    el punto; si no lo confirma, recorte con zoom para que la IA precise.
 */
async function pointAt(req: PointRequest): Promise<FinalPoint | null> {
  const { parsed, abort } = req;
  const label = parsed.label ?? '';

  const fly = (capture: ScreenCapture, target: PointTarget) => {
    toOverlays('overlay:pointing-owner', capture.displayId);
    toOverlays('overlay:point', target);
  };

  if (parsed.mark !== null) {
    const mark = req.marks.get(parsed.mark);
    if (!mark) {
      status(`La IA eligió la marca #${parsed.mark}, que no existe`);
      return null;
    }
    const origin = mark.capture.bounds;
    const rect = { ...mark.element.rect, x: mark.element.rect.x - origin.x, y: mark.element.rect.y - origin.y };
    const target: PointTarget = {
      displayId: mark.capture.displayId,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
      label: label || mark.element.name,
      rect,
    };
    fly(mark.capture, target);
    status(`Señalando #${mark.id} ${mark.element.controlType} "${mark.element.name}"`);
    return { capture: mark.capture, target, how: `marca #${mark.id}` };
  }

  const { captures } = req;
  const capture =
    (parsed.screenNumber && captures[parsed.screenNumber - 1]) || captures.find((c) => c.isCursorScreen) || captures[0];
  const origin = capture.bounds;
  // Si había marcas y aun así eligió coordenadas, lo que busca no es un control:
  // encajar con el control más cercano sería señalar otra cosa.
  const allowSnap = settings.snapToElements && req.marks.size === 0;

  let snappedName = '';
  const resolveTarget = async (local: { x: number; y: number }): Promise<PointTarget> => {
    const target: PointTarget = { displayId: capture.displayId, ...local, label };
    if (!allowSnap) return target;
    const element = await elementAtPoint({ x: local.x + origin.x, y: local.y + origin.y });
    if (!element) return target;
    snappedName = element.name;
    const rect = { ...element.rect, x: element.rect.x - origin.x, y: element.rect.y - origin.y };
    return { ...target, rect, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };

  let local = imagePointToDisplayLocal(capture, parsed.point!.x, parsed.point!.y, req.mode);
  let target = await resolveTarget(local);
  if (abort.signal.aborted) return null;
  fly(capture, target);
  let how = target.rect ? 'coordenadas + control de Windows' : 'coordenadas';
  status(`Señalando "${label}" (${how})`);

  // Si Windows confirma que bajo el punto está justo el control nombrado, ya es exacto.
  if (!settings.refinePointing || namesMatch(snappedName, label)) return { capture, target, how };

  const cleanCapture = { ...capture, image: req.cleanImages[captures.indexOf(capture)] };
  const crop = zoomCrop(cleanCapture, local);
  const refined = parsePoint(
    await chat(settings.provider, settings.providers[settings.provider], {
      system: refineSystemPrompt(req.mode),
      history: [],
      userText: `element to find: "${label}". the user had asked: "${req.userText}"`,
      images: [crop.image],
      maxTokens: 64,
      signal: abort.signal,
    }),
  );
  if (abort.signal.aborted || !refined.point) return { capture, target, how };

  local = crop.toDisplayLocal(refined.point.x, refined.point.y, req.mode);
  const better = await resolveTarget(local);
  if (abort.signal.aborted) return null;
  const moved = Math.hypot(better.x - target.x, better.y - target.y);
  if (moved > 6) {
    target = better;
    fly(capture, target);
    how += ' + zoom';
    status(`Afinado ${Math.round(moved)} px con zoom`);
  }
  return { capture, target, how };
}

function namesMatch(a: string, b: string) {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const [x, y] = [norm(a), norm(b)];
  return x.length > 1 && y.length > 1 && (x.includes(y) || y.includes(x));
}

/**
 * Diagnóstico opcional: guarda lo que vio la IA (con marcas), su respuesta y
 * dónde acabó señalando, en %APPDATA%\clicky-local\diagnostico.
 */
async function saveDebug(captures: ScreenCapture[], raw: string, final: FinalPoint | null) {
  try {
    const dir = debugDir();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, capture] of captures.entries()) {
      const req: AnnotateRequest = { jpeg: capture.image.base64, boxes: [] };
      if (final?.capture === capture) {
        const t = final.target;
        const sx = capture.imageWidth / capture.bounds.width;
        const sy = capture.imageHeight / capture.bounds.height;
        req.crosshair = { x: t.x * sx, y: t.y * sy };
        if (t.rect) {
          const global = { ...t.rect, x: t.rect.x + capture.bounds.x, y: t.rect.y + capture.bounds.y };
          req.boxes = [{ ...elementBoxInImage(capture, { name: '', controlType: '', rect: global }), id: 0 }];
        }
      }
      fs.writeFileSync(path.join(dir, `pantalla${i + 1}.jpg`), Buffer.from(await engine<Uint8Array>('annotate', req)));
    }
    const result = final
      ? `${final.how} → (${Math.round(final.target.x)}, ${Math.round(final.target.y)}) DIP en el monitor ${final.capture.displayId}`
      : 'nada';
    fs.writeFileSync(path.join(dir, 'respuesta.txt'), `${raw}\n\n---\nseñalado: ${result}\n`);
  } catch (err) {
    status(`No pude guardar el diagnóstico: ${errorText(err)}`);
  }
}

function debugDir() {
  return path.join(app.getPath('userData'), 'diagnostico');
}

async function speak(text: string, abort: AbortController) {
  if (!text.trim() || settings.tts.mode === 'off') {
    setState('responding');
    return;
  }
  try {
    if (settings.tts.mode === 'system') {
      await engine('speakSystem', { text, voice: settings.tts.systemVoice, rate: settings.tts.rate });
    } else {
      const bytes = await synthesizeCloud(settings, text, abort.signal);
      if (abort.signal.aborted) return;
      await engine('playAudio', { bytes: new Uint8Array(bytes), mime: 'audio/mpeg' });
    }
  } catch (err) {
    if (abort.signal.aborted) return;
    status(`Voz falló (${errorText(err)}), uso la voz de Windows`);
    await engine('speakSystem', { text, voice: settings.tts.systemVoice, rate: settings.tts.rate }).catch(() => {});
  }
}

function fail(message: string) {
  status(`Error: ${message}`);
  setState('idle');
  setCaption(`⚠ ${message.slice(0, 220)}`, 8000);
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

// --- Ajustes -------------------------------------------------------------------------

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 760,
    height: Math.min(860, screen.getPrimaryDisplay().workAreaSize.height - 40),
    title: 'Clicky Local — Ajustes',
    icon: trayIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: { preload: PRELOAD },
  });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  settingsWindow.loadFile(path.join(RENDERER_DIR, 'settings', 'index.html'));
  if (DEV) settingsWindow.webContents.openDevTools({ mode: 'detach' });
}

ipcMain.handle('settings:get', () => ({
  settings,
  version: app.getVersion(),
  update: describeUpdate(updateState()),
  updateKind: updateState().kind,
  providerLabels: PROVIDER_LABELS,
  hotkeyLabels: HOTKEY_LABELS,
}));

ipcMain.handle('settings:save', (_e, next: Settings) => {
  const previousSttModel = settings.stt.localModel;
  settings = saveSettings(next);
  setHotkey(settings.hotkey);
  sendOverlayOptions();
  buildTrayMenu();
  if (settings.stt.mode === 'local' && settings.stt.localModel !== previousSttModel) preloadWhisper();
  status('Ajustes guardados');
  return settings;
});

ipcMain.handle('settings:list-models', (_e, id: ProviderId, provider: ProviderSettings) => listModels(id, provider));

ipcMain.handle('settings:ask', async (_e, text: string) => {
  cancelCurrent();
  const abort = new AbortController();
  currentAbort = abort;
  try {
    return { ok: true, text: await respond(text, abort) };
  } catch (err) {
    fail(errorText(err));
    return { ok: false, text: errorText(err) };
  }
});

ipcMain.handle('settings:check-updates', () => checkForUpdates(settings.autoUpdate));
ipcMain.handle('settings:download-update', () => downloadUpdate());
ipcMain.handle('settings:install-update', () => installUpdateNow());

function onUpdateState(state: UpdateState) {
  if (state.kind !== 'downloading') status(describeUpdate(state));
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('app:update', { text: describeUpdate(state), kind: state.kind });
  }
  if (tray) buildTrayMenu();
}

ipcMain.handle('settings:clear-history', () => {
  history = [];
  status('Conversación reiniciada');
});

ipcMain.handle('settings:voices', () => engine('listVoices'));
ipcMain.handle('settings:preload-whisper', () => preloadWhisper());

function preloadWhisper() {
  return engine('preloadWhisper', { model: settings.stt.localModel }).catch((err) =>
    status(`No pude cargar Whisper: ${errorText(err)}`),
  );
}

// --- Bandeja ---------------------------------------------------------------------------

/** Icono del triángulo dibujado por código (sin assets binarios). */
function trayIcon() {
  const size = 32;
  const poly = [
    [3, 2],
    [21, 11],
    [12, 13],
    [9, 22],
  ].map(([x, y]) => [(x * size) / 24 + 2, (y * size) / 24]);
  const insidePoly = (px: number, py: number) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (insidePoly(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++;
      const alpha = Math.round((hits / 16) * 255);
      const o = (y * size + x) * 4;
      // BGRA premultiplicado, azul #3b82f6
      buf[o] = Math.round((0xf6 * alpha) / 255);
      buf[o + 1] = Math.round((0x82 * alpha) / 255);
      buf[o + 2] = Math.round((0x3b * alpha) / 255);
      buf[o + 3] = alpha;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function updateMenuItem(): Electron.MenuItemConstructorOptions {
  const state = updateState();
  if (state.kind === 'ready') return { label: `Reiniciar para actualizar a ${state.version}`, click: installUpdateNow };
  if (state.kind === 'available') return { label: `Descargar versión ${state.version}`, click: () => void downloadUpdate() };
  if (state.kind === 'downloading' || state.kind === 'checking') return { label: describeUpdate(state), enabled: false };
  return { label: 'Buscar actualizaciones', click: () => void checkForUpdates(settings.autoUpdate) };
}

function buildTrayMenu() {
  tray!.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Hablar: mantén ${HOTKEY_LABELS[settings.hotkey].split(' (')[0]}`, enabled: false },
      { label: `IA: ${PROVIDER_LABELS[settings.provider]}`, enabled: false },
      { type: 'separator' },
      { label: 'Ajustes…', click: openSettings },
      updateMenuItem(),
      {
        label: 'Mostrar compañero',
        type: 'checkbox',
        checked: buddyEnabled,
        click: (item) => {
          buddyEnabled = item.checked;
          sendOverlayOptions();
        },
      },
      {
        label: 'Iniciar con Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        // En desarrollo apuntaría a electron.exe; solo tiene sentido instalada.
        enabled: app.isPackaged,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      {
        label: 'Abrir diagnóstico del último señalado',
        visible: settings.saveDebug,
        click: () => void shell.openPath(debugDir()),
      },
      {
        label: 'Reiniciar conversación',
        click: () => {
          history = [];
        },
      },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]),
  );
}

// --- Arranque ----------------------------------------------------------------------------

app.on('second-instance', openSettings);

app.whenReady().then(() => {
  const firstRun = isFirstRun();
  settings = loadSettings();
  app.setAppUserModelId('local.clicky.windows');

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'speaker-selection');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  createEngineWindow();
  createOverlays();
  startCursorPolling();
  screen.on('display-added', createOverlays);
  screen.on('display-removed', createOverlays);
  screen.on('display-metrics-changed', createOverlays);

  tray = new Tray(trayIcon());
  tray.setToolTip('Clicky Local');
  tray.on('click', openSettings);
  buildTrayMenu();

  setHotkey(settings.hotkey);
  try {
    startHotkeyListener({
      onPress: () => void onPushToTalkPress(),
      onRelease: (cancelled) => void onPushToTalkRelease(cancelled),
      onEscape: () => {
        if (voiceState !== 'idle') {
          cancelCurrent();
          void engine('cancelRecording').catch(() => {});
          setState('idle');
          setCaption(null);
        }
      },
    });
  } catch (err) {
    status(`No pude registrar el atajo global: ${errorText(err)}`);
  }

  if (settings.stt.mode === 'local') void preloadWhisper();
  if (settings.snapToElements || settings.numberedMarks) warmUpUiAutomation();
  startUpdater({ autoDownload: () => settings.autoUpdate, onChange: onUpdateState });

  const needsKey = ['anthropic', 'openai', 'gemini'].includes(settings.provider);
  if (firstRun || (needsKey && !settings.providers[settings.provider].apiKey)) openSettings();
});

// App de bandeja: cerrar ajustes no la cierra.
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  stopHotkeyListener();
  stopUiAutomation();
});
