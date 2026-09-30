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
  // Windows 上第一动作是树杀 taskkill /T /F；测试里 exec 是失败桩，因此会退回 process.kill
  assert.ok(
    result.steps.some((s) => /^(taskkill|kill-fallback|sigterm):7777:/.test(s)),
    `应记录针对 7777 的终止动作：${JSON.stringify(result.steps)}`
  );
  assert.ok(
    result.steps.every((s) => !/:\d+:/.test(s) || s.includes(':7777:')),
    `不得对 7777 以外的 pid 动手：${JSON.stringify(result.steps)}`
  );
});

test('Windows 上先做树杀 taskkill /pid <pid> /T /F（旧实现永远轮不到 /T）', async () => {
  const execCalls = [];
  const { deps, killed } = makeDeps({
    platform: 'win32',
    isPortInUse: async () => true,
    findListenerPid: async () => ({ pid: 7777, name: 'node.exe', commandLine: 'node .../dsh/lib/bin.js web --no-open' }),
    waitForPortReleased: async () => true,
    exec: (spec) => { execCalls.push(spec); return { ok: true, stdout: '', stderr: '' }; }
  });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'stopped');
  assert.strictEqual(execCalls[0].file, 'taskkill', '第一动作必须是树杀');
  assert.deepStrictEqual(execCalls[0].args, ['/pid', '7777', '/T', '/F']);
  assert.ok(result.steps.includes('taskkill:7777:ok'));
  assert.deepStrictEqual(killed, [], 'taskkill 成功时不应再退回 process.kill');
});

test('POSIX 上先 SIGTERM（存在真正的温和阶段），且不调用 taskkill', async () => {
  const execCalls = [];
  const killed = [];
  const { deps } = makeDeps({
    platform: 'linux',
    isPortInUse: async () => true,
    findListenerPid: async () => ({ pid: 7777, name: 'node', commandLine: 'node /opt/dsh/lib/bin.js web' }),
    waitForPortReleased: async () => true,
    kill: (pid, signal) => { killed.push({ pid, signal: signal || 'SIGTERM' }); },
    exec: (spec) => { execCalls.push(spec); return { ok: true, stdout: '', stderr: '' }; }
  });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'stopped');
  assert.deepStrictEqual(killed, [{ pid: 7777, signal: 'SIGTERM' }]);
  assert.ok(result.steps.includes('sigterm:7777:ok'));
  assert.strictEqual(execCalls.length, 0, 'POSIX 路径不应出现 taskkill');
});

test('端口探测不确定时不得谎报"无人监听，无需停止"', async () => {
  const { deps } = makeDeps({
    isPortInUseDetailed: async () => ({ state: 'unknown' }),
    findListenerPid: async () => null
  });
  const result = await run({ port: 3080, ...deps });
  assert.notStrictEqual(result.action, 'none', '探测不确定时不能报告"无需停止"');
  assert.strictEqual(result.reason, 'listener-unknown', '应继续尝试识别监听者，识别不到就明确拒绝动手');
});

test('端口确实空闲时才报告"无需停止"', async () => {
  const { deps } = makeDeps({ isPortInUseDetailed: async () => ({ state: 'free' }) });
  const result = await run({ port: 3080, ...deps });
  assert.strictEqual(result.action, 'none');
  assert.strictEqual(result.reason, 'port-free');
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

test('parseArgs 拒绝缺值/空串/越界端口（旧实现会静默回落到 3080 并停掉真实服务）', () => {
  const badCases = [['--port'], ['--port', ''], ['--port', 'abc'], ['--port', '0'], ['--port', '-1'], ['--port', '65536'], ['--port', '3.5']];
  for (const bad of badCases) {
    assert.throws(() => parseArgs(bad), /--port/, `应拒绝: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parseArgs(['--host']), /--host/);
  assert.throws(() => parseArgs(['--host', '   ']), /--host/);

  assert.strictEqual(parseArgs(['--port', '1']).port, 1);
  assert.strictEqual(parseArgs(['--port', '65535']).port, 65535);
  assert.strictEqual(parseArgs(['--host', ' ::1 ']).host, '::1');
});

test('run() 对非法端口拒绝执行，绝不回落到默认端口', async () => {
  const { deps, killed } = makeDeps({ isPortInUse: async () => true });
  await assert.rejects(() => run({ port: NaN, ...deps }), /端口/);
  await assert.rejects(() => run({ port: 70000, ...deps }), /端口/);
  assert.strictEqual(killed.length, 0);
});

test('真实 dsh 垫片的命令行能通过身份校验（收紧默认模式后不得误漏真服务）', async () => {
  // 本机 C:\nvm4w\nodejs\dsh.cmd 实际执行的命令行（实测核对）
  const realShim =
    '"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --no-open';
  const { deps, killed } = makeDeps({
    isPortInUse: async () => true,
    findListenerPid: async () => ({ pid: 42060, name: 'node.exe', commandLine: realShim })
  });
  const result = await run({ port: 3080, dryRun: true, ...deps });
  assert.strictEqual(result.action, 'would-stop');
  assert.strictEqual(result.pid, 42060);
  assert.strictEqual(killed.length, 0);
});

test('路径里偶然含 dsh 的无关 node 服务不再被判成 DSH（旧默认 /dsh/i 会误杀）', async () => {
  const unrelated = [
    'node C:\\Users\\dsh\\app\\server.js',
    'node C:\\tools\\mydsh\\api.js',
    'node dsh-something\\server.js'
  ];
  for (const commandLine of unrelated) {
    const { deps, killed } = makeDeps({
      isPortInUse: async () => true,
      findListenerPid: async () => ({ pid: 4242, name: 'node.exe', commandLine })
    });
    const result = await run({ port: 3080, ...deps });
    assert.strictEqual(result.action, 'refused', commandLine);
    assert.strictEqual(killed.length, 0, `绝不能误杀: ${commandLine}`);
  }
});
