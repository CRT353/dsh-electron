# dsh-electron

把 DSH Web GUI（默认 `http://127.0.0.1:3080`）装进独立 Electron 窗口，并附带
**服务生命周期管理、归属校验、状态监测侧边栏与安全加固**。

当前版本 **v1.1.0**（v1.0.0 的功能等价实现见 git 快照 `d09f279`）。

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
| 8 | **零自动化测试**，只有一个假服务脚本 | 43 个用例：命令/端口解析、终止校验、健康判定、安全策略、日志脱敏与轮转、**真实子进程 + 真实端口**的生命周期集成测试，以及用假 Electron 驱动的 `main.js` 装配层烟雾测试 | `tests/*.test.js` |
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

---

## 三、安全模型（v1.1.0 新增）

设计原则：**默认拒绝（fail-closed）、最小权限、身份可验证、行为可审计**。

| 面 | 管控措施 | 位置 |
|---|---|---|
| 进程沙箱 | `app.enableSandbox()` 全局开启；窗口 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`nodeIntegrationInSubFrames: false`、`webviewTag: false`、`allowRunningInsecureContent: false`、`safeDialogs: true` | `main.js` |
| 导航 | DSH 视图仅允许**同源**在应用内导航；`will-navigate` / `will-redirect` / `window.open` 全部过策略；其他 http(s) 交系统浏览器；重定向不允许外跳；`file:` / `javascript:` / `data:` / `about:` / `ms-*` 等协议一律阻止并记日志 | `lib/security.js#decideNavigation` |
| 外链 | `shell.openExternal` 只接受 `http:`/`https:`（可用 `DSH_EXTERNAL_SCHEMES` 调整），其余拒绝 | `lib/security.js#decideOpenExternal` |
| 权限 | `setPermissionRequestHandler` + `setPermissionCheckHandler` **默认拒绝**摄像头/麦克风/地理/通知/HID/串口/USB/剪贴板读取等；仅放行 `clipboard-sanitized-write` 且必须同源；设备权限一律拒绝 | `lib/security.js#decidePermission` |
| IPC | 主进程只暴露 5 个固定 channel；每次调用校验 `event.sender === 侧边栏窗口`，来源不明直接拒绝并记日志；preload 不接受渲染进程传入的 channel 名 | `main.js#registerIpc`、`preload.js` |
| 渲染层 | 侧边栏与占位页都有严格 CSP（`default-src 'self'`、`connect-src 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'none'`）；所有动态内容用 `textContent` 写入，杜绝日志/命令行/URL 造成的 XSS | `renderer/*` |
| 目标地址 | `DSH_URL` 默认只接受本机地址；指向远端时**拒绝启动**，必须显式 `DSH_ALLOW_REMOTE=1` | `lib/config.js` |
| 终止进程 | 终止任何 pid 前必须通过证据校验（见上表 #4）；`taskkill` 只对通过校验的 pid 执行；拒绝时打印补救方式 | `lib/procs.js#decideKill` |
| 启动命令 | 永不使用 `shell:true`（避免命令注入面与不可回收的包装进程）；命令先解析成真实可执行文件与参数数组 | `lib/procs.js#buildSpawnPlan` |
| 日志 | 落盘前脱敏（查询串凭据、Bearer、URL 凭据、40+ 位 token）；可用 `DSH_LOG_REDACT_TOKENS=0` 关闭 | `lib/log.js#redact` |
| 单实例 | 防止多实例争抢端口/互相清理 | `main.js` |

已知取舍（有意为之，记录在案）：

- 权限白名单里的 `clipboard-sanitized-write` 是为了让 DSH 页面上的"复制"按钮可用；如需更严可设置
  `DSH_ALLOW_PERMISSIONS` 覆盖，或直接把该权限从 `lib/security.js` 的 `DEFAULT_ALLOWED_PERMISSIONS` 里删掉。
- 视图默认沿用 Electron 默认会话（保留你原来的本地登录态）。如需与系统其它 Electron 应用隔离，
  设置 `DSH_VIEW_PARTITION=persist:dsh-view` 使用独立分区（代价：可能需要重新登录/丢失页面本地状态）。
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
npm test                       # 43 个自动化用例
npm run selftest               # 真实环境自检（建议在普通终端运行）
npm run selftest -- --inspect 3080   # 只读查看 3080 被谁监听（不会终止任何进程）
npm run gen-icon               # 重新生成 icon.png / build/icon.ico
npm run dist                   # 打包安装包（需 electron-builder）
```

工作区根目录的 `dsh_electron.lnk` 双击即可启动（直接指向 `node_modules\electron\dist\electron.exe`，
无控制台窗口）。若移动了目录，请重建快捷方式。

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
| `DSH_VIEW_PARTITION` | 空 | 设置后视图使用独立会话分区（如 `persist:dsh-view`） |
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
npm test                        # 43 项：单测 + 集成测试 + main.js 装配层烟雾测试
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
- `tools/selftest.js` 会真正调用系统进程查询与终止命令，**必须在普通终端运行**；若检测到受限环境
  （`spawn EPERM`）会明确提示并以退出码 3 结束，而不是让你误以为代码有问题。
- 任何一次测试/自检都不会操作 3080（脚本内置断言拒绝），需要查看 3080 时只做只读检查。

## 九、打包

```powershell
npm install                     # 同步 devDependencies（含 electron-builder）
npm run gen-icon                # 可选：重新生成图标
npm run dist                    # 输出到 dist/：Windows NSIS 安装包 + 免安装版
```

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

### 从 v1.0.0 切换到 v1.1.0（重要）

当前若还在跑旧实例，它的清理逻辑会"杀掉任何监听 3080 的进程"，因此：

1. **推荐**：先在旧实例上完全退出（窗口 × → "关闭并退出"，或托盘菜单"退出"）。
   旧实例会终止它此前拉起的那个 dsh（当前 GUI 页面会断开，属正常），随后双击快捷方式启动 v1.1.0，
   新版发现端口空闲会自己拉起新服务，页面恢复。
2. **不想中断当前会话**：直接启动 v1.1.0（新版会把它判定为 `reuse`，不会动它），
   等旧实例退出后再在新版里点"重启服务"。
3. ⚠ 不要在新版已经拉起服务后，再让**旧版**执行"关闭并退出"——旧版会把新版的服务一起杀掉。

回滚：本目录已是 git 仓库，`git checkout d09f279 -- .` 可恢复 v1.0.0 的代码
（快照提交 `d09f279`，标签 `v1.0.0-snapshot`）。

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
| `main.js` | 主进程装配：单实例、安全策略执行、窗口/视图/托盘、IPC、轮询与退出清理 |
| `preload.js` | contextBridge 暴露 5 个固定接口给侧边栏 |
| `renderer/index.html` `sidebar.css` `sidebar.js` | 侧边栏 UI（严格 CSP，全部 `textContent` 渲染） |
| `renderer/view-placeholder.html` | 服务未就绪时的占位页 |
| `lib/*.js` | 可单测的业务逻辑（见上） |
| `tests/*.test.js` | 41 个自动化用例；`tests/dummy-server.js` 为假 DSH 服务 |
| `tools/selftest.js` | 真实环境全链路自检 / 只读端口检查 |
| `tools/gen-icon.js` | 纯 Node 生成 `icon.png` 与 `build/icon.ico` |
| `build/icon.ico` `build/icon.png` | 打包资源（由 `gen-icon` 生成） |
| `load-status.log` | 运行日志（自动轮转，凭据脱敏） |
