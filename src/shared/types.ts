// Tipos compartidos entre main, preload y renderers.

export type ProviderId =
  | 'claude-code'
  | 'gemini-cli'
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

/** Proveedores que usan una CLI con sesión iniciada (tu plan) en vez de API key. */
export const CLI_PROVIDERS: ProviderId[] = ['claude-code', 'gemini-cli'];

export interface ProviderSettings {
  apiKey: string;
  /** URL de la API, o ruta al ejecutable en proveedores CLI (vacío = autodetectar). */
  baseUrl: string;
  model: string;
}

export type SttMode = 'local' | 'openai';
export type TtsMode = 'system' | 'openai' | 'elevenlabs' | 'off';
export type HotkeyId = 'ctrl+shift' | 'ctrl+alt' | 'ctrl+win' | 'rightctrl' | 'rightalt';

export interface Settings {
  provider: ProviderId;
  providers: Record<ProviderId, ProviderSettings>;
  sendScreenshot: boolean;
  /** 0 = automático según el proveedor. */
  screenshotMaxDimension: number;
  /** Segunda pasada con zoom para afinar dónde señalar. */
  refinePointing: boolean;
  /** Ajustar el señalado al control real de Windows (UI Automation). */
  snapToElements: boolean;
  /** Numerar en la captura los controles de Windows para que la IA elija por número. */
  numberedMarks: boolean;
  /** Guardar en disco la última captura y dónde señaló, para depurar. */
  saveDebug: boolean;
  /** Descargar actualizaciones solo e instalarlas al cerrar. */
  autoUpdate: boolean;
  maxTokens: number;
  extraInstructions: string;
  hotkey: HotkeyId;
  showCaption: boolean;
  stt: {
    mode: SttMode;
    localModel: string;
    language: string; // '' = auto
    openaiBaseUrl: string;
    openaiApiKey: string;
    openaiModel: string;
  };
  tts: {
    mode: TtsMode;
    systemVoice: string;
    rate: number;
    openaiBaseUrl: string;
    openaiApiKey: string;
    openaiModel: string;
    openaiVoice: string;
    elevenlabsApiKey: string;
    elevenlabsVoiceId: string;
    elevenlabsModel: string;
  };
}

export type VoiceState = 'idle' | 'listening' | 'processing' | 'responding';

/** Punto al que el compañero debe volar, en coords locales (DIP) de la ventana overlay. */
export interface PointTarget {
  displayId: number;
  x: number;
  y: number;
  label: string;
  /** Rectángulo del elemento (DIP locales del overlay) para resaltarlo, si se conoce. */
  rect?: { x: number; y: number; width: number; height: number };
}

export interface CursorUpdate {
  /** Coordenadas globales DIP. Cada overlay resta su propio origen. */
  x: number;
  y: number;
}
