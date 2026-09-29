'use strict';
/** lib/context-menu.js 单测：右键菜单条目与安全约束 */
const test = require('node:test');
const assert = require('node:assert');

const { buildContextMenu, tidySeparators } = require('../lib/context-menu');

const APP = 'http://127.0.0.1:3080';

function keys(items) {
  return items.filter((i) => i.type !== 'separator').map((i) => i.key);
}

function find(items, key) {
  return items.find((i) => i.key === key);
}

test('tidySeparators 去掉首尾与重复分隔线', () => {
  const items = tidySeparators([
    { type: 'separator' },
    { key: 'a' },
    { type: 'separator' },
    { type: 'separator' },
    { key: 'b' },
    { type: 'separator' }
  ]);
  assert.deepStrictEqual(items, [{ key: 'a' }, { type: 'separator' }, { key: 'b' }]);
});

test('有选区时提供剪切/复制，未编辑状态不提供粘贴', () => {
  const items = buildContextMenu({
    params: { selectionText: 'hello', isEditable: false, editFlags: { canCopy: true, canCut: true, canSelectAll: true } },
    options: { scope: 'dsh-view', restartable: true }
  });
  assert.ok(find(items, 'copy'), '应提供复制');
  assert.ok(find(items, 'cut'), '应提供剪切');
  assert.strictEqual(find(items, 'paste'), undefined, '不可编辑时不应出现粘贴');
  assert.ok(find(items, 'select-all'));
});

test('可编辑输入框提供粘贴与粘贴为纯文本，并按 editFlags 控制可用性', () => {
  const items = buildContextMenu({
    params: { isEditable: true, selectionText: '', editFlags: { canCopy: false, canPaste: false, canSelectAll: true } },
    options: { scope: 'dsh-view' }
  });
  assert.strictEqual(find(items, 'paste').enabled, false, 'canPaste=false 时应显示但禁用');
  assert.strictEqual(find(items, 'paste-plain').enabled, false);
  assert.strictEqual(find(items, 'copy').enabled, false, 'canCopy=false 时应禁用（而不是隐藏，符合系统习惯）');
  assert.ok(find(items, 'select-all'));
});

test('只读输入框不提供剪切', () => {
  const items = buildContextMenu({
    params: { isEditable: true, isReadOnly: true, selectionText: 'x', editFlags: { canCut: true, canCopy: true } },
    options: { scope: 'dsh-view' }
  });
  assert.strictEqual(find(items, 'cut').enabled, false, '只读区域剪切必须禁用');
  assert.strictEqual(find(items, 'copy').enabled, true);
});

test('链接菜单：http(s) 可打开，危险协议只显示被阻止的说明', () => {
  const ok = buildContextMenu({ params: { linkURL: 'https://example.com/a' }, options: { scope: 'dsh-view' } });
  assert.strictEqual(find(ok, 'open-link').action, 'open-link');
  assert.strictEqual(find(ok, 'copy-link').action, 'copy-link');

  for (const url of ['file:///C:/Windows/system.ini', 'javascript:alert(1)', 'ms-settings:', 'data:text/html,x']) {
    const items = buildContextMenu({ params: { linkURL: url }, options: { scope: 'dsh-view' } });
    assert.strictEqual(find(items, 'open-link'), undefined, `${url} 不得出现在可打开条目里`);
    const blocked = find(items, 'open-link-blocked');
    assert.ok(blocked, `${url} 应给出被阻止的说明`);
    assert.strictEqual(blocked.enabled, false);
    assert.strictEqual(blocked.action, null, '被阻止的条目不得携带任何动作');
    assert.ok(find(items, 'copy-link'), '仍允许复制链接文本');
  }
});

test('DSH 视图菜单包含应用级操作，且重启项按状态启用', () => {
  const items = buildContextMenu({ params: {}, options: { scope: 'dsh-view', restartable: false, forceRestartable: true, devtools: true } });
  const list = keys(items);
  for (const key of ['copy-page-url', 'reload', 'toggle-devtools', 'reload-view', 'restart-service', 'adopt-restart', 'copy-status', 'open-log']) {
    assert.ok(list.includes(key), `缺少条目 ${key}`);
  }
  assert.strictEqual(find(items, 'restart-service').enabled, false, '不可重启时应禁用而不是隐藏');
  assert.strictEqual(find(items, 'adopt-restart').action, 'adopt-restart');
  assert.strictEqual(items[0].type === 'separator', false, '不应以分隔线开头');
  assert.notStrictEqual(items[items.length - 1].type, 'separator', '不应以分隔线结尾');
});

test('接管项仅在允许时出现；关闭 devtools 后不出现该条目', () => {
  const items = buildContextMenu({ params: {}, options: { scope: 'dsh-view', forceRestartable: false, devtools: false } });
  const list = keys(items);
  assert.ok(!list.includes('adopt-restart'));
  assert.ok(!list.includes('toggle-devtools'));
  assert.ok(list.includes('copy-status'), '复制状态摘要始终可用');
});

test('侧边栏菜单不提供视图专属条目', () => {
  const items = buildContextMenu({ params: { selectionText: 'log line' }, options: { scope: 'sidebar' } });
  const list = keys(items);
  assert.deepStrictEqual(list.sort(), ['cut', 'copy', 'select-all', 'reload-sidebar', 'copy-status', 'open-log'].sort());
});

test('editFlags 缺失时按可用处理（避免整片灰菜单）；撤销/重做则不显示', () => {
  const items = buildContextMenu({ params: { selectionText: 'abc' }, options: { scope: 'dsh-view' } });
  assert.strictEqual(find(items, 'copy').enabled, true, '未给出 canCopy 时按可用处理');
  assert.strictEqual(find(items, 'undo'), undefined, '未确认可撤销时不显示撤销');
  assert.strictEqual(find(items, 'redo'), undefined);

  const withUndo = buildContextMenu({
    params: { isEditable: true, editFlags: { canUndo: true, canRedo: false, canPaste: true } },
    options: { scope: 'dsh-view' }
  });
  assert.ok(find(withUndo, 'undo'), 'canUndo=true 时应提供撤销');
  assert.strictEqual(find(withUndo, 'redo'), undefined, 'canRedo=false 时不显示重做');
});

test('允许协议可通过 options.allowedSchemes 覆盖（与主进程配置一致）', () => {
  const items = buildContextMenu({
    params: { linkURL: 'mailto:a@b.com' },
    options: { scope: 'dsh-view', allowedSchemes: ['mailto:'] }
  });
  assert.strictEqual(find(items, 'open-link').action, 'open-link');

  const stillBlocked = buildContextMenu({
    params: { linkURL: 'mailto:a@b.com' },
    options: { scope: 'dsh-view', allowedSchemes: ['http:', 'https:'] }
  });
  assert.ok(find(stillBlocked, 'open-link-blocked'));
});
