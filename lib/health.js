'use strict';
/**
 * 健康检查与状态判定（不依赖 Electron，可单测）
 *
 * 修掉的旧问题：
 *  - 旧实现"任意 <500 响应都算 DSH 活着"，3080 上任何一个 404/错误页都会被当成
 *    服务健康 → 现在区分 reachable（有 HTTP 响应）与 ok（身份确认：状态 <500
 *    且返回 text/html），并在 UI 上把"弱身份"标出来。
 *  - 旧实现一次探测失败立刻翻红（外网抖动就报警）→ 现在用 FlapGuard
 *    做阈值消抖：连续 2 次失败才判离线，1 次成功即恢复。
 */

/** 探测 DSH 服务：返回 reachable（有响应）与 ok（身份确认）两个维度 */
async function probeDsh(options = {}) {
  const url = options.url;
  const timeoutMs = options.timeoutMs || 3000;
  const requireHtml = options.requireHtml !== false;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();

  if (!url) return { ok: false, reachable: false, status: null, contentType: null, identity: 'none', reason: 'no-url', latencyMs: 0 };

  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    });
    const contentType = res.headers && res.headers.get ? res.headers.get('content-type') : null;
    const isHtml = /text\/html/i.test(String(contentType || ''));
    const statusOk = res.status < 500;
    const ok = statusOk && (!requireHtml || isHtml);
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch (_) { /* 忽略 */ }
    }
    const identity = statusOk && isHtml ? 'strong' : 'weak';
    return {
      ok,
      reachable: true,
      status: res.status,
      contentType: contentType || null,
      identity,
      reason: ok ? 'ok' : (statusOk ? 'content-type-not-html' : `http-${res.status}`),
      latencyMs: Date.now() - started
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      status: null,
      contentType: null,
      identity: 'none',
      reason: (err && err.name === 'TimeoutError') ? 'timeout' : `unreachable:${err && err.message ? err.message : err}`,
      latencyMs: Date.now() - started
    };
  }
}

/** 探测外网（可关闭、可自定义目标） */
async function probeInternet(options = {}) {
  if (options.enabled === false) return { ok: true, skipped: true, reason: 'disabled', latencyMs: 0 };
  const url = options.url || 'https://www.baidu.com';
  const timeoutMs = options.timeoutMs || 3000;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch (_) { /* 忽略 */ }
    }
    return { ok: true, status: res.status, skipped: false, reason: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      status: null,
      skipped: false,
      reason: (err && err.name === 'TimeoutError') ? 'timeout' : `unreachable:${err && err.message ? err.message : err}`,
      latencyMs: Date.now() - started
    };
  }
}

/** 阈值消抖：避免单次网络抖动就翻状态 */
class FlapGuard {
  constructor(options = {}) {
    this.failThreshold = options.failThreshold === undefined ? 2 : options.failThreshold;
    this.recoverThreshold = options.recoverThreshold === undefined ? 1 : options.recoverThreshold;
    this.stable = options.initial === undefined ? null : options.initial;
    this.failCount = 0;
    this.okCount = 0;
  }

  update(ok) {
    const value = Boolean(ok);
    if (this.stable === null) {
      this.stable = value;
      this.okCount = value ? 1 : 0;
      this.failCount = value ? 0 : 1;
      return this.stable;
    }
    if (value) {
      this.okCount += 1;
      this.failCount = 0;
      if (this.stable === false && this.okCount >= this.recoverThreshold) this.stable = true;
    } else {
      this.failCount += 1;
      this.okCount = 0;
      if (this.stable === true && this.failCount >= this.failThreshold) this.stable = false;
    }
    return this.stable;
  }

  reset() {
    this.stable = null;
    this.failCount = 0;
    this.okCount = 0;
  }
}

/** 检测状态翻转，用于托盘气泡（窗口隐藏时才通知） */
function detectTransitions(prev, next) {
  const out = [];
  const keys = ['dsh', 'net'];
  for (const key of keys) {
    const before = prev ? prev[key] : null;
    const after = next ? next[key] : null;
    if (before === null || before === undefined || after === null || after === undefined) continue;
    if (before !== after) out.push({ kind: key, from: before, to: after });
  }
  return out;
}

module.exports = { probeDsh, probeInternet, FlapGuard, detectTransitions };
