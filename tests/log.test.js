'use strict';
/** lib/log.js 单测：脱敏、限长、轮转、最近错误 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLogger, redact, safeUrl, clampMessage } = require('../lib/log');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-test-'));
}

test('redact 抹掉查询串凭据 / Bearer / URL userinfo / 超长 token', () => {
  assert.strictEqual(
    redact('GET http://127.0.0.1:3080/?token=abc123&x=1'),
    'GET http://127.0.0.1:3080/?token=<redacted>&x=1'
  );
  assert.strictEqual(redact('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer <redacted>');
  assert.strictEqual(redact('https://user:pass@example.com/x'), 'https://<redacted>@example.com/x');
  assert.strictEqual(redact('password=hunter2'), 'password=hunter2', '不带 ? 或 & 前缀的键值不动（避免误伤）');
  assert.strictEqual(redact('api_key=zzz&next=1'), 'api_key=zzz&next=1');
  assert.strictEqual(redact('&api_key=zzz'), '&api_key=<redacted>');
  const long = 'a'.repeat(64);
  assert.strictEqual(redact(`token ${long}`), 'token <redacted>');
  assert.strictEqual(redact('short abc123'), 'short abc123');
  assert.strictEqual(redact(`token ${long}`, { tokens: false }), `token ${long}`);
});

test('safeUrl 去掉凭据、查询串与 hash', () => {
  assert.strictEqual(safeUrl('http://user:pw@127.0.0.1:3080/a?token=x#frag'), 'http://127.0.0.1:3080/a');
  assert.strictEqual(safeUrl('not-a-url'), 'not-a-url');
});

test('clampMessage 超长时头尾保留并标注', () => {
  const text = 'x'.repeat(100);
  assert.strictEqual(clampMessage(text, 200), text);
  const clamped = clampMessage(text, 40);
  assert.ok(clamped.length < text.length + 80);
  assert.match(clamped, /已截断 60 字符/);
});

test('logger 写文件 + 自动轮转 + 环形缓冲 + 最近错误', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'test.log');
  const logger = createLogger({ file, maxBytes: 300, maxMessage: 4096, ringSize: 5 });

  for (let i = 0; i < 30; i += 1) logger.info(`普通日志 ${i} ${'y'.repeat(20)}`);
  logger.error('第一类错误', new Error('boom'));

  assert.ok(fs.existsSync(file), '日志文件应存在');
  assert.ok(fs.existsSync(`${file}.1`), '超过上限应轮转为 .1');
  assert.strictEqual(logger._ring.length, 5, '环形缓冲有条数上限');
  assert.ok(logger.recentErrors(1).length >= 1);
  assert.match(logger.lastError(), /第一类错误/);

  const backup = fs.readFileSync(`${file}.1`, 'utf8');
  assert.ok(!/token=\w/.test(backup));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logger.error 保留完整堆栈与 cause 链（旧版本截断根因的回归测试）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'stack.log');
  const logger = createLogger({ file, maxMessage: 8192 });

  const root = new Error('plugin tree failed to load: failed to apply loader entry include (cordis:include)');
  const wrapper = new Error('dsh: plugin tree failed to load', { cause: root });
  logger.error('服务启动失败', wrapper);

  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /服务启动失败/);
  assert.match(content, /plugin tree failed to load/);
  assert.match(content, /caused by/);
  assert.match(content, /cordis:include/, '根因（cause 链最深处）必须保留');
  assert.match(content, /at /, '应包含堆栈帧');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logger.stream 单块限长，但错误块仍可定位', () => {
  const logger = createLogger({ file: null, streamLimit: 50 });
  logger.stream('dsh-svc-err', 'A'.repeat(500));
  const tail = logger.tail(1)[0];
  assert.match(tail, /\[\+450\]/);
  logger.stream('dsh-svc-err', 'Error: boot failed');
  assert.match(logger.lastError(), /boot failed/);
});
