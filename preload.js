'use strict';
/**
 * 预加载脚本：以最小面积暴露主进程能力给侧边栏页面。
 * - 只暴露固定 channel 的调用，不接受渲染进程传入的 channel 名；
 * - 不暴露任何 Node/Electron 原生对象；
 * - 主进程侧还会用 event.sender 再次校验来源（纵深防御）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshBridge', {
  /** 一次性获取当前状态 */
  getStatus: () => ipcRenderer.invoke('get-status'),
  /** 订阅状态推送，返回取消订阅函数 */
  onStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status-update', listener);
    return () => ipcRenderer.removeListener('status-update', listener);
  },
  /** 刷新右侧 DSH 视图 */
  reloadDsh: () => ipcRenderer.invoke('reload-dsh'),
  /** 重启本程序管理的 DSH 服务；force=true 表示"接管外部 dsh 后重启" */
  restartService: (options) => ipcRenderer.invoke('restart-service', { force: Boolean(options && options.force) }),
  /** 打开日志文件 */
  openLog: () => ipcRenderer.invoke('open-log'),
  /** 读取日志尾部（用于界面展示最近错误） */
  getLogTail: () => ipcRenderer.invoke('get-log-tail')
});
