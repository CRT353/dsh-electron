# CHANGELOG —— 版本变更记录

本项目逐版本改了什么。**当前功能与用法请看 `README.md`，本文件只记变化。**

格式约定：每个版本写清**问题（含实测证据）→ 做法 → 影响**。
凡是修掉的坑都保留原文描述，因为它们是"为什么代码长这样"的唯一解释。

标签与提交的对应关系见各条目；也可直接查：

```powershell
git tag --list --format='%(refname:short)  %(objectname:short)  %(subject)'
```

---

## v1.4.2 —— 沙箱兜底开关（本机 Chromium 沙箱初始化失败）

- **问题**：2026-10-18 起，本机上双击 `03-shortcuts\DSH.lnk` **完全打不开**：
  正常双击是"没有窗口、直接没反应"，管理员身份运行则是"空白窗口几秒后自己关闭"。
  实测证据（同日、同一台机、同一份代码）：
  - `load-status.log` 停在 `已启动服务进程 pid=...`，**没有** `开始退出清理` ⇒ 进程被瞬间掐掉；
  - 同一次运行里窗口侧有 `DSH 视图进程异常退出: launch-failed`；
  - Windows 事件日志：`electron.exe` `0xc0000005`，**故障模块是 electron.exe 自身**；
    控制台另有 `GPU process launch failed: error_code=18`、`Network service crashed, restarting service`；
  - 对照实验（最小 Electron 冒烟程序，与 DSH 代码无关）：
    `electron.exe --version` **加沙箱就秒崩，退出码 `0x80000003`，stdout/stderr 一个字都没有**；
    加 `--no-sandbox` 则窗口、渲染进程、`executeJavaScript` 全部正常（1126ms 完成）；
  - 结论：**不是 DSH 代码的 bug，也不是快捷方式指向失效** —— 本机 Chromium 沙箱起不来。
    而 `bootstrap()` 里的 `app.enableSandbox()` 是无条件的，于是必崩。
- **做法**：
  - `lib/config.js` 新增 `wantsSandboxDisabled(argv, commandLine)`：认 `--no-sandbox`
    与 `--disable-sandbox`（argv 与 `app.commandLine.hasSwitch()` 两条路都看；
    取不到命令行时按"开沙箱"处理，**绝不因为异常反过来关掉沙箱**）；
  - `bootstrap()` 改为"默认强制沙箱，显式传开关才跳过 `app.enableSandbox()`"，
    跳过时打一条 WARN（`启动参数含 --no-sandbox：本次不强制 Chromium 沙箱…`），保证降级永远留痕；
  - `package.json` 新增 `start:no-sandbox` 脚本，版本号 1.4.2。
- **影响**：默认行为完全不变（不传开关 ⇒ 照旧 `app.enableSandbox()`，`webPreferences.sandbox` 仍为 true）。
  只有显式 `--no-sandbox` 才放弃渲染进程沙箱；此时 `contextIsolation` / `nodeIntegration:false` /
  导航白名单等防线仍在。本机 `DSH.lnk` 已带上该参数（见工作区 `03-shortcuts/README.md`）。
- **未做**：没有重新打包（`dist/` 与 release 归档仍是 v1.4.1 产物），本次只改源码与文档。
- **补充（同日晚些时候，仅文档/配置，未再改代码）**：`--no-sandbox` 只解决了其中一个根因。
  继续排查发现第二个机器级故障 —— Chromium 在默认 profile `%APPDATA%\dsh-electron` 里
  **建不出单实例锁**（`process_singleton_win.cc(465) Lock file can not be created! Error code: 5`），
  于是 `requestSingleInstanceLock()` 返 false、程序**在写日志之前**就 `app.quit()`，
  表现为"无窗口 + 无日志 + 无崩溃记录"。同一目录 `cmd` 能写、只有 `electron.exe` 被拒（非 ACL 问题），
  所以本机快捷方式又加了 `--user-data-dir`。完整证据与"为什么昨天还好今天坏"的时间线见工作区
  `04-exp/2026-10-18-electron-shell-wont-open/README.md`。

---

## v1.4.1 —— 令牌 → Cookie 兑换修正（v1.4.0 的修复）

- **问题**：v1.4.0 只做了"取到令牌并把带令牌的地址用于探测"，但**健康检查仍判不就绪**，
  报 `http-303-redirect`。2026-10-16 在真实 DSH 0.2 上逐条实测后搞清了完整机制 ——
  **认证是两步兑换，不是"带上令牌就行"**：

  | 请求 | 响应 |
  |---|---|
  | `GET /`（无凭据） | 401（无 Content-Type、无正文） |
  | `GET /?token=<secret>` | **303** + `Set-Cookie: dsh-auth-<rand>=v1.…`（`Location: ./`） |
  | `GET /`（带 Cookie，**不带 query**） | **200** + `text/html` |
  | `GET /?token=<secret>`（带 Cookie，**仍带 query**） | **303** ← 令牌**一次性** |

  `Set-Cookie` 的值内含 `authority`（绑 主机:端口）与 `expiresAt`。
  两个关键细节都是实测踩出来的：
  1) **只带令牌不够** —— 303 在旧判据里是 `identity=weak`，仍不就绪；
  2) **重试必须去掉 query** —— 带着 `?token=` 重试仍得 303（令牌一次性）。
     第一版修复正是因为漏了这一步而无效。

  这也解释了"视图能加载、健康检查却永远不就绪"这个费解现象：
  Electron 的 `webContents` 自带 Cookie 罐（跳转时自动保存并回带），而裸 `fetch` 没有。

- **修法**：`lib/health.js` 的 `probeDsh` 完成兑换 —— 仅当 3xx 的 `Location` **同源**
  且下发 `dsh-auth-*` Cookie 时，才用该 Cookie **去掉 query** 重试一次原地址。
  **跨源一律不跟随**：v1.3.1 审计确立的 fail-closed 边界不变，并新增专门测试守住它。

- **测试**：`tests/dummy-dsh-02.js` 升级为**完整复现**上述四行行为（含"带 cookie 但
  仍带 token 应回 303"这一条）；`tests/token-adapter.test.js` 增到 7 项，其中新增
  "拒绝跨源重定向"一项（起一个 303 到别的 origin 的陌生服务，断言不得被判为身份确认）。
  应用测试 125 → **126 项，全过**。

---
## v1.4.0 —— DSH 0.2 令牌适配

- **问题**：DSH 0.2 起本地 Web 服务加了**进程级令牌门禁**：密钥在启动时随机生成
  （`randomBytes(32)`）、**不落盘、也无法由外部指定**，只印在服务 stdout 的一行上
  （`dsh web: http://127.0.0.1:3080/?token=<secret>`）。不带令牌访问 `/`、`/index.html`、
  `/api` 全部返回 **401**（实测：裸响应、无 Content-Type、无正文）。
  对本外壳有两处硬影响：
  ① 健康检查发裸 GET 得 401，`status < 500` 为假 ⇒ **永远判"未就绪"**，
     60 秒后报"服务未在 60s 内就绪"（而服务其实活得好好的，日志里已有
     "端口 3080 由疑似 dsh 的 pid 服务，但本程序没有记录到它"）；
  ② 视图用裸地址加载会得到一片 401（实测日志：`DSH 视图加载失败: ERR_ABORTED (-3)`）。
- **修法**：外壳本来就是拉起服务的一方，也本来就在读它的 stdout（`_spawnService` 里
  已有 `proc.stdout.on('data', ...)`）。在那里**先于日志**解析出带令牌的地址
  （`parseAuthenticatedUrl`，取最后一条，兼容截断/多行/LAN 提示），存进
  `state.authenticatedUrl`，再由新增的 `currentUrl()` 提供给健康检查与视图加载。
  **必须在日志之前取** —— `logger.stream` 会按凭据规则脱敏 token，脱敏后就取不到了。
  日志里始终只写 `safeUrl()` 处理过的地址，令牌不落日志。
- **改动**：`lib/service.js`（解析函数 + stdout 捕获 + `currentUrl()` + 导出解析函数）、
  `main.js`（新增 `dshTargetUrl()`；`pollStatusOnce`、注入的 `probeHealth`、
  视图 `loadURL` 三处改用它）。
- **测试**：新增 `tests/dummy-dsh-02.js`（复现 0.2 令牌门禁的假服务：启动打印令牌行、
  无令牌 401、带令牌 200+text/html）与 `tests/token-adapter.test.js`（6 项：5 项解析单测
  + 1 项真实子进程/真实端口的端到端验证）。应用测试 119 → **125 项，全过**。
- **能力边界（有意为之）**：令牌只在"本外壳拉起服务"的那次 stdout 里，因此
  **外部已运行的服务不再能被直接复用**（拿不到令牌）—— 这是 DSH 0.2 令牌模型的固有结果。
  要交回外壳管理，先停掉外部服务再由外壳拉起。

---
## v1.3.2 —— 打包版身份修复

- **问题**：打包产物内 `package.json` 没有顶层 `productName`（`productName` 只写在 `build` 段，
  electron-builder 不会把它带进 asar），而 Electron 的 `app.getPath('userData')` 由 `app.getName()`
  决定、且**优先取顶层 `productName`**。于是打包版的 userData 是 `%APPDATA%\dsh-electron` ——
  与开发版（`npm start`）**同一个目录**：两版的单实例锁落在同一处，**不能同时运行**，
  后启动的那个一启动就静默退出（退出码 0、无窗口、无日志），表现出来就是"双击没反应"。
  （这条是 2026-10-03 在真实产物上实测发现的，1.3.0/1.3.1 都存在。）
- **修法**：在 `build` 段加 `extraMetadata: { productName: "DSH Desktop" }`。electron-builder 会把该
  字段**只注入打包产物**的 `package.json`，源码那份不变 —— 于是开发版仍是 `dsh-electron`、
  打包版变成 `DSH Desktop`，两者彻底分开。
  ⚠ **反例**：直接在 `package.json` **顶层**加 `productName` 是**修不好**的 —— 开发版与打包版读的是
  同一份内容，两边会一起变成 `DSH Desktop`，仍然共用同一个目录。
- **效果**：打包版 userData 变为 `%APPDATA%\DSH Desktop`，与开发版可同时运行；打包版的本地状态
  （DSH 页面 cookie/localStorage/缓存、窗口位置）改从新目录开始；卸载时要手动清理的目录也随之改变。
- **验收已固化**：`node tools\verify-packaged-logpath.js` 在产物缺顶层 `productName` 时会打 `[WARN]`
  并说明后果；修好后该项转为 PASS。
- 构建来源提交 `6ce6c0f`（标签 `v1.3.2`）。

---

## v1.3.1 —— 一次完整审计后的修复（按严重度分四组）

- **误杀面 / 静默回落**：默认身份判定模式由裸 `/dsh/i` 收紧为锚定 DSH 入口形态
  （`@deepseek-ai/dsh`、`dsh(.exe|.cmd)`、`<...>/dsh/lib/bin.js`），不再把路径里偶然含 "dsh"
  的无关 node 服务判成 DSH；`npm stop --port` 缺值/越界改为直接报错（旧实现静默回落到 3080，
  打印的是 `NaN`、停掉的却是真实服务）；进程查询改用 `netstat -ano`（`-p TCP` 在 Windows 上
  不含任何 IPv6 监听项，实测 0/43）。
- **失败侧归属**：退出清理改为按时间预算分配（旧实现各步等待之和远超超时，`app.exit` 会在强杀与
  兜底之前截断清理，服务被留成孤儿且不记录 `lastKill`）；就绪失败也承认归属（否则自己拉起的进程
  永不被清理、之后重启永远卡在 port-busy）；netstat 受限时不再把正常服务误报成 orphan
  （旧实现会打印字面量"原 pid null 已退出"）；命令行读不到时提供"spawn 相关性"恢复入口
  （仅用户显式点击时生效）；Windows 用 `taskkill /T /F` 结束整棵进程树（`process.kill` 不连带
  子进程，且 Windows 没有真正的"温和阶段"）；终止前用命令行复验一次身份（防 pid 复用误杀），
  可信 pid 集合不再只增不减。
- **"不知道"不再被当成"知道"**：健康探测不再跟随重定向（旧实现下"3xx → HTML 登录页"的陌生服务
  会被认证成 identity=strong）；端口与进程查询区分"确定空闲 / 在用 / 不知道"；
  `selftest --inspect` 在查不到监听者时以退出码 3 结束，而不是谎报"未查到监听者/端口空闲"；
  `probeInternet` 不再把 4xx/5xx/重定向算作"网络在线"。
- **日志与凭据**：`stream()` 先判级再截断（旧实现会丢掉落在 2000 字符之后的根因、并把它降级成
  INFO，侧边栏"当前问题"因此为空）；脱敏补齐 `--token xxx`、`token: xxx`、`"token":"xxx"`、
  `#token=x`、`Authorization: Basic`（`DSH_START_COMMAND` 里的凭据曾被逐字写进日志并长期留存）；
  打包态（`__dirname` 落在不可写的 `resources/app.asar` 内）默认日志路径改用 userData 目录，
  落盘失败也不再被静默吞掉。
- 其它：`bool()` 容忍空白（cmd 的 `set VAR=1 && npm start` 不再导致"配置错误"拒绝启动）；
  `ringSize` 负值不再死循环卡死主进程；`cause` 链超过 10 层显式标注；轮询加重入保护；
  权限闸门在"来源证据缺失"或"跨源子框架"时一律拒绝；`preload` 接口数文档由 5 改为 6。
- 测试项数由 43 增至 118，随后增至 119（见 v1.2.1 与 README 第八节）。
- 构建来源提交 `0fd1df1`（标签 `v1.3.1`）。

> **同一轮的外围修复**：会话日志工具箱（工作区里的 `02-projects/dev/dsh-session-tools/`，
> 不在本仓库内）另有独立修复 —— `truncate` 在首条记录损坏时写出的文件加载器无法读取、
> `region.mjs` 字符/字节混用导致崩栈、空帧被判"健康"、明文布局报错不友好、
> 并发写入导致备份与产物同时丢数据（新增 size/mtime 复检与 fsync）。
> 那是另一个项目的变更，只在此处留一条线索。

---

## v1.3.0

- **DSH 视图默认使用独立会话分区**（`persist:dsh-view`）：Cookie / localStorage / 缓存与其它 Electron 应用隔离；
  要回到旧行为（复用 Electron 默认会话）设 `DSH_VIEW_PARTITION=default`。
- **"接管并重启"按钮改为常驻显示**（灰显 + 悬停原因），不再只在需要时才出现（避免找不到）。
- **新增安全停止工具** `npm stop`（`tools/stop-dsh.js`）：只终止"经身份校验确认是 DSH"的进程，
  用于替代 `dsh_off.ps1` 里"杀掉所有 node.exe"的做法（见 README 第十节末）。
- **旧脚本退役归档**：`dsh_on.ps1` / `dsh_off.ps1` 及其快捷方式已移入工作区的
  `02-projects\retired\dsh_legacy_v0.0.0\`（版本号 `0.0.0`，附 `RIP.txt`），
  当前唯一启停入口是快捷方式 `DSH.lnk` + `npm stop`。
- 打包落地：`npm install` + `npm run dist` 产出 Windows 安装包与免安装版。

---

## v1.2.1

主动清理服务时不再把进程退出误记为"服务异常退出"（Windows 上 `process.kill` 会把退出码报成 1，
旧实现会因此留下一句假的"当前问题"）；自检脚本新增"**cmd 包装进程场景**"，专门复现旧版 `taskkill`
杀不掉真服务的那个条件（见 README 第八节）。

---

## v1.2.0

新增**右键上下文菜单**（复制 / 剪切 / 粘贴 / 粘贴为纯文本 / 全选、链接与页面地址复制、重载、
DevTools、服务操作、"复制状态摘要"），不想记快捷键时可以直接右键。菜单在主进程构建，
**链接协议白名单与导航策略同样生效**。

---

## v1.1.0 —— 生命周期与安全加固

| # | v1.0.0 的问题（实测证据） | v1.1.0 的做法 | 对应代码 |
|---|---|---|---|
| 1 | **没有单实例锁**：可同时开多个实例互相抢 3080 端口 | `app.requestSingleInstanceLock()`；第二实例只唤醒已有窗口后退出 | `main.js` 入口段 |
| 2 | **重启不等端口释放**：`kill` 完立刻重新拉起，两个实例抢端口 → `plugin tree failed to load` boot 失败（9/23、9/29 各一次） | 重启流程改为 `清理 → 轮询等端口释放 → 再拉起`；端口不让出就放弃拉起并如实报错 | `lib/service.js#restart` |
| 3 | **`taskkill /T /F` 永远失败（日志 14/14）**：记录的是 `shell:true` 产生的 cmd 包装进程 pid，真服务是它的子进程，不在该 pid 的树里 | 不再使用 `shell:true`；`dsh` 在 Windows 上解析为 `dsh.cmd` 并用 `cmd.exe /d /s /c` 调用；**权威身份改为"监听 DSH 端口的真实 pid"**（netstat/lsof/ss 解析 + 命令行读取），强杀针对真实 pid | `lib/procs.js`、`lib/service.js#_adoptListener` |
| 4 | **端口兜底会杀掉任何监听 3080 的进程**（注释还写"绝对安全"） | 三级兜底只对通过身份校验的 pid 生效：① 本程序记录/观察到的 pid ② 进程名在白名单且命令行匹配 dsh；否则**默认拒绝**并打印补救方式（`DSH_ALLOW_UNVERIFIED_KILL=1`） | `lib/procs.js#decideKill` |
| 5 | **状态会漂移却谎报"本程序管理"**：pid 已死、服务仍在跑（孤儿），侧边栏显示错误的 PID | 每次轮询校验 pid 存活并识别归属：`reuse / foreign / managed / orphan / takeover / stopped`，漂移时如实上报并给出"接管"入口，且不再声称 managed | `lib/service.js#refresh`、`renderer/sidebar.js` |
| 6 | **日志把根因截断**（`slice(0,300)`），boot 失败的 cause/stack 全丢 | 日志支持完整堆栈与 `cause` 链、单条 8KB 上限（超出标注截断长度）、超 2MB 自动轮转、**凭据脱敏**（`token=`/Bearer/URL userinfo/长 token），内存环形缓冲供界面显示"最近错误" | `lib/log.js` |
| 7 | **没有打包能力**（只有指向 `node_modules\electron\dist\electron.exe` 的快捷方式，图标 658B） | 内置 electron-builder 配置（NSIS/portable/dmg/AppImage，asar），`npm run gen-icon` 纯 Node 生成 256px PNG 与多尺寸 ICO | `package.json#build`、`tools/gen-icon.js` |
| 8 | **零自动化测试**，只有一个假服务脚本 | 43 个用例：命令/端口解析、终止校验、健康判定、安全策略、日志脱敏与轮转、**真实子进程 + 真实端口**的生命周期集成测试，以及用假 Electron 驱动的 `main.js` 装配层烟雾测试 | `tests/*.test.js` |
| 9 | **健康检查过宽**：任意 `<500` 响应都算"DSH 活着"；单次抖动即翻红 | 区分 `reachable`（有响应）与 `ok`（身份确认：<500 且 `text/html`），弱身份在界面标注；状态用 `FlapGuard` 消抖（连续 2 次失败才判离线） | `lib/health.js` |
| 10 | **跨平台假支持**：`taskkill`/`netstat -ano` 是 Windows 专有；macOS 下窗口全关不清理服务 | POSIX 走 `lsof` → `ss` + `SIGTERM/SIGKILL`；`window-all-closed` 在所有平台都清理并退出 | `lib/procs.js`、`main.js` |

附带修好的小问题：视图加载失败后不会自愈（现在服务恢复会自动重载，且最多重试 5 次并退避）、
服务启动期间右侧一片空白（现在显示本地占位页）、并发 `ensure()` 会重复拉起（现在用 in-flight Promise 去重）、
重启/接管结果只在日志里（现在侧边栏有操作结果提示）。

---

## v1.0.0 —— 原始实现

初始版本：把 DSH Web GUI 装进 Electron 窗口。
快照提交 `d09f279`，标签 `v1.0.0-snapshot`。

回退到该版本：

```powershell
git checkout d09f279 -- .
```

---

## 更早：`dsh_on.ps1` / `dsh_off.ps1`

本项目的**前身**（2026-08-22 启用，2026-09-29 退役，享年 38 天）。
职责是一键拉起 DSH 并打开浏览器 / 一键停止，已由 v1.0.0 起的本程序完整接管。

| 旧脚本 | 它做什么 | 为什么退役 |
|---|---|---|
| `dsh_on.ps1` | 在**可见终端前台**运行 `dsh web --host 127.0.0.1 --port 3080`，并另起隐藏进程等端口就绪后**打开系统浏览器** | 拉起 + 开窗已由本程序自动完成；它启动的服务属于"外部服务"，本程序只能 `reuse`（只复用不管理），"重启服务"会灰掉 —— 那正是"接管并重启"按钮唯一会亮起来的场景 |
| `dsh_off.ps1` | **终止机器上所有 `node.exe`** | 风险高：会连带杀掉与本项目无关的 Node 进程。已由 `npm stop` 取代（只终止经身份校验确认是 DSH 的那个进程） |

它们的原件留档在工作区的 `02-projects\retired\dsh_legacy_v0.0.0\`（附 `RIP.txt`）。
