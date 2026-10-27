// Genera build/icon.png (256×256) con el triángulo azul de Clicky, sin
// dependencias: rasteriza el polígono con supersampling y escribe un PNG.
// electron-builder lo convierte a .ico para el instalador y el .exe.
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIZE = 256;
const SS = 4; // muestras por eje

// Mismo trazado que el SVG del overlay (viewBox 24×24), con margen.
const poly = [
  [3, 2],
  [21, 11],
  [12, 13],
  [9, 22],
].map(([x, y]) => [((x + 0.5) * SIZE) / 24, ((y + 0.5) * SIZE) / 24]);

function inside(px, py) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

// Filas RGBA con byte de filtro 0 al inicio de cada una.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) {
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) if (inside(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
    // Degradado vertical #60a5fa → #2563eb
    const t = y / SIZE;
    const o = y * (SIZE * 4 + 1) + 1 + x * 4;
    raw[o] = Math.round(0x60 + (0x25 - 0x60) * t);
    raw[o + 1] = Math.round(0xa5 + (0x63 - 0xa5) * t);
    raw[o + 2] = Math.round(0xfa + (0xeb - 0xfa) * t);
    raw[o + 3] = Math.round((hits / (SS * SS)) * 255);
  }
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bits
ihdr[9] = 6; // RGBA

fs.mkdirSync('build', { recursive: true });
fs.writeFileSync(
  'build/icon.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
console.log('build/icon.png listo');
