// Icono de Charliee AI dibujado por código (sin assets binarios): cuadrado
// obsidiana con el cursor en degradado lima → menta y un punto de "presencia".
// Se rasteriza con campos de distancia (antialias limpio a cualquier tamaño).
import zlib from 'node:zlib';

// Mismo trazado que el cursor del overlay (viewBox 24×24).
const CURSOR = [
  [3, 2],
  [21, 11],
  [12, 13],
  [9, 22],
];

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdPolygon(px, py, poly) {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const ex = bx - ax;
    const ey = by - ay;
    const t = clamp(((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey));
    d = Math.min(d, Math.hypot(px - ax - ex * t, py - ay - ey * t));
    if (ay > py !== by > py && px < (ex * (py - ay)) / ey + ax) inside = !inside;
  }
  return inside ? -d : d;
}

/** Píxeles RGBA (no premultiplicados) de un icono de size×size. */
export function renderIcon(size) {
  const k = size / 256;
  const cursor = CURSOR.map(([x, y]) => [(64 + (x - 3) * 6.4) * k, (58 + (y - 2) * 6.4) * k]);
  const dot = { x: 186 * k, y: 186 * k, r: 13 * k };
  const lime = hex('#dcf76a');
  const mint = hex('#8fe3c2');
  const out = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const dBox = sdRoundRect(px, py, size / 2, size / 2, size / 2 - 6 * k, size / 2 - 6 * k, 58 * k);
      const boxA = clamp(0.5 - dBox);
      if (boxA <= 0) continue;

      // Fondo: obsidiana con luz suave arriba a la izquierda.
      const light = clamp(1 - Math.hypot(px - 70 * k, py - 50 * k) / (230 * k));
      let r = mix(10, 30, light * light);
      let g = mix(11, 33, light * light);
      let b = mix(13, 38, light * light);

      // Filo interior fino, más visible arriba.
      const rim = clamp(1 - Math.abs(dBox + 1.5 * k) / (1.2 * k)) * mix(0.16, 0.04, py / size);
      r = mix(r, 255, rim);
      g = mix(g, 255, rim);
      b = mix(b, 255, rim);

      // Halo lima bajo el cursor.
      const dCur = sdPolygon(px, py, cursor);
      const glow = dCur > 0 ? 0.16 * Math.exp(-((dCur / (16 * k)) ** 2)) : 0;
      r = mix(r, lime[0], glow);
      g = mix(g, lime[1], glow);
      b = mix(b, lime[2], glow);

      // Cursor y punto, degradado diagonal lima → menta.
      const t = clamp((px + py - 120 * k) / (260 * k));
      const shapeA = Math.max(clamp(0.5 - dCur / Math.max(k, 0.6)), clamp(0.5 - (Math.hypot(px - dot.x, py - dot.y) - dot.r)));
      r = mix(r, mix(lime[0], mint[0], t), shapeA);
      g = mix(g, mix(lime[1], mint[1], t), shapeA);
      b = mix(b, mix(lime[2], mint[2], t), shapeA);

      const o = (y * size + x) * 4;
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = Math.round(boxA * 255);
    }
  }
  return out;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function iconPng(size) {
  const rgba = renderIcon(size);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro "none"
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
