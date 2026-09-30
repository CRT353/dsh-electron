'use strict';
/**
 * 安全的"停止 DSH 服务"工具（替代已归档的 dsh_off.ps1 里"杀掉所有 node.exe"的做法）
 *
 * 只终止"确实是 DSH 服务"的进程：
 *   1. 解析监听 DSH 端口的进程（netstat/lsof/ss + 命令行读取）；
 *   2. 通过身份校验才动手——证据是"进程名在可信名单内 且 命令行匹配 DSH 入口形态"
 *      （判定模式与主程序共用 `lib/config.js#resolveKillPattern`，可用 DSH_KILL_PATTERN 覆盖）；
 *      本工具**没有**"本程序记录过的 pid"这类证据，因此只会终止命令行能确认是 DSH 的进程；
 *   3. 终止策略按平台区分：Windows 用 taskkill /T /F 结束整棵进程树（process.kill 不带子进程，
 *      且没有真正的"温和"阶段）；POSIX 先 SIGTERM，端口不让出再 SIGKILL；
 *   4. 校验不通过就明确拒绝并说明原因，绝不误杀（例如把别的 node 服务一起杀掉）。
 *
 * 用法：
 *   npm run stop                  # 停止 127.0.0.1:3080 上的 DSH 服务
 *   node tools/stop-dsh.js --port 39999
 *   node tools/stop-dsh.js --dry-run     # 只看会做什么，不动任何进程
 */

const path = require('path');

const { createExec } = require('../lib/exec');
const { findListenerPid, isPidAlive, isPortInUse, waitForPortReleased, decideKill } = require('../lib/procs');
const { createLogger } = require('../lib/log');
const { resolveKillPattern } = require('../lib/config');

const DEFAULT_PORT = 3080;
const DEFAULT_HOST = '127.0.0.1';

/**
 * 解析命令行参数；非法输入**直接抛错**（由 main 打印用法并以退出码 2 结束）。
 *
 * 旧实现是 `args.port = Number(argv[++i])`，而 run() 里用 `Number(options.port || DEFAULT_PORT)`：
 * `--port` 缺值得到 NaN，NaN 是假值 ⇒ **静默回落到 3080**，可打印的目标却是 `NaN`
 * ——用户以为在操作别的端口，实际停掉的可能是正在运行的 DSH 服务，且看不出异常。
 */
function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, dryRun: false, host: DEFAULT_HOST };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--port') {
      const raw = argv[i + 1];
      i += 1;
      const num = Number(raw);
      if (raw === undefined || String(raw).trim() === '' || !Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(
          `--port 需要一个 1–65535 的整数（收到 ${raw === undefined ? '缺值' : JSON.stringify(raw)}）`
        );
      }
      args.port = num;
    } else if (token === '--host') {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || String(raw).trim() === '') throw new Error('--host 需要一个非空主机名');
      args.host = String(raw).trim();
    } else if (token === '--dry-run' || token === '-n') {
      args.dryRun = true;
    }
  }
  return args;
}

/**
 * 核心流程（依赖可注入，便于单测）
 * @returns {Promise<{action:string, reason?:string, pid?:number, steps?:string[]}>}
 */
async function run(options = {}) {
  const deps = {
    exec: options.exec || createExec(),
    findListenerPid: options.findListenerPid,
    isPidAlive: options.isPidAlive || isPidAlive,
    isPortInUse: options.isPortInUse || isPortInUse,
    waitForPortReleased: options.waitForPortReleased || waitForPortReleased,
    kill: options.kill || ((pid, signal) => process.kill(pid, signal)),
    platform: options.platform || process.platform,
    logger: options.logger || createLogger({ file: null }),
    pattern: options.pattern || resolveKillPattern(process.env),
    allowUnverified: options.allowUnverified !== undefined
      ? options.allowUnverified
      : process.env.DSH_ALLOW_UNVERIFIED_KILL === '1'
  };
  // 端口/主机一律显式校验，绝不"回落默认值"：回落到 3080 会停掉真实 DSH 服务。
  const port = options.port === undefined || options.port === null ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`非法端口: ${String(options.port)}（应为 1–65535 的整数）`);
  }
  const hostRaw = options.host === undefined || options.host === null ? DEFAULT_HOST : String(options.host).trim();
  const host = hostRaw === '' ? DEFAULT_HOST : hostRaw;
  const dryRun = Boolean(options.dryRun);

  const inUse = await deps.isPortInUse(port, host, 800);
  if (!inUse) {
    deps.logger.info(`端口 ${host}:${port} 无人监听，无需停止`);
    return { action: 'none', reason: 'port-free' };
  }

  const resolve = deps.findListenerPid || ((p, h) => findListenerPid(p, { host: h, exec: deps.exec }));
  const listener = await resolve(port, host);
  if (!listener) {
    const message = `端口 ${host}:${port} 被占用，但无法识别监听进程（netstat/ps 不可用或被限制）。为避免误杀，本工具不做任何操作；可用 --dry-run 之外的排查方式确认后手动处理。`;
    deps.logger.warn(message);
    return { action: 'refused', reason: 'listener-unknown' };
  }

  const verdict = decideKill({
    pid: listener.pid,
    name: listener.name,
    commandLine: listener.commandLine,
    pattern: deps.pattern,
    allowUnverified: deps.allowUnverified
  });

  if (!verdict.allowed) {
    deps.logger.warn(
      `拒绝终止 pid ${listener.pid}（${listener.name || '未知'}）：${verdict.reason}。` +
      `该进程不像 DSH 服务，为避免误杀（例如连别的 node 服务一起杀掉）本工具不动它。` +
      `确认无误可设置 DSH_ALLOW_UNVERIFIED_KILL=1 后重试。`
    );
    return { action: 'refused', reason: verdict.reason, pid: listener.pid };
  }

  if (dryRun) {
    deps.logger.info(`[dry-run] 将终止 pid ${listener.pid}（${listener.name || '未知'}）——判定依据 ${verdict.reason}`);
    return { action: 'would-stop', pid: listener.pid, reason: verdict.reason };
  }

  const steps = [];
  deps.logger.info(`停止 DSH 服务：pid ${listener.pid}（${listener.name || '未知'}），判定依据 ${verdict.reason}`);

  // Windows 上 process.kill() 是强制终止且**不连带子进程**（无 POSIX 信号），因此先用
  // taskkill /T /F 结束整棵进程树；只有 POSIX 才存在真正的"温和"阶段（SIGTERM → SIGKILL）。
  // 旧实现两边都先 process.kill，再用"pid 是否还活着"决定要不要 taskkill —— 那时 pid 必然
  // 已死，/T 永远轮不到，被停服务的子孙进程会残留。
  if (deps.platform === 'win32') {
    const res = deps.exec({ file: 'taskkill', args: ['/pid', String(listener.pid), '/T', '/F'], timeoutMs: 8000 });
    steps.push(`taskkill:${listener.pid}:${res && res.ok ? 'ok' : 'failed'}`);
    if (!res || !res.ok) {
      // 拿不到 taskkill（受限终端等）时退回 process.kill，保证"至少把目标本身停掉"
      try {
        deps.kill(listener.pid);
        steps.push(`kill-fallback:${listener.pid}:ok`);
      } catch (err) {
        steps.push(`kill-fallback:${listener.pid}:${err && err.code ? err.code : 'error'}`);
      }
    }
  } else {
    try {
      deps.kill(listener.pid);
      steps.push(`sigterm:${listener.pid}:ok`);
    } catch (err) {
      steps.push(`sigterm:${listener.pid}:${err && err.code ? err.code : 'error'}`);
    }
  }

  let released = await deps.waitForPortReleased(port, host, { timeoutMs: 4000 });
  if (!released && deps.isPidAlive(listener.pid)) {
    if (deps.platform === 'win32') {
      const res = deps.exec({ file: 'taskkill', args: ['/pid', String(listener.pid), '/T', '/F'], timeoutMs: 8000 });
      steps.push(`taskkill-retry:${listener.pid}:${res && res.ok ? 'ok' : 'failed'}`);
    } else {
      try {
        deps.kill(listener.pid, 'SIGKILL');
        steps.push(`sigkill:${listener.pid}:ok`);
      } catch (err) {
        steps.push(`sigkill:${listener.pid}:${err && err.code ? err.code : 'error'}`);
      }
    }
    released = await deps.waitForPortReleased(port, host, { timeoutMs: 4000 });
  }

  if (released) {
    deps.logger.info(`服务已停止，端口 ${host}:${port} 已释放：${steps.join(' → ')}`);
    return { action: 'stopped', pid: listener.pid, steps };
  }
  deps.logger.error(`未能释放端口 ${host}:${port}：${steps.join(' → ')}`);
  return { action: 'failed', pid: listener.pid, steps };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`参数错误: ${err && err.message ? err.message : err}`);
    console.error('用法: node tools/stop-dsh.js [--port <1-65535>] [--host <地址>] [--dry-run|-n]');
    process.exit(2);
  }
  console.log('=== 停止 DSH 服务（带身份校验，不会误杀其它 node 进程）===');
  console.log(`目标: ${args.host}:${args.port}${args.dryRun ? '（dry-run，不会真的终止）' : ''}`);
  const logger = createLogger({ file: null, ringSize: 100 });
  const result = await run({ ...args, logger });
  for (const line of logger.tail(20)) console.log(`  ${line}`);
  console.log(`结论: ${result.action}${result.reason ? `（${result.reason}）` : ''}`);
  process.exit(result.action === 'stopped' || result.action === 'none' || result.action === 'would-stop' ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('停止工具异常：', err);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, DEFAULT_PORT };
