'use strict';
/**
 * 生成图标资源（纯 Node，无第三方依赖）：
 *   icon.png        —— 256×256，供 Electron 托盘使用
 *   build/icon.ico  —— 多尺寸（16/32/48/64/128/256），供 electron-builder 打包使用
 *
 * 旧版本 icon.png 只有 658 字节（分辨率极低），打包时也缺少 .ico。
 * 用法：npm run gen-icon
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- 绘制 ----------
function mix(a, b, t) {
  return a + (b - a) * t;
}

function roundedRectAlpha(x, y, size, radius) {
  // 圆角矩形内部为 1，外部为 0（含抗锯齿由外层超采样负责）
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  if (x >= radius && x <= size - radius) return y >= 0 && y <= size ? 1 : 0;
  if (y >= radius && y <= size - radius) return x >= 0 && x <= size ? 1 : 0;
  return dx * dx + dy * dy <= radius * radius ? 1 : 0;
}

/** 采样一次颜色：暗色圆角底 + 蓝色菱形（◈ 风格，中间镂空） */
function sampleColor(px, py, size) {
  const radius = size * 0.22;
  if (!roundedRectAlpha(px, py, size, radius)) return [0, 0, 0, 0];

  // 背景竖直渐变
  const t = py / size;
  let r = mix(27, 14, t);
  let g = mix(31, 18, t);
  let b = mix(39, 24, t);
  let a = 255;

  // 边框
  const edgeDist = Math.min(px, py, size - px, size - py);
  if (edgeDist < Math.max(1, size * 0.012)) {
    r = 48; g = 54; b = 68;
  }

  // 菱形：|dx| + |dy| <= R
  const cx = size / 2;
  const cy = size / 2;
  const d = Math.abs(px - cx) + Math.abs(py - cy);
  const outer = size * 0.34;
  const inner = size * 0.185;
  if (d <= outer) {
    const shade = 1 - d / outer;
    r = mix(61, 122, shade);
    g = mix(123, 176, shade);
    b = 255;
    a = 255;
    if (d <= inner) {
      // 镂空内芯
      r = mix(20, 12, d / inner);
      g = mix(24, 16, d / inner);
      b = mix(32, 22, d / inner);
    }
  }
  return [r, g, b, a];
}

/** 超采样渲染，得到抗锯齿的 RGBA 缓冲 */
function render(size, samples = 4) {
  const out = Buffer.alloc(size * size * 4);
  const step = 1 / samples;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const [pr, pg, pb, pa] = sampleColor(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size);
          const alpha = pa / 255;
          r += pr * alpha;
          g += pg * alpha;
          b += pb * alpha;
          a += pa;
        }
      }
      const total = samples * samples;
      const alphaAvg = a / total;
      const weight = alphaAvg > 0 ? (a / 255) : 1;
      const idx = (y * size + x) * 4;
      out[idx] = Math.max(0, Math.min(255, Math.round(r / weight)));
      out[idx + 1] = Math.max(0, Math.min(255, Math.round(g / weight)));
      out[idx + 2] = Math.max(0, Math.min(255, Math.round(b / weight)));
      out[idx + 3] = Math.max(0, Math.min(255, Math.round(alphaAvg)));
    }
  }
  return out;
}

// ---------- ICO 封装（PNG 负载，Vista+ 支持） ----------
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dirEntries = [];
  let offset = 6 + entries.length * 16;
  const blobs = [];
  for (const entry of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = entry.size >= 256 ? 0 : entry.size;
    dir[1] = entry.size >= 256 ? 0 : entry.size;
    dir[2] = 0; // palette
    dir[3] = 0; // reserved
    dir.writeUInt16LE(1, 4);  // planes
    dir.writeUInt16LE(32, 6); // bpp
    dir.writeUInt32LE(entry.png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirEntries.push(dir);
    blobs.push(entry.png);
    offset += entry.png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...blobs]);
}

function main() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });

  const mainPng = encodePng(256, 256, render(256, 4));
  fs.writeFileSync(path.join(ROOT, 'icon.png'), mainPng);
  console.log(`icon.png        ${mainPng.length} 字节 (256×256)`);

  const sizes = [16, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => ({ size, png: encodePng(size, size, render(size, size <= 32 ? 8 : 4)) }));
  const ico = encodeIco(entries);
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.ico'), ico);
  console.log(`build/icon.ico  ${ico.length} 字节 (${sizes.join('/')})`);

  const png256 = entries[entries.length - 1].png;
  fs.writeFileSync(path.join(BUILD_DIR, 'icon.png'), png256);
  console.log(`build/icon.png  ${png256.length} 字节 (256×256)`);
}

main();
