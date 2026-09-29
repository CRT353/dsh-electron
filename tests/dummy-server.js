'use strict';
/**
 * 测试用假 DSH 服务：仅用于验证"本程序拉起/清理"生命周期，不碰真实 DSH。
 * 用法：
 *   1) 手动测试：$env:DSH_URL="http://127.0.0.1:39999"; $env:DSH_START_COMMAND="node tests/dummy-server.js"; npm start
 *   2) 自动化：tests/service.test.js 与 tools/selftest.js 会用随机端口拉起它
 */
const http = require('http');

const PORT = Number(process.env.PORT || 39999);
const HOST = process.env.HOST || '127.0.0.1';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('dummy dsh service ok');
});

server.on('error', (err) => {
  console.error(`[dummy-dsh] 启动失败: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[dummy-dsh] listening on http://${HOST}:${PORT} pid=${process.pid}`);
});

// 收到 SIGTERM 时立刻退出（模拟被外部终止），保证端口快速释放
process.on('SIGTERM', () => process.exit(0));
