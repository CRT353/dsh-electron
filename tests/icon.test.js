'use strict';
/**
 * 图标产物结构校验。
 *
 * 为什么单独守这一块：托盘 / 窗口 / 任务栏图标都来自 icon.png，打包用 build/icon.ico。
 * 它们一旦损坏，**不会有任何其它测试变红**（`createTray` 的失败被 catch 成一条日志，
 * 窗口图标坏了更是看不出来），属于典型的"静默回归"。这里只校验**已提交的产物**，
 * 不重新生成（gen-icon.js 是直写仓库路径的入口脚本，不适合在测试里运行）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 按 PNG 块结构遍历（块长 + 类型 + 数据 + CRC），返回块列表与解析结束偏移。 */
function walkPng(buf) {
  const chunks = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return { chunks, endOffset: off };
}

test('icon.png：PNG 结构完整、IDAT 可解压且像素数据长度与尺寸匹配', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'icon.png'));
  assert.ok(buf.subarray(0, 8).equals(PNG_SIG), 'PNG 签名必须正确');

  const { chunks, endOffset } = walkPng(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const idat = chunks.find((c) => c.type === 'IDAT');
  assert.ok(ihdr, '必须有 IHDR');
  assert.ok(idat, '必须有 IDAT');
  assert.strictEqual(chunks[chunks.length - 1].type, 'IEND', '必须以 IEND 结束');
  assert.strictEqual(endOffset, buf.length, 'IEND 之后不得有多余字节');

  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  assert.strictEqual(width, 256, '托盘/窗口图标应为 256px');
  assert.strictEqual(height, 256);
  assert.strictEqual(ihdr.data[8], 8, '位深 8');
  assert.strictEqual(ihdr.data[9], 6, '颜色类型 6 = RGBA');

  // 解压成功 + 长度精确匹配 = 图像数据没有损坏或截断
  const raw = zlib.inflateSync(idat.data);
  assert.strictEqual(raw.length, (width * 4 + 1) * height, '解压字节数必须等于 (宽*4+1)*高');
});

test('build/icon.ico：目录表与各条目载荷合法，覆盖 16–256 多档', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
  assert.strictEqual(buf.readUInt16LE(0), 0, 'reserved 必须为 0');
  assert.strictEqual(buf.readUInt16LE(2), 1, 'type 必须为 1（图标）');
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 4, `应包含多个尺寸，实际 ${count}`);

  const sizes = [];
  for (let i = 0; i < count; i += 1) {
    const off = 6 + i * 16;
    const width = buf[off] === 0 ? 256 : buf[off];
    const height = buf[off + 1] === 0 ? 256 : buf[off + 1];
    const bpp = buf.readUInt16LE(off + 6);
    const size = buf.readUInt32LE(off + 8);
    const offset = buf.readUInt32LE(off + 12);
    assert.strictEqual(width, height, `条目 ${i} 应为正方形`);
    assert.strictEqual(bpp, 32, `条目 ${i} 应为 32bpp`);
    assert.ok(offset + size <= buf.length, `条目 ${i} 的数据必须落在文件内`);
    assert.ok(buf.subarray(offset, offset + 8).equals(PNG_SIG), `条目 ${i} 应内嵌 PNG 载荷`);
    sizes.push(width);
  }
  assert.strictEqual(new Set(sizes).size, sizes.length, `尺寸不应重复：${sizes.join(',')}`);
  assert.ok(sizes.includes(16) && sizes.includes(256), `应覆盖 16 与 256：${sizes.join(',')}`);
});

test('根目录 icon.png 与 build/icon.png 一致（打包版与开发版不应显示不同图标）', () => {
  const rootIcon = fs.readFileSync(path.join(ROOT, 'icon.png'));
  const buildIcon = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'));
  assert.ok(rootIcon.equals(buildIcon), '两处图标应逐字节一致');
});
