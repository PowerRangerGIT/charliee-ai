// Persistencia de ajustes en userData/config.json. Las API keys se cifran con
// safeStorage (DPAPI en Windows) para que no queden en texto plano en disco.

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ProviderId, Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'claude-code',
  providers: {
    'claude-code': { apiKey: '', baseUrl: '', model: 'sonnet' },
    'gemini-cli': { apiKey: '', baseUrl: '', model: 'gemini-2.5-flash' },
    anthropic: { apiKey: '', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
    openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash' },
    ollama: { apiKey: '', baseUrl: 'http://localhost:11434', model: 'qwen2.5vl' },
    lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234/v1', model: '' },
    custom: { apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  },
  sendScreenshot: true,
  screenshotMaxDimension: 0,
  refinePointing: true,
  snapToElements: true,
  numberedMarks: true,
  saveDebug: false,
  autoUpdate: true,
  maxTokens: 1024,
  extraInstructions: '',
  hotkey: 'ctrl+shift',
  showCaption: true,
  stt: {
    mode: 'local',
    localModel: 'onnx-community/whisper-base',
    language: 'spanish',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: '',
    openaiModel: 'whisper-1',
  },
  tts: {
    mode: 'system',
    systemVoice: '',
    rate: 1.05,
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiApiKey: '',
    openaiModel: 'gpt-4o-mini-tts',
    openaiVoice: 'alloy',
    elevenlabsApiKey: '',
    elevenlabsVoiceId: '',
    elevenlabsModel: 'eleven_flash_v2_5',
  },
};

const ENC_PREFIX = 'enc:';

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function protect(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) return value;
  return ENC_PREFIX + safeStorage.encryptString(value).toString('base64');
}

function unprotect(value: string): string {
  if (!value?.startsWith(ENC_PREFIX)) return value ?? '';
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

/** Aplica fn a cada campo secreto. Mantener en sync con Settings. */
function mapSecrets(s: Settings, fn: (v: string) => string): Settings {
  const out: Settings = structuredClone(s);
  for (const id of Object.keys(out.providers) as ProviderId[]) {
    out.providers[id].apiKey = fn(out.providers[id].apiKey);
  }
  out.stt.openaiApiKey = fn(out.stt.openaiApiKey);
  out.tts.openaiApiKey = fn(out.tts.openaiApiKey);
  out.tts.elevenlabsApiKey = fn(out.tts.elevenlabsApiKey);
  return out;
}

/** Mezcla profunda: los valores guardados ganan, los defaults rellenan campos nuevos. */
function merge<T>(base: T, saved: unknown): T {
  if (typeof base !== 'object' || base === null || typeof saved !== 'object' || saved === null) {
    return (saved ?? base) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
    out[k] = k in out ? merge(out[k], v) : v;
  }
  return out as T;
}

let cached: Settings | null = null;

/** Sin config.json todavía: primera vez que se abre la app. */
export function isFirstRun() {
  return !fs.existsSync(configPath());
}

export function loadSettings(): Settings {
  if (cached) return cached;
  let saved: unknown = {};
  try {
    saved = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    // primer arranque o archivo corrupto: defaults
  }
  cached = mapSecrets(merge(DEFAULT_SETTINGS, saved), unprotect);
  return cached;
}

export function saveSettings(next: Settings): Settings {
  cached = merge(DEFAULT_SETTINGS, next);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(mapSecrets(cached, protect), null, 2));
  return cached;
}
