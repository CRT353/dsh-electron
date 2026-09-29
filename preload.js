// 预加载脚本：把主进程的状态/IPC 能力以安全接口暴露给侧边栏页面
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshBridge', {
  /** 一次性获取当前状态 */
  getStatus: () => ipcRenderer.invoke('get-status'),
  /** 订阅状态推送，返回取消订阅函数 */
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status-update', listener);
    return () => ipcRenderer.removeListener('status-update', listener);
  },
  /** 刷新右侧 DSH 视图 */
  reloadDsh: () => ipcRenderer.invoke('reload-dsh'),
  /** 重启由本程序管理的 DSH 服务 */
  restartService: () => ipcRenderer.invoke('restart-service'),
});
