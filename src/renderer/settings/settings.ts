// Ventana de ajustes. Los campos genéricos se enlazan con data-path="a.b";
// el bloque de proveedor se enlaza a mano porque depende del proveedor elegido.

import { CLI_PROVIDERS, type ProviderId, type ProviderSettings, type Settings } from '../../shared/types';

const $ = <T extends HTMLElement = HTMLInputElement>(id: string) => document.getElementById(id) as T;

const PROVIDER_HINTS: Record<ProviderId, string> = {
  'claude-code':
    'Usa tu suscripción de Claude (Pro/Max) a través de Claude Code. Requisito: <code>npm i -g @anthropic-ai/claude-code</code>, luego en una terminal <code>claude</code> → <code>/login</code>. Algo más lento que la API (arranca un proceso por pregunta).',
  'gemini-cli':
    'Usa tu cuenta de Google (gratis o Google AI Pro) a través de Gemini CLI. Requisito: <code>npm i -g @google/gemini-cli</code>, luego en una terminal <code>gemini</code> e inicia sesión con Google.',
  anthropic: 'Key en <a href="https://console.anthropic.com/settings/keys">console.anthropic.com</a>. Todos los Claude actuales ven imágenes.',
  openai: 'Key en <a href="https://platform.openai.com/api-keys">platform.openai.com</a>. Usa un modelo con visión.',
  gemini: 'Key gratis en <a href="https://aistudio.google.com/apikey">aistudio.google.com</a>.',
  ollama:
    'Sin key. Instala un modelo con visión, p.ej. <code>ollama pull qwen2.5vl</code> o <code>gemma3</code>, y deja Ollama abierto.',
  lmstudio:
    'Sin key. En LM Studio: pestaña Developer → Start Server, y carga un modelo con visión (Qwen2.5-VL, Gemma 3...). Modelo vacío = el cargado.',
  custom: 'Cualquier API compatible con OpenAI: OpenRouter, Groq, Together, vLLM, llama.cpp server...',
};
const NEEDS_KEY: ProviderId[] = ['anthropic', 'openai', 'gemini', 'custom'];

let settings: Settings;
let currentProvider: ProviderId;

function getPath(obj: any, path: string) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function boundFields() {
  return [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-path]')];
}

function fillProviderFields() {
  const p = settings.providers[currentProvider];
  $('apiKey').value = p.apiKey;
  $('baseUrl').value = p.baseUrl;
  $('model').value = p.model;
  $('providerHint').innerHTML = PROVIDER_HINTS[currentProvider];
  $('apiKeyRow').style.display = NEEDS_KEY.includes(currentProvider) ? '' : 'none';
  const isCli = CLI_PROVIDERS.includes(currentProvider);
  $('baseUrlLabel').textContent = isCli ? 'Ruta del ejecutable (vacío = buscar automáticamente)' : 'URL base';
  $('loadModels').textContent = isCli ? 'Comprobar CLI' : 'Cargar modelos';
  $('modelList').innerHTML = '';
}

function readProviderFields() {
  const p: ProviderSettings = settings.providers[currentProvider];
  p.apiKey = $('apiKey').value.trim();
  p.baseUrl = $('baseUrl').value.trim();
  p.model = $('model').value.trim();
}

function render() {
  currentProvider = settings.provider;
  $<HTMLSelectElement>('provider').value = currentProvider;
  fillProviderFields();
  for (const el of boundFields()) {
    const value = getPath(settings, el.dataset.path!);
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = String(value ?? '');
  }
  updateVisibility();
}

function collect(): Settings {
  readProviderFields();
  settings.provider = currentProvider;
  for (const el of boundFields()) {
    let value: unknown = el.value;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
    else if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range')) value = Number(el.value);
    setPath(settings, el.dataset.path!, value);
  }
  return settings;
}

function updateVisibility() {
  for (const el of document.querySelectorAll<HTMLElement>('[data-show]')) {
    const [id, expected] = el.dataset.show!.split('=');
    el.classList.toggle('shown', $<HTMLSelectElement>(id).value === expected);
  }
  $('rateValue').textContent = `${Number($('rate').value).toFixed(2)}×`;
  const hotkey = $<HTMLSelectElement>('hotkey');
  $('hotkeyHint').textContent = hotkey.selectedOptions[0]?.textContent?.split(' (')[0] ?? '';
}

function log(message: string) {
  const el = $('log');
  el.textContent = [message, ...(el.textContent ?? '').split('\n')].slice(0, 2).join('\n');
}

async function save() {
  settings = await window.charliee.invoke('settings:save', collect());
}

async function loadVoices() {
  const voices: { name: string; lang: string; local: boolean }[] = await window.charliee.invoke('settings:voices');
  const select = $<HTMLSelectElement>('systemVoice');
  // Primero las voces del idioma elegido.
  const langPrefix = settings.stt.language.slice(0, 2);
  voices.sort((a, b) => Number(b.lang.startsWith(langPrefix)) - Number(a.lang.startsWith(langPrefix)));
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v.name;
    opt.textContent = `${v.name} (${v.lang})`;
    select.append(opt);
  }
  select.value = settings.tts.systemVoice;
}

function showUpdate(u: { text: string; kind: string }) {
  $('updateText').textContent = u.text;
  const action = $<HTMLButtonElement>('updateAction');
  action.hidden = u.kind !== 'ready' && u.kind !== 'available';
  action.dataset.kind = u.kind;
  action.textContent = u.kind === 'ready' ? 'Reiniciar y actualizar' : 'Descargar';
}

async function init() {
  const data = await window.charliee.invoke('settings:get');
  settings = data.settings;
  document.title = `Charliee AI ${data.version} — Ajustes`;
  $('version').textContent = `v${data.version}`;
  showUpdate({ text: data.update, kind: data.updateKind });
  window.charliee.on('app:update', showUpdate);
  $('checkUpdates').addEventListener('click', async () => {
    await save();
    await window.charliee.invoke('settings:check-updates');
  });
  $('updateAction').addEventListener('click', () => {
    const kind = $('updateAction').dataset.kind;
    void window.charliee.invoke(kind === 'ready' ? 'settings:install-update' : 'settings:download-update');
  });

  const providerSelect = $<HTMLSelectElement>('provider');
  for (const [id, label] of Object.entries(data.providerLabels as Record<string, string>)) {
    providerSelect.add(new Option(label, id));
  }
  const hotkeySelect = $<HTMLSelectElement>('hotkey');
  for (const [id, label] of Object.entries(data.hotkeyLabels as Record<string, string>)) {
    hotkeySelect.add(new Option(label, id));
  }
  render();
  void loadVoices();

  providerSelect.addEventListener('change', () => {
    readProviderFields();
    currentProvider = providerSelect.value as ProviderId;
    fillProviderFields();
  });
  document.addEventListener('change', updateVisibility);
  document.addEventListener('input', updateVisibility);

  $('save').addEventListener('click', async () => {
    await save();
  });

  $('loadModels').addEventListener('click', async () => {
    readProviderFields();
    const button = $<HTMLButtonElement>('loadModels');
    button.disabled = true;
    try {
      const models: string[] = await window.charliee.invoke(
        'settings:list-models',
        currentProvider,
        settings.providers[currentProvider],
      );
      $('modelList').innerHTML = models.map((m) => `<option value="${m.replace(/"/g, '&quot;')}"></option>`).join('');
      log(
        CLI_PROVIDERS.includes(currentProvider)
          ? 'CLI encontrada. Si al preguntar dice que no hay sesión, inicia sesión en la terminal.'
          : `${models.length} modelos disponibles — haz clic en el campo Modelo para elegir`,
      );
      if (!$('model').value && models[0]) $('model').value = models[0];
    } catch (err) {
      log(`No pude listar modelos: ${err instanceof Error ? err.message : err}`);
    } finally {
      button.disabled = false;
    }
  });

  $('preloadWhisper').addEventListener('click', async () => {
    await save();
    log('Descargando modelo de voz…');
    await window.charliee.invoke('settings:preload-whisper');
  });

  const ask = async () => {
    const text = $('askText').value.trim();
    if (!text) return;
    await save();
    const answer = $('answer');
    answer.classList.remove('error');
    answer.textContent = 'Pensando…';
    const result: { ok: boolean; text: string } = await window.charliee.invoke('settings:ask', text);
    answer.classList.toggle('error', !result.ok);
    answer.textContent = result.text || '(sin respuesta)';
  };
  $('ask').addEventListener('click', ask);
  $('askText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void ask();
  });

  $('clearHistory').addEventListener('click', () => window.charliee.invoke('settings:clear-history'));

  // Los enlaces de ayuda se abren fuera (main los intercepta con setWindowOpenHandler).
  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a?.href) {
      e.preventDefault();
      window.open(a.href, '_blank');
    }
  });

  window.charliee.on('app:status', log);
}

void init();
