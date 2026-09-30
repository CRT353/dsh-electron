'use strict';
/**
 * 日志模块（不依赖 Electron，可单测）
 *
 * 修掉的旧问题：
 *  - 旧实现 `String(d).trim().slice(0, 300)` 把错误根因和堆栈截断，导致
 *    "plugin tree failed to load" 这类故障无法定位 → 现在保留完整堆栈，
 *    只在超过 maxMessage 时做头尾保留并显式标注截断长度。
 *  - 日志里可能带 token / 查询串 → 统一脱敏后再落盘。
 *  - 日志无限增长 → 超过 maxBytes 自动轮转为 <file>.1。
 *  - 新增内存环形缓冲，供侧边栏显示"最近错误"，无需打开文件。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // 单文件上限（轮转阈值）
const DEFAULT_MAX_MESSAGE = 8 * 1024;      // 单条消息上限（足够放完整堆栈）
const DEFAULT_RING = 200;                  // 内存环形缓冲条数

// 脱敏规则：查询串凭据、Bearer、URL userinfo、超长 token
const SECRET_QUERY_RE = /([?&](?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|apikey|key|secret|password|passwd|pwd|auth|authorization|code|session|sig|signature)=)[^&\s"'<>]+/gi;
const BEARER_RE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_\-+/=]{40,}\b/g;

/** 对任意文本做脱敏（幂等、无副作用） */
function redact(input, options = {}) {
  let text = typeof input === 'string' ? input : String(input);
  text = text.replace(USERINFO_RE, '$1<redacted>@');
  text = text.replace(SECRET_QUERY_RE, '$1<redacted>');
  text = text.replace(BEARER_RE, '$1<redacted>');
  if (options.tokens !== false) text = text.replace(LONG_TOKEN_RE, '<redacted>');
  return text;
}

/** URL 脱敏：去掉凭据、查询串与 hash，只保留 scheme://host:port/path */
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return redact(String(value));
  }
}

/** 单条消息限长：保留头部与尾部（堆栈通常在头部与中间，尾部常是关键行） */
function clampMessage(text, maxMessage) {
  const str = String(text);
  if (str.length <= maxMessage) return str;
  const head = Math.floor(maxMessage * 0.7);
  const tail = maxMessage - head;
  return `${str.slice(0, head)}\n…[已截断 ${str.length - maxMessage} 字符，完整堆栈见运行时 stderr]…\n${str.slice(-tail)}`;
}

function createLogger(options = {}) {
  const file = options.file === undefined ? null : options.file;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const maxMessage = options.maxMessage || DEFAULT_MAX_MESSAGE;
  const redactTokens = options.redactTokens !== false;
  const ringSize = options.ringSize || DEFAULT_RING;
  const now = options.now || (() => new Date());
  const streamLimit = options.streamLimit || 2000;

  const ring = [];
  let wroteRotateHint = false;
  let writeFailureReported = false;

  function rotateIfNeeded() {
    if (!file) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size < maxBytes) return;
      const backup = `${file}.1`;
      try { fs.rmSync(backup, { force: true }); } catch (_) { /* 忽略 */ }
      fs.renameSync(file, backup);
    } catch (_) { /* 文件不存在等情况忽略 */ }
  }

  function write(level, message) {
    const ts = now().toISOString();
    const text = clampMessage(redact(message, { tokens: redactTokens }), maxMessage);
    ring.push({ ts, level, text });
    while (ring.length > ringSize) ring.shift();
    if (!file) return text;
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, `${ts} [${level}] ${text}\n`);
    } catch (err) {
      // 落盘失败不能完全静默：旧实现只写注释"日志失败不影响功能"，于是打包版
      // （默认路径落在不可写的 app.asar 内）表现为"界面一切正常、磁盘上没有任何日志"，
      // 排查时无从下手。这里把**首次**失败塞进环形缓冲，侧边栏的"最近错误"就能看到它。
      if (!writeFailureReported) {
        writeFailureReported = true;
        const why = err && err.code ? err.code : (err && err.message) || 'error';
        ring.push({
          ts,
          level: 'ERROR',
          text: `日志写入失败（${why}）：${file}\n程序继续运行，但本次运行的日志不会落盘；可用 DSH_LOG_FILE 指定一个可写路径。`
        });
        while (ring.length > ringSize) ring.shift();
      }
    }
    return text;
  }

  function error(message, cause) {
    let text = String(message);
    if (cause) {
      text += `\n${cause.stack || cause.message || String(cause)}`;
      // 递归展开 cause 链（旧版本把这一层丢掉了，正是根因所在）
      let depth = 0;
      let cur = cause.cause;
      while (cur && depth < 5) {
        text += `\ncaused by: ${cur.stack || cur.message || String(cur)}`;
        cur = cur.cause;
        depth += 1;
      }
    }
    return write('ERROR', text);
  }

  return {
    file,
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error,
    /** 子进程输出：单块限长，但不再丢根因（错误块会完整保留到 maxMessage） */
    stream: (tag, chunk) => {
      const text = String(chunk);
      const body = text.length > streamLimit ? `${text.slice(0, streamLimit)}…[+${text.length - streamLimit}]` : text;
      const level = /error|throw|failed|exception/i.test(body) ? 'ERROR' : 'INFO';
      return write(level, `[${tag}] ${body.replace(/\s+$/, '')}`);
    },
    tail: (n = 50) => ring.slice(-n).map((e) => `${e.ts} [${e.level}] ${e.text}`),
    recentErrors: (n = 3) => ring.filter((e) => e.level === 'ERROR').slice(-n).map((e) => e.text),
    lastError: () => {
      const found = ring.filter((e) => e.level === 'ERROR');
      return found.length ? found[found.length - 1].text.split('\n')[0] : null;
    },
    /** 只在时间窗内查找最近错误：避免历史错误让界面永久挂着红条 */
    lastErrorWithin: (windowMs) => {
      const cutoff = now().getTime() - windowMs;
      for (let i = ring.length - 1; i >= 0; i -= 1) {
        const entry = ring[i];
        if (entry.level !== 'ERROR') continue;
        const at = Date.parse(entry.ts);
        if (Number.isFinite(at) && at >= cutoff) return entry.text.split('\n')[0];
        return null;
      }
      return null;
    },
    rotateIfNeeded,
    _ring: ring
  };
}

module.exports = { createLogger, redact, safeUrl, clampMessage, DEFAULT_MAX_BYTES, DEFAULT_MAX_MESSAGE };
