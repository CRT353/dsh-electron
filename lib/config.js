'use strict';
/**
 * 配置加载与校验（不依赖 Electron，可单测）
 *
 * 安全相关：
 *  - DSH_URL 默认只接受本机地址；指向远端时默认**拒绝启动**（fail-closed），
 *    必须显式设置 DSH_ALLOW_REMOTE=1 才放行，避免这个"本地外壳"被当成
 *    任意远端站点的容器。
 *  - 所有数值项都做范围收敛，避免环境变量写错导致轮询风暴或永不超时。
 */

const path = require('path');
const os = require('os');
const { isLocalHost, parsePermissionList } = require('./security');
const { DEFAULT_KILL_PATTERN } = require('./procs');

const DEFAULT_URL = 'http://127.0.0.1:3080';
const DEFAULT_START_COMMAND = 'dsh web --no-open';
const DEFAULT_NET_CHECK_URL = 'https://www.baidu.com';
const DEFAULT_VIEW_PARTITION = 'persist:dsh-view';

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  // 先 trim：cmd.exe 的 `set DSH_ALLOW_REMOTE=1 && npm start` 会把值设成 "1 "（末尾带空格），
  // 旧实现不容忍空白 ⇒ 用户明明按文档设置了却以"配置错误"拒绝启动（或安全/功能开关被静默置反）。
  // 注意 num() 一直用 Number() 能容忍空白，两种解析口径现在一致了。
  const text = String(value).trim();
  if (text === '') return fallback;
  return text === '1' || text.toLowerCase() === 'true';
}

/**
 * 路径是否落在 asar 归档内（打包后 `__dirname` 就是 `<install>\resources\app.asar`）。
 * asar 归档对 Node 而言是一个**文件**，其下任何写入都会抛 ENOENT（已实测：
 * statSync/appendFileSync/writeFileSync 三者全部失败）。
 */
function isInsideAsar(p) {
  return /(^|[\\/])app\.asar([\\/]|$)/i.test(String(p || ''));
}

/**
 * 默认日志路径。
 * 打包态必须换到可写目录：否则默认值 `<install>\resources\app.asar\load-status.log`
 * 永远写不进去，而 lib/log.js 会静默吞掉失败 ⇒ 发行版“看起来正常但没有任何日志”，
 * “打开日志”也指向不存在的路径。开发态保持原行为（写项目目录），并始终让 DSH_LOG_FILE 优先。
 */
function defaultLogFile(env, root, userDataDir) {
  if (env.DSH_LOG_FILE) return env.DSH_LOG_FILE;
  if (isInsideAsar(root)) return path.join(userDataDir || os.tmpdir(), 'load-status.log');
  return path.join(root, 'load-status.log');
}

/**
 * 解析"这个进程是 DSH"的判定模式（`DSH_KILL_PATTERN`）。
 * 非法正则回退到安全默认；空值也用默认。主程序（main.js）与 `npm stop`
 * （tools/stop-dsh.js）共用本函数，避免两处各写一份判定口径而漂移。
 */
function resolveKillPattern(env = {}) {
  const raw = env && env.DSH_KILL_PATTERN;
  if (!raw) return DEFAULT_KILL_PATTERN;
  try {
    return new RegExp(String(raw), 'i');
  } catch (_) {
    return DEFAULT_KILL_PATTERN;
  }
}

function loadConfig(env = process.env, options = {}) {
  const root = options.root || __dirname;
  const urlRaw = env.DSH_URL || DEFAULT_URL;

  let parsed = null;
  let urlError = null;
  try {
    parsed = new URL(urlRaw);
    if (!/^https?:$/.test(parsed.protocol)) urlError = `DSH_URL 只支持 http/https，当前为 ${parsed.protocol}`;
    else if (!parsed.hostname) urlError = 'DSH_URL 缺少主机名';
  } catch (_) {
    urlError = `DSH_URL 不是合法 URL：${urlRaw}`;
  }

  const allowRemote = bool(env.DSH_ALLOW_REMOTE, false);
  const remoteTarget = Boolean(parsed && !isLocalHost(parsed.hostname));
  let fatalError = urlError;
  if (!fatalError && remoteTarget && !allowRemote) {
    fatalError =
      `DSH_URL 指向非本机地址（${parsed.hostname}），默认拒绝启动：本程序是本地 DSH 服务的外壳。` +
      `如确实需要连接远端，请显式设置 DSH_ALLOW_REMOTE=1（将失去"仅本地"安全假设）。`;
  }

  const host = parsed ? parsed.hostname.replace(/^\[|\]$/g, '') : '127.0.0.1';
  const port = parsed ? Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)) : 3080;

  const killPattern = resolveKillPattern(env);

  // 视图默认使用独立会话分区：Cookie/localStorage/缓存与其它 Electron 应用隔离
  // （可用 DSH_VIEW_PARTITION=default 退回 Electron 默认会话）
  const viewPartitionRaw = env.DSH_VIEW_PARTITION === undefined
    ? DEFAULT_VIEW_PARTITION
    : String(env.DSH_VIEW_PARTITION).trim();
  const viewPartition = /^(default|none|off|0|)$/i.test(viewPartitionRaw) ? '' : viewPartitionRaw;

  return {
    url: urlRaw,
    host,
    port,
    remoteTarget,
    allowRemote,
    fatalError,
    startCommand: env.DSH_START_COMMAND || DEFAULT_START_COMMAND,
    pollIntervalMs: num(env.DSH_POLL_INTERVAL, 5000, 1000, 120000),
    checkTimeoutMs: num(env.DSH_CHECK_TIMEOUT, 3000, 500, 30000),
    readyTimeoutMs: num(env.DSH_READY_TIMEOUT, 60000, 5000, 600000),
    killTimeoutMs: num(env.DSH_KILL_TIMEOUT, 8000, 1000, 60000),
    dshFailThreshold: num(env.DSH_FAIL_THRESHOLD, 2, 1, 10),
    netFailThreshold: num(env.DSH_NET_FAIL_THRESHOLD, 2, 1, 10),
    netCheck: bool(env.DSH_NET_CHECK, true),
    netCheckUrl: env.DSH_NET_CHECK_URL || DEFAULT_NET_CHECK_URL,
    requireHtml: bool(env.DSH_HEALTH_REQUIRE_HTML, true),
    allowUnverifiedKill: bool(env.DSH_ALLOW_UNVERIFIED_KILL, false),
    killPattern,
    allowedPermissions: parsePermissionList(env.DSH_ALLOW_PERMISSIONS),
    externalSchemes: parsePermissionList(env.DSH_EXTERNAL_SCHEMES).length
      ? parsePermissionList(env.DSH_EXTERNAL_SCHEMES).map((s) => (s.endsWith(':') ? s : `${s}:`))
      : ['http:', 'https:'],
    viewPartition,
    devtools: bool(env.DSH_DEVTOOLS, true),
    viewRetryIntervalMs: num(env.DSH_VIEW_RETRY_INTERVAL, 5000, 1000, 60000),
    viewMaxAttempts: num(env.DSH_VIEW_MAX_ATTEMPTS, 5, 1, 50),
    logFile: defaultLogFile(env, root, options.userDataDir),
    logMaxBytes: num(env.DSH_LOG_MAX_BYTES, 2 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    logMaxMessage: num(env.DSH_LOG_MAX_MESSAGE, 8 * 1024, 512, 256 * 1024),
    redactLogTokens: bool(env.DSH_LOG_REDACT_TOKENS, true),
    sidebarWidth: 240
  };
}

module.exports = { loadConfig, resolveKillPattern, isInsideAsar, DEFAULT_URL, DEFAULT_START_COMMAND, DEFAULT_NET_CHECK_URL, DEFAULT_VIEW_PARTITION };
