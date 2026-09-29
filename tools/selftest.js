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

const { createExec } = require('../lib/exec');
const { buildSpawnPlan, findListenerPid, isPidAlive, isPortInUse, waitForPortReleased } = require('../lib/procs');
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

/** 只读检查：谁在监听这个端口（不做任何终止动作） */
function inspectPort(port) {
  console.log(`\n=== 只读检查：端口 ${port} 的监听者 ===`);
  const listener = findListenerPid(port, { exec, host: '127.0.0.1' });
  if (!listener) {
    console.log('  未查到监听者（端口空闲，或本机 netstat/ps/lsof 不可用，或被安全策略限制）');
    return null;
  }
  console.log(`  pid      : ${listener.pid}`);
  console.log(`  name     : ${listener.name || '未知'}`);
  console.log(`  命令行   : ${listener.commandLine ? listener.commandLine.slice(0, 200) : '读取失败（可能导致清理时默认拒绝）'}`);
  return listener;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.inspect) {
    inspectPort(args.inspect);
    process.exit(0);
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
  const probeListener = inspectPort(3080);
  record('能读取端口监听者信息（netstat/ps + 命令行）', Boolean(probeListener && probeListener.commandLine),
    probeListener ? `pid=${probeListener.pid} name=${probeListener.name}` : '查询失败');
  if (!probeListener) {
    console.log('  提示：若这里是 FAIL，请在该终端直接运行本脚本；受限沙箱会禁止子进程管道。');
  }

  console.log(`\n=== 3. 用假服务走完整生命周期（端口 ${port}）===`);
  const plan = buildSpawnPlan(`${process.execPath} "${path.join(__dirname, '..', 'tests', 'dummy-server.js')}"`, {});
  const manager = new ServiceManager({
    config: {
      url: `http://127.0.0.1:${port}`,
      host: '127.0.0.1',
      port,
      startCommand: args.startCommand,
      spawnPlan: plan,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      readyTimeoutMs: 20000,
      killTimeoutMs: 8000,
      readyPollMs: 200
    },
    logger,
    exec,
    probeHealth: () => probeDsh({ url: `http://127.0.0.1:${port}`, timeoutMs: 1500, requireHtml: false }),
    findListenerPid: (p, h) => findListenerPid(p, { host: h, exec })
  });

  let snapshot = null;
  try {
    snapshot = await manager.ensure();
    record('服务拉起并就绪', snapshot.mode === 'managed', `mode=${snapshot.mode} spawnCount=${snapshot.spawnCount}`);
    record('端口进入监听状态', await isPortInUse(port, '127.0.0.1'), `127.0.0.1:${port}`);
    record('权威身份取自真实监听 pid', Boolean(snapshot.listenerPid), `listenerPid=${snapshot.listenerPid} wrapperPid=${snapshot.wrapperPid}`);
    record('监听进程身份经命令行校验', snapshot.listenerVerified === true,
      snapshot.listenerVerified ? '已校验' : '仅观察认定（netstat/ps 不可用时属预期）');

    const kill = await manager.killManaged('selftest');
    record('清理完成', kill.ok === true, kill.ok ? kill.steps.join(' → ') : `${kill.reason || ''} ${JSON.stringify(kill.steps || [])}`);
    record('清理后端口释放', (await isPortInUse(port, '127.0.0.1', 800)) === false, `127.0.0.1:${port}`);
    if (snapshot.listenerPid) {
      await new Promise((r) => setTimeout(r, 200));
      record('清理后进程退出', isPidAlive(snapshot.listenerPid) === false, `pid=${snapshot.listenerPid}`);
    }
  } catch (err) {
    record('生命周期自检异常', false, err && err.message ? err.message : String(err));
  } finally {
    // 兜底：确保不留下测试进程
    try { await manager.shutdown({ timeoutMs: 4000 }); } catch (_) { /* 忽略 */ }
    const leftover = await waitForPortReleased(port, '127.0.0.1', { timeoutMs: 3000, intervalMs: 200 });
    if (!leftover) console.log(`  警告：端口 ${port} 仍被占用，可能有残留测试进程，请手动检查。`);
  }

  console.log('\n=== 自检结论 ===');
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`  ${r.ok ? '✔' : '✖'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`  合计 ${results.length} 项，失败 ${failed.length} 项`);

  // 受限环境识别：沙箱/受限 shell 会禁止子进程管道，此时结论不代表代码有问题
  const environmentLimited = logger.tail(400).some((l) => /EPERM|EACCES|not permitted/i.test(l));
  if (environmentLimited) {
    console.log('\n  ⚠ 检测到受限执行环境（子进程管道被禁止：spawn EPERM）。');
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
