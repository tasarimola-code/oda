// Renders the ODA app icon (gold voice bars on anthracite) to build/icon.png and build/icon.ico.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pngToIco from 'png-to-ico';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'build');
fs.mkdirSync(outDir, { recursive: true });

const BG = [0x16, 0x19, 0x1e];
const BORDER = [0x2a, 0x2e, 0x35];
const GOLD_TOP = [0xde, 0xbd, 0x7e];
const GOLD_BOTTOM = [0xb8, 0x8d, 0x48];

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const bars = (() => {
  const heights = [0.2, 0.38, 0.54, 0.38, 0.2];
  const w = 0.07;
  const gap = 0.05;
  const total = heights.length * w + (heights.length - 1) * gap;
  let x = 0.5 - total / 2 + w / 2;
  return heights.map((h) => {
    const b = { cx: x, hw: w / 2, hh: h / 2 };
    x += w + gap;
    return b;
  });
})();

function sample(u, v) {
  // returns [r,g,b,a] in 0..1 for unit coords
  const bgD = sdRoundRect(u, v, 0.5, 0.5, 0.47, 0.47, 0.2);
  if (bgD > 0) return [0, 0, 0, 0];
  let col = bgD > -0.012 ? BORDER : BG;
  for (const b of bars) {
    if (sdRoundRect(u, v, b.cx, 0.5, b.hw, b.hh, b.hw) <= 0) {
      const t = Math.min(1, Math.max(0, (v - 0.23) / 0.54));
      col = GOLD_TOP.map((c, i) => c + (GOLD_BOTTOM[i] - c) * t);
      break;
    }
  }
  return [col[0] / 255, col[1] / 255, col[2] / 255, 1];
}

function render(size) {
  const png = new PNG({ width: size, height: size });
  const ss = size <= 32 ? 8 : 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = sample((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const n = ss * ss;
      const idx = (y * size + x) * 4;
      png.data[idx + 3] = Math.round((a / n) * 255);
      png.data[idx] = a ? Math.round((r / a) * 255) : 0;
      png.data[idx + 1] = a ? Math.round((g / a) * 255) : 0;
      png.data[idx + 2] = a ? Math.round((b / a) * 255) : 0;
    }
  }
  return PNG.sync.write(png);
}

fs.writeFileSync(path.join(outDir, 'icon.png'), render(512));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const ico = await pngToIco(icoSizes.map((s) => render(s)));
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log('icon written:', path.join(outDir, 'icon.png'), path.join(outDir, 'icon.ico'));
