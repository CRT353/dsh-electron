'use strict';
/**
 * tests/token-adapter.test.js
 *
 * 验证"DSH 0.2 令牌适配"整条链路：外壳拉起服务 → 从 stdout 取到带令牌的 URL →
 * 用该 URL 探测得到 200+text/html（身份确认）→ 而裸地址只会得到 401。
 *
 * 背景：0.2 起本地 Web 服务要**进程级令牌**（随机生成、不落盘、不可外部指定），
 * 裸地址一律 401。旧健康检查遇到 401 判 `status < 500` 为假 ⇒ 永远"未就绪"。
 *
 * 全程使用随机空闲端口，绝不触碰生产端口 3080。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

const { ServiceManager, parseAuthenticatedUrl } = require('../lib/service');
const { probeDsh } = require('../lib/health');
const { freePort, silentLogger } = require('./helpers');

const DUMMY02 = path.join(__dirname, 'dummy-dsh-02.js');
const PROD_PORT = 3080;

/* ------------------------------------------------------------------ *
 * 单元：解析函数（不依赖子进程）
 * ------------------------------------------------------------------ */

test('口令解析：从 dsh web 输出行取出带令牌的 URL', () => {
  assert.strictEqual(
    parseAuthenticatedUrl('dsh web: http://127.0.0.1:3080/?token=AbC-123_xyz'),
    'http://127.0.0.1:3080/?token=AbC-123_xyz'
  );
});

test('口令解析：带 LAN 提示时只取第一个（本机）地址', () => {
  const line = 'dsh web: http://127.0.0.1:3080/?token=T1 (LAN: http://10.0.0.5:3080/?token=T1)';
  assert.strictEqual(parseAuthenticatedUrl(line), 'http://127.0.0.1:3080/?token=T1');
});

test('口令解析：原有其它查询串被丢掉，只保留 token（不把无关参数带进视图）', () => {
  assert.strictEqual(
    parseAuthenticatedUrl('dsh web: http://127.0.0.1:3080/?a=1&token=T2'),
    'http://127.0.0.1:3080/?token=T2'
  );
});

test('口令解析：半行（被截断）与无 token 的输出都返回 null，不得猜', () => {
  assert.strictEqual(parseAuthenticatedUrl('dsh web: http://127.0.0.1:3080/?tok'), null);
  assert.strictEqual(parseAuthenticatedUrl('dsh web: http://127.0.0.1:3080/'), null);
  assert.strictEqual(parseAuthenticatedUrl(''), null);
});

test('口令解析：多行输出中取最后一条（服务重启后以最新令牌为准）', () => {
  const text = 'dsh web: http://127.0.0.1:3080/?token=OLD\n[INFO] 轮转\ndsh web: http://127.0.0.1:3080/?token=NEW\n';
  assert.strictEqual(parseAuthenticatedUrl(text), 'http://127.0.0.1:3080/?token=NEW');
});

/* ------------------------------------------------------------------ *
 * 集成：真实子进程 + 真实端口 + 真实 401 门禁
 * ------------------------------------------------------------------ */

function baseConfig(port, extra = {}) {
  return {
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    startCommand: 'node tests/dummy-dsh-02.js',
    spawnPlan: {
      file: process.execPath,
      args: [DUMMY02],
      launcher: 'direct',
      resolved: true,
      display: 'node tests/dummy-dsh-02.js'
    },
    env: { ...process.env, PORT: String(port) },
    // stdout 必须是管道：令牌就在标准输出上
    stdio: ['ignore', 'pipe', 'pipe'],
    readyTimeoutMs: 15000,
    killTimeoutMs: 6000,
    readyPollMs: 60,
    ...extra
  };
}

test('集成：外壳从 stdout 取到令牌后，健康检查从 401 转为身份确认（200+text/html）', async (t) => {
  const port = await freePort();
  assert.notStrictEqual(port, PROD_PORT, '禁止使用生产端口');

  const config = baseConfig(port);
  const baseUrl = config.url;

  let sm;
  const children = [];
  sm = new ServiceManager({
    config,
    logger: silentLogger(),
    spawn: (file, args, opts) => {
      const child = realSpawn(file, args, opts);
      children.push(child);
      return child;
    },
    // 注入的探针用 currentUrl()，与 main.js 的装配方式一致
    probeHealth: () => probeDsh({
      url: sm.currentUrl(),
      timeoutMs: config.checkTimeoutMs || 3000,
      requireHtml: true
    }),
    // 进程查询在沙箱里不可用：给出明确的"不知道"，而不是假装空闲
    findListenerPid: async () => ({ ok: false, reason: 'test-stub' })
  });

  t.after(async () => {
    try { await sm.killManaged('test-cleanup'); } catch (_) { /* 忽略 */ }
    for (const c of children) { try { c.kill('SIGKILL'); } catch (_) { /* 忽略 */ } }
  });

  // 拉起：内部会 spawn → 读 stdout 取令牌 → 轮询 probeHealth 直到就绪
  const snap = await sm.ensure();
  assert.ok(snap, 'ensure() 应返回快照');

  // ① 令牌确实被取到了
  const authed = sm.currentUrl();
  assert.notStrictEqual(authed, baseUrl, '拿到令牌后 currentUrl() 不应再是裸地址');
  assert.match(authed, /\?token=/, 'currentUrl() 应带上 token');
  assert.match(authed, new RegExp(`:${port}/`), 'currentUrl() 应仍指向同一个端口');
  assert.ok(sm.state.authenticatedUrl, 'state.authenticatedUrl 应已写入');

  // ② 用带令牌的地址探测，应得到"身份确认"
  //    注意：令牌是**一次性**的 —— 服务先回 303 + Set-Cookie，probeDsh 内部完成
  //    "令牌 → 会话 Cookie → **去掉 query** 重试"的兑换，最终才拿到 200。
  const authedProbe = await probeDsh({ url: authed, timeoutMs: 5000, requireHtml: true });
  assert.strictEqual(authedProbe.status, 200, `带令牌兑换后应 200，实际 ${authedProbe.status}（reason=${authedProbe.reason}）`);
  assert.strictEqual(authedProbe.ok, true, '带令牌应通过身份确认（ok=true）');
  assert.strictEqual(authedProbe.identity, 'strong', '带令牌应判为 strong（200 + text/html）');
  assert.match(String(authedProbe.contentType), /text\/html/i, 'Content-Type 应为 text/html');

  // ③ 对照：服务已在运行时，裸地址仍是 401 —— 证明"修复来自令牌兑换，而不是服务恰好放开了"
  // 注意必须先启动服务再探测：服务没起来时拿到的是"连接被拒"，而非 401。
  const bareAfter = await probeDsh({ url: baseUrl, timeoutMs: 3000, requireHtml: true });
  assert.strictEqual(bareAfter.status, 401, `裸地址应 401，实际 ${bareAfter.status}（reason=${bareAfter.reason}）`);
  assert.strictEqual(bareAfter.reachable, true, '401 说明服务器回了话 → reachable 必须为 true');
  assert.strictEqual(bareAfter.ok, false, '裸地址不应通过身份确认');
});

test('集成：拒绝跨源重定向（fail-closed）—— 3xx 指向别处时绝不跟随', async () => {
  // 起一个"陌生"服务：收到请求就 303 到另一个 origin，并顺手塞一个 dsh-auth Cookie。
  // v1.3.1 审计的结论必须仍然成立：不得跟随跨源重定向，否则探测会被引向任意主机；
  // 也不能因为有 Set-Cookie 就放宽 —— 只有"同源 3xx + dsh-auth Cookie"才允许重试。
  const http = require('http');
  const evil = http.createServer((req, res) => {
    res.writeHead(303, {
      Location: 'http://127.0.0.1:1/',
      'Set-Cookie': 'dsh-auth-evil=x; Path=/'
    });
    res.end();
  });
  const port = await new Promise((resolve) => evil.listen(0, '127.0.0.1', () => resolve(evil.address().port)));
  try {
    const r = await probeDsh({ url: `http://127.0.0.1:${port}/`, timeoutMs: 3000, requireHtml: true });
    assert.strictEqual(r.ok, false, '跨源重定向不得被判为身份确认');
    assert.strictEqual(r.redirect, true, '应如实标记这是一个未跟随的重定向');
    assert.strictEqual(r.status, 303, '应报告原始 303，而不是跟随后的结果');
    assert.strictEqual(r.reachable, true, '服务器确实回了话 → reachable 为 true');
  } finally {
    evil.close();
  }
});
