// Ventana oculta "engine": micrófono, Whisper local (transformers.js) y
// reproducción de voz (voces de Windows o audio de API). Main le manda
// comandos por `engine:cmd` y recibe la respuesta por `engine:reply`.

import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

const SAMPLE_RATE = 16000;

// Runtime ONNX empaquetado junto a la app (build.mjs lo copia) en vez del CDN,
// así Whisper funciona offline una vez descargado el modelo.
env.backends.onnx.wasm!.wasmPaths = {
  mjs: new URL('./ort-wasm-simd-threaded.asyncify.mjs', location.href).href,
  wasm: new URL('./ort-wasm-simd-threaded.asyncify.wasm', location.href).href,
};

const emit = (channel: string, payload?: unknown) => window.charliee.send(channel, payload);
const status = (message: string) => emit('engine:status', message);

// --- Grabación -----------------------------------------------------------------

const WORKLET_SOURCE = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('tap', Tap);
`;

let recording: {
  stream: MediaStream;
  context: AudioContext;
  chunks: Float32Array[];
} | null = null;

async function startRecording() {
  await cancelRecording();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // Chromium remuestrea el micro a 16 kHz, lo que Whisper espera.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  await context.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  const source = context.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(context, 'tap');
  const chunks: Float32Array[] = [];
  let sinceLevel = 0;
  let levelAccumulator = 0;

  tap.port.onmessage = (e: MessageEvent<Float32Array>) => {
    chunks.push(e.data);
    for (const s of e.data) levelAccumulator += s * s;
    sinceLevel += e.data.length;
    // ~30 actualizaciones de nivel por segundo para la onda del overlay.
    if (sinceLevel >= SAMPLE_RATE / 30) {
      const rms = Math.sqrt(levelAccumulator / sinceLevel);
      emit('engine:level', Math.min(1, rms * 8));
      sinceLevel = 0;
      levelAccumulator = 0;
    }
  };
  source.connect(tap);
  recording = { stream, context, chunks };
}

async function stopRecording(): Promise<{ samples: Float32Array; sampleRate: number }> {
  if (!recording) return { samples: new Float32Array(0), sampleRate: SAMPLE_RATE };
  const { chunks } = recording;
  await cancelRecording();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    samples.set(c, offset);
    offset += c.length;
  }
  return { samples, sampleRate: SAMPLE_RATE };
}

async function cancelRecording() {
  if (!recording) return;
  recording.stream.getTracks().forEach((t) => t.stop());
  await recording.context.close().catch(() => {});
  recording = null;
  emit('engine:level', 0);
}

// --- Whisper local ---------------------------------------------------------------

let whisper: { model: string; pipe: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

// Varios .onnx bajan en paralelo: promediamos y solo avisamos cada 5%.
const downloadProgress = new Map<string, number>();
let lastReported = -1;

function progressCallback(p: { status: string; file?: string; progress?: number }) {
  if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
    downloadProgress.set(p.file, p.progress ?? 0);
    const values = [...downloadProgress.values()];
    const overall = Math.floor(values.reduce((a, b) => a + b, 0) / values.length / 5) * 5;
    if (overall !== lastReported) {
      lastReported = overall;
      status(`Descargando modelo de voz: ${overall}%`);
    }
  } else if (p.status === 'ready') {
    downloadProgress.clear();
    lastReported = -1;
    status('Modelo de voz listo');
  }
}

async function createWhisper(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  const hasWebGPU = 'gpu' in navigator && (await (navigator as any).gpu.requestAdapter().catch(() => null));
  if (hasWebGPU) {
    try {
      return (await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
        progress_callback: progressCallback,
      })) as AutomaticSpeechRecognitionPipeline;
    } catch (err) {
      console.warn('WebGPU falló, usando WASM', err);
    }
  }
  return (await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: progressCallback,
  })) as AutomaticSpeechRecognitionPipeline;
}

function getWhisper(model: string) {
  if (!whisper || whisper.model !== model) {
    const pipe = createWhisper(model);
    pipe.catch(() => {
      if (whisper?.pipe === pipe) whisper = null;
    });
    whisper = { model, pipe };
  }
  return whisper.pipe;
}

async function transcribeLocal(args: { samples: Float32Array; model: string; language: string }) {
  const transcriber = await getWhisper(args.model);
  const output = await transcriber(args.samples, {
    ...(args.language ? { language: args.language } : {}),
    task: 'transcribe',
    chunk_length_s: 30,
  });
  const result = Array.isArray(output) ? output[0] : output;
  return result.text.trim();
}

// --- Voz ---------------------------------------------------------------------------

let currentAudio: HTMLAudioElement | null = null;
let speechToken = 0;

function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  const voices = speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

/** Partimos por frases: algunas voces cortan textos largos a mitad. */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?¡¿…]+[.!?…]+["')\]]*|[^.!?…]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

async function speakSystem(args: { text: string; voice: string; rate: number }) {
  stopSpeaking();
  const token = ++speechToken;
  const voices = await voicesReady();
  const voice = voices.find((v) => v.name === args.voice);

  let first = true;
  for (const sentence of splitSentences(args.text)) {
    if (token !== speechToken) return;
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(sentence);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = args.rate;
      u.onstart = () => {
        if (first) emit('engine:speech-start');
        first = false;
      };
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}

async function playAudio(args: { bytes: Uint8Array; mime: string }) {
  stopSpeaking();
  const token = speechToken;
  const url = URL.createObjectURL(new Blob([args.bytes as BlobPart], { type: args.mime }));
  const audio = new Audio(url);
  currentAudio = audio;
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onplaying = () => emit('engine:speech-start');
      audio.onended = () => resolve();
      audio.onpause = () => resolve();
      audio.onerror = () => reject(new Error('No se pudo reproducir el audio'));
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
    if (token === speechToken) currentAudio = null;
  }
}

function stopSpeaking() {
  speechToken++;
  speechSynthesis.cancel();
  currentAudio?.pause();
  currentAudio = null;
}

async function listVoices() {
  return (await voicesReady()).map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
}

// --- Marcas numeradas sobre capturas -------------------------------------------------

// Colores saturados y distintos entre vecinos para que cada número se lea bien.
const MARK_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#c026d3', '#ea580c', '#0891b2', '#7c3aed', '#ca8a04'];

async function annotate(args: {
  jpeg: string;
  boxes: { id: number; x: number; y: number; w: number; h: number }[];
  crosshair?: { x: number; y: number };
}) {
  const bytes = Uint8Array.from(atob(args.jpeg), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);

  const fontSize = Math.max(11, Math.round(bitmap.width / 115));
  ctx.font = `bold ${fontSize}px "Segoe UI", Arial, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.lineWidth = Math.max(1.5, bitmap.width / 900);

  args.boxes.forEach((box, i) => {
    const color = MARK_COLORS[i % MARK_COLORS.length];
    ctx.strokeStyle = color;
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, Math.max(1, box.w - 1), Math.max(1, box.h - 1));

    const text = String(box.id);
    const tagW = Math.ceil(ctx.measureText(text).width) + 6;
    const tagH = fontSize + 3;
    // Etiqueta encima de la esquina; si no cabe, dentro.
    const tagY = box.y - tagH >= 0 ? box.y - tagH : box.y;
    const tagX = Math.min(box.x, bitmap.width - tagW);
    ctx.fillStyle = color;
    ctx.fillRect(tagX, tagY, tagW, tagH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, tagX + 3, tagY + 1.5);
  });

  if (args.crosshair) {
    const { x, y } = args.crosshair;
    ctx.strokeStyle = '#ff0040';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.moveTo(x - 24, y);
    ctx.lineTo(x + 24, y);
    ctx.moveTo(x, y - 24);
    ctx.lineTo(x, y + 24);
    ctx.stroke();
  }

  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
  return new Uint8Array(await out.arrayBuffer());
}

// --- Dispatcher --------------------------------------------------------------------

const handlers: Record<string, (payload: any) => unknown> = {
  startRecording,
  stopRecording,
  cancelRecording,
  transcribeLocal,
  preloadWhisper: (p: { model: string }) => getWhisper(p.model).then(() => true),
  speakSystem,
  playAudio,
  stopSpeaking,
  listVoices,
  annotate,
};

window.charliee.on('engine:cmd', async (msg: { id: number; type: string; payload: unknown }) => {
  try {
    const handler = handlers[msg.type];
    if (!handler) throw new Error(`Comando desconocido: ${msg.type}`);
    const result = await handler(msg.payload);
    emit('engine:reply', { id: msg.id, ok: true, result });
  } catch (err) {
    emit('engine:reply', { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

emit('engine:ready');
