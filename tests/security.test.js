'use strict';
/** lib/security.js 单测：导航 / 外链 / 权限三类默认拒绝策略 */
const test = require('node:test');
const assert = require('node:assert');

const {
  decideNavigation,
  decideOpenExternal,
  decidePermission,
  isSameOrigin,
  isLocalHost,
  parsePermissionList,
  parseOrigin,
  describePolicy
} = require('../lib/security');

const APP = 'http://127.0.0.1:3080';

test('isSameOrigin / isLocalHost / parseOrigin', () => {
  assert.strictEqual(isSameOrigin('http://127.0.0.1:3080/x?y=1', APP), true);
  assert.strictEqual(isSameOrigin('http://127.0.0.1:3081/', APP), false, '端口不同即不同源');
  assert.strictEqual(isSameOrigin('http://localhost:3080/', APP), false, 'localhost 与 127.0.0.1 是不同源');
  assert.strictEqual(parseOrigin('not a url'), null);
  assert.strictEqual(isLocalHost('127.0.0.1'), true);
  assert.strictEqual(isLocalHost('::1'), true);
  assert.strictEqual(isLocalHost('localhost'), true);
  assert.strictEqual(isLocalHost('example.com'), false);
});

test('decideNavigation：同源放行、外链交系统浏览器、其他协议拒绝', () => {
  assert.deepStrictEqual(
    decideNavigation({ targetUrl: `${APP}/session/1`, appUrl: APP }),
    { action: 'allow', reason: 'same-origin' }
  );
  assert.strictEqual(decideNavigation({ targetUrl: 'https://example.com/a', appUrl: APP }).action, 'external');
  assert.strictEqual(decideNavigation({ targetUrl: 'file:///C:/Windows/system.ini', appUrl: APP }).action, 'deny');
  assert.strictEqual(decideNavigation({ targetUrl: 'javascript:alert(1)', appUrl: APP }).action, 'deny');
  assert.strictEqual(decideNavigation({ targetUrl: 'data:text/html,<h1>x</h1>', appUrl: APP }).action, 'deny');
  assert.strictEqual(decideNavigation({ targetUrl: 'ms-settings:', appUrl: APP }).action, 'deny');
  assert.strictEqual(decideNavigation({ targetUrl: 'about:blank', appUrl: APP }).action, 'deny');
  assert.strictEqual(decideNavigation({ targetUrl: 'nonsense', appUrl: APP }).action, 'deny');
  assert.strictEqual(
    decideNavigation({ targetUrl: 'https://example.com', appUrl: APP, allowExternal: false }).action,
    'deny',
    '重定向场景不允许交给外部浏览器'
  );
});

test('decideOpenExternal：只放行 http/https', () => {
  assert.strictEqual(decideOpenExternal({ url: 'https://example.com' }).action, 'open');
  assert.strictEqual(decideOpenExternal({ url: 'http://example.com' }).action, 'open');
  assert.strictEqual(decideOpenExternal({ url: 'file:///C:/secret.txt' }).action, 'deny');
  assert.strictEqual(decideOpenExternal({ url: 'mailto:a@b.com' }).action, 'deny');
  assert.strictEqual(decideOpenExternal({ url: 'vbscript:msgbox(1)' }).action, 'deny');
  assert.strictEqual(decideOpenExternal({ url: 'javascript:alert(1)' }).action, 'deny');
  assert.strictEqual(decideOpenExternal({ url: '' }).action, 'deny');
  assert.strictEqual(decideOpenExternal({ url: 'https://x.com', allowedSchemes: ['http:'] }).action, 'deny');
});

test('decidePermission：默认拒绝，仅放行白名单且必须同源', () => {
  const allowClipboard = decidePermission({ permission: 'clipboard-sanitized-write', requestingUrl: APP, appUrl: APP });
  assert.strictEqual(allowClipboard.allow, true);

  for (const permission of ['media', 'geolocation', 'notifications', 'hid', 'serial', 'usb', 'display-capture', 'clipboard-read', 'openExternal']) {
    const verdict = decidePermission({ permission, requestingUrl: APP, appUrl: APP });
    assert.strictEqual(verdict.allow, false, `${permission} 应默认拒绝`);
    assert.strictEqual(verdict.reason, 'deny-by-default');
  }

  const crossOrigin = decidePermission({ permission: 'clipboard-sanitized-write', requestingUrl: 'https://evil.com', appUrl: APP });
  assert.strictEqual(crossOrigin.allow, false);
  assert.strictEqual(crossOrigin.reason, 'cross-origin');

  const explicit = decidePermission({ permission: 'media', requestingUrl: APP, appUrl: APP, allowExtra: ['media'] });
  assert.strictEqual(explicit.allow, true);
  assert.strictEqual(explicit.reason, 'explicit-allowlist');
});

test('decidePermission：来源证据缺失 / 跨源子框架一律拒绝（旧实现在这两种情况下会放行）', () => {
  // Electron 对**跨源子框架**的权限检查故意不提供 requestingUrl（见 electron.d.ts 中
  // PermissionCheckHandlerHandlerDetails 的注释），旧实现此时直接跳过同源闸门。
  const noEvidence = decidePermission({ permission: 'clipboard-sanitized-write', requestingUrl: null, appUrl: APP });
  assert.strictEqual(noEvidence.allow, false, '没有来源证据就不该放行');
  assert.strictEqual(noEvidence.reason, 'no-origin-evidence');

  // 主框架 + 无来源证据：仍按白名单放行，避免误伤本应用自己的页面
  const mainFrame = decidePermission({
    permission: 'clipboard-sanitized-write',
    requestingUrl: null,
    isMainFrame: true,
    appUrl: APP
  });
  assert.strictEqual(mainFrame.allow, true);

  // 跨源子框架：即使声称的来源是同源也要拒绝
  const subframe = decidePermission({
    permission: 'clipboard-sanitized-write',
    requestingUrl: APP,
    isMainFrame: false,
    embeddingOrigin: 'https://evil.com',
    appUrl: APP
  });
  assert.strictEqual(subframe.allow, false);
  assert.strictEqual(subframe.reason, 'cross-origin-subframe');

  // 即使用 DSH_ALLOW_PERMISSIONS 放开了 media，跨源子框架也拿不到
  const widened = decidePermission({
    permission: 'media',
    requestingUrl: APP,
    isMainFrame: false,
    embeddingOrigin: 'https://evil.com',
    appUrl: APP,
    allowExtra: ['media']
  });
  assert.strictEqual(widened.allow, false, '白名单不得绕过来源校验');
});

test('parsePermissionList / describePolicy', () => {
  assert.deepStrictEqual(parsePermissionList('media, geolocation ,'), ['media', 'geolocation']);
  assert.deepStrictEqual(parsePermissionList(''), []);
  const policy = describePolicy();
  assert.ok(policy.allowedPermissions.includes('clipboard-sanitized-write'));
  assert.ok(policy.deniedPermissionHints.includes('geolocation'));
});
