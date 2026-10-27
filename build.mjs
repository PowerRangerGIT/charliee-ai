// Build con esbuild: main + preload (Node/CJS) y renderers (navegador/ESM).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2022' };

await build({
  ...common,
  entryPoints: { 'main/main': 'src/main/main.ts', 'preload/preload': 'src/preload/preload.ts' },
  outdir: out,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'uiohook-napi'],
});

await build({
  ...common,
  entryPoints: {
    'renderer/overlay/overlay': 'src/renderer/overlay/overlay.ts',
    'renderer/engine/engine': 'src/renderer/engine/engine.ts',
    'renderer/settings/settings': 'src/renderer/settings/settings.ts',
  },
  outdir: out,
  platform: 'browser',
  format: 'esm',
});

// Estáticos de cada renderer.
for (const name of ['overlay', 'engine', 'settings']) {
  const src = path.join('src/renderer', name);
  for (const file of fs.readdirSync(src)) {
    if (/\.(html|css)$/.test(file)) fs.copyFileSync(path.join(src, file), path.join(out, 'renderer', name, file));
  }
}

// Runtime ONNX para Whisper local (ver engine.ts).
const ortDist = 'node_modules/onnxruntime-web/dist';
for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  fs.copyFileSync(path.join(ortDist, file), path.join(out, 'renderer/engine', file));
}
