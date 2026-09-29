'use strict';
/**
 * 安全的"停止 DSH 服务"工具（替代已归档的 dsh_off.ps1 里"杀掉所有 node.exe"的做法）
 *
 * 只终止"确实是 DSH 服务"的进程：
 *   1. 解析监听 DSH 端口的进程（netstat/lsof/ss + 命令行读取）；
 *   2. 通过身份校验（本工具的目标 pid 或 命令行匹配 dsh）才动手；
 *   3. 先 SIGTERM，等端口释放，必要时才强杀；
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

const DEFAULT_PORT = 3080;

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, dryRun: false, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--host') args.host = argv[++i];
    else if (argv[i] === '--dry-run' || argv[i] === '-n') args.dryRun = true;
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
    pattern: options.pattern || /dsh/i,
    allowUnverified: options.allowUnverified !== undefined
      ? options.allowUnverified
      : process.env.DSH_ALLOW_UNVERIFIED_KILL === '1'
  };
  const port = Number(options.port || DEFAULT_PORT);
  const host = options.host || '127.0.0.1';
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
  try {
    deps.kill(listener.pid);
    steps.push(`sigterm:${listener.pid}:ok`);
  } catch (err) {
    steps.push(`sigterm:${listener.pid}:${err && err.code ? err.code : 'error'}`);
  }

  let released = await deps.waitForPortReleased(port, host, { timeoutMs: 4000 });
  if (!released && deps.isPidAlive(listener.pid)) {
    if (deps.platform === 'win32') {
      const res = deps.exec({ file: 'taskkill', args: ['/pid', String(listener.pid), '/T', '/F'], timeoutMs: 8000 });
      steps.push(`taskkill:${listener.pid}:${res && res.ok ? 'ok' : 'failed'}`);
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
  const args = parseArgs(process.argv.slice(2));
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
