# dsh-electron

把 DSH Web GUI（`http://127.0.0.1:3080`）装进独立 Electron 窗口，并附带服务生命周期管理与状态监测侧边栏。

## 功能

1. **自动拉起**：打开程序时若 DSH 服务未在运行，自动执行 `dsh web --no-open` 拉起；已在运行则直接复用。
2. **自动清理**：完全退出时自动关闭**由本程序拉起的** DSH 进程（外部启动的服务不会被误杀）。
3. **状态侧边栏**：左侧独立面板，每 5 秒监测外网连通性与 DSH 服务健康状态；
   网络离线或 DSH 异常时红色警示并给出提示；支持一键刷新 DSH 视图、
   重启（仅限本程序管理的）服务。
4. **关闭选择 + 系统托盘**：每次点窗口 × 都会询问"最小化到托盘 / 关闭并退出 / 取消"；
   最小化到托盘后程序与 DSH 服务继续在后台运行，点击托盘图标恢复窗口，
   托盘菜单"退出"可完全关闭。
5. **托盘异常通知**：窗口隐藏期间（托盘驻留），若 DSH 服务或外网状态发生
   异常/恢复的翻转变化，自动弹托盘气泡通知；窗口可见时由侧边栏展示，不弹通知。

## 运行前提

- 本机已安装 Node.js（含 npm）
- `dsh` 命令可用（或在环境变量 `DSH_START_COMMAND` 中指定启动命令）

## 使用

```bash
# 1. 安装依赖（首次运行，需下载 Electron，耗时约 1~3 分钟）
npm install

# 2. 启动独立窗口（会自动拉起/复用 DSH 服务）
npm start
```

## 快捷方式

工作区根目录已生成 `dsh_electron.lnk`，双击即可启动（直接指向
`node_modules\electron\dist\electron.exe`，无控制台窗口）。
若移动了项目目录，请重建快捷方式：右键 → 新建快捷方式 →
目标填 `项目路径\node_modules\electron\dist\electron.exe`，参数填 `.`，
起始位置填项目目录。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DSH_URL` | `http://127.0.0.1:3080` | DSH 服务地址（也是健康检查地址） |
| `DSH_START_COMMAND` | `dsh web --no-open` | 服务未运行时用于拉起的命令（`--no-open` 禁止 dsh web 自动打开系统浏览器） |

## 行为说明

- **不会跳出系统浏览器**：a) 拉起服务用 `--no-open`，禁止 dsh web 自行打开浏览器；
  b) DSH 页面内的同源弹窗留在应用内导航，仅外部链接交给系统浏览器。
- **服务归属**：若 DSH 已在运行（如你自己开的终端），程序只复用、关闭时不动它；
  若由本程序拉起，完全退出时自动清理（三级兜底：kill → taskkill 进程树 → 端口定位）。
- **窗口即开即用**：窗口立即创建，服务在后台拉起，侧边栏从"启动中"自动过渡到"运行中"。
- **关闭≠退出**：点 × 弹三选（最小化到托盘/关闭并退出/取消）；最小化到托盘后
  服务继续运行，托盘图标可恢复窗口或完全退出。

## 测试

```powershell
# managed 分支：用假服务验证"拉起→清理"链路（不影响真实 DSH）
$env:DSH_URL = "http://127.0.0.1:39999"
$env:DSH_START_COMMAND = "node tests/dummy-server.js"
npm start
```

## 文件说明

| 文件 | 作用 |
|------|------|
| `main.js` | 主进程：服务生命周期管理、状态轮询、窗口/视图布局、IPC |
| `preload.js` | contextBridge 暴露状态接口给侧边栏 |
| `renderer/` | 侧边栏 UI（index.html / sidebar.css / sidebar.js） |
| `tests/dummy-server.js` | 假 DSH 服务，用于安全测试自动拉起/清理逻辑 |

## 架构示意

```
npm start
 └─ main.js
     ├─ ensureDshRunning()   → 3080 在跑? 复用 : spawn dsh web
     ├─ BrowserWindow        → renderer/index.html（侧边栏）
     │    └─ WebContentsView → 加载 http://127.0.0.1:3080（DSH 页面）
     ├─ setInterval(5s)      → 外网 ping + DSH 健康检查 → IPC 推送侧边栏
     └─ before-quit          → 仅清理本程序拉起的服务进程树
```

> 注意：若你的终端环境禁止命名管道（受限 shell），Chromium 渲染进程无法启动；
> 在普通终端中直接 `npm start` 即可，不受此影响。
