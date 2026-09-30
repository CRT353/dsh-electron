'use strict';
/** lib/config.js 单测：默认值、远端目标 fail-closed、数值收敛 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { loadConfig } = require('../lib/config');

test('默认配置：本机 3080 + dsh web --no-open，无致命错误', () => {
  const config = loadConfig({}, { root: 'C:\\app' });
  assert.strictEqual(config.url, 'http://127.0.0.1:3080');
  assert.strictEqual(config.port, 3080);
  assert.strictEqual(config.host, '127.0.0.1');
  assert.strictEqual(config.startCommand, 'dsh web --no-open');
  assert.strictEqual(config.fatalError, null);
  assert.strictEqual(config.remoteTarget, false);
  assert.strictEqual(config.netCheck, true);
  assert.strictEqual(config.requireHtml, true);
  assert.strictEqual(config.allowUnverifiedKill, false);
  assert.deepStrictEqual(config.externalSchemes, ['http:', 'https:']);
  assert.ok(config.logFile.endsWith('load-status.log'));
});

test('打包态（app.asar 内）默认日志路径换到可写目录，而不是写不进去的 asar', () => {
  const root = 'C:\\Program Files\\DSH Desktop\\resources\\app.asar';
  const userDataDir = 'C:\\Users\\x\\AppData\\Roaming\\DSH Desktop';

  const packaged = loadConfig({}, { root, userDataDir });
  assert.strictEqual(packaged.logFile, path.join(userDataDir, 'load-status.log'));
  assert.ok(!/app\.asar/i.test(packaged.logFile), '绝不能把日志写进 asar 归档（实测必抛 ENOENT）');

  // 没有 userDataDir 时也要退到可写目录，而不是退回 asar
  const fallback = loadConfig({}, { root });
  assert.ok(!/app\.asar/i.test(fallback.logFile));
  assert.ok(fallback.logFile.endsWith('load-status.log'));

  // 开发态（项目目录）保持原行为：仍写项目目录
  const dev = loadConfig({}, { root: 'D:\\proj\\dsh_electron' });
  assert.strictEqual(dev.logFile, path.join('D:\\proj\\dsh_electron', 'load-status.log'));

  // 显式指定永远优先
  const explicit = loadConfig({ DSH_LOG_FILE: 'D:\\logs\\x.log' }, { root, userDataDir });
  assert.strictEqual(explicit.logFile, 'D:\\logs\\x.log');
});

test('端口从 DSH_URL 派生，且支持 https 默认端口', () => {
  const config = loadConfig({ DSH_URL: 'http://127.0.0.1:39999/' });
  assert.strictEqual(config.port, 39999);
  const https = loadConfig({ DSH_URL: 'https://127.0.0.1/' });
  assert.strictEqual(https.port, 443);
});

test('远端目标默认拒绝启动（fail-closed），显式放行后可用', () => {
  const blocked = loadConfig({ DSH_URL: 'http://example.com:3080' });
  assert.match(blocked.fatalError, /非本机地址/);
  assert.strictEqual(blocked.remoteTarget, true);

  const allowed = loadConfig({ DSH_URL: 'http://example.com:3080', DSH_ALLOW_REMOTE: '1' });
  assert.strictEqual(allowed.fatalError, null);
  assert.strictEqual(allowed.remoteTarget, true);
  assert.strictEqual(allowed.allowRemote, true);
});

test('非法 URL 与非 http 协议被拒绝', () => {
  assert.match(loadConfig({ DSH_URL: 'not a url' }).fatalError, /不是合法 URL/);
  assert.match(loadConfig({ DSH_URL: 'file:///C:/x' }).fatalError, /只支持 http\/https/);
});

test('数值项做范围收敛，避免轮询风暴', () => {
  const config = loadConfig({
    DSH_POLL_INTERVAL: '10',
    DSH_CHECK_TIMEOUT: '1',
    DSH_READY_TIMEOUT: '999999999',
    DSH_KILL_TIMEOUT: '0',
    DSH_FAIL_THRESHOLD: '999'
  });
  assert.strictEqual(config.pollIntervalMs, 1000);
  assert.strictEqual(config.checkTimeoutMs, 500);
  assert.strictEqual(config.readyTimeoutMs, 600000);
  assert.strictEqual(config.killTimeoutMs, 1000);
  assert.strictEqual(config.dshFailThreshold, 10);
});

test('布尔与列表类环境变量解析', () => {
  const config = loadConfig({
    DSH_NET_CHECK: '0',
    DSH_HEALTH_REQUIRE_HTML: '0',
    DSH_ALLOW_UNVERIFIED_KILL: '1',
    DSH_DEVTOOLS: '0',
    DSH_ALLOW_PERMISSIONS: 'media,geolocation',
    DSH_EXTERNAL_SCHEMES: 'http,mailto',
    DSH_KILL_PATTERN: 'dsh-web'
  });
  assert.strictEqual(config.netCheck, false);
  assert.strictEqual(config.requireHtml, false);
  assert.strictEqual(config.allowUnverifiedKill, true);
  assert.strictEqual(config.devtools, false);
  assert.deepStrictEqual(config.allowedPermissions, ['media', 'geolocation']);
  assert.deepStrictEqual(config.externalSchemes, ['http:', 'mailto:']);
  assert.ok(config.killPattern.test('node dsh-web --port'));
  assert.strictEqual(config.killPattern.test('node other'), false);
});

test('非法 DSH_KILL_PATTERN 回退到默认 dsh 规则', () => {
  const config = loadConfig({ DSH_KILL_PATTERN: '([unclosed' });
  assert.ok(config.killPattern.test('node .../dsh web --no-open'));
});

test('视图会话默认独立隔离，可用环境变量退回默认会话', () => {
  assert.strictEqual(loadConfig({}).viewPartition, 'persist:dsh-view', '默认应与其它 Electron 应用隔离');
  assert.strictEqual(loadConfig({ DSH_VIEW_PARTITION: 'default' }).viewPartition, '');
  assert.strictEqual(loadConfig({ DSH_VIEW_PARTITION: 'off' }).viewPartition, '');
  assert.strictEqual(loadConfig({ DSH_VIEW_PARTITION: 'none' }).viewPartition, '');
  assert.strictEqual(loadConfig({ DSH_VIEW_PARTITION: '  ' }).viewPartition, '');
  assert.strictEqual(loadConfig({ DSH_VIEW_PARTITION: 'persist:custom' }).viewPartition, 'persist:custom');
});
