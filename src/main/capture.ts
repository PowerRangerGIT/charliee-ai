// Captura todas las pantallas a resolución nativa (píxeles físicos), las
// reduce al tamaño que mejor entiende cada proveedor, y convierte
// coordenadas de imagen ↔ pantalla. Guarda la captura nativa para poder
// recortar y hacer zoom al afinar dónde señalar.

import { desktopCapturer, screen, type NativeImage, type Rectangle } from 'electron';
import type { ProviderId } from '../shared/types';
import type { ChatImage } from './llm';
import type { CoordinateMode } from './prompt';

export interface ScreenCapture {
  displayId: number;
  /** Bounds del display en DIP (coordenadas globales de Electron). */
  bounds: Rectangle;
  /** Captura a resolución nativa. */
  native: NativeImage;
  /** Tamaño de la imagen enviada al modelo (coordenadas en las que responde). */
  imageWidth: number;
  imageHeight: number;
  isCursorScreen: boolean;
  image: ChatImage;
}

/**
 * Tamaño que cada proveedor procesa sin volver a reducir la imagen. Si el
 * servidor la reescala, el modelo responde en coordenadas de una imagen que no
 * es la que le dijimos y el señalado se desvía (más hacia la derecha/abajo).
 * Claude: lado largo ≤ 1568 y ≤ ~1,15 MP (16:9 → 1456×816).
 */
interface SizeLimit {
  edge: number;
  area: number;
}

const AUTO_LIMITS: Record<ProviderId, SizeLimit> = {
  'claude-code': { edge: 1568, area: 1_150_000 },
  anthropic: { edge: 1568, area: 1_150_000 },
  'gemini-cli': { edge: 1920, area: 2_100_000 },
  gemini: { edge: 1920, area: 2_100_000 },
  openai: { edge: 1366, area: 1_050_000 }, // "high detail" acaba en 768 px de lado corto
  ollama: { edge: 1288, area: 1_000_000 }, // múltiplos de 28 para Qwen-VL
  lmstudio: { edge: 1288, area: 1_000_000 },
  custom: { edge: 1366, area: 1_050_000 },
};

export function sizeLimitFor(provider: ProviderId, configuredEdge: number): SizeLimit {
  const auto = AUTO_LIMITS[provider];
  return configuredEdge > 0 ? { edge: configuredEdge, area: Math.max(auto.area, configuredEdge * configuredEdge) } : auto;
}

export function coordinateModeFor(provider: ProviderId): CoordinateMode {
  return provider === 'gemini' || provider === 'gemini-cli' ? 'normalized' : 'pixels';
}

export async function captureAllScreens(limit: SizeLimit, mode: CoordinateMode): Promise<ScreenCapture[]> {
  const cursor = screen.getCursorScreenPoint();
  const cursorDisplay = screen.getDisplayNearestPoint(cursor);
  const displays = screen.getAllDisplays().sort((a, b) => {
    if (a.id === cursorDisplay.id) return -1;
    if (b.id === cursorDisplay.id) return 1;
    return a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y;
  });

  // Pedimos el tamaño físico del monitor más grande para no perder resolución.
  const physical = displays.map((d) => ({
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  }));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(...physical.map((p) => p.width)),
      height: Math.max(...physical.map((p) => p.height)),
    },
  });

  const captures: ScreenCapture[] = [];
  displays.forEach((display, index) => {
    const source = sources.find((s) => s.display_id === String(display.id)) ?? (displays.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) return;

    const native = source.thumbnail;
    const nativeSize = native.getSize();
    const scale = Math.min(
      1,
      limit.edge / Math.max(nativeSize.width, nativeSize.height),
      Math.sqrt(limit.area / (nativeSize.width * nativeSize.height)),
    );
    const sent = scale < 1 ? native.resize({ width: Math.round(nativeSize.width * scale), quality: 'best' }) : native;
    const { width, height } = sent.getSize();

    const isCursorScreen = display.id === cursorDisplay.id;
    let label =
      displays.length === 1
        ? "user's screen"
        : `screen ${index + 1} of ${displays.length}${isCursorScreen ? ' — cursor is on this screen (primary focus)' : ''}`;
    label += ` (image dimensions: ${width}x${height} pixels)`;
    if (isCursorScreen) {
      const span = mode === 'normalized' ? { w: 1000, h: 1000 } : { w: width, h: height };
      const cx = Math.round(((cursor.x - display.bounds.x) / display.bounds.width) * span.w);
      const cy = Math.round(((cursor.y - display.bounds.y) / display.bounds.height) * span.h);
      label += `. the user's mouse cursor is at (${cx}, ${cy}) in this image`;
    }

    captures.push({
      displayId: display.id,
      bounds: display.bounds,
      native,
      imageWidth: width,
      imageHeight: height,
      isCursorScreen,
      image: { base64: sent.toJPEG(85).toString('base64'), mediaType: 'image/jpeg', label },
    });
  });
  return captures;
}

/** Punto de la imagen enviada (píxeles o 0-1000) → punto local (DIP) dentro del overlay. */
export function imagePointToDisplayLocal(capture: ScreenCapture, x: number, y: number, mode: CoordinateMode = 'pixels') {
  if (mode === 'normalized') {
    x = (x / 1000) * capture.imageWidth;
    y = (y / 1000) * capture.imageHeight;
  }
  const clampedX = Math.max(0, Math.min(x, capture.imageWidth));
  const clampedY = Math.max(0, Math.min(y, capture.imageHeight));
  return {
    x: clampedX * (capture.bounds.width / capture.imageWidth),
    y: clampedY * (capture.bounds.height / capture.imageHeight),
  };
}

export interface ZoomCrop {
  image: ChatImage;
  /** Convierte un punto del recorte (píxeles o 0-1000) a punto local (DIP) del display. */
  toDisplayLocal: (x: number, y: number, mode: CoordinateMode) => { x: number; y: number };
  width: number;
  height: number;
}

/**
 * Recorte a resolución nativa alrededor de un punto (DIP local), para que el
 * modelo vea los detalles finos y corrija su primera estimación.
 */
export function zoomCrop(capture: ScreenCapture, center: { x: number; y: number }): ZoomCrop {
  const { width: nw, height: nh } = capture.native.getSize();
  const pxPerDip = nw / capture.bounds.width;
  // ~30 % del lado corto de la pantalla, entre 420 y 900 px nativos.
  const side = Math.round(Math.max(420, Math.min(900, Math.min(nw, nh) * 0.3)));
  const cropW = Math.min(nw, Math.round(side * 1.5));
  const cropH = Math.min(nh, side);
  const left = Math.round(Math.max(0, Math.min(nw - cropW, center.x * pxPerDip - cropW / 2)));
  const top = Math.round(Math.max(0, Math.min(nh - cropH, center.y * pxPerDip - cropH / 2)));

  const crop = capture.native.crop({ x: left, y: top, width: cropW, height: cropH });
  return {
    image: {
      base64: crop.toJPEG(90).toString('base64'),
      mediaType: 'image/jpeg',
      label: `zoomed crop of the screen (image dimensions: ${cropW}x${cropH} pixels)`,
    },
    width: cropW,
    height: cropH,
    toDisplayLocal: (x, y, mode) => {
      if (mode === 'normalized') {
        x = (x / 1000) * cropW;
        y = (y / 1000) * cropH;
      }
      return {
        x: (left + Math.max(0, Math.min(x, cropW))) / pxPerDip,
        y: (top + Math.max(0, Math.min(y, cropH))) / pxPerDip,
      };
    },
  };
}
