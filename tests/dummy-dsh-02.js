'use strict';
/**
 * 测试用"带令牌门禁的假 DSH 服务"（**完整复现 DSH 0.2 的认证机制**）。
 *
 * 为什么需要它：0.2 给本地 Web 服务加了一套**进程级令牌 + 会话 Cookie** 的认证 ——
 * 令牌随机生成、不落盘、无法由外部指定，只印在 stdout 的一行上；而且
 * **令牌是一次性的**，必须换成一个 dsh-auth Cookie 之后才能访问界面。
 *
 * 本文件逐条复现 2026-10-16 在真实 DSH 0.2 上实测到的行为：
 *
 *   1) 启动时向 stdout 打印 `dsh web: http://host:port/?token=<secret>`；
 *   2) 不带任何凭据访问 `/`              → **401**（无 Content-Type、无正文）
 *   3) 带 `?token=<secret>` 访问 `/`     → **303**，`Location: ./`，
 *      并下发 `Set-Cookie: dsh-auth-<rand>=...`（仿真实格式，含属性）
 *   4) 带 **cookie** 且**不带 query** 访问 `/` → **200 + text/html**
 *   5) 带 cookie 但**仍带着 `?token=`** 访问 → **303**（令牌一次性；
 *      实测：这正是最初修复没生效的原因）
 *   6) 令牌用错 → 401
 *
 * 用法：环境变量 PORT / HOST 指定监听地址；令牌由本进程随机生成。
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 39998);
const HOST = process.env.HOST || '127.0.0.1';

// 与真实实现同构：随机 32 字节、base64url 编码
const SECRET = crypto.randomBytes(32).toString('base64url');
// 会话 Cookie 名与真实形态一致（dsh-auth-<随机>）；值不做真实 JWT
const COOKIE_NAME = `dsh-auth-${crypto.randomBytes(24).toString('base64url')}`;
const COOKIE_VALUE = `v1.${crypto.randomBytes(32).toString('base64url')}`;

function cookieHeader() {
  return `${COOKIE_NAME}=${COOKIE_VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`;
}

function readCookie(req) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const kv = part.trim();
    if (kv.startsWith(`${COOKIE_NAME}=`)) return kv.slice(COOKIE_NAME.length + 1);
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const token = url.searchParams.get('token');
  const cookieOk = readCookie(req) === COOKIE_VALUE;

  // (2) 无任何凭据 → 401（无 Content-Type、无正文，与真实服务一致）
  if (token === null && !cookieOk) {
    res.writeHead(401);
    res.end();
    return;
  }

  if (token !== null) {
    // (6) 令牌错误 → 401
    if (token !== SECRET) {
      res.writeHead(401);
      res.end();
      return;
    }
    // (3)(5) 令牌正确 → 303 + Set-Cookie（即使已带 cookie 也照回 303，与实测一致）
    res.writeHead(303, { Location: './', 'Set-Cookie': cookieHeader() });
    res.end();
    return;
  }

  // (4) 只带正确 cookie（无 query）→ 200 + text/html
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>dummy 0.2 dsh</title><p>authenticated</p>');
});

server.on('error', (err) => {
  console.error(`[dummy-0.2] 启动失败: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 真实服务打印的正是这一行（外壳从这里取令牌）
  console.log(`dsh web: http://${HOST}:${PORT}/?token=${SECRET}`);
});

process.on('SIGTERM', () => process.exit(0));
