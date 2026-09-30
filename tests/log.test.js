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
  // 这两条原本把"脱敏缺口"固化成了期望行为（注释写的是"避免误伤"）。但 main.js 会把
  // DSH_START_COMMAND 逐字写进日志，凭据以 --token=xxx / token: xxx / "token":"xxx"
  // 的形态原样落盘并被轮转长期保存，所以改为按**键名白名单**脱敏（误伤面很小）。
  assert.strictEqual(redact('password=hunter2'), 'password=<redacted>');
  assert.strictEqual(redact('api_key=zzz&next=1'), 'api_key=<redacted>&next=1');
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

test('日志落盘失败不再完全静默：首次失败进入环形缓冲（打包版 asar 场景的回归测试）', () => {
  const dir = tmpDir();
  // 构造"父路径其实是一个文件"——与 asar 归档内写入失败的机制完全一致（实测 ENOENT）
  const fakeAsar = path.join(dir, 'app.asar');
  fs.writeFileSync(fakeAsar, 'not a real archive');
  const unwritable = path.join(fakeAsar, 'load-status.log');
  const logger = createLogger({ file: unwritable });

  logger.info('这条只进内存环');
  assert.strictEqual(fs.existsSync(unwritable), false, '该路径确实写不进去');
  assert.ok(logger.recentErrors(5).length >= 1, '首次落盘失败必须被记录，而不是静默吞掉');
  assert.match(logger.lastError(), /日志写入失败/);
  assert.match(logger.lastError(), /ENOENT|ENOTDIR/i);

  // 只报一次，避免刷屏
  logger.info('第二条');
  const failures = logger.recentErrors(20).filter((t) => /日志写入失败/.test(t));
  assert.strictEqual(failures.length, 1, '同样的落盘失败只提示一次');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('logger.stream 先判级再截断：错误落在长块末尾时不得丢根因、不得降级成 INFO', () => {
  const logger = createLogger({ file: null }); // 默认单块上限已对齐 maxMessage(8192)
  logger.stream('dsh-svc-err', `${'A'.repeat(2900)}\nError: plugin tree failed to load\n`);
  const line = logger.tail(1)[0];
  assert.match(line, /\[ERROR\]/, '长块里的错误必须判为 ERROR');
  assert.match(line, /plugin tree failed to load/, '根因必须保留（旧实现先截到 2000 字符再判级，两样都丢）');
  // 注意 lastError() 只返回该条日志的**首行**（长块首行是大段 A），所以要看完整文本
  assert.match(logger.recentErrors(1)[0], /plugin tree failed to load/, '作为 ERROR 进入环形缓冲，侧边栏"最近错误"能看到');

  // 显式给很小的上限时：判级仍按完整内容，截断只影响正文长度
  const tight = createLogger({ file: null, streamLimit: 20 });
  tight.stream('dsh-svc-err', `${'A'.repeat(100)}Error: boom`);
  assert.match(tight.tail(1)[0], /\[ERROR\]/);
});

test('ringSize 非法（负值/0/NaN）不得死循环，回退到默认条数', () => {
  // 旧实现 `options.ringSize || DEFAULT_RING` 挡不住负值，而
  // `while (ring.length > ringSize) ring.shift()` 在空数组上长度恒为 0、永远大于负数
  // ⇒ 第一次写日志就无限循环，把整个主进程卡死。
  const logger = createLogger({ file: null, ringSize: -3 });
  for (let i = 0; i < 205; i += 1) logger.info(`第 ${i} 条`);
  assert.strictEqual(logger._ring.length, 200, '负值应回退到默认 200 条');

  const zero = createLogger({ file: null, ringSize: 0 });
  zero.info('x');
  assert.ok(zero._ring.length <= 200);
});

test('脱敏覆盖命令行/JSON/冒号/Basic/fragment 形态的凭据', () => {
  // 这些形态原本一律漏网，而 DSH_START_COMMAND 会被逐字写进日志
  assert.match(redact('dsh web --no-open --token sk-abcdef123456'), /--token <redacted>/);
  assert.match(redact('{"token":"abc123","x":1}'), /"token":"<redacted>"/);
  assert.match(redact('token: abc123'), /token: <redacted>/);
  assert.match(redact('http://h/#token=abc123'), /#token=<redacted>/);
  assert.match(redact('Authorization: Basic dXNlcjpwYXNzd29yZA=='), /Basic <redacted>/);
  assert.match(redact('apiKey=xyz789'), /apiKey=<redacted>/);
  // 不该误伤的：普通文本与不含分隔符的用法
  assert.strictEqual(redact('token'), 'token');
  assert.strictEqual(redact('the password field is required'), 'the password field is required');
  assert.strictEqual(redact('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer <redacted>');
});

test('cause 链超过 10 层时显式标注截断，而不是静默丢根因', () => {
  // 构造 level-1（最内层根因）→ level-14（最外层）
  let err = new Error('level-1');
  for (let i = 2; i <= 14; i += 1) err = new Error(`level-${i}`, { cause: err });
  const logger = createLogger({ file: null });
  logger.error('顶层失败', err);
  const text = logger._ring[logger._ring.length - 1].text;
  assert.match(text, /level-13/, '要继续展开多层 cause（旧实现第 6 层就静默截断）');
  assert.match(text, /已截断/, '超过上限必须显式标注，而不是静默丢根因');
});
