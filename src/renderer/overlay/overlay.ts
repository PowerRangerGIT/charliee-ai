// Overlay transparente (uno por monitor, click-through). Dibuja el triángulo
// azul que sigue al cursor, la onda mientras escucha, el spinner mientras
// piensa, y el vuelo en arco hasta el elemento que la IA quiere señalar.

import type { PointTarget, VoiceState } from '../../shared/types';

type Vec = { x: number; y: number };
type Mode = 'follow' | 'flying' | 'pointing' | 'returning';

const FOLLOW_OFFSET: Vec = { x: 16, y: 14 };
/** La punta del triángulo está en (3,2) dentro del SVG. */
const TIP: Vec = { x: 3, y: 2 };
const POINT_HOLD_MS = 3200;

const buddy = document.getElementById('buddy')!;
const triangle = document.getElementById('triangle')!;
const bubble = document.getElementById('bubble')!;
const highlight = document.getElementById('highlight')!;
const RING_SIZE = 44;
const HIGHLIGHT_PAD = 4;
const bars = [...document.querySelectorAll<HTMLSpanElement>('#wave span')];

let displayId = -1;
let origin: Vec = { x: 0, y: 0 };
let size: Vec = { x: window.innerWidth, y: window.innerHeight };
let cursor: Vec = { x: -9999, y: -9999 };
let pos: Vec = { x: -100, y: -100 };
let voiceState: VoiceState = 'idle';
let enabled = true;
let showCaption = true;
let caption: string | null = null;
let pointingOwner: number | null = null;
let level = 0;

let mode: Mode = 'follow';
let flight: { from: Vec; control: Vec; to: Vec; start: number; duration: number } | null = null;
let pointLabel = '';
let pointTarget: PointTarget | null = null;
let holdUntil = 0;

const local = (p: Vec): Vec => ({ x: p.x - origin.x, y: p.y - origin.y });
const inside = (p: Vec) => p.x >= 0 && p.y >= 0 && p.x < size.x && p.y < size.y;
const clampToScreen = (p: Vec): Vec => ({
  x: Math.max(20, Math.min(p.x, size.x - 20)),
  y: Math.max(20, Math.min(p.y, size.y - 20)),
});
const followTarget = () => clampToScreen({ x: local(cursor).x + FOLLOW_OFFSET.x, y: local(cursor).y + FOLLOW_OFFSET.y });

function startFlight(to: Vec, next: Mode) {
  const from = { ...pos };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // Arco: punto de control desplazado en perpendicular, siempre hacia arriba.
  const bend = Math.min(distance * 0.3, 220);
  const nx = distance ? -dy / distance : 0;
  const ny = distance ? dx / distance : 0;
  const sign = ny > 0 ? -1 : 1;
  const control = { x: (from.x + to.x) / 2 + nx * bend * sign, y: (from.y + to.y) / 2 + ny * bend * sign };
  flight = { from, control, to, start: performance.now(), duration: Math.max(600, Math.min(1400, distance * 1.1)) };
  mode = next;
}

function bezier(t: number, a: Vec, c: Vec, b: Vec): Vec {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function setBubble(text: string | null, kind: 'caption' | 'label') {
  if (!text) {
    bubble.classList.remove('visible');
    return;
  }
  if (bubble.textContent !== text) bubble.textContent = text;
  bubble.classList.toggle('label', kind === 'label');
  bubble.classList.add('visible');

  const rect = kind === 'label' ? pointTarget?.rect : undefined;
  if (rect) {
    // Etiqueta fuera del control resaltado: debajo si cabe, si no encima.
    const below = rect.y + rect.height + HIGHLIGHT_PAD + 8;
    const top = below + bubble.offsetHeight < size.y ? below : rect.y - HIGHLIGHT_PAD - 8 - bubble.offsetHeight;
    const left = Math.max(8, Math.min(rect.x - HIGHLIGHT_PAD, size.x - bubble.offsetWidth - 8));
    bubble.classList.remove('flip-x', 'flip-y');
    bubble.style.left = `${left - pos.x}px`;
    bubble.style.top = `${top - pos.y}px`;
    return;
  }
  bubble.style.left = '';
  bubble.style.top = '';
  bubble.classList.toggle('flip-x', pos.x + 380 > size.x);
  bubble.classList.toggle('flip-y', pos.y + bubble.offsetHeight + 60 > size.y);
}

function frame(now: number) {
  let visible = false;
  let scale = 1;

  if (mode === 'follow') {
    const cursorHere = inside(local(cursor));
    visible = enabled && cursorHere && pointingOwner === null;
    const target = followTarget();
    // Primer frame en este monitor: salta, no animes desde fuera de la pantalla.
    if (!inside(pos)) pos = target;
    pos = { x: pos.x + (target.x - pos.x) * 0.35, y: pos.y + (target.y - pos.y) * 0.35 };
  } else if (flight && (mode === 'flying' || mode === 'returning')) {
    visible = true;
    const t = Math.min(1, (now - flight.start) / flight.duration);
    pos = bezier(easeInOut(t), flight.from, flight.control, flight.to);
    scale = 1 + Math.sin(Math.PI * t) * 0.3;
    if (mode === 'returning') flight.to = followTarget(); // persigue al cursor si se mueve
    if (t >= 1) {
      if (mode === 'flying') {
        mode = 'pointing';
        holdUntil = now + POINT_HOLD_MS;
      } else {
        mode = 'follow';
        flight = null;
        window.clicky.send('overlay:point-done', displayId);
      }
    }
  } else if (mode === 'pointing') {
    visible = true;
    if (now >= holdUntil && voiceState !== 'responding') startFlight(followTarget(), 'returning');
  }

  buddy.classList.toggle('hidden', !visible);
  buddy.classList.toggle('flying', mode === 'flying' || mode === 'returning');
  buddy.dataset.state = mode === 'follow' ? voiceState : 'idle';
  buddy.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  triangle.style.transform = `scale(${scale})`;

  // Resaltado: aparece cuando el triángulo llega y se va cuando vuelve.
  if (pointTarget && mode === 'pointing') {
    const r = pointTarget.rect ?? {
      x: pointTarget.x - RING_SIZE / 2,
      y: pointTarget.y - RING_SIZE / 2,
      width: RING_SIZE,
      height: RING_SIZE,
    };
    const pad = pointTarget.rect ? HIGHLIGHT_PAD : 0;
    highlight.style.transform = `translate(${r.x - pad}px, ${r.y - pad}px)`;
    highlight.style.width = `${r.width + pad * 2}px`;
    highlight.style.height = `${r.height + pad * 2}px`;
    highlight.classList.toggle('ring', !pointTarget.rect);
    highlight.classList.add('visible');
  } else {
    highlight.classList.remove('visible');
  }

  if (mode === 'pointing') setBubble(pointLabel, 'label');
  else if (mode === 'follow' && showCaption && caption && voiceState !== 'listening') setBubble(caption, 'caption');
  else setBubble(null, 'caption');

  if (voiceState === 'listening') {
    bars.forEach((bar, i) => {
      const wobble = 0.55 + 0.45 * Math.sin(now / 90 + i * 1.3);
      bar.style.height = `${4 + level * 18 * wobble}px`;
    });
  }

  requestAnimationFrame(frame);
}

const on = window.clicky.on;

on('overlay:init', (info: { displayId: number; bounds: { x: number; y: number; width: number; height: number } }) => {
  displayId = info.displayId;
  origin = { x: info.bounds.x, y: info.bounds.y };
  size = { x: info.bounds.width, y: info.bounds.height };
});
on('overlay:cursor', (p: Vec) => (cursor = p));
on('overlay:state', (s: VoiceState) => (voiceState = s));
on('overlay:level', (l: number) => (level = l));
on('overlay:caption', (text: string | null) => (caption = text));
on('overlay:options', (o: { enabled: boolean; showCaption: boolean }) => {
  enabled = o.enabled;
  showCaption = o.showCaption;
});
on('overlay:pointing-owner', (owner: number | null) => (pointingOwner = owner));
on('overlay:point', (target: PointTarget) => {
  if (target.displayId !== displayId) return;
  // Si el cursor está en otro monitor, despega desde el borde más cercano.
  if (!inside(pos) || mode === 'follow') pos = clampToScreen(mode === 'follow' ? followTarget() : pos);
  pointLabel = target.label;
  pointTarget = target;
  // Con rectángulo, la punta va a la esquina inferior derecha del control para no taparlo.
  const tip = target.rect
    ? { x: Math.min(target.x + target.rect.width / 2, target.x + 40) - 4, y: Math.min(target.y + target.rect.height / 2, target.y + 30) - 4 }
    : { x: target.x, y: target.y };
  startFlight({ x: tip.x - TIP.x, y: tip.y - TIP.y }, 'flying');
});
on('overlay:cancel-point', () => {
  if (mode !== 'follow') startFlight(followTarget(), 'returning');
});

requestAnimationFrame(frame);
