// Generate Teams app icons (color 192x192, outline 32x32) as minimal PNGs.
// Abstract "lightning-in-hexagon" motif — no Microsoft trademarks.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "teams", "appPackage");
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const S = 192;
const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // vertical gradient purple->indigo
    const t = y / S;
    const r = Math.round(124 - 60 * t);
    const g = Math.round(140 - 30 * t);
    const b = Math.round(255 - 120 * t);
    // hexagon mask
    const cx = S / 2, cy = S / 2, R = S * 0.46, rIn = S * 0.4;
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    const inHex = (dy <= R * 0.866) && (dx <= R * 0.5 + (R * 0.5 - dx) * 0 + R * 0.5 * (1 - dy / (R * 0.866)));
    const inHex2 = dy <= R * 0.866 && dx <= R * 0.5 * (2 - dy / (R * 0.866)) / 1;
    // simple point-in-hexagon: |x-cx| <= R/2 * (2 - |y-cy|/(R*0.866))
    const hw = (R / 2) * (2 - dy / (R * 0.866));
    const inside = dx <= hw;
    if (inside) {
      // lightning bolt glyph (two triangles)
      const bx = cx - 10, by = cy - 30;
      const bolt = (x > bx - 26 && x < bx + 26 && y > by - 40 && y < by + 44 && Math.abs((y - by) + 0.6 * (x - bx)) < 26);
      const bolt2 = (x > bx - 30 && x < bx + 22 && y > by - 44 && y < by + 48 && Math.abs((x - bx) - 0.35 * (y - by)) < 20);
      px[i] = bolt2 ? 255 : r; px[i + 1] = bolt2 ? 255 : g; px[i + 2] = bolt2 ? 255 : b; px[i + 3] = 255;
    } else {
      px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
    }
  }
}
fs.writeFileSync(path.join(outDir, "color.png"), png(S, S, px));

// outline: 32x32 transparent with white hexagon ring
const S2 = 32;
const px2 = Buffer.alloc(S2 * S2 * 4);
for (let y = 0; y < S2; y++) {
  for (let x = 0; x < S2; x++) {
    const i = (y * S2 + x) * 4;
    const cx = S2 / 2, cy = S2 / 2, R = S2 * 0.42;
    const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
    const hw = (R / 2) * (2 - dy / (R * 0.866));
    const dist = dx - hw;
    const ring = dist > -2.2 && dist < 0.5 && dy <= R * 0.866 + 1;
    if (ring) { px2[i] = 255; px2[i + 1] = 255; px2[i + 2] = 255; px2[i + 3] = 255; }
    else { px2[i] = 0; px2[i + 1] = 0; px2[i + 2] = 0; px2[i + 3] = 0; }
  }
}
fs.writeFileSync(path.join(outDir, "outline.png"), png(S2, S2, px2));
console.log("icons written -> teams/appPackage/{color.png,outline.png}");
