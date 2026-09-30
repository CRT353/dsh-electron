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

test('probeDsh：不跟随重定向 —— 302 → HTML 登录页不得被认证成 DSH', async () => {
  const redirectToHtml = await startServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>请登录</h1>');
    } else {
      res.writeHead(302, { Location: '/login' });
      res.end();
    }
  });
  const redirectLoop = await startServer((req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  });
  try {
    // 旧实现会跟随重定向，用终点的 200 text/html 判成 identity=strong
    // —— 等于任何"3xx 到 HTML 页"的陌生服务都绕过了身份确认。
    const viaRedirect = await probeDsh({ url: redirectToHtml.url, timeoutMs: 2000, requireHtml: true });
    assert.strictEqual(viaRedirect.ok, false, '重定向终点是 HTML 也不能算身份确认');
    assert.notStrictEqual(viaRedirect.identity, 'strong');
    assert.strictEqual(viaRedirect.status, 302);
    assert.strictEqual(viaRedirect.reason, 'http-302-redirect');
    assert.strictEqual(viaRedirect.reachable, true, '服务器确实回了话 → reachable 必须为 true');

    // 重定向成环：旧实现 fetch 抛错 → reachable=false，服务生命周期会以为"端口没人"
    const loop = await probeDsh({ url: redirectLoop.url, timeoutMs: 2000, requireHtml: true });
    assert.strictEqual(loop.reachable, true, '收到 3xx 就说明服务器在，不能报"不可达"');
    assert.strictEqual(loop.ok, false, '但身份未经确认');
  } finally {
    await redirectToHtml.close();
    await redirectLoop.close();
  }
});

test('probeInternet：4xx/5xx/重定向（典型强制门户）不得算"网络在线"', async () => {
  const notFound = await startServer((req, res) => { res.writeHead(404); res.end('nope'); });
  const serverError = await startServer((req, res) => { res.writeHead(500); res.end('boom'); });
  const redirect = await startServer((req, res) => { res.writeHead(302, { Location: 'http://example.com/' }); res.end(); });
  try {
    assert.strictEqual((await probeInternet({ url: notFound.url, timeoutMs: 2000 })).ok, false, '404 不得算在线');
    assert.strictEqual((await probeInternet({ url: serverError.url, timeoutMs: 2000 })).ok, false, '500 不得算在线');
    assert.strictEqual((await probeInternet({ url: redirect.url, timeoutMs: 2000 })).ok, false, '重定向（典型门户）不得算在线');
    // 已知局限：门户返回 200 + HTML 登录页时，仅凭状态码无法与真实响应区分（未在此装作已解决）
  } finally {
    await notFound.close();
    await serverError.close();
    await redirect.close();
  }
});
