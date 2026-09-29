// ============================================================
// DSH Electron 封装（增强版）
//  1. 打开程序时自动拉起 DSH 服务（若 3080 未在运行）
//  2. 关闭窗口时自动关闭"由本程序拉起的" DSH 进程
//     （若 DSH 是外部启动的，则复用且不杀，避免误伤）
//  3. 左侧自绘侧边栏：监测外网与 DSH 服务状态，异常时提示
//  布局：宿主窗口加载 renderer/index.html（侧边栏），
//        右侧用 WebContentsView 加载 DSH 网页
// ============================================================
const { app, BrowserWindow, WebContentsView, shell, ipcMain, Tray, Menu, dialog, nativeImage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 配置 ----------
const DSH_URL = process.env.DSH_URL || 'http://127.0.0.1:3080'; // DSH 服务地址
// 拉起命令：--no-open 禁止 dsh web 自行打开默认浏览器（本程序自己就是"浏览器"）
const DSH_START_COMMAND = process.env.DSH_START_COMMAND || 'dsh web --no-open';
const SIDEBAR_WIDTH = 240;        // 侧边栏宽度（px）
const POLL_INTERVAL = 5000;       // 状态轮询间隔（ms）
const CHECK_TIMEOUT = 3000;       // 单次健康检查超时（ms）
const START_WAIT_TIMEOUT = 60000; // 等待服务就绪的最长时间（ms）

// ---------- 运行时状态 ----------
const state = {
  serviceManaged: false, // 服务是否由本程序拉起（决定关闭时是否清理）
  servicePid: null,      // 由本程序拉起的服务 PID
  serviceProc: null,     // 由本程序拉起的子进程句柄
  serviceExited: false,  // 本程序拉起的服务是否已退出（崩溃/被杀）
  starting: false,       // 正在等待服务就绪
  dshOnline: false,      // DSH 服务是否可达
  internetOnline: false, // 外网是否可达
  lastDshCheck: null,
  lastNetCheck: null,
  quitting: false,
};
let win = null;
let dshView = null;
let pollTimer = null;
let tray = null;          // 系统托盘图标
let userWantsQuit = false; // 用户已明确选择完全退出（放行 close）
let closeAction = null;   // 本轮关闭选择：'quit' 表示已确认退出（放行 close）
let trayNotified = false; // 是否已弹过"已最小化"提示气泡
let prevDshOnline = null; // 上一次轮询的 DSH 状态（用于边沿检测）
let prevNetOnline = null; // 上一次轮询的外网状态（用于边沿检测）

// ---------- 日志 ----------
function log(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, 'load-status.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch (_) { /* 忽略日志写入失败 */ }
}

// ---------- 健康检查 ----------
async function isDshReachable() {
  try {
    const res = await fetch(DSH_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT) });
    return res.status < 500; // 任意 <500 响应都算服务活着（302/404 也算）
  } catch (_) { return false; }
}

async function isInternetReachable() {
  try {
    await fetch('https://www.baidu.com', { signal: AbortSignal.timeout(CHECK_TIMEOUT) });
    return true;
  } catch (_) { return false; }
}

// ---------- DSH 服务生命周期 ----------
function waitForDshReady(timeoutMs = START_WAIT_TIMEOUT) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (done) return;
      let ok = false;
      try { ok = await isDshReachable(); } catch (_) { ok = false; }
      if (ok) return finish(true);
      if (Date.now() >= deadline) return finish(false);
      setTimeout(tick, 1000);
    };
    tick();
    // 硬超时兜底：无论如何都要结束等待，不阻塞后续流程
    setTimeout(() => finish(false), timeoutMs + 2000);
  });
}

/** 确保 DSH 服务在跑：已有则复用，否则由本程序拉起 */
async function ensureDshRunning() {
  if (await isDshReachable()) {
    log(`DSH already running at ${DSH_URL} (reuse, not managed by this app)`);
    state.serviceManaged = false;
    state.serviceExited = false;
    return;
  }

  log(`DSH not reachable, starting: ${DSH_START_COMMAND}`);
  state.starting = true;
  state.serviceExited = false;
  try {
    state.serviceProc = spawn(DSH_START_COMMAND, {
      shell: true,
      cwd: os.homedir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.serviceManaged = true;
    state.servicePid = state.serviceProc.pid;
    log(`spawned DSH service pid=${state.servicePid}`);

    state.serviceProc.stdout.on('data', (d) => log(`[dsh-svc] ${String(d).trim().slice(0, 300)}`));
    state.serviceProc.stderr.on('data', (d) => log(`[dsh-svc-err] ${String(d).trim().slice(0, 300)}`));
    state.serviceProc.on('error', (e) => log(`DSH service spawn error: ${e.message}`));
    state.serviceProc.on('exit', (code, sig) => {
      log(`DSH service exited code=${code} sig=${sig}`);
      if (state.serviceManaged) {
        // 本程序拉起的服务退出了：保持"本程序管理"语义，标记为已停止
        state.serviceExited = true;
        state.servicePid = null;
      }
      state.starting = false;
      pushStatus();
    });

    const ready = await waitForDshReady();
    state.starting = false;
    if (ready) log('DSH service ready');
    else log('WARN: DSH service did not become ready within timeout');
  } catch (e) {
    state.starting = false;
    log(`failed to start DSH service: ${e.message}`);
  }
}

/** 关闭窗口时清理：仅清理本程序拉起的服务（三级兜底，确保进程被终止） */
function killManagedService() {
  if (state.quitting) return;
  state.quitting = true;
  if (!state.serviceManaged || !state.serviceProc) return;
  const pid = state.servicePid;
  log(`killing managed DSH service pid=${pid}`);

  // 1) 直接终止 spawn 的包装进程（shell 包装）
  try { state.serviceProc.kill(); } catch (e) { log(`proc.kill: ${e.message}`); }

  // 2) 终止整棵进程树（Windows）
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      log('taskkill tree ok');
    } catch (e) {
      log(`taskkill tree failed: ${e.message}`);
    }
  }

  // 3) 端口兜底：直接终止监听 DSH 端口的进程（仅限本程序拉起的服务，绝对安全）
  try {
    const port = new URL(DSH_URL).port || (DSH_URL.startsWith('https:') ? '443' : '80');
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s+.*LISTENING\\s+(\\d+)`);
    const m = out.match(re);
    if (m) {
      const target = Number(m[1]);
      log(`port fallback: killing pid=${target} on :${port}`);
      try { process.kill(target); log('port fallback ok'); } catch (e2) { log(`port fallback failed: ${e2.message}`); }
    }
  } catch (e3) { log(`port fallback error: ${e3.message}`); }

  state.servicePid = null;
  state.serviceManaged = false;
}

/** 重启由本程序管理的服务（复用模式/外部服务不可重启） */
async function restartManagedService() {
  if (!state.serviceManaged) return { ok: false, reason: 'external' };
  if (state.servicePid) killManagedService();
  state.quitting = false;
  await ensureDshRunning();
  return { ok: true };
}

// ---------- 状态推送与 IPC ----------
function buildStatus() {
  return {
    dshOnline: state.dshOnline,
    internetOnline: state.internetOnline,
    starting: state.starting,
    serviceManaged: state.serviceManaged,
    serviceExited: state.serviceExited,
    servicePid: state.servicePid,
    lastDshCheck: state.lastDshCheck,
    lastNetCheck: state.lastNetCheck,
    dshUrl: DSH_URL,
  };
}

function pushStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('status-update', buildStatus());
}

async function pollStatus() {
  const [dsh, net] = await Promise.all([isDshReachable(), isInternetReachable()]);

  // 状态边沿检测：仅当窗口隐藏（托盘驻留）且状态发生翻转时才弹通知，
  // 窗口可见时由侧边栏展示，不弹托盘气泡
  const windowHidden = !win || win.isDestroyed() || !win.isVisible();
  if (windowHidden) {
    if (prevDshOnline !== null && prevDshOnline !== dsh) {
      if (dsh) notifyTray('DSH 服务已恢复', `DSH 服务恢复可用（${DSH_URL}）`);
      else notifyTray('DSH 服务异常', `DSH 服务不可达（${DSH_URL}）\n可通过托盘菜单恢复窗口后处理。`);
    }
    if (prevNetOnline !== null && prevNetOnline !== net) {
      if (net) notifyTray('网络已恢复', '外网连接已恢复。');
      else notifyTray('网络离线', '无法访问外网，DSH 的部分功能可能受限。');
    }
  }

  prevDshOnline = dsh;
  prevNetOnline = net;
  state.dshOnline = dsh;
  state.internetOnline = net;
  state.lastDshCheck = new Date().toISOString();
  state.lastNetCheck = new Date().toISOString();
  pushStatus();
}

// ---------- 托盘与窗口显隐 ----------
function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('DSH — 点击恢复窗口');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DSH 窗口', click: () => showWindow() },
    { type: 'separator' },
    { label: '退出（关闭 DSH）', click: () => { userWantsQuit = true; app.quit(); } },
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (!win.isVisible()) win.show();
  win.focus();
}

function hideToTray() {
  win.hide();
  if (tray && !trayNotified) {
    trayNotified = true;
    try {
      tray.displayBalloon({
        title: 'DSH 已最小化到托盘',
        content: '程序与 DSH 服务仍在后台运行。点击托盘图标恢复窗口；托盘菜单选择"退出"可完全关闭。',
      });
    } catch (_) { /* 气球提示失败不影响功能 */ }
  }
}

/** 托盘气泡通知（仅在窗口隐藏时由状态变化触发） */
function notifyTray(title, content) {
  if (!tray) return;
  try { tray.displayBalloon({ title, content }); } catch (_) { /* 通知失败不影响功能 */ }
}

// ---------- 窗口 ----------
function layoutViews() {
  if (!win || win.isDestroyed() || !dshView) return;
  const [w, h] = win.getContentSize();
  dshView.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, w - SIDEBAR_WIDTH), height: h });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'DSH',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 宿主窗口 = 侧边栏页面
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 右侧视图 = DSH 网页
  dshView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.contentView.addChildView(dshView);
  layoutViews();
  dshView.webContents.loadURL(DSH_URL);
  dshView.webContents.on('did-finish-load', () => {
    log(`DSH view loaded: ${dshView.webContents.getURL()}`);
    pushStatus();
  });
  dshView.webContents.setWindowOpenHandler(({ url }) => {
    // 同源（DSH 服务）弹窗留在应用内导航，避免跳出系统浏览器
    if (url.startsWith(DSH_URL)) {
      dshView.webContents.loadURL(url);
      return { action: 'deny' };
    }
    shell.openExternal(url); // 外链才交给系统浏览器
    return { action: 'deny' };
  });

  win.on('resize', layoutViews);
  win.on('close', (e) => {
    // 已明确退出（托盘菜单"退出"/本轮选择"关闭并退出"）→ 放行
    if (userWantsQuit || closeAction === 'quit') return;

    e.preventDefault(); // 拦截默认关闭，每次关闭都询问

    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'DSH',
      message: '关闭窗口后要做什么？',
      detail: '最小化到托盘：程序与 DSH 服务继续在后台运行。\n关闭并退出：停止由本程序拉起的 DSH 服务。',
      buttons: ['最小化到托盘', '关闭并退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) hideToTray(); // 最小化到托盘（下次点 × 仍会询问）
    else if (choice === 1) { closeAction = 'quit'; win.close(); } // 重新触发 close，本次放行
    // choice === 2（取消）：什么都不做，窗口保持打开
  });
  win.on('closed', () => {
    win = null;
    dshView = null;
  });
}

// ---------- 生命周期与 IPC ----------
ipcMain.handle('get-status', () => buildStatus());
ipcMain.handle('reload-dsh', () => {
  if (dshView && !dshView.webContents.isDestroyed()) dshView.webContents.reload();
  return { ok: true };
});
ipcMain.handle('restart-service', async () => {
  if (!state.serviceManaged) return { ok: false, reason: 'external' };
  return restartManagedService();
});

// ---------- 生命周期 ----------
app.whenReady().then(() => {
  createTray();   // 系统托盘（最小化到托盘后用于恢复/退出）
  createWindow(); // 窗口立即出现，不被服务启动阻塞
  pollTimer = setInterval(pollStatus, POLL_INTERVAL);
  pollStatus();

  // 服务在后台拉起/复用，侧边栏会从"启动中"自动过渡到"运行中"
  ensureDshRunning();

  app.on('activate', () => {
    // macOS：点击 Dock 图标恢复窗口；窗口已销毁则重建
    if (!win || win.isDestroyed()) { createWindow(); return; }
    if (!win.isVisible()) win.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    killManagedService(); // 窗口全关即清理服务（幂等）
    app.quit();
  }
});

app.on('before-quit', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (tray) { tray.destroy(); tray = null; }
  killManagedService(); // 兜底，quitting 标志保证只执行一次
});
