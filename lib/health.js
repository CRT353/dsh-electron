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

  const baseHeaders = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' };

  /** 取出响应下发的 dsh-auth 会话 Cookie（只取键值对，丢弃属性） */
  function authCookieOf(res) {
    let list = [];
    if (res.headers && typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie() || [];
    if (list.length === 0 && res.headers && typeof res.headers.get === 'function') {
      const one = res.headers.get('set-cookie');
      if (one) list = [one];
    }
    const pairs = list
      .map((c) => String(c).split(';')[0].trim())
      .filter((kv) => /^dsh-auth-/i.test(kv));
    return pairs.length > 0 ? pairs.join('; ') : null;
  }

  /** 同源判断：跟随重定向只允许留在同一 origin，绝不把探测引向任意主机 */
  function sameOrigin(target, base) {
    try { return new URL(target, base).origin === new URL(base).origin; } catch (_) { return false; }
  }

  /**
   * 去掉 query 后的同源地址。
   * 令牌是**一次性**的：带 `?token=` 时服务会一直回 303；换成 Cookie 后必须访问
   * **不带 query** 的地址才会拿到 200（2026-10-16 实测 —— 带着 token 重试仍得 303）。
   */
  function stripQuery(target) {
    try {
      const u = new URL(target);
      u.search = '';
      return u.toString();
    } catch (_) {
      return target;
    }
  }

  const requestOnce = (target, extraHeaders) => fetchImpl(target, {
    // redirect: 'manual' —— 默认绝不跟随。两条理由（v1.3.1 审计结论，仍然成立）：
    //  1) 身份校验必须只看**我们请求的那个地址**的响应；跟随之后拿到的是重定向终点的
    //     status/content-type，于是任何"3xx → HTML 登录页"的陌生服务都会被判成身份强确认；
    //  2) 跟随重定向会把探测请求发往 Location 指向的**任意主机**，与"本地外壳"的定位冲突。
    //
    // ⚠️ DSH 0.2 起多了**一种合法的同源跳转**（2026-10-16 实测）：
    //    带 `?token=` 访问 `/` 先回 303 并下发 `dsh-auth-*` 会话 Cookie，再跳回 `/`；
    //    而 `?token=` 是一次性的，之后必须靠该 Cookie 访问。
    //    所以这里只多做一件事：**仅当 3xx 的 Location 同源、且下发的是 dsh-auth Cookie 时**，
    //    用该 Cookie 重试一次原地址。跨源一律不跟随 —— fail-closed 不变。
    //
    //    这也正是"视图能加载、健康检查却永远不就绪"的原因：Electron 的 webContents 自带
    //    Cookie 罐，而裸 fetch 没有。
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { ...baseHeaders, ...(extraHeaders || {}) }
  });

  try {
    let res = await requestOnce(url);
    const firstStatus = res.status;

    if (firstStatus >= 300 && firstStatus < 400) {
      const cookie = authCookieOf(res);
      const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
      if (cookie && loc && sameOrigin(loc, url)) {
        if (res.body && typeof res.body.cancel === 'function') {
          try { await res.body.cancel(); } catch (_) { /* 忽略 */ }
        }
        // 关键：重试要访问**去掉 query** 的同源地址。带着 `?token=` 重试仍会得到 303
        // （令牌一次性，服务会继续要求换 Cookie）。
        res = await requestOnce(stripQuery(url), { cookie });
      }
    }
    const contentType = res.headers && res.headers.get ? res.headers.get('content-type') : null;
    const isHtml = /text\/html/i.test(String(contentType || ''));
    const status = res.status;
    const isRedirect = status >= 300 && status < 400;
    const statusOk = status < 500 && !isRedirect;
    const ok = statusOk && (!requireHtml || isHtml);
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch (_) { /* 忽略 */ }
    }
    const identity = statusOk && isHtml ? 'strong' : 'weak';
    return {
      ok,
      // 3xx 说明服务器**确实回了话**：reachable 必须为 true（服务生命周期判断依赖它，
      // 否则 lib/service.js 会以为端口没人而再拉起一个实例），但身份未经确认。
      reachable: true,
      status,
      contentType: contentType || null,
      identity,
      redirect: isRedirect,
      reason: ok ? 'ok' : (isRedirect ? `http-${status}-redirect` : (statusOk ? 'content-type-not-html' : `http-${status}`)),
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
    const res = await fetchImpl(url, {
      redirect: 'manual', // 门户/代理的重定向不算"网络在线"
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: '*/*' }
    });
    if (res.body && typeof res.body.cancel === 'function') {
      try { await res.body.cancel(); } catch (_) { /* 忽略 */ }
    }
    // 旧实现只要拿到响应就报 ok=true：强制门户（返回 200 HTML 登录页）、代理错误页、
    // 404/500 都会被判成"网络在线"，于是"网络离线"的托盘通知永远不会触发。
    const status = res.status;
    const online = status < 400 && !(status >= 300);
    return {
      ok: online,
      status,
      skipped: false,
      reason: online ? 'ok' : `http-${status}`,
      latencyMs: Date.now() - started
    };
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
