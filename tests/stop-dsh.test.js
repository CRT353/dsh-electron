'use strict';
/** tools/stop-dsh.js 单测：只做"判定"，不真的终止任何进程 */
const test = require('node:test');
const assert = require('node:assert');

const { run, parseArgs } = require('../tools/stop-dsh');
const { isPortInUse: realIsPortInUse } = require('../lib/procs');
const { silentLogger, startServer } = require('./helpers');

function makeDeps(overrides = {}) {
  const killed = [];
  return {
    killed,
    deps: {
      logger: silentLogger(),
      findListenerPid: async () => null,
      isPidAlive: () => true,
      isPortInUse: async () => false,
      waitForPortReleased: async () => true,
      kill: (pid, signal) => { killed.push({ pid, signal: signal || 'SIGTERM' }); },
      exec: () => ({ ok: false, stdout: '', stderr: 'stub' }),
      platform: 'win32',
      allowUnverified: false,
      ...overrides
    }
  };
}

test('parseArgs 默认端口与 dry-run', () => {
  assert.deepStrictEqual(parseArgs([]), { port: 3080, dryRun: false, host: '127.0.0.1' });
  assert.strictEqual(parseArgs(['--port', '39999']).port, 39999);
  assert.strictEqual(parseArgs(['--dry-run']).dryRun, true);
});

test('端口空闲时不做任何事', async () => {
  const { deps, killed } = makeDeps({ isPortInUse: async () => false });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'none');
  assert.strictEqual(killed.length, 0);
});

test('端口被占用但无法识别监听者 → 拒绝动手（不猜、不误杀）', async () => {
  const { deps, killed } = makeDeps({ isPortInUse: async () => true, findListenerPid: async () => null });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'refused');
  assert.strictEqual(result.reason, 'listener-unknown');
  assert.strictEqual(killed.length, 0);
});

test('监听者不是 dsh（例如别的 node 服务）→ 拒绝动手', async () => {
  const { deps, killed } = makeDeps({
    isPortInUse: async () => true,
    findListenerPid: async () => ({ pid: 4321, name: 'node.exe', commandLine: 'node my-other-server.js' })
  });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'refused');
  assert.strictEqual(result.reason, 'commandline-mismatch');
  assert.strictEqual(killed.length, 0, '绝不能误杀其它 node 进程');
});

test('监听者确实是 dsh：dry-run 只报告不终止', async () => {
  const { deps, killed } = makeDeps({
    isPortInUse: async () => true,
    findListenerPid: async () => ({ pid: 7777, name: 'node.exe', commandLine: 'node .../dsh/lib/bin.js web --no-open' })
  });
  const result = await run({ port: 3080, dryRun: true, ...deps });
  assert.strictEqual(result.action, 'would-stop');
  assert.strictEqual(result.pid, 7777);
  assert.strictEqual(killed.length, 0);
});

test('监听者确实是 dsh：实际停止（注入 kill，不碰真实进程）', async () => {
  let released = false;
  const { deps, killed } = makeDeps({
    isPortInUse: async () => !released,
    findListenerPid: async () => ({ pid: 7777, name: 'node.exe', commandLine: 'node .../dsh/lib/bin.js web --no-open' }),
    waitForPortReleased: async () => { released = true; return true; },
    kill: (pid) => { released = true; killed.push({ pid }); }
  });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'stopped');
  assert.deepStrictEqual(killed, [{ pid: 7777 }]);
  assert.ok(result.steps.some((s) => s.startsWith('sigterm:7777')));
});

test('真实端口探测：占用中的端口会被识别（避免"端口空闲"误判）', async () => {
  const server = await startServer();
  try {
    // 用真实的端口探测 + 模拟"受限环境下查不到监听者"
    const { deps } = makeDeps({ findListenerPid: async () => null, isPortInUse: realIsPortInUse });
    const result = await run({ port: server.port, ...deps });
    assert.strictEqual(result.action, 'refused', '端口确实被占用时不能当成"无需停止"');
    assert.strictEqual(result.reason, 'listener-unknown');
  } finally {
    await server.close();
  }
});
