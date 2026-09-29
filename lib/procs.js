'use strict';
/**
 * 进程 / 端口工具（不依赖 Electron，全部可注入、可单测）
 *
 * 修掉的旧问题：
 *  - 旧实现用 `spawn(cmd, {shell:true})`，记录下来的 pid 是 cmd.exe 包装进程，
 *    真服务是它的子进程 → `taskkill /pid <wrapper> /T /F` 永远失败（日志里 14/14 失败），
 *    真正杀掉服务靠的是"杀监听端口的进程"这条兜底。
 *    现在：命令先解析成可执行文件（Windows 上正确处理 .cmd/.bat 垫片），
 *    并且**以监听端口的真实 pid 作为权威身份**。
 *  - 旧兜底会杀掉任何监听 3080 的进程（注释还写着"绝对安全"）→ 现在
 *    decideKill() 做默认拒绝的身份校验。
 *  - 旧正则硬编码 `127.0.0.1:port` + Windows netstat 文本 → 现在支持
 *    netstat / lsof / ss 三种来源与 IPv6、localhost 写法。
 */

const fs = require('fs');
const net = require('net');
const path = require('path');

const TRUSTED_NAMES = new Set(['node', 'node.exe', 'electron', 'electron.exe', 'dsh', 'dsh.exe']);
const SHELL_META_RE = /[|&<>^%]/;

/** 解析启动命令为 token 数组（支持单/双引号，Windows 反斜杠转义） */
function splitCommand(command) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let started = false;
  const text = String(command == null ? '' : command);
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (ch === '\\' && quote === '"' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
        cur += text[i + 1];
        i += 1;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) { tokens.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) tokens.push(cur);
  return tokens;
}

function defaultIsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/**
 * 解析可执行文件真实路径。
 * Windows 上 npm 全局命令是 .cmd/.ps1 垫片，必须解析成 <name>.cmd，
 * 否则 shell:false 直接 spawn 'dsh' 会 ENOENT；而 shell:true 又会引入
 * 无法回收的包装进程 pid。
 */
function resolveExecutable(file, options = {}) {
  const platform = options.platform || process.platform;
  const isFile = options.isFile || defaultIsFile;
  const pathEnv = options.pathEnv !== undefined ? options.pathEnv : process.env.PATH;
  const pathext = (options.pathext !== undefined ? options.pathext : process.env.PATHEXT) || '.COM;.EXE;.BAT;.CMD';
  const hasSep = /[\\/]/.test(file);
  const hasExt = /\.[A-Za-z0-9]+$/.test(file);
  // 路径拼接必须跟随"目标平台"而不是"宿主平台"，否则在 Windows 上模拟 POSIX 会拼出反斜杠
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;

  const dirs = hasSep
    ? ['']
    : String(pathEnv || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);

  const candidates = [];
  for (const dir of dirs) {
    const base = dir ? pathImpl.join(dir, file) : file;
    if (platform === 'win32' && !hasExt) {
      // 扩展名优先：nvm-windows 的 bin 目录里同时存在无扩展名的 bash 脚本，
      // 它的优先级必须低于 dsh.cmd
      for (const ext of pathext.split(';').filter(Boolean)) candidates.push(base + ext);
      candidates.push(base);
    } else {
      candidates.push(base);
    }
  }

  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const ext = pathImpl.extname(candidate).toLowerCase();
    const needsShell = platform === 'win32' && (ext === '.cmd' || ext === '.bat' || ext === '.ps1');
    return { path: candidate, needsShell, resolved: true };
  }
  return { path: file, needsShell: platform === 'win32', resolved: false };
}

/**
 * 生成 spawn 计划。永远不用 shell:true，避免包装进程 pid 无法回收；
 * Windows 上的 .cmd/.bat 垫片通过 cmd.exe /d /s /c 调用（这一步仍会多一层
 * 包装进程，但权威身份取自端口监听者，因此不影响回收）。
 */
function buildSpawnPlan(command, options = {}) {
  const platform = options.platform || process.platform;
  const tokens = splitCommand(command);
  if (tokens.length === 0) throw new Error('DSH_START_COMMAND 为空');
  const [head, ...rest] = tokens;
  const resolved = resolveExecutable(head, { ...options, platform });
  const usesMeta = SHELL_META_RE.test(command) || /^\s*(?:npm|npx|pnpm|yarn)\s+run\b/.test(command);

  if (platform === 'win32') {
    if (resolved.needsShell || usesMeta) {
      const comspec = options.comspec || process.env.ComSpec || 'cmd.exe';
      return { file: comspec, args: ['/d', '/s', '/c', command], useShell: false, launcher: 'cmd', resolved: resolved.resolved, display: command };
    }
    return { file: resolved.path, args: rest, useShell: false, launcher: 'direct', resolved: resolved.resolved, display: command };
  }
  if (usesMeta) {
    return { file: '/bin/sh', args: ['-c', command], useShell: false, launcher: 'sh', resolved: resolved.resolved, display: command };
  }
  return { file: resolved.path, args: rest, useShell: false, launcher: 'direct', resolved: resolved.resolved, display: command };
}

/** 解析 `netstat -ano` 输出中的 TCP 监听项 */
function parseNetstatListeners(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(TCP|TCPv6)\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const local = m[2];
    const idx = local.lastIndexOf(':');
    if (idx < 0) continue;
    const address = local.slice(0, idx);
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port) || port <= 0) continue;
    out.push({ protocol: m[1], address, port, pid: Number(m[4]) });
  }
  return out;
}

/** 解析 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 输出 */
function parseLsofListeners(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/\((?:LISTEN)\)/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    const name = cols[0];
    const addrField = cols[cols.length - 2];
    const idx = addrField.lastIndexOf(':');
    if (idx < 0 || !Number.isInteger(pid)) continue;
    out.push({ protocol: 'TCP', address: addrField.slice(0, idx), port: Number(addrField.slice(idx + 1)), pid, name });
  }
  return out;
}

/** 解析 `ss -ltnp` 输出（Linux 兜底） */
function parseSsListeners(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^\s*LISTEN/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const addrField = cols[3];
    if (!addrField) continue;
    const idx = addrField.lastIndexOf(':');
    const pidMatch = /pid=(\d+)/.exec(line);
    if (idx < 0 || !pidMatch) continue;
    out.push({ protocol: 'TCP', address: addrField.slice(0, idx), port: Number(addrField.slice(idx + 1)), pid: Number(pidMatch[1]) });
  }
  return out;
}

function normalizeAddress(address) {
  return String(address || '').trim().replace(/^\[|\]$/g, '');
}

/** 监听地址是否覆盖目标主机（0.0.0.0 / :: 视为全部网卡） */
function matchesHost(address, host) {
  const a = normalizeAddress(address).toLowerCase();
  const h = normalizeAddress(host || '127.0.0.1').toLowerCase();
  if (a === '0.0.0.0' || a === '::' || a === '*') return true;
  if (a === h) return true;
  if ((a === '127.0.0.1' || a === '::1') && (h === 'localhost' || h === '127.0.0.1' || h === '::1')) return true;
  if ((h === '127.0.0.1' || h === '::1') && a === 'localhost') return true;
  return false;
}

function pickListener(listeners, port, host) {
  const list = Array.isArray(listeners) ? listeners : [];
  const exact = list.find((l) => l.port === port && matchesHost(l.address, host) && normalizeAddress(l.address) === normalizeAddress(host));
  if (exact) return exact;
  return list.find((l) => l.port === port && matchesHost(l.address, host)) || null;
}

function isPidAlive(pid, options = {}) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  const kill = options.kill || process.kill;
  try {
    kill(num, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * 是否允许终止该 pid —— 默认拒绝（fail-closed）。
 * 只信两种证据：本程序亲自记录并校验过的 pid，或名字在白名单且命令行匹配 dsh。
 */
function decideKill(input = {}) {
  const pid = Number(input.pid);
  const name = String(input.name || '').toLowerCase();
  const commandLine = input.commandLine ? String(input.commandLine) : '';
  const trustedPids = (input.trustedPids || []).map(Number);
  const pattern = input.pattern || /dsh/i;

  if (!Number.isInteger(pid) || pid <= 0) return { allowed: false, reason: 'invalid-pid' };
  if (trustedPids.includes(pid)) return { allowed: true, reason: 'tracked-pid' };
  if (!TRUSTED_NAMES.has(name)) {
    if (input.allowUnverified) return { allowed: true, reason: 'unverified-override', risky: true };
    return { allowed: false, reason: `untrusted-name:${name || 'unknown'}` };
  }
  if (!commandLine) {
    if (input.allowUnverified) return { allowed: true, reason: 'unverified-override', risky: true };
    return { allowed: false, reason: 'no-commandline-evidence' };
  }
  if (pattern.test(commandLine)) return { allowed: true, reason: 'commandline-match' };
  return { allowed: false, reason: 'commandline-mismatch' };
}

/** 探测端口是否已被监听（纯 Node，无子进程，可在沙箱内单测） */
function isPortInUse(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 等待端口释放（重启前必须先等到端口空出来，旧版没等 → 双实例抢端口 → boot 失败） */
async function waitForPortReleased(port, host = '127.0.0.1', options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 8000 : options.timeoutMs;
  const intervalMs = options.intervalMs === undefined ? 250 : options.intervalMs;
  const probe = options.probe || ((p, h) => isPortInUse(p, h, options.probeTimeoutMs || 700));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const inUse = await probe(port, host);
    if (!inUse) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** 读取进程名与命令行（用于身份校验；失败返回 name 或 null） */
function readProcessInfo(pid, options = {}) {
  const exec = options.exec;
  const platform = options.platform || process.platform;
  if (!exec || !Number.isInteger(Number(pid))) return null;

  if (platform === 'win32') {
    const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; if ($p) { "$($p.Name)` + '`t' + `$($p.CommandLine)" }`;
    const res = exec({ file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs: 4000 });
    if (res && res.ok) {
      const line = String(res.stdout || '').split(/\r?\n/).find((l) => l.trim().length > 0);
      if (line) {
        const [name, ...rest] = line.split('\t');
        return { pid: Number(pid), name: (name || '').trim(), commandLine: rest.join('\t').trim() || null };
      }
    }
    const csv = exec({ file: 'tasklist', args: ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], timeoutMs: 4000 });
    if (csv && csv.ok) {
      const m = /^"([^"]+)"/m.exec(String(csv.stdout || ''));
      if (m) return { pid: Number(pid), name: m[1], commandLine: null };
    }
    return null;
  }

  const res = exec({ file: 'ps', args: ['-p', String(Number(pid)), '-o', 'comm=,args='], timeoutMs: 4000 });
  if (!res || !res.ok) return null;
  const line = String(res.stdout || '').split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!line) return null;
  const trimmed = line.trim();
  const idx = trimmed.indexOf(' ');
  const name = idx < 0 ? trimmed : trimmed.slice(0, idx);
  const commandLine = idx < 0 ? null : trimmed.slice(idx + 1).trim();
  return { pid: Number(pid), name: path.posix.basename(name), commandLine };
}

/** 查出监听指定端口的 pid（Windows: netstat，macOS/Linux: lsof → ss） */
function findListenerPid(port, options = {}) {
  const exec = options.exec;
  const platform = options.platform || process.platform;
  const host = options.host || '127.0.0.1';
  if (!exec) return null;

  let listeners = [];
  if (platform === 'win32') {
    const res = exec({ file: 'netstat', args: ['-ano', '-p', 'TCP'], timeoutMs: 5000 });
    if (!res || !res.ok) return null;
    listeners = parseNetstatListeners(res.stdout);
  } else {
    const res = exec({ file: 'lsof', args: ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN'], timeoutMs: 5000 });
    if (res && res.ok) listeners = parseLsofListeners(res.stdout);
    if (listeners.length === 0) {
      const ss = exec({ file: 'ss', args: ['-ltnp'], timeoutMs: 5000 });
      if (ss && ss.ok) listeners = parseSsListeners(ss.stdout);
    }
  }

  const match = pickListener(listeners, Number(port), host);
  if (!match) return null;
  const info = readProcessInfo(match.pid, { exec, platform });
  return {
    pid: match.pid,
    name: (info && info.name) || match.name || null,
    commandLine: (info && info.commandLine) || null,
    address: match.address,
    port: match.port
  };
}

module.exports = {
  TRUSTED_NAMES,
  splitCommand,
  resolveExecutable,
  buildSpawnPlan,
  parseNetstatListeners,
  parseLsofListeners,
  parseSsListeners,
  matchesHost,
  pickListener,
  isPidAlive,
  decideKill,
  isPortInUse,
  waitForPortReleased,
  readProcessInfo,
  findListenerPid
};
