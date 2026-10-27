// Voz por API en la nube (opcional). Lo local/gratis (Whisper en el navegador
// y las voces de Windows) vive en el renderer "engine".

import type { Settings } from '../shared/types';

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** PCM mono float32 → WAV 16-bit, que aceptan todas las APIs de transcripción. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buffer;
}

const LANGUAGE_CODES: Record<string, string> = {
  spanish: 'es',
  english: 'en',
  portuguese: 'pt',
  french: 'fr',
  german: 'de',
  italian: 'it',
};

/** Transcripción vía /audio/transcriptions (OpenAI, Groq, servidores whisper locales...). */
export async function transcribeCloud(settings: Settings, wav: Buffer, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', settings.stt.openaiModel);
  const lang = LANGUAGE_CODES[settings.stt.language];
  if (lang) form.append('language', lang);

  const res = await fetch(`${trimSlash(settings.stt.openaiBaseUrl)}/audio/transcriptions`, {
    method: 'POST',
    headers: settings.stt.openaiApiKey ? { authorization: `Bearer ${settings.stt.openaiApiKey}` } : {},
    body: form,
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Transcripción HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).text ?? '';
}

/** Devuelve audio MP3 listo para reproducir en el engine. */
export async function synthesizeCloud(settings: Settings, text: string, signal?: AbortSignal): Promise<Buffer> {
  const { tts } = settings;
  let res: Response;
  if (tts.mode === 'elevenlabs') {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(tts.elevenlabsVoiceId)}`, {
      method: 'POST',
      headers: { 'xi-api-key': tts.elevenlabsApiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: tts.elevenlabsModel }),
      signal,
    });
  } else {
    res = await fetch(`${trimSlash(tts.openaiBaseUrl)}/audio/speech`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(tts.openaiApiKey ? { authorization: `Bearer ${tts.openaiApiKey}` } : {}),
      },
      body: JSON.stringify({ model: tts.openaiModel, voice: tts.openaiVoice, input: text, response_format: 'mp3' }),
      signal,
    });
  }
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}
