'use strict';
/**
 * lib/service.js 集成测试：用真实子进程（tests/dummy-server.js）+ 真实端口探测，
 * 验证"拉起 → 认领监听者 → 清理 → 端口释放"整条链路，
 * 以及并发去重、重启前等端口、拒绝终止陌生进程等修复点。
 *
 * 注意：全程使用随机空闲端口，绝不触碰生产端口 3080。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn: realSpawn } = require('child_process');

const { ServiceManager } = require('../lib/service');
const { probeDsh } = require('../lib/health');
const { isPidAlive, isPortInUse, waitForPortReleased } = require('../lib/procs');
const { freePort, silentLogger, startServer, sleep } = require('./helpers');

const DUMMY = path.join(__dirname, 'dummy-server.js');
const PROD_PORT = 3080;

function baseConfig(port, extra = {}) {
  return {
    url: `http://127.0.0.1:${port}`,
    host: '127.0.0.1',
    port,
    startCommand: 'node tests/dummy-server.js',
    spawnPlan: {
      file: process.execPath,
      args: [DUMMY],
      launcher: 'direct',
      resolved: true,
      display: 'node tests/dummy-server.js'
    },
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'ignore'],
    readyTimeoutMs: 15000,
    killTimeoutMs: 6000,
    readyPollMs: 60,
    ...extra
  };
}

function makeManager(options = {}) {
  const port = options.port;
  assert.notStrictEqual(port, PROD_PORT, '测试绝不能使用生产端口 3080');
  const children = [];
  const execCalls = [];
  const logger = options.logger || silentLogger();

  const deps = {
    logger,
    spawn: options.spawn || ((file, args, opts) => {
      const child = realSpawn(file, args, opts);
      children.push(child);
      return child;
    }),
    exec: options.exec || ((spec) => {
      execCalls.push(spec);
      return { ok: false, stdout: '', stderr: 'test-stub (沙箱内不允许子进程管道)' };
    }),
    probeHealth: options.probeHealth || (() => probeDsh({ url: `http://127.0.0.1:${port}`, timeoutMs: 1000, requireHtml: false })),
    findListenerPid: options.findListenerPid || (async () => {
      const last = children[children.length - 1];
      if (!last) return null;
      // 模拟真实 netstat + 命令行读取：命令行用**真实 dsh 入口形态**
      // （本机 dsh.cmd 实际执行的就是 @deepseek-ai/dsh/lib/bin.js），因此可被身份校验放行。
      return { pid: last.pid, name: 'node.exe', commandLine: `node D:\\nvm\\v24.18.0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --no-open --test-pid=${last.pid}` };
    }),
    isPidAlive: options.isPidAlive || isPidAlive,
    isPortInUse: options.isPortInUse || isPortInUse,
    waitForPortReleased: options.waitForPortReleased || waitForPortReleased
  };
  if (options.sleep) deps.sleep = options.sleep;
  if (options.setTimer) deps.setTimer = options.setTimer;
  // 注入 kill 是必要的安全措施：用合成 pid 的用例绝不能落到真实的 process.kill 上
  if (options.kill) deps.kill = options.kill;

  const manager = new ServiceManager({
    config: { ...baseConfig(port), ...(options.config || {}) },
    ...deps
  });
  return { manager, children, execCalls, logger, port };
}

test('托管生命周期：拉起 → 认领真实监听 pid → 清理 → 端口释放', async () => {
  const port = await freePort();
  const { manager, children, logger } = makeManager({ port });

  const snapshot = await manager.ensure();
  assert.strictEqual(snapshot.mode, 'managed', `应为 managed，实际 ${snapshot.mode}；日志：${logger.lines.join(' | ')}`);
  assert.strictEqual(snapshot.owned, true);
  assert.strictEqual(snapshot.spawnCount, 1);
  assert.strictEqual(children.length, 1);
  assert.strictEqual(snapshot.listenerPid, children[0].pid, '权威身份应是监听端口的真实 pid');
  assert.strictEqual(snapshot.listenerVerified, true);
  assert.strictEqual(await isPortInUse(port, '127.0.0.1'), true);

  const killResult = await manager.killManaged('test');
  assert.strictEqual(killResult.ok, true, `清理应成功：${JSON.stringify(killResult)}`);
  assert.strictEqual(killResult.released, true);
  assert.strictEqual(await isPortInUse(port, '127.0.0.1', 500), false, '清理后端口必须释放');
  await sleep(200);
  assert.strictEqual(isPidAlive(children[0].pid), false, '清理后服务进程必须退出');
  assert.strictEqual(manager.snapshot().mode, 'stopped');
  // 主动清理不应被记成"服务异常退出"（Windows 上 process.kill 会把退出码报成 1）
  assert.ok(
    !logger.lines.some((l) => /异常退出/.test(l)),
    `主动清理不得产生故障日志：${logger.lines.filter((l) => /异常退出/.test(l)).join(' | ')}`
  );
  assert.strictEqual(manager.snapshot().lastError, null, '主动清理后不应留下"当前问题"');
});

test('并发 ensure() 只拉起一个实例（旧版本会重复拉起抢端口）', async () => {
  const port = await freePort();
  const { manager, children } = makeManager({ port });
  const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.strictEqual(children.length, 1, '并发调用只能产生一个子进程');
  assert.strictEqual(a.mode, 'managed');
  assert.strictEqual(b.spawnCount, 1);
  await manager.killManaged('test');
});

test('restart() 先等端口释放再拉起，且只产生一个新实例', async () => {
  const port = await freePort();
  const { manager, children, logger } = makeManager({ port });
  await manager.ensure();
  const firstPid = children[0].pid;

  const result = await manager.restart({});
  assert.strictEqual(result.ok, true, `重启应成功：${JSON.stringify(result)}`);
  assert.strictEqual(children.length, 2, '应只重启一次（不再盲拉第二个实例）');
  assert.notStrictEqual(children[1].pid, firstPid);
  assert.strictEqual(manager.snapshot().mode, 'managed');
  assert.strictEqual(manager.snapshot().listenerPid, children[1].pid);
  assert.strictEqual(await isPortInUse(port, '127.0.0.1'), true);
  assert.ok(logger.lines.some((l) => /开始清理服务/.test(l)));
  await manager.killManaged('test');
});

test('端口不释放时放弃拉起（避免双实例抢端口导致 boot 失败）', async () => {
  const port = await freePort();
  const blocker = await startServer();
  // 用一个真实占用端口的服务器模拟"端口没让出来"
  const blockerManager = makeManager({
    port,
    config: { url: `http://127.0.0.1:${blocker.port}` },
    isPortInUse: async () => true,
    waitForPortReleased: async () => false,
    kill: () => {} // 合成 pid 4242：不得落到真实 process.kill
  });
  blockerManager.manager.state.owned = true;
  blockerManager.manager.state.mode = 'managed';
  blockerManager.manager.state.listenerPid = 4242;

  const result = await blockerManager.manager.restart({});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'port-busy');
  assert.strictEqual(blockerManager.children.length, 0, '端口占用时不得再拉起新实例');
  await blocker.close();
});

test('清理拒绝终止陌生进程（默认拒绝，且不再"杀掉任何监听端口的进程"）', async () => {
  const port = await freePort();
  const holder = await startServer(); // 真实占用一个端口，扮演陌生进程
  const { manager, execCalls } = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.port}` },
    exec: (spec) => { execCalls.push(spec); return { ok: false, stdout: '', stderr: 'stub' }; },
    isPidAlive: (pid) => pid === 4242,          // 我们记录的 pid "还活着"
    isPortInUse: async () => true,              // 端口始终有人占用
    waitForPortReleased: async () => false,     // 永远不会释放
    kill: () => {},                             // 合成 pid 4242：不得落到真实 process.kill
    findListenerPid: async () => ({ pid: 9999, name: 'postgres.exe', commandLine: 'postgres -D C:\\data' })
  });

  manager.state.owned = true;
  manager.state.mode = 'managed';
  manager.state.listenerPid = 4242;
  manager.state.wrapperPid = 4242;
  manager.state.trustedPids.add(4242);

  const result = await manager.killManaged('test');
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /^refused:/, `应拒绝终止陌生进程：${JSON.stringify(result)}`);
  assert.match(result.reason, /untrusted-name/);
  assert.ok(
    !execCalls.some((c) => (c.args || []).includes('9999')),
    '绝不能对未通过身份校验的 pid 执行 taskkill'
  );
  await holder.close();
});

test('清理兜底：命令行匹配 dsh 时才允许强杀（并记录判定依据）', async () => {
  const port = await freePort();
  const holder = await startServer();
  const { manager, execCalls } = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.port}` },
    exec: (spec) => { execCalls.push(spec); return { ok: false, stdout: '', stderr: 'stub' }; },
    isPidAlive: (pid) => pid === 4242,
    isPortInUse: async () => true,
    waitForPortReleased: async () => false,
    kill: () => {},                             // 合成 pid 4242：不得落到真实 process.kill
    findListenerPid: async () => ({
      pid: 9999,
      name: 'node.exe',
      commandLine: 'node D:\\nvm\\v24.18.0\\node_modules\\@deepseek-ai\\dsh\\bin.js web --no-open'
    })
  });
  manager.state.owned = true;
  manager.state.mode = 'orphan';
  manager.state.listenerPid = 4242;

  const result = await manager.killManaged('test');
  assert.ok(result.steps.some((s) => s.includes('fallback-verdict:commandline-match')), JSON.stringify(result));
  const forced = execCalls.filter((c) => (c.args || []).includes('9999'));
  assert.ok(forced.length > 0, '身份校验通过后应执行 taskkill /T /F');
  assert.ok(forced.every((c) => c.file === 'taskkill' || c.file === 'kill'));
  await holder.close();
});

test('归属漂移：我们的 pid 死了但端口仍被服务 → orphan / takeover 如实上报', async () => {
  const port = await freePort();
  const holder = await startServer({}, {});
  const orphanCase = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.url}` },
    probeHealth: () => probeDsh({ url: holder.url, timeoutMs: 1000, requireHtml: true }),
    isPidAlive: () => false,
    findListenerPid: async () => ({ pid: 7777, name: 'node.exe', commandLine: 'node .../dsh web --no-open' })
  });
  orphanCase.manager.state.owned = true;
  orphanCase.manager.state.mode = 'managed';
  orphanCase.manager.state.listenerPid = 6666;

  const orphanSnapshot = await orphanCase.manager.refresh({ healthy: true, reachable: true });
  assert.strictEqual(orphanSnapshot.mode, 'orphan');
  assert.match(orphanSnapshot.lastError, /孤儿进程/);
  assert.strictEqual(orphanSnapshot.managed, false, '归属漂移时不得再谎报 managed');

  const takeoverCase = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.url}` },
    probeHealth: () => probeDsh({ url: holder.url, timeoutMs: 1000, requireHtml: true }),
    isPidAlive: () => false,
    findListenerPid: async () => ({ pid: 8888, name: 'nginx.exe', commandLine: 'nginx' })
  });
  takeoverCase.manager.state.owned = true;
  takeoverCase.manager.state.mode = 'managed';
  takeoverCase.manager.state.listenerPid = 6666;

  const takeoverSnapshot = await takeoverCase.manager.refresh({ healthy: true, reachable: true });
  assert.strictEqual(takeoverSnapshot.mode, 'takeover');
  assert.strictEqual(await takeoverCase.manager.killManaged('test').then((r) => r.ok), false, 'takeover 状态不得清理');
  await holder.close();
});

test('复用外部服务：不认领、不清理，并暴露"接管"入口', async () => {
  const port = await freePort();
  const external = await startServer();
  const { manager } = makeManager({
    port,
    config: { url: external.url },
    probeHealth: () => probeDsh({ url: external.url, timeoutMs: 1000, requireHtml: true }),
    findListenerPid: async () => ({ pid: process.pid, name: 'node.exe', commandLine: 'node .../dsh web --no-open' }),
    spawn: () => { throw new Error('复用模式下不应拉起任何进程'); }
  });

  const snapshot = await manager.ensure();
  assert.strictEqual(snapshot.mode, 'reuse');
  assert.strictEqual(snapshot.managed, false);
  assert.strictEqual(snapshot.forceRestartable, true, '看起来是 dsh 时应提供"接管并重启"入口');

  const killResult = await manager.killManaged('test');
  assert.strictEqual(killResult.ok, false);
  assert.strictEqual(killResult.reason, 'not-managed');
  assert.strictEqual(isPidAlive(process.pid), true, '绝不能杀掉外部服务（这里用测试进程自身作证）');

  const restart = await manager.restart({});
  assert.strictEqual(restart.ok, false);
  assert.strictEqual(restart.reason, 'external');
  await external.close();
});

test('清理遵守时间预算：预算不足时显式跳过兜底并如实报告（旧实现会被外层超时截断）', async () => {
  const port = await freePort();
  const holder = await startServer();
  const { manager, execCalls } = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.port}` },
    exec: (spec) => { execCalls.push(spec); return { ok: false, stdout: '', stderr: 'stub' }; },
    kill: () => {},
    isPidAlive: (pid) => pid === 4242,
    isPortInUse: async () => true,
    waitForPortReleased: async () => false, // 端口永不释放
    findListenerPid: async () => ({
      pid: 9999,
      name: 'node.exe',
      commandLine: 'node D:\\x\\node_modules\\@deepseek-ai\\dsh\\bin.js web'
    })
  });
  manager.state.owned = true;
  manager.state.mode = 'managed';
  manager.state.listenerPid = 4242;

  // 预算 1ms：两步等待耗尽后，兜底必须被显式跳过（而不是被外层超时强行截断）
  const result = await manager.killManaged('test', { budgetMs: 1 });
  assert.strictEqual(result.reason, 'budget-exhausted', JSON.stringify(result));
  assert.ok(result.steps.some((s) => s.startsWith('fallback:skipped-budget')), JSON.stringify(result));
  assert.ok(!execCalls.some((c) => (c.args || []).includes('9999')), '预算不足时不得去动兜底目标');
  assert.strictEqual(manager.snapshot().lastKill.released, false, '失败也要留下 lastKill 记录供诊断');
  await holder.close();
});

test('shutdown() 返回真实清理结果，不会被外层超时吞掉', async () => {
  const port = await freePort();
  const { manager } = makeManager({ port });
  await manager.ensure();

  const result = await manager.shutdown({ timeoutMs: 6000 });
  assert.strictEqual(result.ok, true, `正常清理应返回真实结果而不是 shutdown-timeout：${JSON.stringify(result)}`);
  assert.strictEqual(result.released, true);
  assert.strictEqual(manager.snapshot().mode, 'stopped');
  assert.strictEqual(await isPortInUse(port, '127.0.0.1', 500), false);
});

test('拉起了但没就绪：也必须承认归属并能清理（旧实现留下不可清理的遗留进程）', async () => {
  const port = await freePort();
  const { manager, children } = makeManager({
    port,
    probeHealth: async () => ({ ok: false, reachable: false }), // 永远"不就绪"
    config: { readyTimeoutMs: 300, readyPollMs: 50 }
  });

  const snap = await manager.ensure();
  assert.strictEqual(snap.mode, 'stopped');
  assert.strictEqual(snap.readyFailure, 'timeout');
  assert.strictEqual(snap.owned, true, '本程序 spawn 过就必须承认归属，否则退出时不会清理它');
  assert.strictEqual(snap.wrapperPid, children[0].pid);
  assert.strictEqual(snap.listenerPid, null, '未认领的监听者不能算作我们的 pid');
  assert.ok(manager.state.trustedPids.has(children[0].pid), '包装进程应进入可信集合，供收尾使用');

  // 旧实现在这里会返回 not-managed（owned=false），于是这个进程永远留在系统里
  const kill = await manager.killManaged('test');
  assert.strictEqual(kill.ok, true, `应能清理自己拉起的进程：${JSON.stringify(kill)}`);
  await sleep(200);
  assert.strictEqual(isPidAlive(children[0].pid), false, '自己拉起的进程必须被收掉');
  assert.strictEqual(await isPortInUse(port, '127.0.0.1', 500), false);
});

test('降级态（从未解析出监听者）不得被误报成 orphan，也不得出现 "pid null"', async () => {
  const port = await freePort();
  const holder = await startServer();
  const { manager } = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.port}` },
    probeHealth: () => probeDsh({ url: holder.url, timeoutMs: 1000, requireHtml: true }),
    findListenerPid: async () => null // netstat/ps 受限：始终解析不到监听者
  });
  manager.state.owned = true;
  manager.state.mode = 'managed';
  manager.state.listenerPid = null;
  manager.state.listenerUnresolved = true; // 启动时就走了降级路径
  manager.state.wrapperPid = 1234;

  const snap = await manager.refresh({ healthy: true, reachable: true });
  assert.strictEqual(snap.mode, 'managed', '服务正常且属本程序管理时不得降级成 orphan');
  assert.strictEqual(snap.lastError, null);
  assert.strictEqual(snap.restartable, true, '"重启服务"按钮不应被误灰');

  // 对照组：不是降级态（真丢过监听者）仍应如实报 orphan，但不得再打印字面量 pid null
  const other = makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.port}` },
    probeHealth: () => probeDsh({ url: holder.url, timeoutMs: 1000, requireHtml: true }),
    findListenerPid: async () => null
  });
  other.manager.state.owned = true;
  other.manager.state.mode = 'managed';
  other.manager.state.listenerPid = 6666;
  const orphan = await other.manager.refresh({ healthy: true, reachable: true });
  assert.strictEqual(orphan.mode, 'orphan');
  assert.ok(!/pid null/.test(orphan.lastError || ''), `不得出现字面量 pid null：${orphan.lastError}`);
  await holder.close();
});

test('认领失败（命令行读不到）时，spawn 相关性提供受限的恢复入口', async () => {
  const port = await freePort();
  const holder = await startServer();
  const setup = () => makeManager({
    port,
    config: { url: `http://127.0.0.1:${holder.port}` },
    kill: () => {},
    isPidAlive: () => true,
    waitForPortReleased: async () => true,
    probeHealth: async () => ({ ok: true, reachable: true }),
    // CIM/WMI 被限制：拿到进程名但读不到命令行 ⇒ dshLike=false
    findListenerPid: async () => ({ pid: 7777, name: 'node.exe', commandLine: null })
  });

  // ① 我们刚拉起的进程认领失败过（readyFailure 非空）⇒ 允许用户显式接管
  const failed = setup();
  Object.assign(failed.manager.state, {
    owned: true, mode: 'takeover', everSpawned: true, wrapperPid: 1234,
    baselineListenerPid: null, readyFailure: 'identity-mismatch',
    observed: { pid: 7777, name: 'node.exe', dshLike: false }
  });
  assert.strictEqual(failed.manager.snapshot().spawnCorrelated, true);
  assert.strictEqual(failed.manager.snapshot().forceRestartable, true, '应提供恢复入口，而不是两边按钮全灰');
  const adopted = await failed.manager.adoptAndRestart();
  assert.ok(
    !['not-dsh-like', 'no-commandline-evidence', 'listener-unknown'].includes(adopted.reason),
    `spawn 相关性应被接受为证据：${JSON.stringify(adopted)}`
  );
  assert.strictEqual(failed.manager.state.adopted, true);

  // ② 对照组：我们并没有"刚拉起就认领失败"这回事 ⇒ 仍然严格拒绝
  const unrelated = setup();
  Object.assign(unrelated.manager.state, {
    owned: false, mode: 'takeover', everSpawned: false, baselineListenerPid: 7777,
    readyFailure: null, observed: { pid: 7777, name: 'node.exe', dshLike: false }
  });
  assert.strictEqual(unrelated.manager.snapshot().forceRestartable, false);
  const refused = await unrelated.manager.adoptAndRestart();
  assert.strictEqual(refused.reason, 'not-dsh-like', '没有 spawn 相关性时必须继续拒绝');

  await holder.close();
});

test('shutdown() 预算耗尽时如实返回 shutdown-timeout（不假装成功）', async () => {
  const port = await freePort();
  const { manager } = makeManager({
    port,
    kill: () => {},
    isPidAlive: () => true,
    waitForPortReleased: () => new Promise(() => {}), // 永远挂住，模拟清理卡死
    setTimer: (fn) => setTimeout(fn, 0)                // 立即触发兜底保险
  });
  manager.state.owned = true;
  manager.state.mode = 'managed';
  manager.state.listenerPid = 4242;

  const result = await manager.shutdown({ timeoutMs: 6000 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'shutdown-timeout');
});
