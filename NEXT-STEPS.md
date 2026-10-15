# NEXT-STEPS —— 交给下一个会话

> **归属说明**：本文件是**会话交接文档**，记录 `dsh_electron` 这个项目未完成的待办与踩坑经验，
> 因此放在本仓库根目录；它**不是**任何上层目录的说明（项目区那一层的说明是
> `02-projects/README.md`）。2026-10-12 由 `02-projects/NEXT-STEPS.md` 迁入此处。
>
> 本文件由上一轮会话在 2026-09-30 写下，用于交接"审计修复"之后剩下的任务。
> 读完之后可以按需更新或删除；**长期文档是本仓库的 `README.md` 与 `CHANGELOG.md`**。

## 一、当前状态（先核对，不要凭本文件相信）

| 位置 | 状态 |
|---|---|
| `source/dsh_electron/` （应用仓库） | 分支 `main`，版本号 **1.3.2**，标签 `v1.3.2` → `6ce6c0f`（= 1.3.2 产物的构建来源） |
| `D:\Desktop\08-AI_Workspace\`（工作区仓库） | 分支 `main`；gitlink 指向应用仓库的某个提交 —— **本行不再写死编号**，用 `git ls-files -s 02-projects/dev/dsh_electron` 查 |
| 测试 | 应用：`npm test` → **119/119**；会话工具箱：`node --test --test-isolation=none session-log-tools.test.mjs` → **14/14** |
| DSH 服务 | 由 Electron 外壳管理，`127.0.0.1:3080`。运行中的是**开发版**外壳（v1.3.1 代码，启动于 10-03 12:09；1.3.2 只改了打包配置，对开发态运行时无影响，**不必为它重启**） |

先跑一次 `git -C <仓库> log --oneline -20` 与 `npm test` 复核，再动任何东西。

> **2026-10-03 复核（新会话执行，逐条实测）**：上表除一行外全部属实 —— 两仓库 HEAD 与 gitlink 一致
> （均为 `0fd1df1`）、`npm test` → **118/118**、会话工具箱 → **12/12**、两个仓库确实都没有 remote。
> **修正一处已失效的记载**：原表"DSH 服务"行称"运行中的外壳是修复前的代码"，
> 实测 `source/dsh_electron/load-status.log` 记有
> `2026-10-03T04:09:39Z [INFO] DSH Electron 启动（v1.3.1，Electron 33.4.11，Node 20.18.3）`，
> 且外壳进程启于 10-03 12:09（源码最后改动为 09-30 23:51）→ **当前外壳已是修复后的代码**；
> 3080 的监听者（pid 3572）也已由外壳**接管**（`04:10:15 已接管服务 来源=commandline-match`），
> 不是 `reuse`。所以"重启外壳才生效"这一条**已自然满足**，不必再重启。
> 另核对 `dist/` 为空目录、`%APPDATA%\DSH Desktop` 不存在 → **待办 1（打包版端到端验证）仍未开始**，结论不变。
> 同时修掉了根 `README.md` 两处过期数字（`npm test` 61 项 → 118 项；`selftest` 不再写"13 项"这个硬数字）。
>
> **2026-10-03 同一会话续作**：待办 1、3、4 全部完成（详见第二节各条），发布 `v1.3.1` 产物，
> 并**新发现**一条打包版身份问题（待办 6）。此后测试项数变为应用 **119**、工具箱 **14**。
>
> **2026-10-03 再续（收尾）**：待办 6 也已修复并发布 —— **v1.3.2**（`build.extraMetadata.productName`，
> 打包版 userData 改为 `%APPDATA%\DSH Desktop`，与开发版彻底分开）。验收工具 9 项全通过、
> 无 `[WARN]`；并做了真实用户路径实测（免安装版、无参数、默认 userData、**开发版外壳同时运行**
> 的情况下正常启动并复用 3080 的已有服务）。详见 `releases\dsh_electron\1.3.2\RELEASE.txt`。
> 至此**第二节已无待办项**，只剩第 2 条（加远端，需用户提供远端地址）。

## 二、待办（按优先级）

### 1. ✅ 已完成（2026-10-03）打包版的端到端验证 —— 当初唯一没能验证的修复
- **结果：通过。** 产物已构建（`dist\` 两个 exe，构建自提交 `0fd1df1` = 标签 `v1.3.1`），
  并已按现有约定发布到 `releases\dsh_electron\1.3.1\`（含 `SHA256SUMS.txt` 与 `RELEASE.txt`）。
- **怎么验的（不需要人工双击）**：① 拿产物 asar 里的**真实字节**跑 `lib/config.js`
  —— 它不依赖 Electron，于是"日志会不会落进 asar"可以自动化验收：确认打包态日志路径落在
  userData、不指向 `app.asar`，并实测 `<asar>\load-status.log` 写入确实抛 `ENOENT`（旧缺陷实证）；
  ② 真启动 `dist\win-unpacked\DSH Desktop.exe`：日志确实产生在 userData 目录内、内容含
  "DSH Electron 启动（v1.3.1，Electron 33.4.11，Node 20.18.3）"。两次都只使用随机空闲端口上的
  假服务，**未接触 3080**。
- **已固化成仓库工具**：`source\dsh_electron\tools\verify-packaged-logpath.js`
  （`npm run dist` 后执行 `node tools\verify-packaged-logpath.js`，退出码 0 = 通过，共 8 项检查）。
  以后这类"打包态行为"不必再靠人工双击来验。
- **仅剩一条需人工**：侧边栏"打开日志"按钮点击后是否真能打开文件（日志文件本身已确认存在、
  路径计算正确）。注意 `%APPDATA%\DSH Desktop` 这个目录**根本不会被创建** —— 原因见下面新增的第 6 条。
- **注意**：`releases\dsh_electron\1.3.0\` 里的 exe 是**修复前**的产物，不要拿它做验证。

### 2. 【需用户决定】两个仓库都没有 remote
- 应用仓库 `source\dsh_electron` 与工作区仓库 `D:\Desktop\08-AI_Workspace\` **都没有远程**，全部历史只在本机。
- 这是用户最初说"稍后再和其他更新一起考虑"的第 4 项。要加就先建私有远端再 `git remote add` + `push --all --tags`。

### 3. ✅ 已完成（2026-10-03）`session-log-repair.mjs` 大区间输出爆炸
- **改法**：超过阈值即汇总 —— 记录列表 >8 条时打印"共 M 条记录，区间 #a–#b（文件第 x–y 行）；前 5 条: …"。
- **顺带修掉第二个爆炸点**（原记录里没提到）：`plan.dupSeqs.join(",")` 在重复量大时比记录列表更长，
  现同样在 >12 个时收口为"前 8 个 … 最后一个（共 N 个重复序号）"。
- **实测**：1.2 万条记录夹具的 stdout 从 14KB+ 降到 **1026 字节**；小夹具（5 条）仍逐条打印明细，
  可读性没有因为汇总而丢失。上面第 1 条里提到的"16 项断言"式核对口径同样适用：断言条数只增不减。
- **回归测试 2 条**：`缺陷 C：大区间重复的计划打印必须汇总，stdout 稳定在约 1KB` 与
  `缺陷 C 回归对照：小规模重复仍逐条打印明细（汇总不得吃掉可读性）`。工具箱测试 12 → 14 项。

### 4. ✅ 已完成（2026-10-03）托盘"窗口可见时不打扰"分支
- 新增用例 `托盘翻转通知：窗口可见时不弹气泡，只在日志里如实记录（不打扰）`：窗口保持可见 →
  关掉服务 → **先轮询等日志里出现"DSH 服务不可达"**（把"翻转确实发生了"这个前提等到手，
  否则"没弹气泡"可能只是还没轮到翻转 → 假通过）→ 再等一轮 → 断言 `tray.balloons` 为空
  且窗口仍可见（第二条断言防的是"窗口被意外隐藏导致假通过"）。
- 不需要"同端口重建服务"那套：只要翻转发生在窗口可见期间即可（可见分支本来就只记日志）。
- 应用测试 118 → 119 项。

### 5. 【环境受限】以下部分在受限沙箱里**做不到**，需要真实环境
- 真实 Electron GUI 行为：`WebContentsView` 真实布局/层级、托盘图标真实加载、`showMessageBoxSync` 真实返回值、
  `shell.openExternal` 的真实失败、`webContents.send → preload → sidebar.render` 的跨进程契约、真实沙箱效果。
  （测试文件头部已写明"不能替代人工双击验证"。本轮仍未能覆盖：启动打包版看界面。）
- `lib/exec.js` 的**成功路径**：沙箱禁止同步子进程管道（`execFileSync` 一律 `EPERM`），只能覆盖失败契约。
- `npm run dist`：**本轮实测可行**，但要申请一次更宽的权限 —— electron-builder 需以管道拉起
  `app-builder.exe`，受限模式下报 `spawn EPERM`；授权后一次通过（缓存里已有 NSIS 工具链，未走网络）。
- **启动打包版 GUI 同理**：受限模式下 Electron 启动即崩（本轮观测到 `0x80000003`，
  与上一轮记的 `0xC0000005` 不同，但同属"沙箱内起不来"）；授权后可正常启动并跑完验证。
  顺带解释上一轮那个 `0xC0000005`：打包版 userData 在 `%APPDATA%`（工作区之外），
  受限文件沙箱会拒绝那次写入。

### 6. ✅ 已完成（2026-10-03）打包版 userData 与开发版共用 → 两个版本不能同时运行
- **现象**：打包版的 userData 实际是 `%APPDATA%\dsh-electron`，**与开发版（`npm start`）同一个目录**，
  而不是当时的 README / `RELEASE.txt` 里写的 `%APPDATA%\DSH Desktop`。
- **根因**（实测确认）：打包产物内的 `package.json` 只有 `name="dsh-electron"`，**没有顶层 `productName`**
  （`productName` 只写在 `build` 段里，electron-builder 不会把它带进 asar），而 Electron 的
  `app.getPath('userData')` 由 `app.getName()` 决定、且**优先取顶层 `productName`**。
- **影响**：两版单实例锁落在同一目录，**不能同时运行**；后启动的那个一启动就静默退出
  （退出码 0、无窗口、无日志），表现就是"双击没反应"。
- **修法（1.3.2）**：`build` 段加 `extraMetadata: { productName: "DSH Desktop" }` ——
  electron-builder **只把它注入打包产物**的 package.json，源码那份不变，于是开发版仍是
  `dsh-electron`、打包版变成 `DSH Desktop`，两者彻底分开。
  ⚠ **反例（我一开始就说错了，记下来）**：直接在 `package.json` **顶层**加 `productName` 是**修不好**的
  —— 开发版与打包版读的是同一份内容，会一起变成 `DSH Desktop`，仍然共用目录。
  凡是"只改 package.json"的方案都不可能区分两版，**必须让改动只作用于打包产物**（`extraMetadata`）
  或按 `app.isPackaged` 在代码里区分。
- **验收**：`verify-packaged-logpath.js` 新增"产物是否带顶层 productName"检查；本版 9 项全通过、无 `[WARN]`。
  另做了真实用户路径实测（免安装版、无参数、默认 userData、**开发版外壳同时运行**）：
  1.3.1 在同样条件下会秒退，1.3.2 正常启动、日志落在 `%APPDATA%\DSH Desktop`、且复用了 3080 上的
  已有服务、未影响正在运行的服务。详见 `releases\dsh_electron\1.3.2\RELEASE.txt` 第六节。

## 三、低危未改项（已审议，只在代码里留了注释，不要"顺手"改掉）
- `lib/security.js#isLocalHost` 接受 `*.localhost`（与 RFC 6761 / Chromium 一致；要利用需用户自己设 `DSH_URL`）。
- `lib/security.js#decideNavigation` 不接 `DSH_EXTERNAL_SCHEMES`（导航层恒用默认白名单，只能收紧不能放开，
  方向是 fail-closed；外链条路径会应用该配置）。
- `preload.js` 暴露的 `getLogTail` 目前界面未使用（README 已如实标注为 6 个接口）。

## 四、这个环境的坑（踩过的，别再踩）
1. **不要用管道捕获子进程输出**：受限沙箱里 `spawn/execFileSync` 默认 `stdio:'pipe'` 会直接 `EPERM`。
   需要输出就重定向到临时文件再读回（`tests/selftest.test.js` 的 `runNode()` 是现成范例）；
   子进程只需要"跑起来"时用 `stdio: ['ignore','ignore','ignore']`（服务测试就是这么做的）。
2. **"提交工作区仓库会被拒"取决于会话工作区设在哪**：上一轮会话工作区是 `02-projects`，
   于是 `D:\Desktop\08-AI_Workspace\.git` 在区外、确实被拒；2026-10-03 这一轮会话工作区**就是**
   `D:\Desktop\08-AI_Workspace` 本身，直接提交成功、没申请任何权限。**先 `pwd` 再下结论**，
   别把上一轮的环境约束当成本轮的事实。
3. **Electron 在受限模式下起不来**（本轮观测 `0x80000003`，上一轮记的是 `0xC0000005`，同属"沙箱内起不来"）。
   申请一次更宽权限后**可以**正常启动、并跑完打包版端到端验证；用 `--user-data-dir=<工作区内目录>`
   把 userData 指到工作区里更省事。别在受限模式下指望跑 GUI 或打包产物。
   补充：`npm run dist` 也属同类（`spawn EPERM`），授权后一次通过。
4. `Get-CimInstance` / `wmic` 不可用（读不到别的进程命令行）；`netstat` 可用。
5. **绝对不要碰 3080**：所有实验只用随机空闲端口；`npm run selftest -- --inspect <port>` 只读；
   会话工具箱**绝不**对真实会话日志跑 `--apply`（测试夹具一律在 `os.tmpdir()` 下现造现删）。

## 五、上一轮踩过的错误模式（写下来是为了让你别重演）
1. **编辑时把锚点当上下文、却没在替换文本里带回它** → 吃掉既有代码（上一轮发生了 3 次：一条断言、一行
   `const`、一处恢复，都靠重新读取才发现）。**规则：替换文本必须完整包含锚点原文**；
   改完立刻 `node --check`，并在测试文件里核对"断言条数"或"用例条数"没有减少。
2. **测试期望想当然**（上一轮 4 次：以为 `lastError()` 返回整条、以为某形态已实现、cause 层数方向数反、
   否证词恰好出现在说明文字里）。**规则：断言写完后先看一眼代码实际返回什么**。
3. **同名变量冲突**：新加的顶层 `const` 与文件既有变量重名（`frames` / `after`）→ `node --check` 抓出。
   加变量后可以用"顶层 const 出现次数 > 1"扫一遍。
4. **改动引入回归**：新的"详细探测"无条件默认，覆盖了测试注入的桩（用例真的去探了 3080）→ 全量回归当场变红。
   **规则：每批改动后跑全量 `npm test`，不要只跑单个文件。**
5. PowerShell 里提交信息含全角引号会被当成引号把参数切碎 → 用 here-string（`@'…'@`）传 `-m $msg`。

## 六、索引（要找东西从这里进）
- 应用：`README.md`（**v1.3.1 变化**一节逐组记录了本轮改了什么、旧实现的具体表现）、`package.json`、`main.js`、`lib/*.js`、
  `tools/*.js`（含本轮新增的 `verify-packaged-logpath.js`）、`tests/*.test.js`（119 项）、`renderer/*`。
- 会话工具箱：`source\dsh-session-tools\README.md` + `session-log-*.mjs` + `session-log-tools.test.mjs`（14 项）。
- 已发布产物：`02-projects\release\dsh_electron\1.3.1\`（`SHA256SUMS.txt` + `RELEASE.txt`，
  后者第五节"验证状态"记的就是本轮实测结论）。
- 标签：`v1.3.1` → `0fd1df1`（= 1.3.1 产物的构建来源）。后续提交都是**发布之后**的提交，未打标签。
- 上一轮（审计修复）每个档位都是独立提交，任一提交都是干净回退点：
  `git -C 02-projects\dev\dsh_electron log --oneline 3175149..0fd1df1`
  （`3175149` 是审计修复开始前的基线，`0fd1df1` = 标签 `v1.3.1`）。
