# Charliee AI

Compañera IA para Windows basada en [Clicky](https://github.com/farzaa/clicky) (de Farza, licencia MIT). Vive junto a tu cursor, ve tu pantalla, te escucha y **vuela a señalar** el botón o menú del que te habla.

La diferencia con el original: aquí eliges la IA.

| Proveedor | Necesita | Notas |
|---|---|---|
| **Claude Code** | Tu plan Claude Pro/Max | Sin API key: usa la sesión de la CLI `claude` |
| **Gemini CLI** | Tu cuenta Google | Sin API key: usa la sesión de la CLI `gemini` |
| Claude (Anthropic) | API key | Todos los Claude actuales ven imágenes |
| OpenAI | API key | Usa un modelo con visión |
| Google Gemini | API key (gratis en AI Studio) | |
| Ollama | Ollama abierto | Modelo con visión: `ollama pull qwen2.5vl` o `gemma3` |
| LM Studio | Servidor local activo | Developer → Start Server, carga un modelo con visión |
| Compatible OpenAI | URL + key | OpenRouter, Groq, vLLM, llama.cpp server... |

La voz es local y gratis por defecto: **Whisper** corre dentro de la app (se descarga una vez, ~80 MB) y la respuesta se lee con las **voces de Windows**. Si quieres, puedes usar Whisper/TTS de OpenAI o ElevenLabs.

## Instalar

Descarga `CharlieeAI-Setup-x.y.z.exe` desde **Releases** y ábrelo. Como el instalador no está firmado, Windows SmartScreen puede avisar: **Más información → Ejecutar de todas formas**. Desde el menú de la bandeja puedes activar **Iniciar con Windows**.

### Actualizaciones

La app instalada busca versiones nuevas en GitHub Releases al arrancar y cada 4 horas. Con **Actualizar automáticamente** activado (por defecto) la descarga en segundo plano y la instala al cerrar; también puedes **Reiniciar para actualizar** desde la bandeja o Ajustes → Actualizaciones.

## Usar tu plan en vez de una API key

Las APIs se pagan aparte de las suscripciones de chat. Con los proveedores CLI, Charliee llama a la herramienta oficial en modo headless y usa la sesión que ya tienes:

- **Claude Code**: `npm i -g @anthropic-ai/claude-code`, luego ejecuta `claude` en una terminal y haz `/login` con tu cuenta Pro/Max. Modelos: `sonnet`, `opus`, `haiku`.
- **Gemini CLI**: `npm i -g @google/gemini-cli`, luego ejecuta `gemini` e inicia sesión con Google.

Charliee busca el ejecutable solo; si no lo encuentra, pon la ruta en Ajustes. Cada pregunta arranca un proceso, así que tarda unos segundos más que la API. Ninguna herramienta puede tocar archivos ni ejecutar nada: Claude Code va sin herramientas y Gemini CLI en modo solo lectura.

## Cómo se usa

1. Al abrir la app por primera vez se abre Ajustes (también desde el icono de Charliee en la bandeja del sistema). Elige proveedor, pega la key o la URL local, pulsa **Cargar modelos** y **Guardar**.
2. Mantén **Ctrl + Shift**, habla, suelta.
3. Charliee piensa, te contesta en voz alta y, si ayuda, vuela hasta el elemento en pantalla.

- **Esc** corta la respuesta.
- Si mientras mantienes el atajo pulsas otra tecla (p. ej. Ctrl+Shift+T), no graba: así no estorba a tus atajos normales.
- En Ajustes hay un cuadro para **probar sin micrófono**.
- Sin visión (modelo de solo texto): desactiva "Enviar captura de pantalla".

## Precisión al ver y señalar

Los modelos de IA son malos adivinando píxeles exactos, así que Charliee no depende de eso:

1. **Controles numerados** ("Set-of-Mark"): Windows UI Automation lista los botones, menús, pestañas y campos visibles de la ventana activa y de la barra de tareas. Se dibujan numerados sobre la captura y se envían también como lista con sus nombres. La IA responde `[POINT:#12]` y Charliee resalta el **rectángulo exacto** de ese control.
2. **Coordenadas en el formato de cada modelo**: si lo que busca no es un control (un punto de un documento, una imagen...), usa coordenadas. A Gemini se le piden normalizadas 0-1000, que es como fue entrenado; al resto, en píxeles.
3. **Tamaño correcto de captura**: cada proveedor recibe la imagen al tamaño que procesa sin reescalarla (Claude ≤ 1,15 MP, por ejemplo). Si el servidor la reescalara, las coordenadas se desviarían.
4. **Zoom**: cuando señala por coordenadas, se manda un recorte ampliado a resolución nativa para que corrija el punto, mientras habla.

Si algo se señala mal, activa **Guardar diagnóstico** en Ajustes: en `%APPDATA%\charliee-ai\diagnostico` quedan la imagen que vio la IA (con marcas), su respuesta y dónde señaló al final. Se abre desde la bandeja.

Todo se puede desactivar en Ajustes → Pantalla y respuesta. Los modelos muy pequeños (por ejemplo, de 3B en local) suelen ignorar las instrucciones de señalado.

## Cómo funciona

```
Ctrl+Shift (uiohook) → micro 16 kHz (ventana engine) → Whisper local / API
      → captura de todas las pantallas (desktopCapturer)
      → controles de Windows numerados sobre la captura (UI Automation)
      → IA elegida con el prompt de Charliee → respuesta con [POINT:#N] o [POINT:x,y]
      → UI Automation / zoom afinan el punto
      → overlay transparente vuela y resalta el control  +  voz de Windows / API
```

| Archivo | Qué hace |
|---|---|
| `src/main/main.ts` | Bandeja, ventanas, pipeline completo |
| `src/main/llm.ts` | Un `chat()` para todos los proveedores + `listModels()` |
| `src/main/cli.ts` | Claude Code y Gemini CLI en modo headless |
| `src/main/uia.ts` | Windows UI Automation: controles visibles y control bajo un punto |
| `src/main/marks.ts` | Numera los controles sobre la captura (Set-of-Mark) |
| `src/main/updater.ts` | Actualizaciones automáticas desde GitHub Releases |
| `src/main/prompt.ts` | System prompt (portado del original) y parser de `[POINT]` |
| `src/main/capture.ts` | Capturas nativas, tamaño por proveedor, recortes con zoom |
| `src/main/hotkey.ts` | Push-to-talk global (mantener pulsado) |
| `src/main/speech.ts` | STT/TTS por API (opcional) |
| `src/main/config.ts` | Ajustes en `%APPDATA%\charliee-ai\config.json`, keys cifradas con DPAPI |
| `src/renderer/engine` | Ventana oculta: micro, Whisper (transformers.js), reproducción de voz |
| `src/renderer/overlay` | Cursor, onda, spinner, vuelo en arco, resaltado y burbujas |
| `src/renderer/settings` | Ventana de ajustes |

## Privacidad

- Con proveedor en la nube, cada pregunta envía tu voz transcrita **y capturas de todas tus pantallas** a ese proveedor. Con Ollama o LM Studio no sale nada de tu PC. Con Claude Code o Gemini CLI las capturas van a Anthropic o Google igual que con la API.
- El micrófono solo se abre mientras mantienes el atajo.
- Las API keys se guardan cifradas con la cuenta de Windows (safeStorage/DPAPI).

## Licencia

MIT. Basado en el código abierto de [Clicky](https://github.com/farzaa/clicky) de Farza. Si usabas la versión anterior ("Clicky Local"), tus ajustes se migran solos la primera vez.
