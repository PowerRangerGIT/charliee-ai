// "Set-of-Mark": numera en la captura los controles que Windows conoce y
// los lista con su nombre. La IA responde con el número ([POINT:#12]) y el
// resaltado usa el rectángulo real del control: precisión exacta en vez de
// depender de que el modelo adivine píxeles.

import type { ScreenCapture } from './capture';
import type { UiElement } from './uia';

export interface Mark {
  id: number;
  capture: ScreenCapture;
  element: UiElement;
}

export interface AnnotateBox {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnnotateRequest {
  jpeg: string;
  boxes: AnnotateBox[];
  /** Punto a marcar con una cruz (diagnóstico). */
  crosshair?: { x: number; y: number };
}

export type Annotator = (req: AnnotateRequest) => Promise<Uint8Array>;

const MAX_MARKS = 180;

function cleanName(name: string) {
  return name.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Rectángulo del elemento en píxeles de la imagen enviada de esa captura. */
export function elementBoxInImage(capture: ScreenCapture, el: UiElement): AnnotateBox {
  const sx = capture.imageWidth / capture.bounds.width;
  const sy = capture.imageHeight / capture.bounds.height;
  return {
    id: 0,
    x: Math.round((el.rect.x - capture.bounds.x) * sx),
    y: Math.round((el.rect.y - capture.bounds.y) * sy),
    w: Math.round(el.rect.width * sx),
    h: Math.round(el.rect.height * sy),
  };
}

/**
 * Dibuja las marcas sobre cada captura (sustituye su imagen) y devuelve la
 * tabla número → control y el texto con la lista para el modelo.
 */
export async function addMarks(captures: ScreenCapture[], elements: UiElement[], annotate: Annotator) {
  const marks = new Map<number, Mark>();
  const lines: string[] = [];
  let nextId = 1;

  for (const [screenIndex, capture] of captures.entries()) {
    const b = capture.bounds;
    const onScreen = elements
      .filter((el) => {
        const cx = el.rect.x + el.rect.width / 2;
        const cy = el.rect.y + el.rect.height / 2;
        return cx >= b.x && cy >= b.y && cx < b.x + b.width && cy < b.y + b.height;
      })
      .slice(0, MAX_MARKS - marks.size)
      // Numeración en orden de lectura: arriba→abajo, izquierda→derecha.
      .sort((p, q) => Math.round(p.rect.y / 12) - Math.round(q.rect.y / 12) || p.rect.x - q.rect.x);
    if (!onScreen.length) continue;

    const boxes: AnnotateBox[] = [];
    for (const element of onScreen) {
      const id = nextId++;
      marks.set(id, { id, capture, element });
      boxes.push({ ...elementBoxInImage(capture, element), id });
      const name = cleanName(element.name);
      const where = captures.length > 1 ? ` (screen ${screenIndex + 1})` : '';
      lines.push(`#${id} ${element.controlType.toLowerCase()}${name ? ` "${name}"` : ''}${where}`);
    }

    const bytes = await annotate({ jpeg: capture.image.base64, boxes });
    capture.image = {
      ...capture.image,
      base64: Buffer.from(bytes).toString('base64'),
      label: `${capture.image.label}. interactive controls are outlined and numbered`,
    };
  }

  const controlsText = lines.length
    ? `controls marked on screen (number, type, name):\n${lines.join('\n')}`
    : '';
  return { marks, controlsText };
}
