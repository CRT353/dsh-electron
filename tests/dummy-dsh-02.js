'use strict';
/**
 * 测试用"带令牌门禁的假 DSH 服务"（模拟 DSH 0.2 起的真实行为）。
 *
 * 为什么需要它：0.2 给本地 Web 服务加了**进程级令牌** —— 密钥随机生成、
 * 不落盘、无法由外部指定，只印在 stdout 的一行上。外壳必须从这行里取到令牌，
 * 否则健康检查拿到 401、永远判"未就绪"。
 *
 * 本文件复现三件关键事实，供 tests/service.test.js 做端到端验证：
 *   1) 启动时向 stdout 打印 `dsh web: http://host:port/?token=<secret>`；
 *   2) 不带 `?token=<secret>` 访问 `/` 一律 **401**（且无 Content-Type、无正文）；
 *   3) 带正确令牌访问 `/` 返回 **200 + text/html**（即外壳的"身份确认"）。
 *
 * 用法：环境变量 PORT / HOST 指定监听地址；令牌由本进程随机生成。
 */
const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 39998);
const HOST = process.env.HOST || '127.0.0.1';

// 与真实实现同构：随机 32 字节、base64url 编码
const SECRET = crypto.randomBytes(32).toString('base64url');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const token = url.searchParams.get('token');

  if (token !== SECRET) {
    // 复现真实行为：401、无 Content-Type、无正文
    res.writeHead(401);
    res.end();
    return;
  }

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
