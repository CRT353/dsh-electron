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
| `02-projects/dev/dsh_electron/` （应用仓库） | 分支 `main`，版本号 **1.4.1**（提交 `5089dd6`；其后只有文档提交）|
| `D:\Desktop\08-AI_Workspace\`（工作区仓库） | 分支 `main`；gitlink 指向应用仓库的某个提交 —— **本行不再写死编号**，用 `git ls-files -s 02-projects/dev/dsh_electron` 查 |
| 测试 | 应用：`npm test` → **126/126**；会话工具箱：`node --test --test-isolation=none session-log-tools.test.mjs` → **21/21** |
| **DSH 版本** | **`0.2.0-rc.2`**（2026-10-16 由 `0.1.1-rc.2` 升级，**破坏性变更**：Web 服务加了令牌 + 会话 Cookie 两步认证）|
| DSH 服务 | 由 Electron 外壳管理，`127.0.0.1:3080`。**外壳必须 ≥ v1.4.1 才能配 DSH 0.2**（v1.4.0 及更早会卡在"服务未就绪"）|
| **插件层级** | 见本仓库 **[DSH-PLUGIN-LAYERS.md](./DSH-PLUGIN-LAYERS.md)** —— 想做层级/溯源相关开发，**先读它** |
| **会话格式** | 当前日志为 **format v4**（文件名 `session.v4.jsonl.zstd`）；盘上仍有 53 份 **v0**（`session.jsonl.zstd`）。解码模型见 `02-projects/dev/dsh-session-tools/README.md` 的「解码模型」一节 |

先跑一次 `git -C <仓库> log --oneline -20` 与 `npm test` 复核，再动任何东西。

> **2026-10-17 交接（会话工具箱被 DSH 0.2 打破 → 修复 + 体检脚本补两项）**
>
> **发生了什么**：`npm test` 一直是绿的，但**会话工具箱整个跑不起来** ——
> `node --test session-log-tools.test.mjs` 在 import 阶段就 `SyntaxError`：
> `dsh-session/lib/types/index.js does not provide an export named 'decodeStorageRecord'`。
> 根因：DSH **0.2.0-rc.2 删除了 `decodeStorageRecord`**，而旧代码用**写死的绝对路径**
> （`D:/nvm/v24.18.0/...`）import 这个内部导出 —— 换 Node 版本也会一起断。
>
> **修法**（详见 `02-projects/dev/dsh-session-tools/README.md` 的「解码模型」）：
> 新增桥接层 `session-log-dsh.mjs`：**运行时定位** DSH 安装（从 `process.execPath` 推导，
> 支持 `DSH_PACKAGE_ROOT` 覆盖），按日志头行的 `version` 取该版本**已发布**的物理 codec
> （`releasedV0…V4SessionFormatCodec`），用 `require(ESM)`（Node ≥ 22.12）同步加载。
>
> **踩到的三个坑（都写进了 README，别重演）**：
> ① **一行 ≠ 一个事件**：format v0 有"紧凑 run 行"（一行 12 个事件）。本机某份 v0 日志有
> **1840** 个（359157 事件），另一份 **9287** 个（340765 事件）。按形状直读会把这两份**健康**
> 日志报成"大量不可解析行"。
> ② **codec 是有状态的全量解码器**：必须从第 1 行顺序喂；「单事件行走快速路径、复杂的才给
> codec」会让它只拿到后半段 → run 行展开成 0 个事件 → **健康日志被误报成 seq gap**（真踩了）。
> ③ **recovery 要用 `strict`**：DSH 自己读日志用 `recoverable`，它会记下首个问题后**静默吞掉
> 后续所有行**、直到 `turn/end` 才抛 —— 报错行号误导，而且把工具直接崩掉。`strict` 精确到行，
> 再由 `safeDecodeRow` 归一成 `seq-gap`/`unparsable`；**解不了**（没装 DSH）一律报
> 「无法判定（不是损坏）」并拒绝改文件，绝不谎报损坏。
>
> **顺带修掉的既有缺陷**：`region.mjs` 在**健康**日志上把"尾部连续性"的期望起点算成
> 全文件事件总数 → 一份健康日志被报成"异常次数 173661"。现已按关注点之前的事件数计算。
>
> **测试**：14 → **21** 项（新增：接线表、v4 双路径一致、整份走 codec、诚实降级契约、
> codec 抛错不崩栈、region 健康路径）。另在**真实日志**上验收：4 份（2×v0 + 2×v4）全部判为健康。
>
> **体检脚本补了两项**（`tools/workspace-check.ps1`，此前 `03-shortcuts/README.md` 声称
> "已固化进体检脚本"，实际**从未实现**）：
> 第 7 项扫 `03-shortcuts/*.lnk` 的目标/工作目录/**参数里的路径**；
> 第 8 项校验**文档里的工作区路径引用**能否解析。第 8 项当场抓出 4 处失效引用（都已修）：
> 根 `README.md` 的 `02-projects/prog-guide`（3 处）、`release/dsh_electron/README.md` 的
> `source/dsh_electron/node_modules`。另外根 README 的"环境摘要"曾称 python / ESP-IDF
> **不可用**，与 `ENVIRONMENT.md` 直接矛盾 —— 已改为与之一致。
>
> **遗留（已于 2026-10-17 补上）**：`release/dsh_electron/1.4.1/` 已构建并归档（标签 `v1.4.1`
> → 提交 `c0eda6f`），自动验收 9/9、另在随机端口做了真机端到端验证。详见该目录的 `RELEASE.txt`；
> 升级与回滚步骤在 `D:\Desktop\09-DSH升级操作\升级操作.md`。

> **2026-10-16 交接（DSH 0.2 升级 + 外壳适配）**
>
> **发生了什么**：用户把 DSH 从 `0.1.1-rc.2` 升到 `0.2.0-rc.2`。升级后**网页正常，但 Electron 外壳起不来** ——
> 报"服务未在 60s 内就绪"，而日志里服务其实已经起来了。
>
> **根因（两步都踩了）**：0.2 给本地 Web 服务加了**令牌 + 会话 Cookie 两步认证**：
> ```
> GET /                              -> 401
> GET /?token=<secret>               -> 303 + Set-Cookie: dsh-auth-<rand>=v1.…
> GET /（带 Cookie，不带 query）      -> 200 + text/html
> GET /?token=<secret>（带 Cookie 且仍带 query）-> 303   ← 令牌一次性
> ```
> ① v1.4.0 只做了"取令牌并带上"，拿到的是 **303**，旧判据 `status < 500 && !isRedirect` 判 `weak` → 仍不就绪；
> ② 补兑换时又踩了第二个坑：**重试必须去掉 query**，否则仍得 303。
> 顺带解开一个费解现象：**视图能加载、健康检查却永远不就绪** —— Electron 的 `webContents`
> 自带 Cookie 罐（跳转时自动保存并回带），而裸 `fetch` 没有。
>
> **修法**：`lib/service.js` 从服务 stdout 取令牌（`parseAuthenticatedUrl`，必须在日志脱敏之前取）；
> `lib/health.js` 完成"令牌 → Cookie → 去掉 query 重试"的兑换，**仅同源**，跨源一律不跟随
> （v1.3.1 审计的 fail-closed 边界不变，新增专门测试守住）。
>
> **测试**：119 → **126** 项，全过。新增 `tests/dummy-dsh-02.js`（完整复现上述四行行为）与
> `tests/token-adapter.test.js`（5 项解析单测 + 2 项集成，含"拒绝跨源重定向"）。
>
> **能力边界（有意为之）**：令牌只在"本外壳拉起服务"的那次 stdout 里，所以**外部已运行的服务
> 不能再被直接复用**。要交回外壳管理，先停掉外部服务再由外壳拉起。
>
> **新增文档**：**[DSH-PLUGIN-LAYERS.md](./DSH-PLUGIN-LAYERS.md)** —— 插件组合层级的实证说明
> （空根 → base 94 行 → web-app 85 行 → 用户层 → home 层 → --patch）+ 开发注意事项。
> 起因：官方的插件列表页**只按作用域分组，没有层级、没有空根、没有基础 agent 框架**，
> 想做层级相关开发必须先有一份准确的层级事实。
>
> **遗留**（2026-10-17 已解决）：当时的 `release/dsh_electron/` 里**还没有 `1.4.1/` 分发产物**
> ——现已构建归档，见 `1.4.1/RELEASE.txt`。
> 升级与回滚的完整步骤在 `D:\Desktop\09-DSH升级操作\升级操作.md`。


> **2026-10-03 复核（新会话执行，逐条实测）**：上表除一行外全部属实 —— 两仓库 HEAD 与 gitlink 一致
> （均为 `0fd1df1`）、`npm test` → **118/118**、会话工具箱 → **12/12**、两个仓库确实都没有 remote。
> **修正一处已失效的记载**：原表"DSH 服务"行称"运行中的外壳是修复前的代码"，
> 实测 `02-projects/dev/dsh_electron/load-status.log` 记有
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
> 的情况下正常启动并复用 3080 的已有服务）。详见 `02-projects\release\dsh_electron\1.3.2\RELEASE.txt`。
> 至此**第二节已无待办项**，只剩第 2 条（加远端，需用户提供远端地址）。

## 二、待办（按优先级）

### 1. ✅ 已完成（2026-10-03）打包版的端到端验证 —— 当初唯一没能验证的修复
- **结果：通过。** 产物已构建（`dist\` 两个 exe，构建自提交 `0fd1df1` = 标签 `v1.3.1`），
  并已按现有约定发布到 `02-projects\release\dsh_electron\1.3.1\`（含 `SHA256SUMS.txt` 与 `RELEASE.txt`）。
- **怎么验的（不需要人工双击）**：① 拿产物 asar 里的**真实字节**跑 `lib/config.js`
  —— 它不依赖 Electron，于是"日志会不会落进 asar"可以自动化验收：确认打包态日志路径落在
  userData、不指向 `app.asar`，并实测 `<asar>\load-status.log` 写入确实抛 `ENOENT`（旧缺陷实证）；
  ② 真启动 `dist\win-unpacked\DSH Desktop.exe`：日志确实产生在 userData 目录内、内容含
  "DSH Electron 启动（v1.3.1，Electron 33.4.11，Node 20.18.3）"。两次都只使用随机空闲端口上的
  假服务，**未接触 3080**。
- **已固化成仓库工具**：`02-projects\dev\dsh_electron\tools\verify-packaged-logpath.js`
  （`npm run dist` 后执行 `node tools\verify-packaged-logpath.js`，退出码 0 = 通过，共 8 项检查）。
  以后这类"打包态行为"不必再靠人工双击来验。
- **仅剩一条需人工**：侧边栏"打开日志"按钮点击后是否真能打开文件（日志文件本身已确认存在、
  路径计算正确）。注意 `%APPDATA%\DSH Desktop` 这个目录**根本不会被创建** —— 原因见下面新增的第 6 条。
- **注意**：`02-projects\release\dsh_electron\1.3.0\` 里的 exe 是**修复前**的产物，不要拿它做验证。

### 2. ✅ 已完成（2026-10-15）两个仓库都已加远程并推送
- ~~应用仓库 `02-projects/dev/dsh_electron` 与工作区仓库 `D:\Desktop\08-AI_Workspace\` **都没有远程**~~
  → **现已配好 SSH 远端**：应用 `git@github.com:CRT353/dsh-electron.git`、工作区 `git@github.com:CRT353/ma_workspace.git`，
  密钥 `~/.ssh/id_ed25519`。**无 `gh` CLI，也无 https 凭据助手 → remote 必须保持 SSH 形式。**
- 推送顺序：**先子仓库、后根仓库**（根仓库用 gitlink 记录子仓库提交）。
- `git push` 走 SSH 偶发 `Connection reset … port 22`（网络瞬断，非权限问题）→ 重试即可成功。

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
  已有服务、未影响正在运行的服务。详见 `02-projects\release\dsh_electron\1.3.2\RELEASE.txt` 第六节。

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
  `tools/*.js`（含 `verify-packaged-logpath.js`）、`tests/*.test.js`（**126 项**）、`renderer/*`。
- 会话工具箱：`02-projects\dev\dsh-session-tools\README.md`（**「解码模型」一节是改它之前必读**）+
  `session-log-*.mjs` + `session-log-dsh.mjs`（DSH codec 桥接层）+ `session-log-tools.test.mjs`（**21 项**）。
- 已发布产物：`02-projects\release\dsh_electron\1.3.1\`（`SHA256SUMS.txt` + `RELEASE.txt`，
  后者第五节"验证状态"记的就是本轮实测结论）。
- 标签：`v1.3.1` → `0fd1df1`（= 1.3.1 产物的构建来源）。后续提交都是**发布之后**的提交，未打标签。
- 上一轮（审计修复）每个档位都是独立提交，任一提交都是干净回退点：
  `git -C 02-projects\dev\dsh_electron log --oneline 3175149..0fd1df1`
  （`3175149` 是审计修复开始前的基线，`0fd1df1` = 标签 `v1.3.1`）。
