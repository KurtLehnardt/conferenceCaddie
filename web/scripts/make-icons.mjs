// Generates the app icons in web/public/icons using Node built-ins only.
// The mark is an accent-colored square with a white calendar that holds a check.
// Run with: node web/scripts/make-icons.mjs
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const ACCENT = [36, 87, 214]; // #2457D6, the light-theme accent color.
const WHITE = [255, 255, 255];
const SAMPLES = 4; // 4x4 supersampling per pixel for smooth edges.

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle centered at (cx, cy).
function roundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

// Distance to a line segment from (ax, ay) to (bx, by).
function segment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// True when the point (in glyph units, 0..1) is part of the white calendar mark.
function inGlyph(x, y) {
  const body = roundRect(x, y, 0.5, 0.53, 0.22, 0.21, 0.06);
  const outline = body <= 0 && body >= -0.05;
  const headerBand = body <= 0 && y <= 0.42;
  const ringLeft = roundRect(x, y, 0.4, 0.3, 0.025, 0.06, 0.025) <= 0;
  const ringRight = roundRect(x, y, 0.6, 0.3, 0.025, 0.06, 0.025) <= 0;
  const check =
    Math.min(segment(x, y, 0.4, 0.58, 0.47, 0.65), segment(x, y, 0.47, 0.65, 0.61, 0.51)) <= 0.03;
  return outline || headerBand || ringLeft || ringRight || check;
}

// Draws one icon. `rounded` gives transparent corners; `glyphScale` shrinks the
// mark toward the center (maskable icons keep content inside the safe zone).
function draw(size, { rounded, glyphScale }) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          const inBg = rounded ? roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0 : true;
          if (!inBg) continue;
          bg++;
          const gx = 0.5 + (x - 0.5) / glyphScale;
          const gy = 0.5 + (y - 0.5) / glyphScale;
          if (inGlyph(gx, gy)) fg++;
        }
      }
      const total = SAMPLES * SAMPLES;
      const alpha = bg / total;
      const mix = bg ? fg / bg : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(ACCENT[c] * (1 - mix) + WHITE[c] * mix);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ['icon-192.png', 192, { rounded: true, glyphScale: 1 }],
  ['icon-512.png', 512, { rounded: true, glyphScale: 1 }],
  ['icon-maskable-512.png', 512, { rounded: false, glyphScale: 0.8 }],
  ['apple-touch-icon.png', 180, { rounded: false, glyphScale: 0.9 }],
];
for (const [name, size, options] of icons) {
  writeFileSync(join(OUT, name), draw(size, options));
  console.log(`wrote ${name}`);
}
