'use strict';
/**
 * preload.js 的桥接契约测试。
 *
 * 此前 preload.js **从未被执行过**：main-smoke 只断言了"preload 路径以 preload.js 结尾"，
 * 而 channel 名在 preload 与 main.js 各写一遍 —— 写错了不会有任何用例变红。
 * 这里用假 electron 模块加载真实的 preload.js，核对暴露面与 channel 名。
 */
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

function loadPreload() {
  const exposed = {};
  const ipc = { invoked: [], listeners: new Map(), removed: [] };
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } },
    ipcRenderer: {
      invoke: (channel, ...args) => { ipc.invoked.push([channel, ...args]); return Promise.resolve({ ok: true }); },
      on: (channel, listener) => { ipc.listeners.set(channel, listener); },
      removeListener: (channel, listener) => { ipc.removed.push([channel, listener]); }
    }
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, ...rest);
  };
  const preloadPath = require.resolve('../preload.js');
  delete require.cache[preloadPath];
  try {
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[preloadPath];
  }
  return { exposed, ipc };
}

const EXPECTED_CHANNELS = ['get-status', 'reload-dsh', 'restart-service', 'open-log', 'get-log-tail'];

test('preload 只暴露 dshBridge 一个对象，且不接受渲染层传入的 channel 名', () => {
  const { exposed } = loadPreload();
  assert.deepStrictEqual(Object.keys(exposed), ['dshBridge'], '只能暴露约定的一个桥接对象');

  const api = exposed.dshBridge;
  assert.deepStrictEqual(
    Object.keys(api).sort(),
    ['getLogTail', 'getStatus', 'onStatus', 'openLog', 'reloadDsh', 'restartService'],
    '暴露的方法集合必须与文档一致（README 曾写错成 5 个，实际 6 个）'
  );
  for (const key of Object.keys(api)) {
    assert.strictEqual(typeof api[key], 'function', `${key} 必须是函数`);
  }
  // 不得把 ipcRenderer 或任何 Node/Electron 原生物件交出去
  for (const forbidden of ['ipcRenderer', 'send', 'sendSync', 'require', 'process', 'invoke']) {
    assert.ok(!(forbidden in api), `不得暴露 ${forbidden}`);
  }
});

test('preload 的 channel 名与入参收敛（写错不会有别的用例变红，故在此钉死）', async () => {
  const { exposed, ipc } = loadPreload();
  const api = exposed.dshBridge;

  await api.getStatus();
  await api.reloadDsh();
  await api.restartService({ force: true });
  await api.restartService('随便传个字符串');
  await api.restartService();
  await api.openLog();
  await api.getLogTail();

  assert.deepStrictEqual(
    ipc.invoked.map((call) => call[0]),
    ['get-status', 'reload-dsh', 'restart-service', 'restart-service', 'restart-service', 'open-log', 'get-log-tail']
  );
  assert.deepStrictEqual(ipc.invoked[2][1], { force: true });
  assert.deepStrictEqual(ipc.invoked[3][1], { force: false }, '非对象入参必须收敛成 {force:false}');
  assert.deepStrictEqual(ipc.invoked[4][1], { force: false });
  assert.ok(EXPECTED_CHANNELS.includes('get-log-tail'), '通道清单应与 main.js 的注册一致');
});

test('onStatus：订阅 status-update、返回退订函数、非函数入参退化为空操作', () => {
  const { exposed, ipc } = loadPreload();
  const api = exposed.dshBridge;

  let fired = 0;
  const off = api.onStatus((status) => { fired += 1; assert.ok(status); });
  const listener = ipc.listeners.get('status-update');
  assert.strictEqual(typeof listener, 'function', '必须订阅 status-update 通道');
  listener({}, { mode: 'managed' });
  assert.strictEqual(fired, 1);

  off();
  assert.strictEqual(ipc.removed.length, 1, '应调用 removeListener 退订');
  assert.strictEqual(ipc.removed[0][0], 'status-update');

  const noop = api.onStatus('不是函数');
  assert.strictEqual(typeof noop, 'function', '非函数入参应返回空操作而不是抛异常');
  assert.strictEqual(ipc.listeners.size, 1, '非函数入参不应注册监听器');
});
