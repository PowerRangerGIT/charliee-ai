// Proveedores vía CLI: Claude Code y Gemini CLI en modo headless. Usan la
// sesión ya iniciada en esas herramientas (tu plan Pro/Max/etc.) en vez de
// una API key. Cada llamada es un proceso nuevo y sin estado: el historial
// va como texto dentro del mensaje.

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderSettings } from '../shared/types';
import type { ChatRequest } from './llm';

export type CliProviderId = 'claude-code' | 'gemini-cli';

const TIMEOUT_MS = 180_000;
/** Con claude.cmd/gemini.cmd los argumentos pasan por cmd.exe: solo nombres de modelo simples. */
const SAFE_MODEL = /^[\w.\-:/\[\]]*$/;

function checkModel(model: string) {
  if (!SAFE_MODEL.test(model)) throw new Error(`Nombre de modelo no válido: ${model}`);
  return model;
}

// --- Localizar el ejecutable --------------------------------------------------

const resolved = new Map<string, string>();

function candidates(name: string): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const fixed =
    name === 'claude'
      ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd')]
      : [path.join(appData, 'npm', 'gemini.cmd'), path.join(local, 'Programs', 'gemini', 'gemini.exe')];
  return fixed;
}

function whereAll(name: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where.exe', [name], { windowsHide: true }, (_err, stdout) => {
      resolve(
        String(stdout ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /\.(exe|cmd)$/i.test(l)),
      );
    });
  });
}

function runVersion(exe: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawnCli(exe, ['--version']);
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', () => resolve(false));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

const isCmd = (exe: string) => /\.(cmd|bat)$/i.test(exe);

/**
 * Los shims .cmd de npm solo arrancan vía cmd.exe. Node desaconseja pasar
 * args con shell:true, así que montamos la línea nosotros (args ya validados).
 */
function spawnCli(exe: string, args: string[], options: Parameters<typeof spawn>[2] = {}) {
  const opts = { windowsHide: true, ...options };
  return isCmd(exe) ? spawn([`"${exe}"`, ...args].join(' '), { ...opts, shell: true }) : spawn(exe, args, opts);
}

/** Primer ejecutable que realmente arranca (`where` puede listar shims rotos, p.ej. de nvm). */
export async function findCli(name: 'claude' | 'gemini', override: string): Promise<string> {
  if (override.trim()) return override.trim();
  const cached = resolved.get(name);
  if (cached) return cached;
  const list = [...new Set([...candidates(name), ...(await whereAll(name))])].filter((p) => fs.existsSync(p));
  // .exe antes que .cmd: arranca más rápido y sin pasar por cmd.exe.
  list.sort((a, b) => Number(isCmd(a)) - Number(isCmd(b)));
  for (const exe of list) {
    if (await runVersion(exe)) {
      resolved.set(name, exe);
      return exe;
    }
  }
  throw new Error(
    name === 'claude'
      ? 'No encontré Claude Code. Instálalo (npm i -g @anthropic-ai/claude-code) y ejecuta "claude" una vez para iniciar sesión.'
      : 'No encontré Gemini CLI. Instálalo (npm i -g @google/gemini-cli) y ejecuta "gemini" una vez para iniciar sesión.',
  );
}

// --- Ejecutar ------------------------------------------------------------------

function historyText(req: ChatRequest): string {
  if (!req.history.length) return '';
  const turns = req.history.map((t) => `user: ${t.user}\nyou: ${t.assistant}`).join('\n\n');
  return `conversation so far (for context):\n${turns}\n\n---\n\n`;
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clicky-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// --- Claude Code -----------------------------------------------------------------

async function chatClaudeCode(p: ProviderSettings, req: ChatRequest): Promise<string> {
  const exe = await findCli('claude', p.baseUrl);
  return withTempDir(async (dir) => {
    const systemFile = path.join(dir, 'system.md');
    fs.writeFileSync(systemFile, req.system);

    const content: unknown[] = [];
    const history = historyText(req);
    if (history) content.push({ type: 'text', text: history });
    for (const img of req.images) {
      content.push({ type: 'text', text: img.label });
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
    content.push({ type: 'text', text: req.userText });
    const stdin = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--system-prompt-file', systemFile,
      '--tools', '',
      // Sin hooks/plugins/MCP del usuario: arranca en ~2 s en vez de ~20 s.
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      ...(p.model ? ['--model', checkModel(p.model)] : []),
    ];
    // Con shell (claude.cmd) los argumentos vacíos y rutas necesitan comillas.
    const finalArgs = isCmd(exe) ? args.map((a) => (a === '' ? '""' : a.includes(' ') ? `"${a}"` : a)) : args;

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Si hay ANTHROPIC_API_KEY en el entorno, Claude Code la usaría en vez del plan.
    delete env.ANTHROPIC_API_KEY;
    const { stdout, stderr, code } = await run(exe, finalArgs, { cwd: dir, stdin, env, signal: req.signal });

    const result = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((msg) => msg?.type === 'result');

    if (!result) throw new Error(`Claude Code falló (código ${code}): ${(stderr || stdout).slice(0, 300)}`);
    if (result.is_error) {
      const text = String(result.result ?? '');
      if (/not logged in|\/login/i.test(text)) {
        throw new Error('Claude Code no tiene sesión. Abre una terminal, ejecuta "claude" y usa /login con tu cuenta.');
      }
      throw new Error(`Claude Code: ${text.slice(0, 300)}`);
    }
    return String(result.result ?? '');
  });
}

function run(
  exe: string,
  args: string[],
  opts: { cwd: string; stdin: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal },
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawnCli(exe, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => (stdout += d));
    child.stderr!.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
    child.stdin!.end(opts.stdin);
  });
}

// --- Gemini CLI --------------------------------------------------------------------

async function chatGeminiCli(p: ProviderSettings, req: ChatRequest): Promise<string> {
  const exe = await findCli('gemini', p.baseUrl);
  return withTempDir(async (dir) => {
    const systemFile = path.join(dir, 'system.md');
    fs.writeFileSync(systemFile, req.system);

    // Gemini CLI adjunta archivos (incluidas imágenes) con @ruta, relativa al workspace (cwd).
    const lines: string[] = [];
    req.images.forEach((img, i) => {
      const name = `screen${i + 1}.${img.mediaType === 'image/png' ? 'png' : 'jpg'}`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(img.base64, 'base64'));
      lines.push(`${img.label}: @${name}`);
    });
    const prompt = `${historyText(req)}${lines.join('\n')}${lines.length ? '\n\n' : ''}${req.userText}`;

    const args = ['-p', ' ', '-o', 'json', '--approval-mode', 'plan', ...(p.model ? ['-m', checkModel(p.model)] : [])];
    const finalArgs = isCmd(exe) ? args.map((a) => (a.trim() === '' ? '" "' : a)) : args;
    const env: NodeJS.ProcessEnv = { ...process.env, GEMINI_SYSTEM_MD: systemFile };
    // Igual que con Claude: sin key en el entorno, usa la cuenta de Google con la que iniciaste sesión.
    delete env.GEMINI_API_KEY;
    delete env.GOOGLE_API_KEY;

    const { stdout, stderr, code } = await run(exe, finalArgs, { cwd: dir, stdin: prompt, env, signal: req.signal });
    const jsonStart = stdout.indexOf('{');
    let data: { response?: string; error?: { message?: string } } | null = null;
    try {
      data = jsonStart >= 0 ? JSON.parse(stdout.slice(jsonStart)) : null;
    } catch {
      data = null;
    }
    if (data?.response !== undefined && !data.error) return data.response;
    const detail = data?.error?.message ?? (stderr || stdout);
    if (/auth|login|credential/i.test(detail)) {
      throw new Error('Gemini CLI no tiene sesión. Abre una terminal, ejecuta "gemini" e inicia sesión con Google.');
    }
    throw new Error(`Gemini CLI falló (código ${code}): ${detail.slice(0, 300)}`);
  });
}

export function chatCli(id: CliProviderId, p: ProviderSettings, req: ChatRequest): Promise<string> {
  return id === 'claude-code' ? chatClaudeCode(p, req) : chatGeminiCli(p, req);
}

export const CLI_MODELS: Record<CliProviderId, string[]> = {
  'claude-code': ['sonnet', 'opus', 'haiku'],
  'gemini-cli': ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3-flash-preview'],
};

