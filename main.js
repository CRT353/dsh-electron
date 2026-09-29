'use strict';
// ============================================================
// DSH Electron 外壳（v1.2.0 加固版）
//
// 职责：
//   1. 单实例运行；第二个实例只负责唤醒已有窗口。
//   2. DSH 服务生命周期：复用 / 拉起 / 等待就绪 / 重启 / 退出清理。
//      权威身份是"监听 DSH 端口的真实进程 pid"，不是 spawn 返回的包装进程。
//   3. 左侧侧边栏：网络 + DSH 服务 + 视图状态，异常提示，一键刷新/重启/接管。
//   4. 系统托盘 + 关闭三选 + 状态翻转通知。
//   5. 安全管控：导航白名单、外链 scheme 白名单、权限默认拒绝、
//      IPC sender 校验、CSP、日志脱敏、远端目标默认拒绝。
//   6. 右键菜单：复制/剪切/粘贴/全选、链接与地址复制、重载、DevTools、
//      服务操作与"复制状态摘要"（协议白名单同样生效）。
//
// 业务逻辑都在 lib/ 下（可单测），本文件只做 Electron 装配。
// ============================================================

const { app, BrowserWindow, WebContentsView, shell, ipcMain, Tray, Menu, dialog, nativeImage, session, clipboard } = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const { createLogger, safeUrl } = require('./lib/log');
const { createExec } = require('./lib/exec');
const { findListenerPid } = require('./lib/procs');
const { probeDsh, probeInternet, FlapGuard, detectTransitions } = require('./lib/health');
const { decideNavigation, decideOpenExternal, decidePermission, describePolicy } = require('./lib/security');
const { buildContextMenu } = require('./lib/context-menu');
const { ServiceManager } = require('./lib/service');
const { loadConfig } = require('./lib/config');

const config = loadConfig(process.env, { root: __dirname });
const logger = createLogger({
  file: config.logFile,
  maxBytes: config.logMaxBytes,
  maxMessage: config.logMaxMessage,
  redactTokens: config.redactLogTokens
});
const exec = createExec();

const SIDEBAR_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).toString();
const PLACEHOLDER_URL = pathToFileURL(path.join(__dirname, 'renderer', 'view-placeholder.html')).toString();

// ---------- 运行时状态 ----------
let win = null;
let dshView = null;
let tray = null;
let pollTimer = null;
let userWantsQuit = false;   // 托盘"退出"或关闭对话框选择"关闭并退出"
let closeAction = null;      // 本轮关闭选择：'quit' 放行
let trayNotified = false;
let cleanupDone = false;
let cleanupRunning = false;
let service = null;

const dshGuard = new FlapGuard({ failThreshold: config.dshFailThreshold, recoverThreshold: 1 });
const netGuard = new FlapGuard({ failThreshold: config.netFailThreshold, recoverThreshold: 1 });
let prevStable = { dsh: null, net: null };
const health = { dsh: null, net: null, lastDshCheck: null, lastNetCheck: null };
const viewState = { state: 'idle', error: null, attempts: 0, lastAttemptAt: 0 };
let lastTrayMenuKey = '';

// ---------- 安全策略执行 ----------
function openExternalSafely(url, origin) {
  const verdict = decideOpenExternal({ url, allowedSchemes: config.externalSchemes });
  if (verdict.action === 'open') {
    logger.info(`外部链接交给系统浏览器（${origin}）: ${safeUrl(url)}`);
    shell.openExternal(url).catch((err) => logger.warn(`打开外部链接失败: ${err.message}`));
    return true;
  }
  logger.warn(`拒绝打开外部链接（${verdict.reason}，来源 ${origin}）: ${safeUrl(url)}`);
  return false;
}

/** 对所有 webContents 统一加导航/弹窗防线（放在 web-contents-created 里最保险） */
function guardWebContents(contents, role) {
  contents.on('will-navigate', (event, url) => {
    const verdict = decideNavigation({ targetUrl: url, appUrl: config.url });
    if (verdict.action === 'allow') return;
    event.preventDefault();
    if (verdict.action === 'external') openExternalSafely(url, `${role}/will-navigate`);
    else logger.warn(`已阻止导航（${verdict.reason}，${role}）: ${safeUrl(url)}`);
  });
  contents.on('will-redirect', (event, url) => {
    const verdict = decideNavigation({ targetUrl: url, appUrl: config.url, allowExternal: false });
    if (verdict.action === 'allow') return;
    event.preventDefault();
    logger.warn(`已阻止重定向（${verdict.reason}，${role}）: ${safeUrl(url)}`);
  });
  contents.setWindowOpenHandler(({ url }) => {
    const verdict = decideNavigation({ targetUrl: url, appUrl: config.url });
    if (verdict.action === 'allow' && role === 'dsh-view') {
      contents.loadURL(url).catch((err) => logger.warn(`同源弹窗加载失败: ${err.message}`));
    } else if (verdict.action === 'external') {
      openExternalSafely(url, `${role}/window-open`);
    } else {
      logger.warn(`已阻止弹窗（${verdict.reason}，${role}）: ${safeUrl(url)}`);
    }
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn(`已阻止 webview 附加（${role}）`);
  });
}

/** 会话级权限管控：默认拒绝，只放行最小白名单 */
function hardenSession(targetSession, role) {
  if (!targetSession) return;
  targetSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = (details && details.requestingUrl) || (contents && contents.getURL && contents.getURL()) || null;
    const verdict = decidePermission({
      permission,
      requestingUrl,
      appUrl: config.url,
      allowExtra: config.allowedPermissions
    });
    if (!verdict.allow) logger.warn(`权限请求被拒绝（${role}）: ${permission} [${verdict.reason}]`);
    callback(verdict.allow);
  });
  targetSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const requestingUrl = (details && details.requestingUrl) || requestingOrigin || null;
    const verdict = decidePermission({
      permission,
      requestingUrl,
      appUrl: config.url,
      allowExtra: config.allowedPermissions
    });
    return verdict.allow;
  });
  if (typeof targetSession.setDevicePermissionHandler === 'function') {
    targetSession.setDevicePermissionHandler(() => {
      logger.warn(`设备权限被拒绝（${role}）`);
      return false;
    });
  }
}

// ---------- 状态 ----------
function buildStatus() {
  const sm = service ? service.snapshot() : { mode: 'unknown' };
  return {
    dshOnline: dshGuard.stable === true,
    dshDetail: health.dsh ? { status: health.dsh.status, identity: health.dsh.identity, reason: health.dsh.reason, latencyMs: health.dsh.latencyMs } : null,
    internetOnline: netGuard.stable === true,
    netDetail: health.net ? { status: health.net.status, reason: health.net.reason, skipped: Boolean(health.net.skipped) } : null,
    netCheckEnabled: config.netCheck,
    starting: Boolean(sm.starting),
    mode: sm.mode,
    managed: Boolean(sm.managed),
    owned: Boolean(sm.owned),
    adopted: Boolean(sm.adopted),
    servicePid: sm.listenerPid || null,
    serviceName: sm.listenerName || null,
    listenerVerified: Boolean(sm.listenerVerified),
    wrapperPid: sm.wrapperPid || null,
    observed: sm.observed || null,
    restartable: Boolean(sm.restartable),
    forceRestartable: Boolean(sm.forceRestartable),
    lastError: sm.lastError || (logger.lastErrorWithin ? logger.lastErrorWithin(10 * 60 * 1000) : null),
    lastKillSteps: sm.lastKill ? sm.lastKill.steps.join(' → ') : null,
    viewState: viewState.state,
    viewError: viewState.error,
    lastDshCheck: health.lastDshCheck,
    lastNetCheck: health.lastNetCheck,
    dshUrl: safeUrl(config.url),
    remoteTarget: config.remoteTarget,
    logFile: config.logFile,
    singleInstance: true
  };
}

function pushStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('status-update', buildStatus());
  refreshTrayMenu();
}

// ---------- 视图 ----------
function maybeLoadDshView(reason) {
  if (!dshView || dshView.webContents.isDestroyed()) return;
  const now = Date.now();
  if (reason !== 'user') {
    if (viewState.attempts >= config.viewMaxAttempts) return;
    if (now - viewState.lastAttemptAt < config.viewRetryIntervalMs) return;
  }
  viewState.attempts += 1;
  viewState.lastAttemptAt = now;
  viewState.state = 'loading';
  viewState.error = null;
  logger.info(`加载 DSH 视图（${reason}，第 ${viewState.attempts} 次）: ${safeUrl(config.url)}`);
  dshView.webContents.loadURL(config.url).catch((err) => {
    viewState.state = 'failed';
    viewState.error = err && err.message ? err.message : String(err);
    logger.warn(`DSH 视图加载失败: ${viewState.error}`);
    pushStatus();
  });
}

// ---------- 轮询 ----------
async function pollStatus() {
  const [dshResult, netResult] = await Promise.all([
    probeDsh({ url: config.url, timeoutMs: config.checkTimeoutMs, requireHtml: config.requireHtml }),
    config.netCheck
      ? probeInternet({ url: config.netCheckUrl, timeoutMs: config.checkTimeoutMs })
      : Promise.resolve({ ok: true, skipped: true, reason: 'disabled' })
  ]);

  health.dsh = dshResult;
  health.net = netResult;
  health.lastDshCheck = new Date().toISOString();
  health.lastNetCheck = new Date().toISOString();

  const dshStable = dshGuard.update(dshResult.ok);
  const netStable = netGuard.update(config.netCheck ? netResult.ok : true);

  if (service) await service.refresh({ healthy: dshStable, reachable: dshResult.reachable });

  const transitions = detectTransitions(prevStable, { dsh: dshStable, net: netStable });
  prevStable = { dsh: dshStable, net: netStable };

  const hidden = !win || win.isDestroyed() || !win.isVisible();
  if (hidden) {
    for (const t of transitions) {
      if (t.kind === 'dsh') {
        if (t.to) notifyTray('DSH 服务已恢复', `DSH 服务恢复可用（${safeUrl(config.url)}）`);
        else notifyTray('DSH 服务异常', `DSH 服务不可达（${safeUrl(config.url)}）\n可从托盘恢复窗口后处理。`);
      } else {
        if (t.to) notifyTray('网络已恢复', '外网连接已恢复。');
        else notifyTray('网络离线', '无法访问外网，DSH 的部分功能可能受限。');
      }
    }
  } else if (transitions.some((t) => t.kind === 'dsh' && !t.to)) {
    logger.warn(`DSH 服务不可达：${dshResult.reason}（identity=${dshResult.identity}）`);
  }

  // 服务恢复后自动把视图补回来（旧版本只能手动点"刷新"）
  if (dshStable && viewState.state !== 'ready') maybeLoadDshView('recover');

  pushStatus();
}

// ---------- 托盘 ----------
function trayMenuKey(sm) {
  return `${sm.restartable ? 1 : 0}${sm.forceRestartable ? 1 : 0}`;
}

function refreshTrayMenu() {
  if (!tray) return;
  const sm = service ? service.snapshot() : { restartable: false, forceRestartable: false };
  const key = trayMenuKey(sm);
  if (key === lastTrayMenuKey) return;
  lastTrayMenuKey = key;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DSH 窗口', click: () => showWindow() },
    {
      label: '重启 DSH 服务',
      enabled: Boolean(sm.restartable),
      click: () => { service.restart({ force: false }).then(pushStatus).catch((err) => logger.error('托盘重启失败', err)); }
    },
    {
      label: '接管并重启（终止外部 dsh）',
      enabled: Boolean(sm.forceRestartable),
      click: () => { service.restart({ force: true }).then(pushStatus).catch((err) => logger.error('接管重启失败', err)); }
    },
    { label: '打开日志', click: () => openLogFile() },
    { type: 'separator' },
    { label: '退出（清理本程序拉起的服务）', click: () => { userWantsQuit = true; app.quit(); } }
  ]));
}

function createTray() {
  if (tray) return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
    tray = new Tray(icon);
  } catch (err) {
    logger.error('创建托盘图标失败（继续运行，但将没有托盘）', err);
    return;
  }
  tray.setToolTip('DSH — 点击恢复窗口');
  lastTrayMenuKey = '';
  refreshTrayMenu();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (!win.isVisible()) win.show();
  win.focus();
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  if (tray && !trayNotified) {
    trayNotified = true;
    try {
      tray.displayBalloon({
        title: 'DSH 已最小化到托盘',
        content: '程序与 DSH 服务仍在后台运行。点击托盘图标恢复窗口；托盘菜单选择"退出"可完全关闭。'
      });
    } catch (_) { /* 气泡失败不影响功能 */ }
  }
}

function notifyTray(title, content) {
  if (!tray) return;
  try { tray.displayBalloon({ title, content }); } catch (_) { /* 忽略 */ }
}

async function openLogFile() {
  try {
    const err = await shell.openPath(config.logFile);
    if (err) shell.showItemInFolder(config.logFile);
    return { ok: true };
  } catch (err) {
    logger.warn(`打开日志失败: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ---------- 右键菜单 ----------
/** 人类可读的状态摘要：方便一键复制后贴给别人排查 */
function buildStatusReport() {
  const sm = service ? service.snapshot() : { mode: 'unknown' };
  const lines = [
    `DSH Electron 状态摘要（v${app.getVersion()}，Electron ${process.versions.electron}，Node ${process.versions.node}）`,
    `时间: ${new Date().toLocaleString('zh-CN')}`,
    `服务地址: ${safeUrl(config.url)}${config.remoteTarget ? '（远端目标）' : ''}`,
    `服务来源: ${sm.mode}${sm.managed ? '（本程序管理）' : ''}${sm.adopted ? '（已接管）' : ''}`,
    `监听进程: ${sm.listenerPid ? `pid ${sm.listenerPid} ${sm.listenerName || ''}${sm.listenerVerified ? '（命令行已校验）' : '（仅观察认定）'}` : (sm.observed && sm.observed.pid ? `非本程序 pid ${sm.observed.pid} ${sm.observed.name || ''}` : '未知')}`,
    `DSH 服务: ${dshGuard.stable === true ? '在线' : '不可达'}${health.dsh ? `（${health.dsh.reason}${health.dsh.identity ? `, identity=${health.dsh.identity}` : ''}${health.dsh.status ? `, HTTP ${health.dsh.status}` : ''}）` : ''}`,
    `网络: ${config.netCheck ? (netGuard.stable === true ? '在线' : '离线') : '未检测'}`,
    `视图: ${viewState.state}${viewState.error ? `（${viewState.error}）` : ''}`,
    `日志: ${config.logFile}`,
    sm.lastKill ? `上次清理: ${sm.lastKill.reason} released=${sm.lastKill.released} [${sm.lastKill.steps.join(' → ')}]` : null,
    sm.lastError ? `当前问题: ${sm.lastError}` : '当前问题: 无'
  ].filter(Boolean);
  return lines.join('\n');
}

/** 右键菜单动作：显式作用于"触发菜单的那个 webContents"，不依赖焦点 */
function runContextAction(action, target, params) {
  switch (action) {
    case 'undo': target.undo(); break;
    case 'redo': target.redo(); break;
    case 'cut': target.cut(); break;
    case 'copy': target.copy(); break;
    case 'paste': target.paste(); break;
    case 'paste-plain': target.pasteAndMatchStyle(); break;
    case 'select-all': target.selectAll(); break;
    case 'reload': target.reload(); break;
    case 'open-link':
      openExternalSafely(params.linkURL, 'context-menu');
      break;
    case 'copy-link':
      clipboard.writeText(String(params.linkURL || ''));
      logger.info('已复制链接地址（右键菜单）');
      break;
    case 'copy-page-url':
      clipboard.writeText(safeUrl(target.getURL()));
      logger.info('已复制页面地址（右键菜单）');
      break;
    case 'toggle-devtools':
      target.toggleDevTools();
      break;
    case 'reload-view':
      viewState.attempts = 0;
      maybeLoadDshView('user');
      break;
    case 'restart-service':
      service.restart({ force: false })
        .then((res) => { logger.info(`右键菜单重启：ok=${res.ok} ${res.reason || ''}`); pushStatus(); })
        .catch((err) => logger.error('右键菜单重启失败', err));
      break;
    case 'adopt-restart':
      service.restart({ force: true })
        .then((res) => { logger.warn(`右键菜单接管重启：ok=${res.ok} ${res.reason || ''}`); pushStatus(); })
        .catch((err) => logger.error('右键菜单接管重启失败', err));
      break;
    case 'open-log':
      openLogFile();
      break;
    case 'copy-status':
      clipboard.writeText(buildStatusReport());
      logger.info('已复制状态摘要（右键菜单）');
      break;
    default:
      logger.warn(`未知的右键菜单动作: ${action}`);
  }
}

function showContextMenu(target, scope, params) {
  const sm = service ? service.snapshot() : { restartable: false, forceRestartable: false };
  const items = buildContextMenu({
    params,
    options: {
      scope,
      devtools: config.devtools,
      allowedSchemes: config.externalSchemes,
      restartable: sm.restartable,
      forceRestartable: sm.forceRestartable
    }
  });

  const template = items.map((item) => {
    if (item.type === 'separator') return { type: 'separator' };
    return {
      label: item.label,
      enabled: item.enabled !== false && Boolean(item.action),
      click: item.action ? () => runContextAction(item.action, target, params) : undefined
    };
  });

  Menu.buildFromTemplate(template).popup({ window: win && !win.isDestroyed() ? win : undefined });
}

function attachContextMenu(contents, scope) {
  contents.on('context-menu', (event, params) => {
    try {
      showContextMenu(contents, scope, params || {});
    } catch (err) {
      logger.error('弹出右键菜单失败', err);
    }
  });
}

// ---------- 窗口 ----------
function layoutViews() {
  if (!win || win.isDestroyed() || !dshView) return;
  const [w, h] = win.getContentSize();
  dshView.setBounds({ x: config.sidebarWidth, y: 0, width: Math.max(0, w - config.sidebarWidth), height: h });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'DSH',
    autoHideMenuBar: true,
    backgroundColor: '#16181d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      safeDialogs: true,
      backgroundThrottling: false
    }
  });

  win.loadURL(SIDEBAR_URL).catch((err) => logger.error('侧边栏加载失败', err));
  guardWebContents(win.webContents, 'sidebar');
  attachContextMenu(win.webContents, 'sidebar');

  const viewOptions = {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false,
    safeDialogs: true
  };
  if (config.viewPartition) viewOptions.partition = config.viewPartition;
  dshView = new WebContentsView({ webPreferences: viewOptions });
  win.contentView.addChildView(dshView);
  layoutViews();

  guardWebContents(dshView.webContents, 'dsh-view');
  dshView.webContents.on('did-finish-load', () => {
    const current = dshView.webContents.getURL();
    if (current.startsWith('file:')) return; // 占位页不计入
    viewState.state = 'ready';
    viewState.error = null;
    viewState.attempts = 0;
    logger.info(`DSH 视图已加载: ${safeUrl(current)}`);
    pushStatus();
  });
  dshView.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    viewState.state = 'failed';
    viewState.error = `${errorDescription} (${errorCode})`;
    logger.warn(`DSH 视图加载失败: ${viewState.error} url=${safeUrl(validatedURL)}`);
    pushStatus();
  });
  dshView.webContents.on('render-process-gone', (event, details) => {
    viewState.state = 'failed';
    viewState.error = `视图进程异常退出: ${details && details.reason}`;
    logger.error(`DSH 视图进程异常退出: ${details && details.reason}`);
    pushStatus();
  });
  dshView.webContents.on('before-input-event', (event, input) => {
    if (!config.devtools) return;
    if (input.type === 'keyDown' && input.key === 'F12') dshView.webContents.toggleDevTools();
  });
  attachContextMenu(dshView.webContents, 'dsh-view');

  // 先显示本地占位页，服务就绪后由轮询自动切换到真实页面
  dshView.webContents.loadURL(PLACEHOLDER_URL).catch((err) => logger.warn(`占位页加载失败: ${err.message}`));

  win.on('resize', layoutViews);
  win.on('close', (event) => {
    if (userWantsQuit || closeAction === 'quit') return;
    event.preventDefault();
    if (!win || win.isDestroyed()) return;

    const sm = service ? service.snapshot() : { mode: 'unknown' };
    const ownershipLine = sm.mode === 'managed'
      ? `当前服务由本程序管理${sm.listenerPid ? `（监听进程 pid ${sm.listenerPid}）` : ''}，退出时会一并清理。`
      : (sm.mode === 'orphan'
        ? '当前服务处于"归属漂移"状态（本程序记录的 pid 已退出，端口仍被疑似 dsh 的进程服务）：退出时会先做身份校验再尝试清理。'
        : '当前服务不是本程序拉起的，退出时不会被终止。');
    const detail = [
      ownershipLine,
      '最小化到托盘：程序与 DSH 服务继续在后台运行。',
      '关闭并退出：只清理本程序拉起的 DSH 服务。'
    ].join('\n');

    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'DSH',
      message: '关闭窗口后要做什么？',
      detail,
      buttons: ['最小化到托盘', '关闭并退出', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (choice === 0) hideToTray();
    else if (choice === 1) { closeAction = 'quit'; win.close(); }
  });
  win.on('closed', () => {
    win = null;
    dshView = null;
  });
}

// ---------- IPC（带 sender 校验） ----------
function isSidebarSender(event) {
  try {
    return Boolean(win && !win.isDestroyed() && event && event.sender && event.sender.id === win.webContents.id);
  } catch (_) {
    return false;
  }
}

function registerIpc() {
  const register = (channel, handler) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isSidebarSender(event)) {
        logger.warn(`拒绝来源不明的 IPC 调用: ${channel}`);
        return { ok: false, error: 'forbidden' };
      }
      try {
        return await handler(...args);
      } catch (err) {
        logger.error(`IPC ${channel} 执行失败`, err);
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    });
  };

  register('get-status', () => buildStatus());
  register('reload-dsh', () => {
    viewState.attempts = 0;
    maybeLoadDshView('user');
    return { ok: true };
  });
  register('restart-service', async (options) => {
    const force = Boolean(options && options.force);
    logger.info(`收到重启请求（force=${force}，模式=${service.snapshot().mode}）`);
    const result = await service.restart({ force });
    if (!result.ok) logger.warn(`重启未完成：${result.message || result.reason}`);
    pushStatus();
    return result;
  });
  register('open-log', () => openLogFile());
  register('get-log-tail', () => ({ lines: logger.tail(80) }));
}

// ---------- 退出清理 ----------
function startShutdown(reason) {
  if (cleanupRunning || cleanupDone) return;
  cleanupRunning = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  logger.info(`开始退出清理（触发原因：${reason}）`);
  (async () => {
    if (!service) {
      cleanupDone = true;
      app.exit(0);
      return;
    }
    try {
      const result = await service.shutdown({ timeoutMs: config.killTimeoutMs });
      logger.info(`退出清理结果: ok=${result.ok} reason=${result.reason || '-'} released=${result.released === undefined ? '-' : result.released}`);
    } catch (err) {
      logger.error('退出清理异常', err);
    } finally {
      cleanupDone = true;
      if (tray) { try { tray.destroy(); } catch (_) { /* 忽略 */ } tray = null; }
      app.exit(0);
    }
  })();
}

// ---------- 生命周期 ----------
function bootstrap() {
  app.enableSandbox(); // 强制所有渲染进程运行在沙箱中

  if (config.fatalError) {
    logger.error(`配置校验失败：${config.fatalError}`);
    dialog.showErrorBox('DSH 配置错误', config.fatalError);
    app.exit(1);
    return;
  }

  service = new ServiceManager({
    config: {
      url: config.url,
      host: config.host,
      port: config.port,
      startCommand: config.startCommand,
      cwd: os.homedir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      readyTimeoutMs: config.readyTimeoutMs,
      killTimeoutMs: config.killTimeoutMs,
      verify: { pattern: config.killPattern, allowUnverified: config.allowUnverifiedKill }
    },
    logger,
    exec,
    probeHealth: () => probeDsh({ url: config.url, timeoutMs: config.checkTimeoutMs, requireHtml: config.requireHtml }),
    findListenerPid: (port, host) => findListenerPid(port, { host, exec })
  });

  app.whenReady().then(() => {
    if (config.viewPartition) hardenSession(session.fromPartition(config.viewPartition), 'dsh-view');
    hardenSession(session.defaultSession, 'default');

    logger.info('============================================================');
    logger.info(`DSH Electron 启动（v${app.getVersion()}，Electron ${process.versions.electron}，Node ${process.versions.node}）`);
    logger.info(`服务地址: ${safeUrl(config.url)}${config.remoteTarget ? '（远端目标，已显式放行）' : '（本机）'}`);
    logger.info(`启动命令: ${config.startCommand}`);
    logger.info(`日志文件: ${config.logFile}（上限 ${Math.round(config.logMaxBytes / 1024)}KB 自动轮转，凭据默认脱敏）`);
    logger.info(`安全策略: 导航=${describePolicy().navigation}；权限白名单=${JSON.stringify(describePolicy({ allowExtra: config.allowedPermissions }).allowedPermissions)}；外链协议=${JSON.stringify(config.externalSchemes || ['http:', 'https:'])}`);
    if (config.allowUnverifiedKill) logger.warn('DSH_ALLOW_UNVERIFIED_KILL=1：清理时将允许终止身份未通过校验的进程（风险自负）');

    registerIpc();
    createTray();
    createWindow();      // 窗口立即出现，不被服务启动阻塞
    pollStatus();
    pollTimer = setInterval(() => { pollStatus().catch((err) => logger.error('轮询异常', err)); }, config.pollIntervalMs);
    service.ensure().catch((err) => logger.error('服务启动流程异常', err));

    app.on('activate', () => {
      if (!win || win.isDestroyed()) { createWindow(); return; }
      if (!win.isVisible()) win.show();
    });
  });

  app.on('window-all-closed', () => {
    // 与平台无关：窗口全部关闭即清理本程序拉起的服务并退出（避免遗留服务）
    startShutdown('window-all-closed');
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (cleanupDone) return;
    event.preventDefault();
    startShutdown('before-quit');
  });
}

// ---------- 入口 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在运行：直接退出（已有实例会通过 second-instance 唤醒窗口）
  app.quit();
} else {
  app.on('second-instance', () => {
    logger.info('检测到第二个实例启动，聚焦已有窗口');
    showWindow();
  });
  bootstrap();
}
