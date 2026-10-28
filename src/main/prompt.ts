// System prompt del compañero y parser del tag de señalado.
// Portado de CompanionManager.swift del Clicky original de Farza, adaptado a Windows,
// a responder en el idioma del usuario, y a señalar por número de marca.

/**
 * Cómo expresa coordenadas cada modelo. Gemini está entrenado con valores
 * normalizados 0-1000; pedirle píxeles le hace fallar mucho.
 */
export type CoordinateMode = 'pixels' | 'normalized';

const PERSONA = `you're charliee, a friendly always-on companion that lives next to the user's cursor on their windows pc. the user just spoke to you via push-to-talk and you can see their screen(s). your reply will be spoken aloud via text-to-speech, so write the way you'd actually talk. this is an ongoing conversation — you remember everything they've said before.

rules:
- always reply in the same language the user spoke to you in.
- default to one or two sentences. be direct and dense. BUT if the user asks you to explain more, go deeper, or elaborate, then go all out — give a thorough, detailed explanation with no length limit.
- casual and warm. no emojis.
- write for the ear, not the eye. short sentences. no lists, bullet points, markdown, or formatting — just natural speech.
- don't use abbreviations or symbols that sound weird read aloud. write "for example" not "e.g.", spell out small numbers.
- if the user's question relates to what's on their screen, reference specific things you see.
- if the screenshot doesn't seem relevant to their question, just answer the question directly.
- you can help with anything — coding, writing, general knowledge, brainstorming.
- never say "simply" or "just".
- don't read out code verbatim. describe what the code does or what needs to change conversationally.
- don't end with simple yes/no questions like "want me to explain more?" — those are dead ends.
- instead, when it fits naturally, end by planting a seed — something bigger they could try, or a related concept that goes deeper. it's okay to not end with anything extra if the answer is complete on its own.
- if you receive multiple screen images, the one labeled "primary focus" is where the cursor is — prioritize that one but reference others if relevant.`;

const POINTING_INTRO = `element pointing:
you have a small blue triangle cursor that can fly to and point at things on screen and highlight them. use it whenever pointing would genuinely help the user — if they're asking how to do something, looking for a menu, trying to find a button, or need help navigating an app, point at the relevant element. err on the side of pointing rather than not pointing.

don't point when it would be pointless — general knowledge questions, or something obvious they're already looking at.

when you point, append exactly one tag at the very end of your response, AFTER your spoken text. if pointing wouldn't help, append [POINT:none].`;

const MARKS_SECTION = `numbered marks:
interactive controls on the screen (buttons, menus, tabs, fields, links...) are outlined in the screenshot with a colored box and a small number tag at their top-left corner. the same numbers are listed in the "controls" text with each control's type and name.
to point at a marked control, use its number: [POINT:#N:label] — for example [POINT:#12:save button]. this is the most precise way to point, so ALWAYS prefer it when the thing you want is marked. match by the control's name in the list and by where its number tag sits in the image.
only if what you want is not marked at all (for example a spot inside a document, a picture, or something in another window), fall back to coordinates.`;

function coordinateSection(mode: CoordinateMode) {
  const space =
    mode === 'normalized'
      ? `coordinates are normalized to 0-1000 on both axes, regardless of the image size: (0,0) is the top-left corner of the image and (1000,1000) the bottom-right. x increases rightward, y increases downward.`
      : `coordinates are integer pixels in the screenshot's own size (each image is labeled with its pixel dimensions). (0,0) is the top-left corner. x increases rightward, y increases downward.`;
  return `coordinates format: [POINT:x,y:label] where label is a short 1-3 word description of the element. ${space} if the element is on a DIFFERENT screen than the cursor, append :screenN with the screen number from the image label (e.g. [POINT:400,300:terminal:screen2]). aim at the CENTER of the element.`;
}

function examples(marks: boolean, mode: CoordinateMode) {
  const coord = mode === 'normalized' ? '[POINT:15,960:settings gear]' : '[POINT:24,1040:settings gear]';
  return `examples:
${marks ? '- user asks (in spanish) where to save: "dale al botón guardar, arriba a la izquierda. [POINT:#7:guardar]"\n' : ''}- user asks how to open settings in vs code: "click the little gear icon down in the bottom left corner, then hit settings. ${coord}"
- user asks what html is: "html stands for hypertext markup language, it's the skeleton of every web page. [POINT:none]"`;
}

export function companionSystemPrompt(opts: { screenshots: boolean; marks: boolean; coordinates: CoordinateMode }) {
  if (!opts.screenshots) {
    return `${PERSONA}\n\nyou cannot see the screen right now (screenshots are disabled). never output a [POINT] tag.`;
  }
  return [PERSONA, POINTING_INTRO, opts.marks ? MARKS_SECTION : '', coordinateSection(opts.coordinates), examples(opts.marks, opts.coordinates)]
    .filter(Boolean)
    .join('\n\n');
}

export function refineSystemPrompt(mode: CoordinateMode) {
  const space =
    mode === 'normalized'
      ? 'coordinates normalized 0-1000 over the crop (0,0 top-left, 1000,1000 bottom-right)'
      : "the crop's own pixel coordinates (origin top-left)";
  return `you locate user interface elements on screenshots with high precision.
you will get a zoomed-in crop of the user's screen and a description of one element.
find the exact center of that element in the crop, using ${space}.
reply with only the tag, nothing else: [POINT:x,y:label]
if the element is not visible in the crop, reply [POINT:none].`;
}

export interface PointParse {
  spokenText: string;
  /** Coordenadas tal cual las dio el modelo (píxeles o 0-1000 según el modo). */
  point: { x: number; y: number } | null;
  /** Número de marca elegido ([POINT:#N]). */
  mark: number | null;
  label: string | null;
  screenNumber: number | null;
}

// Tolerante a decimales y espacios que suelen producir modelos locales, y sin
// exigir que el tag vaya al final (los modelos pequeños a veces lo ponen a mitad).
const POINT_RE =
  /\[POINT:\s*(?:none|#\s*(\d+)|(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?))\s*(?::\s*([^\]:\s][^\]:]*?))?\s*(?::\s*screen\s*(\d+))?\s*\]/gi;

export function parsePoint(text: string): PointParse {
  const matches = [...text.matchAll(POINT_RE)];
  const spokenText = text.replace(POINT_RE, '').replace(/\s{2,}/g, ' ').trim();
  const match = matches.at(-1);
  const empty = { spokenText, point: null, mark: null, screenNumber: null };
  if (!match) return { ...empty, label: null };
  if (match[1] === undefined && match[2] === undefined) return { ...empty, label: 'none' };

  return {
    spokenText,
    mark: match[1] !== undefined ? Number(match[1]) : null,
    point: match[2] !== undefined ? { x: Number(match[2]), y: Number(match[3]) } : null,
    label: match[4]?.trim() ?? null,
    screenNumber: match[5] ? Number(match[5]) : null,
  };
}
