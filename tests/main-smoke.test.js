'use strict';
/**
 * main.js 装配层的烟雾测试（用最小假 Electron 模块驱动）
 *
 * 说明与边界：真实 GUI 无法在无头环境启动，这里用 stub 替换 `electron`，
 * 目的是验证 main.js 的**接线是否正确**：
 *   - 顶层层级不会崩（配置加载、ServiceManager 构造、托盘/窗口/IPC 注册）
 *   - IPC 通道是否全部注册、是否校验 sender
 *   - 权限处理器是否真的默认拒绝、只放行白名单
 *   - 导航/外链策略是否真的接到了 shell.openExternal / preventDefault
 *   - 退出流程是否清理并调用 app.exit
 * 它**不能**替代真实的窗口渲染验证，真实 GUI 仍需人工双击运行。
 *
 * 安全性：全程把 DSH_URL 指向测试自建的本地服务、DSH_START_COMMAND 换成无害命令，
 * 并断言"没有真的拉起任何服务"，绝不触碰真实 DSH。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { startServer } = require('./helpers');

function createElectronStub() {
  const calls = {
    sandbox: 0,
    ipc: new Map(),
    windows: [],
    views: [],
    trays: [],
    externalUrls: [],
    openedPaths: [],
    errorBoxes: [],
    messages: [],
    appEvents: new Map(),
    exits: [],
    permissionHandlers: [],
    permissionCheckHandlers: [],
    devicePermissionHandlers: [],
    toggledDevTools: 0,
    menus: [],
    popups: 0,
    clipboardWrites: []
  };
  let idCounter = 100;

  class FakeWebContents {
    constructor(label) {
      this.label = label;
      this.id = (idCounter += 1);
      this.handlers = new Map();
      this.url = '';
      this.windowOpenHandler = null;
      this.destroyed = false;
      this.sent = [];
    }

    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(handler);
      return this;
    }

    once(event, handler) { return this.on(event, handler); }

    emit(event, ...args) {
      for (const handler of this.handlers.get(event) || []) handler(...args);
    }

    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    loadFile(file) { this.url = `file://${file}`; return Promise.resolve(); }
    reload() { this.url = this.url; }
    getURL() { return this.url; }
    isDestroyed() { return this.destroyed; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
    toggleDevTools() { calls.toggledDevTools += 1; }
  }

  class FakeSession {
    constructor(label) { this.label = label; }
    setPermissionRequestHandler(handler) { calls.permissionHandlers.push({ label: this.label, handler }); }
    setPermissionCheckHandler(handler) { calls.permissionCheckHandlers.push({ label: this.label, handler }); }
    setDevicePermissionHandler(handler) { calls.devicePermissionHandlers.push({ label: this.label, handler }); }
  }

  const defaultSession = new FakeSession('default');

  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents('sidebar');
      this.handlers = new Map();
      this.visible = true;
      this.destroyed = false;
      this.contentView = { addChildView: (view) => calls.views.push(view) };
      calls.windows.push(this);
    }

    loadURL(url) { this.webContents.loadURL(url); return Promise.resolve(); }
    on(event, handler) {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event).push(handler);
      return this;
    }
    emit(event, ...args) { for (const handler of this.handlers.get(event) || []) handler(...args); }
    getContentSize() { return [1440, 900]; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    close() { this.emit('close', { preventDefault() {} }); }
  }

  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.webContents = new FakeWebContents('dsh-view');
      this.bounds = null;
      calls.views.push(this);
    }
    setBounds(bounds) { this.bounds = bounds; }
  }

  class Tray {
    constructor(icon) { this.icon = icon; this.menu = null; this.balloons = []; calls.trays.push(this); }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
    on() {}
    displayBalloon(options) { this.balloons.push(options); }
    destroy() {}
  }

  const app = {
    enableSandbox: () => { calls.sandbox += 1; },
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getVersion: () => '1.1.0-test',
    on: (event, handler) => {
      if (!calls.appEvents.has(event)) calls.appEvents.set(event, []);
      calls.appEvents.get(event).push(handler);
    },
    emit: (event, ...args) => {
      for (const handler of calls.appEvents.get(event) || []) handler(...args);
    },
    quit: () => { calls.quit = true; },
    exit: (code) => { calls.exits.push(code); }
  };

  return {
    calls,
    module: {
      app,
      BrowserWindow,
      WebContentsView,
      Tray,
      Menu: {
        buildFromTemplate: (template) => {
          calls.menus.push(template);
          return { popup: () => { calls.popups += 1; } };
        }
      },
      clipboard: { writeText: (text) => { calls.clipboardWrites.push(text); } },
      ipcMain: { handle: (channel, handler) => calls.ipc.set(channel, handler) },
      dialog: {
        showErrorBox: (title, content) => calls.errorBoxes.push({ title, content }),
        showMessageBoxSync: () => { calls.messages.push(true); return 0; }
      },
      shell: {
        openExternal: (url) => { calls.externalUrls.push(url); return Promise.resolve(); },
        openPath: (p) => { calls.openedPaths.push(p); return Promise.resolve(''); },
        showItemInFolder: () => {}
      },
      nativeImage: { createFromPath: () => ({}) },
      session: {
        defaultSession,
        fromPartition: (name) => new FakeSession(name)
      }
    }
  };
}

test('main.js 装配层：启动、IPC 校验、权限/导航策略、退出清理', async () => {
  const server = await startServer(); // 扮演"已在运行的 DSH"（text/html）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-main-smoke-'));
  const logFile = path.join(tmp, 'smoke.log');

  const envBackup = { ...process.env };
  process.env.DSH_URL = server.url;
  process.env.DSH_START_COMMAND = 'node -e "process.exit(0)"';
  process.env.DSH_LOG_FILE = logFile;
  process.env.DSH_POLL_INTERVAL = '60000';
  process.env.DSH_NET_CHECK = '0';

  const stub = createElectronStub();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return stub.module;
    return originalLoad.call(this, request, ...rest);
  };

  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];

  try {
    require(mainPath);            // 顶层：单实例锁 + bootstrap()
    await new Promise((r) => setTimeout(r, 300)); // 等 whenReady().then(...) 跑完

    // ---- 沙箱与窗口 ----
    assert.strictEqual(stub.calls.sandbox, 1, '应调用 app.enableSandbox()');
    assert.strictEqual(stub.calls.windows.length, 1, '应创建一个宿主窗口');
    const win = stub.calls.windows[0];
    assert.strictEqual(win.options.webPreferences.sandbox, true);
    assert.strictEqual(win.options.webPreferences.contextIsolation, true);
    assert.strictEqual(win.options.webPreferences.nodeIntegration, false);
    assert.strictEqual(win.options.webPreferences.webviewTag, false);
    assert.strictEqual(win.options.webPreferences.allowRunningInsecureContent, false);
    assert.ok(win.options.webPreferences.preload.endsWith('preload.js'));
    assert.strictEqual(stub.calls.views.length >= 1, true, '应挂载 DSH 视图');
    // 侧边栏走默认会话；DSH 视图走独立会话分区（cookie/localStorage/缓存与其它 Electron 应用隔离）
    assert.strictEqual(win.options.webPreferences.partition, undefined, '侧边栏使用默认会话');
    assert.strictEqual(
      stub.calls.views.find((v) => v.webContents && v.webContents.label === 'dsh-view').options.webPreferences.partition,
      'persist:dsh-view',
      'DSH 视图默认使用独立会话分区'
    );
    assert.strictEqual(stub.calls.trays.length, 1, '应创建托盘');

    // ---- IPC：通道齐全 + sender 校验 ----
    const channels = [...stub.calls.ipc.keys()].sort();
    assert.deepStrictEqual(channels, ['get-log-tail', 'get-status', 'open-log', 'reload-dsh', 'restart-service']);

    const foreignSender = { sender: { id: 999999 } };
    const forbidden = await stub.calls.ipc.get('get-status')(foreignSender);
    assert.deepStrictEqual(forbidden, { ok: false, error: 'forbidden' }, '来源不明的 IPC 必须被拒绝');

    const status = await stub.calls.ipc.get('get-status')({ sender: { id: win.webContents.id } });
    assert.strictEqual(status.singleInstance, true);
    assert.strictEqual(status.netCheckEnabled, false);
    assert.ok(status.logFile === logFile);
    assert.ok(status.dshUrl.startsWith('http://127.0.0.1:'), '日志/状态里的地址应脱敏后展示');

    // ---- 权限策略接线：默认拒绝，仅放行剪贴板写入 ----
    assert.ok(stub.calls.permissionHandlers.length >= 1, '应注册权限处理器');
    const permLabel = stub.calls.permissionHandlers[0].label;
    const requestVerdict = (permission, origin) => new Promise((resolve) => {
      stub.calls.permissionHandlers
        .find((entry) => entry.label === permLabel)
        .handler({ getURL: () => origin }, permission, resolve, { requestingUrl: origin });
    });
    assert.strictEqual(await requestVerdict('media', server.url), false, '摄像头/麦克风必须默认拒绝');
    assert.strictEqual(await requestVerdict('geolocation', server.url), false);
    assert.strictEqual(await requestVerdict('clipboard-sanitized-write', server.url), true, '复制按钮需要的最小权限应放行');
    assert.strictEqual(await requestVerdict('clipboard-sanitized-write', 'https://evil.example.com'), false, '跨源一律拒绝');

    const checkHandler = stub.calls.permissionCheckHandlers[0].handler;
    assert.strictEqual(checkHandler({}, 'media', server.url, { requestingUrl: server.url }), false);
    assert.strictEqual(checkHandler({}, 'clipboard-sanitized-write', server.url, { requestingUrl: server.url }), true);
    assert.strictEqual(stub.calls.devicePermissionHandlers[0].handler(), false, 'HID/串口/USB 一律拒绝');

    // ---- 导航与外链策略接线 ----
    const view = stub.calls.views.find((v) => v.webContents && v.webContents.label === 'dsh-view');
    assert.ok(view, '应存在 DSH 视图');
    // 视图地址：启动时先加载本地占位页，服务确认可用后应切换到 DSH 地址
    assert.strictEqual(new URL(view.webContents.url).origin, new URL(server.url).origin,
      `视图应加载 DSH 地址，实际 ${JSON.stringify(view.webContents.url)}`);

    const navHandler = view.webContents.handlers.get('will-navigate')[0];
    let prevented = false;
    navHandler({ preventDefault: () => { prevented = true; } }, `${server.url}/session/1`);
    assert.strictEqual(prevented, false, '同源导航应放行');
    prevented = false;
    navHandler({ preventDefault: () => { prevented = true; } }, 'https://example.com/docs');
    assert.strictEqual(prevented, true, '外部链接应被拦住并转交系统浏览器');
    assert.ok(stub.calls.externalUrls.includes('https://example.com/docs'));
    prevented = false;
    navHandler({ preventDefault: () => { prevented = true; } }, 'file:///C:/Windows/system.ini');
    assert.strictEqual(prevented, true, 'file: 协议必须阻止');
    assert.ok(!stub.calls.externalUrls.includes('file:///C:/Windows/system.ini'), 'file: 不得交给 shell.openExternal');

    const openVerdict = view.webContents.windowOpenHandler({ url: 'javascript:alert(1)' });
    assert.deepStrictEqual(openVerdict, { action: 'deny' });
    const sameOriginOpen = view.webContents.windowOpenHandler({ url: `${server.url}/x` });
    assert.deepStrictEqual(sameOriginOpen, { action: 'deny' }, '弹窗一律 deny，同源改为应用内导航');

    // ---- 右键菜单：编辑动作、状态摘要复制、危险链接仍被拦 ----
    view.webContents.emit('context-menu', {}, { selectionText: '选中的文本', editFlags: { canCopy: true, canCut: true, canSelectAll: true } });
    assert.strictEqual(stub.calls.popups, 1, '右键应弹出菜单');
    const viewMenu = stub.calls.menus[stub.calls.menus.length - 1];
    const labels = viewMenu.map((item) => item.label).filter(Boolean);
    for (const expected of ['剪切', '复制', '全选', '复制页面地址', '重新加载页面', '刷新 DSH 视图', '复制状态摘要', '打开日志']) {
      assert.ok(labels.includes(expected), `视图右键菜单缺少「${expected}」：${labels.join('/')}`);
    }
    // 点击"复制"应作用于该 webContents（显式调用，不依赖焦点）
    let copied = 0;
    view.webContents.copy = () => { copied += 1; };
    viewMenu.find((item) => item.label === '复制').click();
    assert.strictEqual(copied, 1, '「复制」应调用触发菜单的那个 webContents.copy()');
    // "复制状态摘要"写入剪贴板
    viewMenu.find((item) => item.label === '复制状态摘要').click();
    const summary = stub.calls.clipboardWrites[stub.calls.clipboardWrites.length - 1];
    assert.match(summary, /DSH Electron 状态摘要/);
    assert.match(summary, /服务来源: reuse/);
    assert.match(summary, new RegExp(server.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    view.webContents.emit('context-menu', {}, { linkURL: 'file:///C:/Windows/system.ini', editFlags: {} });
    const blockedMenu = stub.calls.menus[stub.calls.menus.length - 1];
    const blockedLabels = blockedMenu.map((item) => item.label).filter(Boolean);
    assert.ok(blockedLabels.some((l) => l.includes('已阻止打开该链接')), '危险协议应给出被阻止说明');
    assert.ok(!blockedLabels.includes('在系统浏览器中打开链接'), '危险协议不得出现可打开条目');
    assert.strictEqual(
      blockedMenu.find((item) => (item.label || '').includes('已阻止')).enabled,
      false,
      '被阻止的条目必须不可点'
    );

    // 侧边栏右键菜单不应出现视图专属条目
    win.webContents.emit('context-menu', {}, { selectionText: '日志', editFlags: { canCopy: true } });
    const sidebarLabels = stub.calls.menus[stub.calls.menus.length - 1].map((item) => item.label).filter(Boolean);
    assert.ok(sidebarLabels.includes('复制'));
    assert.ok(!sidebarLabels.includes('刷新 DSH 视图'));
    assert.ok(!sidebarLabels.includes('开发者工具（F12）'));

    // F12 开关 DevTools
    view.webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'F12' });
    assert.strictEqual(stub.calls.toggledDevTools, 1);

    // ---- 视图状态机：did-finish-load 后进入 ready ----
    view.webContents.emit('did-finish-load');
    const afterLoad = await stub.calls.ipc.get('get-status')({ sender: { id: win.webContents.id } });
    assert.strictEqual(afterLoad.viewState, 'ready');

    // ---- 服务归属：外部服务 → reuse，且绝不拉起新进程 ----
    const finalStatus = await stub.calls.ipc.get('get-status')({ sender: { id: win.webContents.id } });
    assert.strictEqual(finalStatus.mode, 'reuse', `外部服务应判定为 reuse，实际 ${finalStatus.mode}`);
    assert.strictEqual(finalStatus.managed, false);
    assert.strictEqual(finalStatus.restartable, false);

    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    assert.ok(logText.includes('DSH Electron 启动'), '启动日志应写入指定文件');
    assert.ok(!/开始拉起/.test(logText), '外部服务在场时不得真的拉起服务');
    assert.match(logText, /安全策略/, '应记录生效的安全策略，便于审计');

    // ---- 退出流程：清理 + app.exit ----
    stub.calls.appEvents.get('before-quit')[0]({ preventDefault: () => {} });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(stub.calls.exits.length >= 1, '退出时应收尾并调用 app.exit');
    assert.ok(!/killing managed|开始清理服务/.test(fs.readFileSync(logFile, 'utf8')), '复用外部服务时不得执行清理');

    delete require.cache[mainPath];
  } finally {
    // 无论断言是否失败都要走一遍退出流程，否则轮询定时器会让进程无法退出
    try {
      const beforeQuit = stub.calls.appEvents.get('before-quit');
      if (beforeQuit && beforeQuit.length) beforeQuit[0]({ preventDefault: () => {} });
      await new Promise((r) => setTimeout(r, 300));
    } catch (_) { /* 忽略 */ }
    Module._load = originalLoad;
    for (const key of Object.keys(process.env)) if (!(key in envBackup)) delete process.env[key];
    for (const [key, value] of Object.entries(envBackup)) process.env[key] = value;
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main.js 配置守卫：远端 DSH_URL 默认拒绝启动', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-main-guard-'));
  const envBackup = { ...process.env };
  process.env.DSH_URL = 'http://example.com:3080';
  process.env.DSH_LOG_FILE = path.join(tmp, 'guard.log');

  const stub = createElectronStub();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return stub.module;
    return originalLoad.call(this, request, ...rest);
  };
  const mainPath = require.resolve('../main.js');
  delete require.cache[mainPath];

  try {
    require(mainPath);
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(stub.calls.windows.length, 0, '配置致命错误时不应创建窗口');
    assert.strictEqual(stub.calls.errorBoxes.length, 1, '应弹出配置错误提示');
    assert.match(stub.calls.errorBoxes[0].content, /非本机地址/);
    assert.deepStrictEqual(stub.calls.exits, [1], '应以退出码 1 结束');
    delete require.cache[mainPath];
  } finally {
    Module._load = originalLoad;
    for (const key of Object.keys(process.env)) if (!(key in envBackup)) delete process.env[key];
    for (const [key, value] of Object.entries(envBackup)) process.env[key] = value;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
