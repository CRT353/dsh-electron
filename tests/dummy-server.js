// 测试用假 DSH 服务：仅用于验证"本程序拉起/清理"生命周期，不碰真实 DSH
// 用法：DSH_URL=http://127.0.0.1:39999 DSH_START_COMMAND="node tests/dummy-server.js" npm start
const http = require('http');

const PORT = process.env.PORT || 39999;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dummy dsh service ok');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[dummy-dsh] listening on http://127.0.0.1:${PORT}`);
  });
