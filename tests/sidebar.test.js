'use strict';
/**
 * renderer/sidebar.js 的渲染层测试（此前**零执行**：没有 jsdom，也没有任何用例加载过它）。
 *
 * 做法：极简 DOM 桩 + `vm` 执行真实脚本，不引入任何依赖。
 * 覆盖点：
 *   - 六种服务归属（managed/reuse/foreign/orphan/takeover/starting/stopped/未知）到
 *     "服务来源"文案的映射（此前无人验证，写错了也没人知道）；
 *   - 异常框/操作提示的显示与隐藏；
 *   - 按钮可用性与"操作进行中"的所有权（第三档修掉的那个问题：
 *     btnAdopt 的 finally 曾无条件把按钮点亮、btnRestart 会在操作期间被轮询推送重新启用）；
 *   - 全部动态内容只走 textContent（一旦有人改成 innerHTML，这里立刻变红）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 默认跑仓库里的真实文件；DSH_SIDEBAR_PATH 只用于"验证用例本身有判别力"
// （指向旧版本时相关用例必须变红，否则说明这些断言抓不到回归）。
const SIDEBAR = process.env.DSH_SIDEBAR_PATH || path.join(__dirname, '..', 'renderer', 'sidebar.js');
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

const IDS = [
  'net-dot', 'net-text', 'dsh-dot', 'dsh-text', 'view-dot', 'view-text',
  'alert-box', 'alert-text', 'notice-box', 'notice-text',
  'meta-url', 'meta-source', 'meta-pid', 'meta-time',
  'btn-reload', 'btn-restart', 'btn-adopt', 'btn-log'
];

/**
 * 从真实 index.html 里取元素的初始文案。
 * 必须这么做：sidebar.js 的点击处理会保存 `original = 按钮.textContent` 并在完成后恢复，
 * 如果桩把初始文案设为空串，就会"恢复成空串"从而掩盖真实行为。
 */
function initialText(html, id) {
  const m = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html);
  return m ? m[1] : '';
}

/** 极简 DOM：记录 textContent/className/disabled，并**禁止** innerHTML。 */
function createDom() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const elements = new Map();
  const innerHtmlUse = [];
  for (const id of IDS) {
    const classes = new Set();
    const el = {
      id,
      textContent: initialText(html, id),
      title: '',
      disabled: false,
      className: '',
      listeners: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); }
      },
      addEventListener(type, fn) { this.listeners[type] = fn; }
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return ''; },
      set() { innerHtmlUse.push(id); }
    });
    elements.set(id, el);
  }
  return {
    elements,
    innerHtmlUse,
    document: { getElementById: (id) => elements.get(id) || null }
  };
}

function makeBridge(options = {}) {
  const state = { statusCb: null, status: options.status || null };
  return {
    state,
    getStatus: () => Promise.resolve(state.status),
    onStatus: (cb) => { state.statusCb = cb; return () => {}; },
    reloadDsh: () => Promise.resolve({ ok: true }),
    restartService: (opts) => (options.restartImpl ? options.restartImpl(opts) : Promise.resolve({ ok: true })),
    openLog: () => Promise.resolve({ ok: true }),
    getLogTail: () => Promise.resolve({ lines: [] })
  };
}

/** 载入真实 sidebar.js；返回 { dom, bridge, push }。 */
async function loadSidebar(options = {}) {
  const dom = createDom();
  const bridge = makeBridge(options);
  const sandbox = {
    document: dom.document,
    window: { dshBridge: bridge },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SIDEBAR, 'utf8'), sandbox, { filename: 'sidebar.js' });
  await new Promise((r) => setTimeout(r, 0)); // 等初始 getStatus().then(render)
  return {
    dom,
    bridge,
    push: (status) => bridge.state.statusCb(status)
  };
}

/** 一份"全部正常"的状态，便于逐项覆盖。 */
function statusFor(extra = {}) {
  return {
    dshOnline: true,
    dshDetail: { identity: 'strong' },
    internetOnline: true,
    netCheckEnabled: true,
    starting: false,
    mode: 'managed',
    managed: true,
    owned: true,
    adopted: false,
    servicePid: 4242,
    serviceName: 'node.exe',
    listenerVerified: true,
    wrapperPid: null,
    observed: null,
    restartable: true,
    forceRestartable: false,
    lastError: null,
    lastKillSteps: null,
    viewState: 'ready',
    viewError: null,
    lastDshCheck: '2026-01-01T00:00:00Z',
    lastNetCheck: null,
    dshUrl: 'http://127.0.0.1:3080/',
    remoteTarget: false,
    logFile: 'load-status.log',
    singleInstance: true,
    ...extra
  };
}

const text = (dom, id) => dom.elements.get(id).textContent;

test('服务来源文案：六种归属 + 沿用旧行为', async () => {
  const { dom, push } = await loadSidebar();

  push(statusFor());
  assert.strictEqual(text(dom, 'meta-source'), '本程序管理 pid 4242');

  push(statusFor({ adopted: true }));
  assert.match(text(dom, 'meta-source'), /本程序接管/);

  push(statusFor({ mode: 'reuse', managed: false, restartable: false, observed: { pid: 777, name: 'node.exe', dshLike: true } }));
  assert.match(text(dom, 'meta-source'), /外部服务 pid 777（未纳管）/);

  push(statusFor({ mode: 'foreign', managed: false, restartable: false, observed: { pid: 888, name: 'nginx.exe', dshLike: false } }));
  assert.match(text(dom, 'meta-source'), /端口占用者身份未确认 pid 888/);

  push(statusFor({ mode: 'orphan', managed: false, restartable: false, observed: { pid: 999, name: 'node.exe', dshLike: true } }));
  assert.match(text(dom, 'meta-source'), /孤儿进程（疑似 dsh pid 999）/);

  push(statusFor({ mode: 'takeover', managed: false, restartable: false, observed: { pid: 1000, name: 'nginx.exe', dshLike: false } }));
  assert.match(text(dom, 'meta-source'), /已被其他进程接管 pid 1000/);

  push(statusFor({ mode: 'starting', starting: true, restartable: false }));
  assert.strictEqual(text(dom, 'meta-source'), '启动中…');

  push(statusFor({ mode: 'stopped', managed: false, restartable: true }));
  assert.strictEqual(text(dom, 'meta-source'), '已停止');

  push(statusFor({ mode: 'something-new', managed: false, restartable: false }));
  assert.strictEqual(text(dom, 'meta-source'), '未知', '未识别的模式必须优雅降级，不能崩');

  assert.deepStrictEqual(dom.innerHtmlUse, [], '所有动态内容必须走 textContent');
});

test('异常框：有问题时显示并如实列出原因，正常时隐藏', async () => {
  const { dom, push } = await loadSidebar();

  push(statusFor());
  assert.ok(dom.elements.get('alert-box').classList.contains('hidden'), '一切正常时隐藏异常框');

  push(statusFor({ dshOnline: false, dshDetail: { identity: 'none', reason: 'unreachable' }, mode: 'stopped', managed: false }));
  assert.ok(!dom.elements.get('alert-box').classList.contains('hidden'), '服务不可达必须显示异常框');
  assert.match(text(dom, 'alert-text'), /DSH 服务不可达/);

  push(statusFor({ mode: 'orphan', managed: false, lastError: '归属漂移：本程序记录的 pid 4242 已退出' }));
  assert.match(text(dom, 'alert-text'), /归属漂移/);
  assert.match(text(dom, 'alert-text'), /最近错误：/);

  push(statusFor({ remoteTarget: true }));
  assert.match(text(dom, 'alert-text'), /指向远端地址/);
});

test('按钮可用性由状态推导', async () => {
  const { dom, push } = await loadSidebar();
  const restart = dom.elements.get('btn-restart');
  const adopt = dom.elements.get('btn-adopt');

  push(statusFor({ restartable: true, forceRestartable: false }));
  assert.strictEqual(restart.disabled, false);
  assert.strictEqual(adopt.disabled, true, '外部服务不适用时应灰显接管按钮');

  push(statusFor({ mode: 'reuse', managed: false, restartable: false, forceRestartable: true }));
  assert.strictEqual(restart.disabled, true);
  assert.strictEqual(adopt.disabled, false, '外部 dsh 占用端口时应提供接管入口');
  assert.match(adopt.title, /终止当前监听端口的外部 dsh 进程/);
});

test('重启期间的状态推送不得把按钮重新启用（第三档修掉的所有权问题）', async () => {
  let resolveRestart;
  const { dom, push } = await loadSidebar({
    restartImpl: () => new Promise((resolve) => { resolveRestart = resolve; })
  });
  const restart = dom.elements.get('btn-restart');

  push(statusFor({ restartable: true }));
  assert.strictEqual(restart.disabled, false);

  const click = restart.listeners.click();
  assert.strictEqual(restart.disabled, true, '点击后立即进入"重启中"');
  assert.strictEqual(restart.textContent, '重启中…');

  // 关键断言：此时后台推来一份"看起来可以重启"的状态（清理阶段 mode 仍是 managed），
  // 旧实现会把按钮重新点亮，用户可以重复提交并收到假的失败提示。
  push(statusFor({ restartable: true }));
  assert.strictEqual(restart.disabled, true, '操作进行中不得被状态推送重新启用');

  resolveRestart({ ok: false, reason: 'port-busy', message: '端口 3080 仍被占用' });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(restart.textContent, '重启服务', '完成后应恢复文案');
  assert.match(text(dom, 'notice-text'), /端口 3080 仍被占用/, '失败原因应显示给用户');

  push(statusFor({ restartable: true }));
  assert.strictEqual(restart.disabled, false, '操作结束后由状态决定可用性');
});

test('接管完成后按钮必须保持灰显（旧实现的 finally 会把它重新点亮）', async () => {
  const { dom, push } = await loadSidebar({
    restartImpl: () => Promise.resolve({ ok: true })
  });
  const adopt = dom.elements.get('btn-adopt');

  push(statusFor({ mode: 'reuse', managed: false, restartable: false, forceRestartable: true }));
  assert.strictEqual(adopt.disabled, false);

  const done = adopt.listeners.click();
  await done;
  await new Promise((r) => setTimeout(r, 0));

  assert.strictEqual(adopt.textContent, '接管并重启', '文案要恢复');
  assert.strictEqual(adopt.disabled, true, '刚推送的状态说"无需接管"，finally 不得把它点亮');

  push(statusFor({ mode: 'managed', restartable: true, forceRestartable: false }));
  assert.strictEqual(adopt.disabled, true);
});

test('刷新视图与打开日志的点击接线', async () => {
  const calls = { reload: 0, log: 0 };
  const dom = createDom();
  const bridge = makeBridge();
  bridge.reloadDsh = () => { calls.reload += 1; return Promise.resolve({ ok: true }); };
  bridge.openLog = () => { calls.log += 1; return Promise.resolve({ ok: true }); };
  const sandbox = {
    document: dom.document,
    window: { dshBridge: bridge },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SIDEBAR, 'utf8'), sandbox, { filename: 'sidebar.js' });
  await new Promise((r) => setTimeout(r, 0));

  dom.elements.get('btn-reload').listeners.click();
  assert.strictEqual(calls.reload, 1);
  assert.match(text(dom, 'notice-text'), /已请求刷新 DSH 视图/);

  await dom.elements.get('btn-log').listeners.click();
  assert.strictEqual(calls.log, 1);

  bridge.openLog = () => Promise.resolve({ ok: false, error: '文件不存在' });
  await dom.elements.get('btn-log').listeners.click();
  assert.match(text(dom, 'notice-text'), /打开日志失败：文件不存在/, '失败必须明确提示');
});
