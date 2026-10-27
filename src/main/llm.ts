// Capa multi-proveedor: un solo `chat()` que habla con Claude, OpenAI, Gemini,
// Ollama, LM Studio o cualquier endpoint compatible con OpenAI.
// Corre en el proceso main (sin CORS) y devuelve la respuesta completa.

import type { ProviderId, ProviderSettings } from '../shared/types';
import { chatCli, CLI_MODELS, findCli } from './cli';

export interface ChatImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png';
  label: string;
}

export interface ChatTurn {
  user: string;
  assistant: string;
}

export interface ChatRequest {
  system: string;
  history: ChatTurn[];
  userText: string;
  images: ChatImage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'claude-code': 'Claude Code (tu plan Pro/Max, sin API key)',
  'gemini-cli': 'Gemini CLI (tu cuenta Google, sin API key)',
  anthropic: 'Claude (Anthropic)',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  custom: 'Compatible OpenAI (OpenRouter, Groq, etc.)',
};

const trimSlash = (url: string) => url.replace(/\/+$/, '');

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  return readJson(res);
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  return readJson(await fetch(url, { headers }));
}

async function readJson(res: Response) {
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no-JSON: ${text.slice(0, 200)}`);
  }
}

/** Modelos de razonamiento locales (qwen3, deepseek-r1...) devuelven <think>; no se debe leer en voz alta. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// --- Anthropic ---------------------------------------------------------------

async function chatAnthropic(p: ProviderSettings, req: ChatRequest): Promise<string> {
  const content: unknown[] = [];
  for (const img of req.images) {
    content.push({ type: 'text', text: img.label });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
  }
  content.push({ type: 'text', text: req.userText });

  const messages = [
    ...req.history.flatMap((t) => [
      { role: 'user', content: t.user },
      { role: 'assistant', content: t.assistant },
    ]),
    { role: 'user', content },
  ];

  const data = await postJson(
    `${trimSlash(p.baseUrl)}/v1/messages`,
    { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
    { model: p.model, max_tokens: req.maxTokens, system: req.system, messages },
    req.signal,
  );
  return (data.content ?? [])
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');
}

// --- OpenAI y compatibles (OpenAI, LM Studio, OpenRouter, Groq...) -----------

async function chatOpenAICompatible(id: ProviderId, p: ProviderSettings, req: ChatRequest): Promise<string> {
  const content: unknown[] = [];
  for (const img of req.images) {
    content.push({ type: 'text', text: img.label });
    content.push({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.base64}` } });
  }
  content.push({ type: 'text', text: req.userText });

  const messages = [
    { role: 'system', content: req.system },
    ...req.history.flatMap((t) => [
      { role: 'user', content: t.user },
      { role: 'assistant', content: t.assistant },
    ]),
    // Sin imágenes mandamos string plano: algunos servidores locales no aceptan arrays.
    { role: 'user', content: req.images.length ? content : req.userText },
  ];

  // La API oficial de OpenAI rechaza max_tokens en modelos nuevos; los servidores
  // compatibles suelen entender solo max_tokens.
  const tokenField = id === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const headers: Record<string, string> = p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {};
  const data = await postJson(
    `${trimSlash(p.baseUrl)}/chat/completions`,
    headers,
    { model: p.model || undefined, messages, [tokenField]: req.maxTokens },
    req.signal,
  );
  const msg = data.choices?.[0]?.message?.content;
  if (Array.isArray(msg)) return msg.map((part: { text?: string }) => part.text ?? '').join('');
  return msg ?? '';
}

// --- Gemini -------------------------------------------------------------------

async function chatGemini(p: ProviderSettings, req: ChatRequest): Promise<string> {
  const parts: unknown[] = [];
  for (const img of req.images) {
    parts.push({ text: img.label });
    parts.push({ inline_data: { mime_type: img.mediaType, data: img.base64 } });
  }
  parts.push({ text: req.userText });

  const contents = [
    ...req.history.flatMap((t) => [
      { role: 'user', parts: [{ text: t.user }] },
      { role: 'model', parts: [{ text: t.assistant }] },
    ]),
    { role: 'user', parts },
  ];

  // Sin maxOutputTokens: en modelos con "thinking" el presupuesto se come la respuesta.
  const data = await postJson(
    `${trimSlash(p.baseUrl)}/models/${encodeURIComponent(p.model)}:generateContent`,
    { 'x-goog-api-key': p.apiKey },
    { systemInstruction: { parts: [{ text: req.system }] }, contents },
    req.signal,
  );
  const candidateParts = data.candidates?.[0]?.content?.parts ?? [];
  return candidateParts
    .filter((part: { thought?: boolean }) => !part.thought)
    .map((part: { text?: string }) => part.text ?? '')
    .join('');
}

// --- Ollama (API nativa: soporta imágenes en cualquier modelo de visión) -------

async function chatOllama(p: ProviderSettings, req: ChatRequest): Promise<string> {
  // /api/chat no permite etiquetar cada imagen, así que las describimos en el texto.
  const labels = req.images.map((img, i) => `imagen ${i + 1}: ${img.label}`).join('\n');
  const userText = labels ? `${labels}\n\n${req.userText}` : req.userText;

  const messages = [
    { role: 'system', content: req.system },
    ...req.history.flatMap((t) => [
      { role: 'user', content: t.user },
      { role: 'assistant', content: t.assistant },
    ]),
    { role: 'user', content: userText, ...(req.images.length ? { images: req.images.map((i) => i.base64) } : {}) },
  ];

  const data = await postJson(
    `${trimSlash(p.baseUrl)}/api/chat`,
    {},
    { model: p.model, messages, stream: false, options: { num_predict: req.maxTokens } },
    req.signal,
  );
  return data.message?.content ?? '';
}

// --- API pública ----------------------------------------------------------------

export async function chat(id: ProviderId, p: ProviderSettings, req: ChatRequest): Promise<string> {
  let text: string;
  switch (id) {
    case 'claude-code':
    case 'gemini-cli':
      text = await chatCli(id, p, req);
      break;
    case 'anthropic':
      text = await chatAnthropic(p, req);
      break;
    case 'gemini':
      text = await chatGemini(p, req);
      break;
    case 'ollama':
      text = await chatOllama(p, req);
      break;
    case 'openai':
    case 'lmstudio':
    case 'custom':
      text = await chatOpenAICompatible(id, p, req);
      break;
  }
  return stripThinking(text);
}

export async function listModels(id: ProviderId, p: ProviderSettings): Promise<string[]> {
  const base = trimSlash(p.baseUrl);
  let names: string[];
  switch (id) {
    case 'claude-code':
    case 'gemini-cli':
      // Comprueba que la CLI existe y arranca; los modelos son alias fijos.
      await findCli(id === 'claude-code' ? 'claude' : 'gemini', p.baseUrl);
      return CLI_MODELS[id];
    case 'anthropic': {
      const data = await getJson(`${base}/v1/models?limit=1000`, {
        'x-api-key': p.apiKey,
        'anthropic-version': '2023-06-01',
      });
      names = data.data.map((m: { id: string }) => m.id);
      break;
    }
    case 'gemini': {
      const data = await getJson(`${base}/models?pageSize=1000`, { 'x-goog-api-key': p.apiKey });
      names = data.models
        .filter((m: { supportedGenerationMethods?: string[] }) =>
          m.supportedGenerationMethods?.includes('generateContent'),
        )
        .map((m: { name: string }) => m.name.replace(/^models\//, ''));
      break;
    }
    case 'ollama': {
      const data = await getJson(`${base}/api/tags`);
      names = data.models.map((m: { name: string }) => m.name);
      break;
    }
    default: {
      const data = await getJson(`${base}/models`, p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {});
      names = data.data.map((m: { id: string }) => m.id);
    }
  }
  return names.sort();
}
