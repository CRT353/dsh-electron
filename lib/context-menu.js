'use strict';
/**
 * 右键上下文菜单模板（纯函数，不依赖 Electron，可单测）
 *
 * 设计：
 *  - 菜单全部在主进程构建，页面拿不到任何控制权；
 *  - 编辑类条目依据 webContents 的 editFlags 决定显示与可用状态；
 *  - "打开链接"同样过 decideOpenExternal 的协议白名单：非 http/https 只显示
 *    一条不可点的说明，交给 shell.openExternal 的永远只有白名单协议；
 *  - 动作以字符串 key 返回，由 main.js 映射到具体 webContents 方法
 *    （显式作用于触发菜单的那个 webContents，不依赖焦点，避免 role 的歧义）。
 */

const { decideOpenExternal } = require('./security');

function flag(editFlags, name) {
  // 拿不到 editFlags 时按"可用"处理，避免出现整片灰菜单
  return editFlags && editFlags[name] !== undefined ? Boolean(editFlags[name]) : true;
}

/** 去掉首尾及重复的分隔线 */
function tidySeparators(items) {
  const out = [];
  for (const item of items) {
    if (item.type === 'separator') {
      if (out.length === 0 || out[out.length - 1].type === 'separator') continue;
      out.push(item);
      continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

function buildContextMenu(input = {}) {
  const params = input.params || {};
  const options = input.options || {};
  const scope = options.scope || 'dsh-view';
  const flags = params.editFlags || {};
  const items = [];

  // ---------- 编辑类 ----------
  const edit = [];
  // 撤销/重做只在"确实可撤销"时出现（避免菜单噪音）；
  // 其余项在拿不到 editFlags 时按可用展示，避免整片灰菜单
  if (flags.canUndo === true) edit.push({ key: 'undo', label: '撤销', action: 'undo' });
  if (flags.canRedo === true) edit.push({ key: 'redo', label: '重做', action: 'redo' });

  const hasSelection = Boolean(params.selectionText && String(params.selectionText).length > 0);
  const editable = Boolean(params.isEditable);
  if (hasSelection || editable) {
    edit.push({ key: 'cut', label: '剪切', action: 'cut', enabled: flag(flags, 'canCut') && !params.isReadOnly });
    edit.push({ key: 'copy', label: '复制', action: 'copy', enabled: flag(flags, 'canCopy') });
  }
  if (editable) {
    edit.push({ key: 'paste', label: '粘贴', action: 'paste', enabled: flag(flags, 'canPaste') });
    edit.push({ key: 'paste-plain', label: '粘贴为纯文本', action: 'paste-plain', enabled: flag(flags, 'canPaste') });
  }
  edit.push({ key: 'select-all', label: '全选', action: 'select-all', enabled: flag(flags, 'canSelectAll') });

  if (edit.length) {
    items.push(...edit);
    items.push({ type: 'separator' });
  }

  // ---------- 链接 ----------
  if (params.linkURL) {
    const verdict = decideOpenExternal({ url: params.linkURL, allowedSchemes: options.allowedSchemes });
    if (verdict.action === 'open') {
      items.push({ key: 'open-link', label: '在系统浏览器中打开链接', action: 'open-link' });
    } else {
      items.push({
        key: 'open-link-blocked',
        label: `已阻止打开该链接（${verdict.reason}）`,
        action: null,
        enabled: false
      });
    }
    items.push({ key: 'copy-link', label: '复制链接地址', action: 'copy-link' });
  }

  // ---------- 视图 / 应用 ----------
  if (scope === 'dsh-view') {
    items.push({ key: 'copy-page-url', label: '复制页面地址', action: 'copy-page-url' });
    items.push({ key: 'reload', label: '重新加载页面', action: 'reload' });
    if (options.devtools !== false) {
      items.push({ key: 'toggle-devtools', label: '开发者工具（F12）', action: 'toggle-devtools' });
    }
    items.push({ type: 'separator' });
    items.push({ key: 'reload-view', label: '刷新 DSH 视图', action: 'reload-view' });
    items.push({
      key: 'restart-service',
      label: '重启 DSH 服务',
      action: 'restart-service',
      enabled: Boolean(options.restartable)
    });
    if (options.forceRestartable) {
      items.push({ key: 'adopt-restart', label: '接管并重启（终止外部 dsh）', action: 'adopt-restart' });
    }
  } else {
    items.push({ key: 'reload-sidebar', label: '重新加载侧边栏', action: 'reload' });
  }

  items.push({ type: 'separator' });
  items.push({ key: 'copy-status', label: '复制状态摘要', action: 'copy-status' });
  items.push({ key: 'open-log', label: '打开日志', action: 'open-log' });

  return tidySeparators(items);
}

module.exports = { buildContextMenu, tidySeparators };
