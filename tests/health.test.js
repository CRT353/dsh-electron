'use strict';
/** lib/health.js 单测：真实本地 HTTP 服务 + 消抖 + 翻转检测 */
const test = require('node:test');
const assert = require('node:assert');

const { probeDsh, probeInternet, FlapGuard, detectTransitions } = require('../lib/health');
const { startServer } = require('./helpers');

test('probeDsh：text/html 且状态 <500 才算身份确认', async () => {
  const html = await startServer();
  const plain = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not dsh');
  });
  const broken = await startServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/html' });
    res.end('<h1>down</h1>');
  });
  try {
    const ok = await probeDsh({ url: html.url, timeoutMs: 2000, requireHtml: true });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.reachable, true);
    assert.strictEqual(ok.identity, 'strong');

    const weak = await probeDsh({ url: plain.url, timeoutMs: 2000, requireHtml: true });
    assert.strictEqual(weak.ok, false, '非 html 不应判定为"身份确认"');
    assert.strictEqual(weak.reachable, true, '但仍应报告端口有人响应');
    assert.strictEqual(weak.identity, 'weak');
    assert.strictEqual(weak.reason, 'content-type-not-html');

    const relaxed = await probeDsh({ url: plain.url, timeoutMs: 2000, requireHtml: false });
    assert.strictEqual(relaxed.ok, true, '关闭严格模式后应放行');

    const down = await probeDsh({ url: broken.url, timeoutMs: 2000, requireHtml: true });
    assert.strictEqual(down.ok, false);
    assert.strictEqual(down.reachable, true);
    assert.strictEqual(down.reason, 'http-503');
  } finally {
    await html.close();
    await plain.close();
    await broken.close();
  }
});

test('probeDsh：不可达与超时的区分', async () => {
  const unreachable = await probeDsh({ url: 'http://127.0.0.1:1', timeoutMs: 800, requireHtml: true });
  assert.strictEqual(unreachable.ok, false);
  assert.strictEqual(unreachable.reachable, false);
  assert.strictEqual(unreachable.identity, 'none');
  assert.match(unreachable.reason, /unreachable|timeout/);

  const noUrl = await probeDsh({});
  assert.strictEqual(noUrl.reason, 'no-url');
});

test('probeInternet：可关闭、可自定义目标', async () => {
  const server = await startServer();
  try {
    const online = await probeInternet({ url: server.url, timeoutMs: 2000 });
    assert.strictEqual(online.ok, true);
    const skipped = await probeInternet({ enabled: false });
    assert.strictEqual(skipped.skipped, true);
    assert.strictEqual(skipped.ok, true);
    const offline = await probeInternet({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.strictEqual(offline.ok, false);
  } finally {
    await server.close();
  }
});

test('FlapGuard 消抖：连续失败才翻红，一次成功即恢复', () => {
  const guard = new FlapGuard({ failThreshold: 2, recoverThreshold: 1 });
  assert.strictEqual(guard.update(true), true, '首个样本直接作为初始状态');
  assert.strictEqual(guard.update(false), true, '单次失败不应翻红');
  assert.strictEqual(guard.update(false), false, '连续两次失败才翻红');
  assert.strictEqual(guard.update(true), true, '一次成功即恢复');
  assert.strictEqual(guard.update(false), true, '恢复后再单次失败仍保持');
});

test('detectTransitions 只在翻转时产生事件', () => {
  assert.deepStrictEqual(detectTransitions({ dsh: true, net: true }, { dsh: true, net: true }), []);
  assert.deepStrictEqual(detectTransitions({ dsh: true, net: true }, { dsh: false, net: true }), [{ kind: 'dsh', from: true, to: false }]);
  assert.strictEqual(detectTransitions({ dsh: null, net: null }, { dsh: true, net: true }).length, 0, '初始状态不通知');
});
