// Push-to-talk global (mantener pulsado). Electron's globalShortcut solo avisa
// del keydown, así que usamos un hook de teclado de bajo nivel (uiohook).
// Si mientras se mantiene el combo se pulsa otra tecla (p.ej. Ctrl+Shift+T),
// la grabación se marca como cancelada para no interferir con atajos normales.

import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import type { HotkeyId } from '../shared/types';

const K = UiohookKey;
const CTRL = [K.Ctrl, K.CtrlRight];
const SHIFT = [K.Shift, K.ShiftRight];
const ALT = [K.Alt, K.AltRight];
const WIN = [K.Meta, K.MetaRight];

const COMBOS: Record<HotkeyId, number[][]> = {
  'ctrl+shift': [CTRL, SHIFT],
  'ctrl+alt': [CTRL, ALT],
  'ctrl+win': [CTRL, WIN],
  rightctrl: [[K.CtrlRight]],
  rightalt: [[K.AltRight]],
};

export const HOTKEY_LABELS: Record<HotkeyId, string> = {
  'ctrl+shift': 'Ctrl + Shift',
  'ctrl+alt': 'Ctrl + Alt (ojo: AltGr también lo activa)',
  'ctrl+win': 'Ctrl + Win',
  rightctrl: 'Ctrl derecho',
  rightalt: 'Alt derecho / AltGr',
};

export interface HotkeyHandlers {
  onPress: () => void;
  onRelease: (cancelled: boolean) => void;
  onEscape: () => void;
}

let combo: number[][] = COMBOS['ctrl+shift'];
const pressed = new Set<number>();
let active = false;
let interrupted = false;
let started = false;

export function setHotkey(id: HotkeyId) {
  combo = COMBOS[id] ?? COMBOS['ctrl+shift'];
}

export function startHotkeyListener(handlers: HotkeyHandlers) {
  if (started) return;
  started = true;

  const comboHeld = () => combo.every((group) => group.some((code) => pressed.has(code)));
  const isComboKey = (code: number) => combo.some((group) => group.includes(code));

  uIOhook.on('keydown', (e: UiohookKeyboardEvent) => {
    pressed.add(e.keycode);
    if (e.keycode === K.Escape) handlers.onEscape();

    if (active) {
      // Otra tecla durante el combo: era un atajo normal, no push-to-talk.
      if (!isComboKey(e.keycode)) interrupted = true;
      return;
    }
    // Solo arranca si lo único pulsado es el combo (Ctrl+Shift sí, Ctrl+Shift+Alt no).
    if (comboHeld() && [...pressed].every(isComboKey)) {
      active = true;
      interrupted = false;
      handlers.onPress();
    }
  });

  uIOhook.on('keyup', (e: UiohookKeyboardEvent) => {
    pressed.delete(e.keycode);
    if (active && !comboHeld()) {
      active = false;
      handlers.onRelease(interrupted);
    }
  });

  uIOhook.start();
}

export function stopHotkeyListener() {
  if (!started) return;
  uIOhook.stop();
  started = false;
}
