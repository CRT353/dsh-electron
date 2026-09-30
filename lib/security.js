'use strict';
/**
 * 安全策略（纯函数，不依赖 Electron，可单测）
 *
 * 这是本次"安全管控"的核心：把导航、外链、权限三类决策从 main.js 里抽出来，
 * 变成默认拒绝（fail-closed）、可审计、可单测的策略函数。
 *
 * 旧版本的问题：
 *  - DSH 视图没有 will-navigate / will-redirect 限制 → 页面内跳转可以把
 *    这个"本地外壳"带去任意远端站点；
 *  - setWindowOpenHandler 只对 http(s) 之外"交给系统浏览器"，
 *    没有 scheme 白名单（file: / 自定义协议 / ms-* 等都可能被交给 shell）；
 *  - 完全没有 setPermissionRequestHandler → Electron 默认放行摄像头、麦克风、
 *    地理位置、通知等权限请求；
 *  - IPC 没有校验 sender（虽然 preload 只挂在侧边栏上，但缺少纵深防御）。
 */

const DEFAULT_EXTERNAL_SCHEMES = ['http:', 'https:'];
const DEFAULT_ALLOWED_PERMISSIONS = ['clipboard-sanitized-write'];
const DENIED_PERMISSION_HINTS = [
  'media', 'audioCapture', 'videoCapture', 'geolocation', 'notifications',
  'midi', 'midiSysex', 'hid', 'serial', 'usb', 'bluetooth', 'idle-detection',
  'display-capture', 'speaker-selection', 'window-management', 'openExternal',
  'clipboard-read', 'storage-access', 'top-level-storage-access', 'unknown'
];

function tryParse(value) {
  try {
    const url = new URL(String(value));
    return url;
  } catch (_) {
    return null;
  }
}

function parseOrigin(value) {
  const url = tryParse(value);
  return url ? url.origin.toLowerCase() : null;
}

function isSameOrigin(a, b) {
  const x = parseOrigin(a);
  const y = parseOrigin(b);
  return Boolean(x && y && x === y);
}

function isLocalHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost');
}

function schemeOf(value) {
  const url = tryParse(value);
  return url ? url.protocol.toLowerCase() : null;
}

/**
 * 导航决策（用于 will-navigate / will-redirect / setWindowOpenHandler）
 * allow = 应用内放行；external = 交给系统浏览器；deny = 直接拒绝
 */
function decideNavigation(input = {}) {
  const target = input.targetUrl;
  const appUrl = input.appUrl;
  const url = tryParse(target);
  if (!url) return { action: 'deny', reason: 'invalid-url' };

  if (appUrl && isSameOrigin(target, appUrl)) return { action: 'allow', reason: 'same-origin' };

  const scheme = url.protocol.toLowerCase();
  const allowed = (input.externalSchemes || DEFAULT_EXTERNAL_SCHEMES).map((s) => s.toLowerCase());
  if (allowed.includes(scheme)) {
    return input.allowExternal === false
      ? { action: 'deny', reason: 'external-disabled' }
      : { action: 'external', reason: 'external-scheme' };
  }
  return { action: 'deny', reason: `blocked-scheme:${scheme.replace(':', '')}` };
}

/** 交给系统浏览器（shell.openExternal）的决策：同样默认拒绝非法 scheme */
function decideOpenExternal(input = {}) {
  const url = tryParse(input.url);
  if (!url) return { action: 'deny', reason: 'invalid-url' };
  const scheme = url.protocol.toLowerCase();
  const allowed = (input.allowedSchemes || DEFAULT_EXTERNAL_SCHEMES).map((s) => s.toLowerCase());
  if (allowed.includes(scheme)) return { action: 'open', reason: 'allowed-scheme' };
  return { action: 'deny', reason: `blocked-scheme:${scheme.replace(':', '')}` };
}

/**
 * 渲染进程权限请求决策：默认拒绝，只放行最小白名单。
 *
 * 来源校验是**失败即拒绝**，并且要能应对 Electron 的两个坑：
 *  - `setPermissionCheckHandler` 对**跨源子框架**故意不提供 `requestingUrl`
 *    （见 electron.d.ts 中 PermissionCheckHandlerHandlerDetails 的注释：
 *    "This is not provided for cross origin sub frames making permission checks"），
 *    旧实现在这种情况下直接跳过同源闸门 —— 恰恰是最需要拦的场景被放行；
 *  - 来源缺失时用 `webContents.getURL()` 兜底是错的：那是**顶层** URL，会把子框架请求
 *    误判成同源（main.js 已不再这样兜底）。
 * 因此：存在 embeddingOrigin（跨源子框架）一律拒绝；没有来源证据时必须由调用方证明是主框架。
 */
function decidePermission(input = {}) {
  const permission = String(input.permission || 'unknown');
  const requestingUrl = input.requestingUrl || input.requestingOrigin || null;
  const appUrl = input.appUrl;
  const allowExtra = input.allowExtra || [];

  if (input.embeddingOrigin) {
    return { allow: false, reason: 'cross-origin-subframe' };
  }
  if (requestingUrl) {
    if (appUrl && !isSameOrigin(requestingUrl, appUrl)) return { allow: false, reason: 'cross-origin' };
  } else if (input.isMainFrame !== true) {
    return { allow: false, reason: 'no-origin-evidence' };
  }
  if (allowExtra.includes(permission)) return { allow: true, reason: 'explicit-allowlist' };
  if (DEFAULT_ALLOWED_PERMISSIONS.includes(permission)) return { allow: true, reason: 'default-allowlist' };
  return { allow: false, reason: 'deny-by-default' };
}

/** 解析 DSH_ALLOW_PERMISSIONS 环境变量 */
function parsePermissionList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 供 README / 侧边栏展示的策略摘要 */
function describePolicy(options = {}) {
  return {
    externalSchemes: options.externalSchemes || DEFAULT_EXTERNAL_SCHEMES,
    allowedPermissions: (options.allowExtra || []).concat(DEFAULT_ALLOWED_PERMISSIONS),
    deniedPermissionHints: DENIED_PERMISSION_HINTS.slice(),
    navigation: '仅同源（DSH 服务）允许在应用内导航；其余 http(s) 交给系统浏览器；其他协议一律拒绝',
    ipc: '仅接受侧边栏窗口发来的调用（校验 event.sender）'
  };
}

module.exports = {
  DEFAULT_EXTERNAL_SCHEMES,
  DEFAULT_ALLOWED_PERMISSIONS,
  DENIED_PERMISSION_HINTS,
  parseOrigin,
  isSameOrigin,
  isLocalHost,
  schemeOf,
  decideNavigation,
  decideOpenExternal,
  decidePermission,
  parsePermissionList,
  describePolicy
};
