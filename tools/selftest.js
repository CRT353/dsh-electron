'use strict';
/**
 * 真实环境自检（headless，不启动 Electron）
 *
 * 用途：在没有 GUI 的情况下，用假 DSH 服务完整走一遍
 *   "解析启动命令 → 拉起 → 用 netstat/ps 认领真实监听 pid → 清理 → 端口释放"
 * 这条链路。它会真正调用 netstat/ps 与 taskkill/kill —— 这些在受限沙箱里
 * 会被拦截，因此本脚本**必须在普通终端里运行**才能得到完整结论。
 *
 * 用法：
 *   npm run selftest                     # 用随机空闲端口 + 假服务
 *   npm run selftest -- --port 39999     # 指定端口
 *   npm run selftest -- --inspect 3080   # 只查看某个端口被谁监听（绝不动它）
 *
 * 安全：全程不触碰真实 DSH 端口（默认 3080），只在 --inspect 下读取信息。
 */

const path = require('path');
const os = require('os');
const net = require('net');

const { createExec } = require('../lib/exec');
const { buildSpawnPlan, findListenerPid, findListenerPidDetailed, isPidAlive, isPortInUse, waitForPortReleased } = require('../lib/procs');
const { probeDsh } = require('../lib/health');
const { ServiceManager } = require('../lib/service');
const { createLogger } = require('../lib/log');

const exec = createExec();
const logger = createLogger({ file: null, ringSize: 400 });
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function parseArgs(argv) {
  const args = { port: null, inspect: null, startCommand: 'node tests/dummy-server.js' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--inspect') args.inspect = Number(argv[++i]);
    else if (argv[i] === '--command') args.startCommand = argv[++i];
  }
  return args;
}

async function freePort() {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * 只读检查：谁在监听这个端口（不做任何终止动作）。
 * 明确区分三种结果：查到监听者 / 端口确实空闲 / **查询能力不可用**。
 * 旧实现把后两者合并成一句"未查到监听者"，并让 `--inspect` 以 0 退出 ——
 * 在拿不到 netstat 的环境里，这会让人得出"端口空闲"的错误结论（而服务其实在跑）。
 * @returns {{listener: object|null, queryFailed: boolean, reason?: string}}
 */
function inspectPort(port) {
  console.log(`\n=== 只读检查：端口 ${port} 的监听者 ===`);
  const result = findListenerPidDetailed(port, { exec, host: '127.0.0.1' });
  if (result.queryFailed) {
    console.log(`  ✖ 查询能力不可用：${result.reason}`);
    console.log('    注意：这不是"端口空闲"——本次检查没有得出任何结论，请在普通终端重试。');
    return result;
  }
  const listener = result.listener;
  if (!listener) {
    console.log('  端口空闲（查询正常完成，该端口当前没有监听者）');
    return result;
  }
  console.log(`  pid      : ${listener.pid}`);
  console.log(`  name     : ${listener.name || '未知'}`);
  console.log(`  命令行   : ${listener.commandLine ? listener.commandLine.slice(0, 200) : '读取失败（可能导致清理时默认拒绝）'}`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspect) {
    const inspected = inspectPort(args.inspect);
    // 查询失败时以非 0 退出：让脚本/CI 不会把"我没查到"当成"端口没人"
    process.exit(inspected.queryFailed ? 3 : 0);
  }

  console.log('=== 1. 命令解析（Windows 上必须解析出 .cmd 垫片，且不使用 shell:true）===');
  const realPlan = buildSpawnPlan(process.env.DSH_START_COMMAND || 'dsh web --no-open', {});
  console.log(`  dsh 启动命令 → launcher=${realPlan.launcher} file=${realPlan.file} resolved=${realPlan.resolved}`);
  record('DSH 启动命令可解析', realPlan.resolved, realPlan.file);

  const port = args.port || (await freePort());
  if (port === 3080) {
    console.log('  拒绝在真实 DSH 端口 3080 上运行破坏性自检，请用 --inspect 3080 只读查看。');
    process.exit(2);
  }

  console.log('\n=== 2. 系统进程查询能力（清理链路的第 3 级兜底依赖它）===');
  // 用**自建**的临时监听来做能力探测，而不是去查 3080：
  // 旧实现把"3080 此刻正被监听且命令行可读"当成通过条件 —— 在没跑 DSH 的机器上
  // （新克隆 / CI / 刚 npm stop）必然记 FAIL 并以退出码 1 结束，把"这台机器没起服务"
  // 伪装成"代码有问题"，还会把人引向排查 netstat/ps 链路。
  const probePort = await freePort();
  const probeServer = net.createServer();
  let capability = { listener: null, queryFailed: true, reason: '未能建立探测用监听' };
  try {
    await new Promise((resolve, reject) => {
      probeServer.once('error', reject);
      probeServer.listen(probePort, '127.0.0.1', resolve);
    });
    capability = inspectPort(probePort);
  } catch (err) {
    console.log(`  探测用监听建立失败：${err && err.message ? err.message : err}`);
  } finally {
    await new Promise((resolve) => probeServer.close(resolve));
  }
  const capabilityOk = capability.queryFailed === false;
  record(
    '进程查询能力可用（netstat/ps 可执行）',
    capabilityOk,
    capabilityOk
      ? `pid=${capability.listener && capability.listener.pid} name=${(capability.listener && capability.listener.name) || '未知'}`
      : capability.reason
  );
  if (capabilityOk && capability.listener && !capability.listener.commandLine) {
    record('命令行可读（身份校验依赖它）', false, '能查到进程但读不到命令行：清理时会默认拒绝，需人工确认');
  }
  if (!capabilityOk) {
    console.log('  提示：这一项失败说明当前终端拿不到进程查询能力（受限沙箱会禁止子进程管道），');
    console.log('        与代码无关 —— 请在**普通终端**重新运行 npm run selftest。');
  }

  // 步骤 3/4 共用：走完"拉起 → 认领 → 清理 → 端口释放"并记录结果
  async function lifecycleCheck(prefix, targetPort, spawnPlan) {
    const manager = new ServiceManager({
      config: {
        url: `http://127.0.0.1:${targetPort}`,
        host: '127.0.0.1',
        port: targetPort,
        startCommand: args.startCommand,
        spawnPlan,
        env: { ...process.env, PORT: String(targetPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
        readyTimeoutMs: 20000,
        killTimeoutMs: 8000,
        readyPollMs: 200,
        verify: { pattern: /dsh|dummy-server/i, allowUnverified: false }
      },
      logger,
      exec,
      probeHealth: () => probeDsh({ url: `http://127.0.0.1:${targetPort}`, timeoutMs: 1500, requireHtml: false }),
      findListenerPid: (p, h) => findListenerPid(p, { host: h, exec })
    });

    let snapshot = null;
    try {
      snapshot = await manager.ensure();
      record(`${prefix}：服务拉起并就绪`, snapshot.mode === 'managed', `mode=${snapshot.mode} spawnCount=${snapshot.spawnCount}`);
      record(`${prefix}：端口进入监听状态`, await isPortInUse(targetPort, '127.0.0.1'), `127.0.0.1:${targetPort}`);
      record(
        `${prefix}：权威身份＝真实监听 pid`,
        Boolean(snapshot.listenerPid),
        `listenerPid=${snapshot.listenerPid} wrapperPid=${snapshot.wrapperPid}`
      );
      record(
        `${prefix}：身份经命令行校验`,
        snapshot.listenerVerified === true,
        snapshot.listenerVerified ? '已校验' : '仅观察认定（netstat/ps 不可用时属预期）'
      );

      const kill = await manager.killManaged('selftest');
      record(`${prefix}：清理完成`, kill.ok === true, kill.ok ? kill.steps.join(' → ') : `${kill.reason || ''} ${JSON.stringify(kill.steps || [])}`);
      record(`${prefix}：清理后端口释放`, (await isPortInUse(targetPort, '127.0.0.1', 800)) === false, `127.0.0.1:${targetPort}`);
      await new Promise((r) => setTimeout(r, 250));
      if (snapshot.listenerPid) record(`${prefix}：真实服务进程已退出`, isPidAlive(snapshot.listenerPid) === false, `pid=${snapshot.listenerPid}`);
      if (snapshot.wrapperPid && snapshot.wrapperPid !== snapshot.listenerPid) {
        record(`${prefix}：包装进程已退出`, isPidAlive(snapshot.wrapperPid) === false, `wrapper pid=${snapshot.wrapperPid}`);
      }
      record(
        `${prefix}：主动清理不产生假故障`,
        manager.snapshot().lastError === null,
        manager.snapshot().lastError || '无异常记录'
      );
    } catch (err) {
      record(`${prefix}：生命周期自检异常`, false, err && err.message ? err.message : String(err));
    } finally {
      try { await manager.shutdown({ timeoutMs: 4000 }); } catch (_) { /* 忽略 */ }
      const leftover = await waitForPortReleased(targetPort, '127.0.0.1', { timeoutMs: 3000, intervalMs: 200 });
      if (!leftover) console.log(`  警告：端口 ${targetPort} 仍被占用，可能有残留测试进程，请手动检查。`);
    }
  }

  console.log(`\n=== 3. 用假服务走完整生命周期（直接启动，端口 ${port}）===`);
  const dummy = path.join(__dirname, '..', 'tests', 'dummy-server.js');
  // 注意：必须给 process.execPath 加引号。Node 默认装在 "C:\Program Files\nodejs\"，
  // 不加引号时 splitCommand 会把它拆成 ["C:\Program", "Files\nodejs\node.exe", ...]，
  // resolved=false 并退化成 cmd 包装 → cmd 报 "'C:\Program' 不是内部或外部命令"，
  // 于是"直接启动"整段生命周期全 FAIL，而排查方向会被误导到产品代码上。
  // （第 4 节的 cmd 包装场景本来就带了引号，这里补齐。）
  await lifecycleCheck('直接启动', port, buildSpawnPlan(`"${process.execPath}" "${dummy}"`, {}));

  // 旧版最致命的场景：Windows 上 dsh 是 .cmd 垫片，真正拉起服务的是 cmd.exe 包装进程，
  // 真服务是它的子进程 —— 当时 kill 包装进程 pid 永远杀不掉服务。这里显式复现该条件。
  if (process.platform === 'win32') {
    const wrapperPort = await freePort();
    const comspec = process.env.ComSpec || 'cmd.exe';
    console.log(`\n=== 4. 复现旧版失败条件：cmd 包装进程 pid ≠ 真实服务 pid（端口 ${wrapperPort}）===`);
    await lifecycleCheck('cmd 包装', wrapperPort, {
      file: comspec,
      args: ['/d', '/s', '/c', `"${process.execPath}" "${dummy}"`],
      useShell: false,
      launcher: 'cmd',
      resolved: true,
      display: `${comspec} /d /s /c node dummy-server.js`
    });
  } else {
    console.log('\n=== 4. 跳过：非 Windows 平台没有 cmd 包装进程场景 ===');
  }

  console.log('\n=== 自检结论 ===');
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`  合计 ${results.length} 项，失败 ${failed.length} 项`);

  // 受限环境识别：以"进程查询能力探测"的**精确结果**为准。
  // 旧实现对整个日志环形缓冲做 EPERM|EACCES 关键词匹配，而被测服务自身的 stderr 也会
  // 进入同一个缓冲 —— 服务输出里出现一次 EACCES 就能把真实的代码缺陷误导成
  // "与代码无关的环境问题"（并让退出码从 1 变成 3）。
  const environmentLimited = !capabilityOk;
  if (environmentLimited) {
    console.log(`\n  ⚠ 进程查询能力不可用：${capability.reason}`);
    console.log('    这一类失败与代码无关：请在**普通终端**（非受限沙箱）中重新运行 npm run selftest。');
  }

  console.log('  日志尾部（用于排查）：');
  for (const line of logger.tail(12)) console.log(`    ${line.split('\n')[0]}`);
  process.exit(failed.length === 0 ? 0 : (environmentLimited ? 3 : 1));
}

main().catch((err) => {
  console.error('自检脚本异常：', err);
  process.exit(1);
});
