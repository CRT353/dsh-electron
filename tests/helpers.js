'use strict';
/** 测试辅助：真实本地 HTTP 服务器 / 空闲端口 / 静默 logger */
const http = require('http');
const net = require('net');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler || ((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><title>DSH</title><body>ok</body></html>');
    }));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(() => r());
        })
      });
    });
  });
}

/** 借一个空闲端口：先监听 0 拿到端口号再释放 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function silentLogger() {
  const lines = [];
  const push = (level, message) => { lines.push(`${level}: ${message}`); };
  return {
    lines,
    file: null,
    info: (m) => push('INFO', m),
    warn: (m) => push('WARN', m),
    error: (m) => push('ERROR', m),
    stream: (tag, chunk) => push('STREAM', `[${tag}] ${chunk}`),
    tail: () => lines.slice(),
    recentErrors: () => lines.filter((l) => l.startsWith('ERROR')),
    lastError: () => (lines.filter((l) => l.startsWith('ERROR')).slice(-1)[0] || null)
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, freePort, silentLogger, sleep };
