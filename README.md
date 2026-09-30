# dsh-electron

把 DSH Web GUI（默认 `http://127.0.0.1:3080`）装进独立 Electron 窗口，并附带
**服务生命周期管理、归属校验、状态监测侧边栏与安全加固**。

当前版本 **v1.3.0**（v1.1.0 = 生命周期与安全加固版；v1.0.0 原始实现见快照 `d09f279`，标签 `v1.0.0-snapshot`）。

**v1.3.0 变化**

- **DSH 视图默认使用独立会话分区**（`persist:dsh-view`）：Cookie / localStorage / 缓存与其它 Electron 应用隔离；
  要回到旧行为（复用 Electron 默认会话）设 `DSH_VIEW_PARTITION=default`。
- **"接管并重启"按钮改为常驻显示**（灰显 + 悬停原因），不再只在需要时才出现（避免找不到）。
- **新增安全停止工具** `npm stop`（`tools/stop-dsh.js`）：只终止"经身份校验确认是 DSH"的进程，
  用于替代 `dsh_off.ps1` 里"杀掉所有 node.exe"的做法（见第十节末）。
- **旧脚本退役归档**：`dsh_on.ps1` / `dsh_off.ps1` 及其快捷方式已移入
  `02-projects\retired\dsh_legacy_v0.0.0\`（版本号 `0.0.0`，附 `RIP.txt`），
  当前唯一启停入口是 `03-shortcuts\DSH.lnk` + `npm stop`。
- 打包落地：`npm install` + `npm run dist` 产出 Windows 安装包与免安装版。

**v1.2.1 修复**：主动清理服务时不再把进程退出误记为"服务异常退出"（Windows 上 `process.kill` 会把退出码报成 1，
旧实现会因此留下一句假的"当前问题"）；自检脚本新增"**cmd 包装进程场景**"，专门复现旧版 `taskkill` 杀不掉真服务
的那个条件（见第八节）。

**v1.2.0 新增**：**右键上下文菜单**（复制 / 剪切 / 粘贴 / 粘贴为纯文本 / 全选、链接与页面地址复制、重载、
DevTools、服务操作、"复制状态摘要"），不想记快捷键时可以直接右键。菜单在主进程构建，
**链接协议白名单与导航策略同样生效**。

---

## 一、v1.1.0 修了什么

| # | v1.0.0 的问题（实测证据） | v1.1.0 的做法 | 对应代码 |
|---|---|---|---|
| 1 | **没有单实例锁**：可同时开多个实例互相抢 3080 端口 | `app.requestSingleInstanceLock()`；第二实例只唤醒已有窗口后退出 | `main.js` 入口段 |
| 2 | **重启不等端口释放**：`kill` 完立刻重新拉起，两个实例抢端口 → `plugin tree failed to load` boot 失败（9/23、9/29 各一次） | 重启流程改为 `清理 → 轮询等端口释放 → 再拉起`；端口不让出就放弃拉起并如实报错 | `lib/service.js#restart` |
| 3 | **`taskkill /T /F` 永远失败（日志 14/14）**：记录的是 `shell:true` 产生的 cmd 包装进程 pid，真服务是它的子进程，不在该 pid 的树里 | 不再使用 `shell:true`；`dsh` 在 Windows 上解析为 `dsh.cmd` 并用 `cmd.exe /d /s /c` 调用；**权威身份改为"监听 DSH 端口的真实 pid"**（netstat/lsof/ss 解析 + 命令行读取），强杀针对真实 pid | `lib/procs.js`、`lib/service.js#_adoptListener` |
| 4 | **端口兜底会杀掉任何监听 3080 的进程**（注释还写"绝对安全"） | 三级兜底只对通过身份校验的 pid 生效：① 本程序记录/观察到的 pid ② 进程名在白名单且命令行匹配 dsh；否则**默认拒绝**并打印补救方式（`DSH_ALLOW_UNVERIFIED_KILL=1`） | `lib/procs.js#decideKill` |
| 5 | **状态会漂移却谎报"本程序管理"**：pid 已死、服务仍在跑（孤儿），侧边栏显示错误的 PID | 每次轮询校验 pid 存活并识别归属：`reuse / foreign / managed / orphan / takeover / stopped`，漂移时如实上报并给出"接管"入口，且不再声称 managed | `lib/service.js#refresh`、`renderer/sidebar.js` |
| 6 | **日志把根因截断**（`slice(0,300)`），boot 失败的 cause/stack 全丢 | 日志支持完整堆栈与 `cause` 链、单条 8KB 上限（超出标注截断长度）、超 2MB 自动轮转、**凭据脱敏**（`token=`/Bearer/URL userinfo/长 token），内存环形缓冲供界面显示"最近错误" | `lib/log.js` |
| 7 | **没有打包能力**（只有指向 `node_modules\electron\dist\electron.exe` 的快捷方式，图标 658B） | 内置 electron-builder 配置（NSIS/portable/dmg/AppImage，asar），`npm run gen-icon` 纯 Node 生成 256px PNG 与多尺寸 ICO | `package.json#build`、`tools/gen-icon.js` |
| 8 | **零自动化测试**，只有一个假服务脚本 | 53 个用例：命令/端口解析、终止校验、健康判定、安全策略、日志脱敏与轮转、右键菜单策略、**真实子进程 + 真实端口**的生命周期集成测试，以及用假 Electron 驱动的 `main.js` 装配层烟雾测试 | `tests/*.test.js` |
| 9 | **健康检查过宽**：任意 `<500` 响应都算"DSH 活着"；单次抖动即翻红 | 区分 `reachable`（有响应）与 `ok`（身份确认：<500 且 `text/html`），弱身份在界面标注；状态用 `FlapGuard` 消抖（连续 2 次失败才判离线） | `lib/health.js` |
| 10 | **跨平台假支持**：`taskkill`/`netstat -ano` 是 Windows 专有；macOS 下窗口全关不清理服务 | POSIX 走 `lsof` → `ss` + `SIGTERM/SIGKILL`；`window-all-closed` 在所有平台都清理并退出 | `lib/procs.js`、`main.js` |

附带修好的小问题：视图加载失败后不会自愈（现在服务恢复会自动重载，且最多重试 5 次并退避）、
服务启动期间右侧一片空白（现在显示本地占位页）、并发 `ensure()` 会重复拉起（现在用 in-flight Promise 去重）、
重启/接管结果只在日志里（现在侧边栏有操作结果提示）。

---

## 二、功能

1. **自动拉起 / 复用**：窗口立即出现；服务未运行则拉起，已运行则复用（且**不接管、不清理**外部服务）。
2. **精确清理**：只清理"本程序拉起的服务"，三级兜底且带身份校验；外部服务的进程绝不动。
3. **状态侧边栏**：网络 / DSH 服务 / 视图 三行状态 + 详情（地址、服务来源、监听进程、检测时间），5 秒轮询。
4. **异常提示与操作**：不可达、归属漂移、端口被接管、身份未确认、视图加载失败都会给出可操作的说明；
   一键"刷新 DSH 视图 / 重启服务 / 打开日志"，外部 dsh 场景额外提供"**接管并重启**"。
5. **关闭三选 + 系统托盘**：关闭窗口时询问"最小化到托盘 / 关闭并退出 / 取消"；托盘可恢复窗口、重启服务、打开日志、完全退出。
6. **托盘通知**：窗口隐藏期间只在服务/网络状态**翻转**时弹气泡（窗口可见时交给侧边栏，不打扰）。
7. **不跳出系统浏览器**：拉起用 `--no-open`；DSH 同源链接留在应用内，外链交给浏览器，其他协议一律拒绝。
8. **右键菜单（v1.2.0）**：不想记快捷键时直接右键。

### 右键菜单条目

| 场景 | 条目 | 说明 |
|---|---|---|
| 有选中文本 | 剪切 / 复制 / 全选 | 按 `editFlags` 决定可用性，只读区域剪切禁用 |
| 可编辑输入框 | 粘贴 / 粘贴为纯文本 | "粘贴为纯文本"可去掉富文本格式 |
| 右键点在链接上 | 在系统浏览器中打开链接 / 复制链接地址 | 非 http(s) 协议**不出现可打开条目**，只显示一条不可点的"已阻止打开该链接（原因）" |
| DSH 视图任意位置 | 复制页面地址 / 重新加载页面 / 开发者工具（F12） | 地址复制前同样去掉查询串与凭据 |
| DSH 视图任意位置 | 刷新 DSH 视图 / 重启 DSH 服务 / 接管并重启（外部 dsh 时出现） | 与侧边栏按钮等价 |
| 两处都有 | 复制状态摘要 / 打开日志 | 状态摘要=版本、地址、服务来源、监听 pid、健康、视图状态、上次清理步骤、当前问题，便于直接贴给他人排查 |

右键菜单由主进程构建，动作显式作用于"触发菜单的那个 webContents"（不依赖焦点），
并且**弹出的菜单本身也过协议白名单**（见下表"右键菜单"一行）。

---

## 三、安全模型（v1.1.0 新增）

设计原则：**默认拒绝（fail-closed）、最小权限、身份可验证、行为可审计**。

| 面 | 管控措施 | 位置 |
|---|---|---|
| 进程沙箱 | `app.enableSandbox()` 全局开启；窗口 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`nodeIntegrationInSubFrames: false`、`webviewTag: false`、`allowRunningInsecureContent: false`、`safeDialogs: true` | `main.js` |
| 导航 | DSH 视图仅允许**同源**在应用内导航；`will-navigate` / `will-redirect` / `window.open` 全部过策略；其他 http(s) 交系统浏览器；重定向不允许外跳；`file:` / `javascript:` / `data:` / `about:` / `ms-*` 等协议一律阻止并记日志 | `lib/security.js#decideNavigation` |
| 外链 | `shell.openExternal` 只接受 `http:`/`https:`（可用 `DSH_EXTERNAL_SCHEMES` 调整），其余拒绝 | `lib/security.js#decideOpenExternal` |
| 右键菜单 | 菜单模板在主进程生成，页面无法注入条目；"打开链接"复用外链协议白名单，被阻止时只给不可点的说明；动作通过 webContents 方法显式作用于触发者 | `lib/context-menu.js`、`main.js#showContextMenu` |
| 权限 | `setPermissionRequestHandler` + `setPermissionCheckHandler` **默认拒绝**摄像头/麦克风/地理/通知/HID/串口/USB/剪贴板读取等；仅放行 `clipboard-sanitized-write` 且必须同源；设备权限一律拒绝 | `lib/security.js#decidePermission` |
| IPC | 主进程只暴露 5 个固定 channel；每次调用校验 `event.sender === 侧边栏窗口`，来源不明直接拒绝并记日志；preload 不接受渲染进程传入的 channel 名 | `main.js#registerIpc`、`preload.js` |
| 渲染层 | 侧边栏与占位页都有严格 CSP（`default-src 'self'`、`connect-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`）；所有动态内容用 `textContent` 写入，杜绝日志/命令行/URL 造成的 XSS | `renderer/*` |
| 目标地址 | `DSH_URL` 默认只接受本机地址；指向远端时**拒绝启动**，必须显式 `DSH_ALLOW_REMOTE=1` | `lib/config.js` |
| 终止进程 | 终止任何 pid 前必须通过证据校验（见上表 #4）；`taskkill` 只对通过校验的 pid 执行；拒绝时打印补救方式 | `lib/procs.js#decideKill` |
| 启动命令 | 永不使用 `shell:true`（避免命令注入面与不可回收的包装进程）；命令先解析成真实可执行文件与参数数组 | `lib/procs.js#buildSpawnPlan` |
| 日志 | 落盘前脱敏（查询串凭据、Bearer、URL 凭据、40+ 位 token）；可用 `DSH_LOG_REDACT_TOKENS=0` 关闭 | `lib/log.js#redact` |
| 会话隔离 | DSH 视图默认使用独立会话分区 `persist:dsh-view`（cookie/localStorage/缓存与其它 Electron 应用互不影响）；侧边栏走默认会话 | `lib/config.js#viewPartition`、`main.js` |
| 单实例 | 防止多实例争抢端口/互相清理 | `main.js` |

已知取舍（有意为之，记录在案）：

- 权限白名单里的 `clipboard-sanitized-write` 是为了让 DSH 页面上的"复制"按钮可用（已确认保留）；如需更严可设
  `DSH_ALLOW_PERMISSIONS` 覆盖，或直接把该权限从 `lib/security.js` 的 `DEFAULT_ALLOWED_PERMISSIONS` 里删掉。
- 视图默认已改为独立会话分区。代价：首次切换后 DSH 页面的本地状态（登录态/主题等）不再与默认会话共享，
  可能需要重新设置一次；要回到旧行为设 `DSH_VIEW_PARTITION=default`。
- `DSH_ALLOW_UNVERIFIED_KILL=1` 会让清理在拿不到进程命令行证据时也放行强杀，属降低安全等级的开关，默认关闭。

---

## 四、运行前提

- Node.js（含 npm）；建议 Node ≥ 22.8（测试脚本用到 `--test-isolation=none`）
- `dsh` 命令可用，或用 `DSH_START_COMMAND` 指定
- 已安装依赖：`npm install`（会下载 Electron；打包另需 electron-builder）

## 五、使用

```powershell
npm install                    # 首次
npm start                      # 启动独立窗口
npm test                       # 61 个自动化用例
npm run selftest               # 真实环境自检（建议在普通终端运行）
npm run selftest -- --inspect 3080   # 只读查看 3080 被谁监听（不会终止任何进程）
npm stop                       # 安全停止 DSH 服务（带身份校验，不会误杀其它 node 进程）
npm run stop:dry               # 只看会终止谁，不动任何进程
npm run gen-icon               # 重新生成 icon.png / build/icon.ico
npm run dist                   # 打包安装包（需 electron-builder）
```

启动入口在**快捷方式区**：`D:\Desktop\08-AI_Workspace\03-shortcuts\DSH.lnk`
（直接指向本项目的 `node_modules\electron\dist\electron.exe`，无控制台窗口）；
同目录还有 `停止 DSH 服务.lnk`（等价于 `npm stop`）。
若移动了项目目录，请重建这两个快捷方式。

本项目在工作区中的位置：`D:\Desktop\08-AI_Workspace\02-projects\source\dsh_electron\`
（源代码区；各版本分发单独放在 `02-projects\releases\dsh-electron\<版本>\`）。

## 六、配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_URL` | `http://127.0.0.1:3080` | 服务地址（也是健康检查地址）；非本机地址默认拒绝启动 |
| `DSH_ALLOW_REMOTE` | `0` | 设为 `1` 才允许 `DSH_URL` 指向远端 |
| `DSH_START_COMMAND` | `dsh web --no-open` | 服务未运行时用于拉起的命令（不使用 shell） |
| `DSH_POLL_INTERVAL` | `5000` | 状态轮询间隔（ms，1000~120000） |
| `DSH_CHECK_TIMEOUT` | `3000` | 单次探测超时（ms，500~30000） |
| `DSH_READY_TIMEOUT` | `60000` | 等待服务就绪上限（ms） |
| `DSH_KILL_TIMEOUT` | `8000` | 清理阶段等待/兜底总时限（ms） |
| `DSH_FAIL_THRESHOLD` | `2` | DSH 连续失败几次判定离线 |
| `DSH_NET_CHECK` / `DSH_NET_CHECK_URL` | `1` / `https://www.baidu.com` | 外网探活开关与目标 |
| `DSH_NET_FAIL_THRESHOLD` | `2` | 外网连续失败几次判定离线 |
| `DSH_HEALTH_REQUIRE_HTML` | `1` | 是否要求响应为 `text/html` 才算"身份确认" |
| `DSH_KILL_PATTERN` | `dsh` | 判定"这个进程是 DSH"的命令行正则 |
| `DSH_ALLOW_UNVERIFIED_KILL` | `0` | `1` = 拿不到命令行证据也允许强杀（降低安全性） |
| `DSH_EXTERNAL_SCHEMES` | `http,https` | 允许交给系统浏览器的协议 |
| `DSH_ALLOW_PERMISSIONS` | 空 | 额外放行的渲染层权限（逗号分隔） |
| `DSH_VIEW_PARTITION` | `persist:dsh-view` | 视图的会话分区；设 `default`/`off` 退回 Electron 默认会话 |
| `DSH_DEVTOOLS` | `1` | `1` = 视图内按 F12 可开 DevTools |
| `DSH_VIEW_RETRY_INTERVAL` / `DSH_VIEW_MAX_ATTEMPTS` | `5000` / `5` | 视图自愈重试间隔与上限 |
| `DSH_LOG_FILE` | `<项目目录>/load-status.log` | 日志路径 |
| `DSH_LOG_MAX_BYTES` / `DSH_LOG_MAX_MESSAGE` | `2097152` / `8192` | 轮转阈值 / 单条上限 |
| `DSH_LOG_REDACT_TOKENS` | `1` | 是否脱敏超长 token |

## 七、状态语义（侧边栏"服务来源"）

| mode | 含义 | 退出时会清理吗 |
|---|---|---|
| `managed` | 本程序拉起并认领了真实监听 pid | ✅ |
| `managed`（adopted） | 你点了"接管并重启"，外部 dsh 被显式纳入管理 | ✅ |
| `reuse` | 端口上已有外部启动的服务（如你自己开的终端），本程序只复用 | ❌ 不动它 |
| `foreign` | 端口有人响应但不是 DSH（身份未确认） | ❌ |
| `orphan` | 本程序记录的 pid 已退出，端口仍由疑似 dsh 的进程服务（孤儿） | ✅（身份校验通过才动手） |
| `takeover` | 端口被其它进程接管，已不属于本程序 | ❌ 并明确提示 |
| `stopped` | 服务已停止，可直接重启 | — |

## 八、测试与自检

```powershell
npm test                        # 53 项：单测 + 集成测试 + main.js 装配层烟雾测试
npm run selftest                # 真实 netstat/ps → 认领 → taskkill/kill → 端口释放 全链路
npm run selftest -- --inspect 3080
```

- `npm test` 用 `--test-isolation=none` 以便在受限终端（禁止子进程管道）里也能跑；在普通终端也可以直接
  `node --test tests/`。
- `tests/service.test.js` 用**真实子进程 + 真实端口探测**验证"拉起 → 认领监听 pid → 清理 → 端口释放"，
  测试内注入的只是"进程查询"这一类需要系统命令的依赖；随机端口，绝不使用 3080。
- `tests/main-smoke.test.js` 用最小假 Electron 模块驱动 `main.js`，验证装配层接线：
  IPC 通道与 sender 校验、权限默认拒绝/白名单放行、导航与外链协议策略、视图状态机、退出清理。
  它**不渲染真实窗口**，不能替代人工双击运行验证（Electron 渲染进程需要真实 GUI 环境）。
- `tools/selftest.js` 分两段跑真实生命周期：**① 直接启动**（`node dummy-server.js`）与
  **② cmd 包装启动**（`cmd.exe /d /s /c node dummy-server.js`，专门复现旧版"包装进程 pid ≠ 真服务 pid、
  `taskkill` 杀不掉服务"的条件），各自校验：能拉起、能认领真实监听 pid、身份经命令行校验、
  清理后端口释放、真服务与包装进程都已退出、主动清理不产生假故障。共 13 项检查。
  它必须**在普通终端运行**；若检测到受限环境（`spawn EPERM`）会明确提示并以退出码 3 结束，
  而不是让你误以为代码有问题。
- 任何一次测试/自检都不会操作 3080（脚本内置断言拒绝），需要查看 3080 时只做只读检查。

## 九、打包

```powershell
npm install                     # 同步 devDependencies（含 electron-builder）
npm run gen-icon                # 可选：重新生成图标
npm run dist                    # 输出 dist/：NSIS 安装包 + 免安装单文件版
```

**已实测产物**（v1.3.0，Windows x64）

| 文件 | 用途 |
|---|---|
| `dist\DSH Desktop Setup 1.3.0.exe`（约 78 MB） | NSIS 安装包：可选安装目录、建桌面快捷方式、带卸载器 |
| `dist\DSH Desktop 1.3.0.exe`（约 78 MB） | 免安装单文件版，双击即用 |
| `dist\win-unpacked\` | 解包后的应用目录（`resources\app.asar` 内只有 16 个应用文件，无 node_modules 冗余） |

如果构建时下载卡住（国内网络访问 GitHub 受限），先设置镜像再构建：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE = "$PWD\.eb-cache"   # 把构建缓存放进项目目录（已 gitignore）
npm run dist
```

构建配置里有两处针对本机的必要设置，改动前请先看原因：

- `electronDist: node_modules/electron/dist` + `electronVersion`：直接复用已安装的 Electron 运行时，
  不再从 GitHub 重新下载一份；`npmRebuild: false`：本项目**零运行时依赖**，无需重建原生模块。
- `win.signAndEditExecutable: false`：Windows 上解包 `winCodeSign` 需要"创建符号链接"权限
  （管理员或开发者模式），否则构建会卡在 `Cannot create symbolic link`。
  代价：**exe 的图标与版本信息仍是 Electron 默认值**（资源管理器里看是 Electron 图标），
  但窗口/任务栏/托盘图标已由 `icon.png` 提供，功能不受影响。
  想要 exe 也带自己的图标：开启 Windows 开发者模式（或管理员终端）后把该项改回 `true` 重新构建。

> 打包后的应用 `productName` 是 `DSH Desktop`，与开发运行（`npm start`）的系统标识不同：
> 两者**可以同时启动**（单实例锁按应用标识区分）。但它们共用同一个 DSH 端口，
> 建议只保留一个在跑，否则第二个会以 `reuse`（外部服务）身份复用端口——不冲突，但状态归属会看着别扭。

## 十、故障排查

| 现象 | 原因与处理 |
|---|---|
| 侧边栏"服务来源"显示 `orphan` | 本程序记录的 pid 已退出但端口仍被疑似 dsh 的进程服务（典型场景：上一版程序把真服务留成了孤儿）。点"**接管并重启**"即可纳管并重建服务 |
| 显示 `reuse`，重启按钮不可用 | 服务是你自己在终端里启动的。按设计本程序不重启/不清理它；如需纳管请点"接管并重启" |
| 显示 `takeover` | 端口被别的进程占用。先确认谁在用：`npm run selftest -- --inspect 3080` |
| 清理时日志出现 `拒绝终止 pid ...` | 该进程没通过身份校验（默认拒绝是安全设计）。确认它确实是本程序的 DSH 后，可临时 `DSH_ALLOW_UNVERIFIED_KILL=1` |
| 日志出现 `plugin tree failed to load`（含完整堆栈与 cause） | DSH 自身 boot 失败，通常是端口被占或配置问题；v1.1.0 已保证不会因为"重启不等端口"制造这个错误 |
| 启动报"DSH_URL 指向非本机地址" | 安全默认值。确需远端请设 `DSH_ALLOW_REMOTE=1` |
| 右侧一直停在占位页，但端口明明有响应 | 默认要求响应为 `text/html` 才认作 DSH（防止把陌生服务当 DSH 加载进外壳）。若你的入口返回其它类型，设 `DSH_HEALTH_REQUIRE_HTML=0` |

### 从旧版（v1.0.0 / v1.1.0）切换到当前版本（重要）

当前若还在跑旧实例，它的清理逻辑会"杀掉任何监听 3080 的进程"，因此：

1. **推荐**：先在旧实例上完全退出（窗口 × → "关闭并退出"，或托盘菜单"退出"）。
   旧实例会终止它此前拉起的那个 dsh（当前 GUI 页面会断开，属正常），随后双击快捷方式启动新版，
   新版发现端口空闲会自己拉起新服务，页面恢复。
2. **不想中断当前会话**：直接启动新版（新版会判定为 `reuse`，不会动它），
   等旧实例退出后再在新版里点"重启服务"。
3. ⚠ 不要在新版已经拉起服务后，再让**旧版**执行"关闭并退出"——旧版会把新版的服务一起杀掉。

回滚：本目录已是 git 仓库，`git checkout d09f279 -- .` 可恢复 v1.0.0 的代码
（快照提交 `d09f279`，标签 `v1.0.0-snapshot`）。

### 旧的 `dsh_on.ps1` / `dsh_off.ps1`：已退役并归档

它们曾是这个项目的前身（2026-08-22 启用，职责：一键拉起并开浏览器 / 一键停止）。
现在职责已全部由本程序接管，**已归档到 `02-projects\retired\dsh_legacy_v0.0.0\`**
（版本号 `0.0.0`，附 `RIP.txt` 墓志），不再参与日常启停：

| 旧脚本 | 它做什么 | 为什么退役 |
|---|---|---|
| `dsh_on.ps1` | 在**可见终端前台**运行 `dsh web --host 127.0.0.1 --port 3080`，并另起隐藏进程等端口就绪后**打开系统浏览器** | 拉起 + 开窗已由本程序自动完成；它启动的服务属于"外部服务"，本程序只能 `reuse`（只复用不管理），"重启服务"会灰掉——那正是"接管并重启"按钮唯一会亮起来的场景 |
| `dsh_off.ps1` | **终止机器上所有 `node.exe`** | 风险高：会连带杀掉与本项目无关的 Node 进程。已由 `npm stop` 取代（只终止经身份校验确认是 DSH 的那个进程） |

当前唯一的启停方式：

```powershell
双击 03-shortcuts\DSH.lnk     # 启动（自动拉起/复用服务）
npm stop                     # 停止（带身份校验，不会误伤其它 node）
npm run stop:dry             # 只看会终止谁，不动任何进程
```

如果哪天还想用回旧脚本：把 `.ps1` 从 `02-projects\retired\dsh_legacy_v0.0.0\` 复制到任意目录执行即可（内容未改动），
但**不要**让它与 `dsh_electron` 同时"拥有"同一个服务——一边清理、另一边还在原地，只会制造 `orphan`/`takeover`。
对应的两个 `.lnk` 也一起归档了（它们指向原绝对路径，搬走后已失效，仅作纪念）。

## 十一、架构

```
npm start
 └─ main.js（Electron 装配：单实例锁 / 会话加固 / 窗口 / 托盘 / IPC / 轮询）
     ├─ lib/config.js    配置加载 + 校验（远端目标默认拒绝）
     ├─ lib/log.js       脱敏 + 轮转 + 环缓冲（完整堆栈）
     ├─ lib/procs.js     命令解析 / 监听者解析 / pid 存活 / 终止校验 / 端口探测
     ├─ lib/exec.js      子进程输出捕获（永不抛异常）
     ├─ lib/health.js    健康探测 + 消抖 + 状态翻转
     ├─ lib/security.js  导航 / 外链 / 权限三类默认拒绝策略
     └─ lib/service.js   ServiceManager：ensure / refresh / restart / killManaged / shutdown
         ├─ 权威身份 = 监听 DSH 端口的真实 pid（netstat | lsof | ss + 命令行）
         ├─ 清理三级兜底：SIGTERM → taskkill /T /F（或 SIGKILL）→ 身份校验后定点强杀
         └─ 归属漂移检测：managed / reuse / foreign / orphan / takeover / stopped
```

## 十二、文件说明

| 文件 | 作用 |
|---|---|
| `main.js` | 主进程装配：单实例、安全策略执行、窗口/视图/托盘、右键菜单、IPC、轮询与退出清理 |
| `preload.js` | contextBridge 暴露 5 个固定接口给侧边栏 |
| `renderer/index.html` `sidebar.css` `sidebar.js` | 侧边栏 UI（严格 CSP，全部 `textContent` 渲染，告警/详情文本可选中复制） |
| `renderer/view-placeholder.html` | 服务未就绪时的占位页 |
| `lib/*.js` | 可单测的业务逻辑（含 `context-menu.js` 右键菜单模板，见上） |
| `tests/*.test.js` | 61 个自动化用例；`tests/dummy-server.js` 为假 DSH 服务 |
| `tools/selftest.js` | 真实环境全链路自检 / 只读端口检查 |
| `tools/stop-dsh.js` | 安全停止工具（`npm stop`）：带身份校验，不会误杀其它 node 进程 |
| `tools/gen-icon.js` | 纯 Node 生成 `icon.png` 与 `build/icon.ico` |
| `build/icon.ico` `build/icon.png` | 打包资源（由 `gen-icon` 生成） |
| `load-status.log` | 运行日志（自动轮转，凭据脱敏） |
