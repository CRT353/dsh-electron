# DSH 插件层级 —— 开发参考（给下一个会话）

> **这份文档是什么**：DSH 插件**组合层级**的实证说明 + 下一轮开发的注意事项。
> **为什么需要它**：官方的插件 UI（设置 → 插件 → 插件列表）**只按作用域分组**，
> 完全看不到"从空根一层层叠起来"的结构。下面的层级是从**补丁文件实测提取**的，不是抄文档。
>
> **测量时间**：2026-10-16　**测量对象**：DSH `0.2.0-rc.2`（本机 `~/.dsh/profiles/web`）
> **配套文档**：[README.md](./README.md)（外壳本身）· [CHANGELOG.md](./CHANGELOG.md)（外壳版本史）· [NEXT-STEPS.md](./NEXT-STEPS.md)（上一个会话的交接）

---

## 一、先纠正一个容易搞错的前提

**官方的"插件列表"页没有层级显示。** 它不做这件事（官方 README 原文）：

| 它做的 | 它不做的 |
|---|---|
| 按**两个作用域**分组：`agent 预设` + `全局清单` | ❌ 不显示组合包层（bundle） |
| 预设分组默认展开、全局分组默认收起 | ❌ 不显示**空根** |
| 卡片显示：启停状态、**出处**、运行状态、禁用条件、发现失败 | ❌ 不显示**基础 agent 框架** |
| 搜索跨两组；展开卡片显示条目 id、完整模块标识 | ❌ 不显示**叠加顺序 / 谁覆盖了谁** |

它的行 key 是 `global:` 与 `preset:<id>:<index>` —— **按作用域限定，不是按层**。

**它还只读**：*"标签页不订阅 Loader 变化，也不会在重连后自动重新读取；重新打开 Settings 则会取得新快照。"*

> ⚠️ **另一个坑**：`dsh-web-app` 的依赖里声明了 `@deepseek-ai/dsh-plugin-manager` 与
> `@deepseek-ai/dsh-client-ui-plugin-manager`，但**本机 profile 里并没有这两个包**。
> 截图里那个"插件"面板实际来自 **`dsh-client-ui-settings-plugin-inventory`**。
> 查这件事时别看声明，要看 `profiles/node_modules/@deepseek-ai/` 里实际有什么。

**所以：想做"层级可视化 / 溯源账本"，没有现成的路，得自己解析补丁文件。**

---

## 二、三个维度，别混为一谈

| 维度 | 是什么 | 本机数量 |
|---|---|---|
| **① 组合包层 bundle** | 官方 patch 层，按 `dsh.profile.bundles` 顺序叠加 | **2 个**（base、web-app）|
| **② 插件行 entry** | 层里的具体插件，按 `id` 覆盖，**后写者赢** | base **94** 行 + web-app **85** 行 |
| **③ 预设 preset** | **每个浏览器会话**选一套 agent 子配置 | **4 个**（standard / ptc / minimal / cordis）|

**预设是"每会话"的，层是"每进程"的** —— 这是最容易搞混的一处。

---

## 三、完整层级（自下而上）

```
 最下 ┌────────────────────────────────────────────────┐
      │ 空根                                            │
      │   profiles/web/cordis.yml                       │
      │   · 内容是一个**空条目列表**                     │
      │   · **每次启动都被 prepareProfile 重写**         │
      │     （版本内置常量，所以永远不会与新版不匹配）    │
      └────────────────────────────────────────────────┘
                          ↓ 一个 insert 一次性塞入 94 行
      ┌────────────────────────────────────────────────┐
      │ 层 2: @deepseek-ai/dsh-base                     │
      │   94 行 / 1 个 insert / 12 处 disabled           │
      │   = 共享核心（模型、工具、会话、沙箱、编排）      │
      └────────────────────────────────────────────────┘
                          ↓ 2 个 insert（主机行）+ 27 行顶层 id 覆盖
      ┌────────────────────────────────────────────────┐
      │ 层 3: @deepseek-ai/dsh-web-app                  │
      │   85 行（insert 内）/ 2 个 insert / 27 处 disabled│
      │   = Web 表层（宿主 API、传输层、全部 UI）        │
      │   · 它把 base 的"按 agent 工具行"**禁用**，      │
      │     改由 preset 名录接管 ← 这是关键的架构切换     │
      └────────────────────────────────────────────────┘
                          ↓ 按 id 覆盖 / disabled / 追加 insert
      ┌────────────────────────────────────────────────┐
      │ 层 4: profile 用户层                            │
      │   profiles/web/cordis.patch.yml                 │
      │   · **本机当前是空的 `[]`**                     │
      │   · 想加插件 / 改配置，**就写在这里**            │
      │   · 预设设置的保存位置也是这里                   │
      └────────────────────────────────────────────────┘
                          ↓
      ┌────────────────────────────────────────────────┐
      │ 层 5: home 层（全 profile 共享）                 │
      │   $DSH_HOME/cordis.patch.yml                    │
      │   · **本机不存在**，需要时自建                   │
      └────────────────────────────────────────────────┘
                          ↓
 最上 ┌────────────────────────────────────────────────┐
      │ 层 6: --patch 覆盖层（命令行，仅本次调用）       │
      └────────────────────────────────────────────────┘
                          ↓ 最后
      ┌────────────────────────────────────────────────┐
      │ telemetry 开关（官方文档提到的最后一层）         │
      └────────────────────────────────────────────────┘
```

**合成顺序（官方 `dsh/README.zh.md` 原文）**：

> 配置树以空根为起点，依次叠加：`dsh.profile.bundles` 中各组合包的 patch → profile 自身的 `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` 指定的覆盖层

**bundle 解析顺序**：先从 **dsh 安装目录**解析（`dsh-base`、`dsh-web-app`、`dsh-headless`、`dsh-sdk-app`、`dsh-sdk-minimal`、`dsh-acp-app`），**再从 profile 自身的 `node_modules`** 解析。

---

## 四、两条必须记住的 patch 语义

### 4.1 覆盖是"整块替换"，不是"合并"

> 官方原文：*"patch 会替换目标行的**整个 `config`**，而不是合并进它。后续组合包层与用户的 profile `cordis.patch.yml` 按 id 覆盖行，**每行最后一次写入生效**。"*

**开发时的后果**：你想改一个已有行的某一个键，**必须把想保留的其它键全部重述一遍**，否则它们会消失。

**实证案例**（这就是为什么 web-app 会"重述"值）：

```yaml
# 层 2 dsh-base  L117-125
- id: session-query-sqlite
  name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: ':memory:'
    openAt: never

# 层 3 dsh-web-app  L30-34 —— 把同样的值又写了一遍
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: never
```

### 4.2 行 id 是覆盖的抓手

- 追加新插件：`- insert:` 下面列行
- 改已有插件：只写 `- id: <目标>` + 要覆盖的键
- 关掉某行：`- id: <目标>` + `disabled: true`

**实证案例**：

```yaml
# 层 2 dsh-base  L19-23
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root: ['.']

# 层 3 dsh-web-app  L22-24 —— 直接关掉，没有 name
- id: hmr
  disabled: true
```

---

## 五、层 2 `dsh-base` 全清单（94 行，按职责分组）

> 这是**基础 agent 框架**，也就是官方插件 UI **完全看不到**的那一层。

| 职责 | 插件行 |
|---|---|
| **插件管理** | `plugin-manager` · `tool-plugin-manager` · `config-editor` |
| **模型接入** | `llm` · `llm-deepseek` · `llm-deepseek-account` · `llm-pi-ai` · `agent-default-model` · `llm-retry` |
| **会话** | `session` · `session-log-deepseek` · `session-persistence-jsonl` · `session-projection` · `session-projection-cache` · `session-query-sqlite` · `session-title` · `session-title-llm` · `session-checkpoint-policy` |
| **存储** | `storage` · `storage-json` · `storage-domain` · `attachment-local` |
| **工具** | `tools` · `tool-fs` · `tool-fs-search` · `tool-bash` · `tool-pwsh` · `tool-jobs` · `tool-todo` · `tool-goal` · `tool-ralph` · `tool-skill` · `tool-web` · `tool-workflow` · `tool-subagent` · `tool-subagent-fork` · `tool-subagent-control` · `tool-subagent-list-agents` |
| **沙箱 / 权限** | `sandbox` · `sandbox-policy` · `bash-sandbox` · `pwsh-sandbox` · `fs-sandbox` · `fs-observation-policy` · `approval` · `permission` |
| **编排** | `agent` · `agent-loop` · `subagent` · `subagent-spawn-in-process` · `subagent-fork-in-process` · `jobs` · `goal` · `goal-round-driver` · `workflow-ptc` · `ptc-runtime` |
| **上下文管理** | `compaction-basic` · `tool-result-pruner` · `token-meter` · `image-offload` · `spill-local` · `spill-policy` · `timeout-policy` · `repeat-tool-reminder` |
| **网络 / MCP** | `web` · `web-search-deepseek` · `web-fetch-http` · `mcp-resources` |
| **技能 / 指令** | `skill` · `skill-filesystem` · `skill-badge` · `system-prompt` · `agent-instructions` |
| **命令** | `commands` · `command-feedback` · `command-goal` · `command-compact` |
| **遥测** | `otel` · `session-telemetry-otel` · `plugin-package-inventory-deepseek` |
| **账号 / 凭据** | `authorization` · `credentials` · `deepseek-account` |
| **基础设施** | `timer` · `hmr` · `typert` · `typert-loader` · `typert-gateway` · `subprocess` · `shell-env` · `settings` · `config-editor` · `plan-mode` · `user-questions` |

**平台门控**（重要）：`bash-sandbox` 与 `tool-bash` 携带 `disabled: !!js process.platform === 'win32'`，孪生行 `pwsh-sandbox` / `tool-pwsh` 以取反表达式**仅在 win32 挂载**。**本机是 Windows，所以实际生效的是 PowerShell 那一套。**

---

## 六、层 3 `dsh-web-app` 全清单（85 行，按职责分组）

| 职责 | 插件行 |
|---|---|
| **宿主 API 控制器** | `session-controller` · `job-controller` · `terminal-controller` · `workspace-controller` · `account-controller` · `settings-controller` |
| **传输层** | `webserver` · `connection` · `web-startup` · `web-runtime` · `modules` · `api-remotes` · `client-hmr` |
| **数据服务** | `workspace` · `workspace-files` · `workspace-changes` · `session-stats` · `session-turn-outline` · `session-reference` · `file-reference-local` · `file-upload` · `plugin-inventory` · `directory-picker` |
| **主界面** | `ui-layout` · `ui-renderer` · `ui-session` · `ui-conversation` · `ui-chat` · `ui-theme` · `ui-brand-official` · `locale` · `resources` |
| **侧边栏（已拆成 6 个）** | `ui-sidebar` · `ui-sidebar-right` · `ui-sidebar-files` · `ui-sidebar-browser` · `ui-sidebar-terminal` · `ui-sidebar-documentpreview` |
| **设置页** | `ui-settings` · `ui-settings-shell` · `-general` · `-models` · `-plugins` · `-plugin-inventory` · `-account` · `-agent-loop` · `-subagent` · `-web-search` · `-session-log` |
| **功能界面** | `ui-workspace` · `ui-workflow-run` · `ui-goal` · `ui-jobs` · `ui-plan` · `ui-subagent` · `ui-skill` · `ui-tool` · `ui-deliverables` · `ui-trajectory` · `ui-approval` · `ui-user-questions` · `ui-input-trigger` · `ui-commands` · `ui-reference` · `ui-message-feedback` · `ui-model-selection` · `ui-permission` · `ui-agent-preset` · `ui-attachment` · `ui-cordis` · `ui-open-in-app` · `ui-shortcuts` |
| **其它** | `desktop-product-telemetry` · `product-analytics` · `message-feedback` · `session-log-download` · `open-in-app` · `office-to-pdf` · `cordis-host-runner` · `cordis-inspect-providers` · `cordis-client-runner` · `subagent-model-selection-settings` · `shortcuts` |

---

## 七、层 3.5 preset 全清单（4 个）

`dsh-web-app/presets/` 下每个预设一个补丁文件，各声明一条 `@deepseek-ai/dsh-agent-preset`：

| preset | 文件 | 内容特征 |
|---|---|---|
| `standard` | `standard.patch.yml`（7511 B）| 默认。`persona` + `agent-instructions` + 完整工具 |
| `ptc` | `ptc.patch.yml`（7697 B）| Programmatic Tool Calling 模式 |
| `minimal` | `minimal.patch.yml`（3184 B）| 精简。无 `persona`，改用 `persistent-shell` + `pty` |
| `cordis` | `cordis.patch.yml`（8089 B）| 与 `standard` 同 persona，面向 Cordis 自身开发 |

> 官方原文：*"每个浏览器会话选择一个随发行版交付的 preset（默认 `standard`）… 保存结果**持久化到 `$DSH_HOME/profiles/web/cordis.patch.yml`**"*
> —— **所以"预设设置"最终也是落到层 4 的用户层**。

---

## 八、怎么自己重新取这些数据（下次不用猜）

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\node_modules\@deepseek-ai"

# 1. 各层的规模
foreach ($n in @('dsh-base','dsh-web-app')) {
  $f = "$p\$n\cordis.patch.yml"
  $l = Get-Content -LiteralPath $f
  "{0,-12} 总行={1,4}  insert 块={2}  行 id={3,3}  disabled={4}" -f $n, $l.Count,
    ($l | Select-String '^\s*-\s+insert:').Count,
    ($l | Select-String '^\s{4}-\s+id:').Count,
    ($l | Select-String 'disabled:').Count
}

# 2. 某一层的行 id 清单（4 空格缩进 = insert 内）
(Get-Content -LiteralPath "$p\dsh-base\cordis.patch.yml") |
  Select-String '^\s{4}-\s+id:\s*(.+)$' |
  ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() }

# 3. 看当前**合成后**的真实配置树（权威，但需能写 $DSH_HOME）
dsh --profile web --dump-config        # 含用户层
dsh --profile web --dump-default-config # 不含用户层
dsh --profile web --dump-config-schema  # 打印 JSON Schema（不是配置值）

# 4. 预设
Get-ChildItem -LiteralPath "$p\dsh-web-app\presets" -File | Select-Object Name, Length
```

**本机注意**：`--dump-config` 会尝试写 `$DSH_HOME`，在受限沙箱下会被拒（见第十节），需要提权。

---

## 九、⚠️ 开发注意事项（踩过的坑，逐条）

### 9.1 patch 语义类

| 坑 | 说明 |
|---|---|
| **覆盖不合并** | 改一个键必须重述整块 `config`，否则其余键消失。**这是最容易犯的错。** |
| **`insert` 是一次性的** | `dsh-base` 就是**一个 insert 把 94 行塞进空根**；后续层靠 `id` 找到它们 |
| **`disabled: true` 不需要 `name`** | 关一行只写 `id` + `disabled` 即可 |
| **同一个服务只能注册一次** | 在沙箱化文件系统提供方之上再加普通文件系统提供方 → **profile 加载失败**（两者注册同一个 `ctx.fs`）。二选一。 |

### 9.2 环境 / 沙箱类

| 坑 | 说明 |
|---|---|
| **本机工作区受限沙箱已坏** | `SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Desktop\08-AI_Workspace)` —— 受限模式**连命令都起不来**，只能提权。见 `ENVIRONMENT.md` 第十一之二节 |
| **`workspace-write` 的 temp 是按会话的私有子目录** | `<temp>\dsh-<hash>`，受限子进程的 `TMP`/`TEMP` 被改写；`read-only` **不授予任何** temp 写入权限。**这正是上面那类授权失败的根源机制** |
| **`Get-CimInstance` / `wmic` 不可用** | 读不到别的进程命令行；`netstat` 可用 |
| **`spawn EPERM`** | 沙箱禁止管道捕获子进程输出；Node 的 `child_process` 默认 `stdio:'pipe'` 会失败。同理 **git 走 SSH 推送**也踩这条 → 需提权 |
| **`--host 0.0.0.0` 被拒** | 官方出于安全在启动时拒绝；LAN 访问用 `--trusted-host` |

### 9.3 Web 认证类（**这轮踩得最狠的坑**）

DSH 0.2 起本地 Web 服务是**两步认证**，不是"带上 token 就行"：

| 请求 | 响应 |
|---|---|
| `GET /`（无凭据） | **401**（无 Content-Type、无正文）|
| `GET /?token=<secret>` | **303** + `Set-Cookie: dsh-auth-<rand>=v1.…`（`Location: ./`）|
| `GET /`（带该 Cookie，**不带 query**）| **200** + `text/html` ✅ |
| `GET /?token=<secret>`（带 Cookie，**仍带 query**）| **303** ← **令牌是一次性的** |

- **令牌不可外部指定**：`randomBytes(32)`，不落盘，只印在服务 stdout
- **`Set-Cookie` 含 `authority`（绑 主机:端口）与 `expiresAt`**
- **`dsh web` 的 URL 行与浏览器交接都是"就绪信号"**，只在 Loader 树结算 + required 检查 + Connection 认证可用之后才发出
- 外壳 v1.4.1 已完整适配（见 `lib/health.js` 的 `probeDsh`、`lib/service.js` 的 `parseAuthenticatedUrl`）

### 9.4 UI / 工具类

| 坑 | 说明 |
|---|---|
| **插件列表页只读且不订阅变化** | 要新快照得**重新打开 Settings**；切换标签页会用旧快照 |
| **`dsh plugin-manager` 实际没装** | 别按 web-app 的 `dependencies` 判断，要看 profile 的 `node_modules` 实际内容 |
| **`desktop` 是保留 profile 名** | CLI 拒绝针对它的启动与 `--dump-config`；npm CLI 也拒绝其插件管理请求 |
| **客户端插件热重载条件** | 客户端插件的无刷新重载**还需要 `pnpm run dev:web` watcher 同时运行**；否则要刷新页面 |

### 9.5 版本 / 兼容类

| 坑 | 说明 |
|---|---|
| **安装与启动会校验 DSH peer 范围** | 不兼容插件**需用户明确确认豁免**（`version-exemptions` / `allow-version` / `revoke-version`）|
| **`0.2.0-rc.2` 是 rc** | API 可能变；**升级 DSH 后要重跑** `npm test`（当前 126 项）并复核本文件 |
| **外壳必须 ≥ v1.4.1 才能配 DSH 0.2** | v1.4.0 及更早会卡在"服务未就绪" |

---

## 十、本机实测快照（2026-10-16）

| 项 | 值 |
|---|---|
| DSH 版本 | `0.2.0-rc.2` |
| 外壳版本 | `1.4.1`（提交 `5089dd6`）|
| 全局安装点 | `C:\nvm4w\nodejs` → 符号链接 → `D:\nvm\v24.18.0\node_modules\@deepseek-ai\dsh\` |
| profile | `$DSH_HOME/profiles/web`，`node_modules` 里 **197** 个 `@deepseek-ai` 包 |
| `dsh.profile.bundles` | `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` |
| profile pnpm 设置 | `nodeLinker: hoisted`、`autoInstallPeers: false` |
| 用户层 | `profiles/web/cordis.patch.yml` = 空 `[]` |
| home 层 | `$DSH_HOME/cordis.patch.yml` **不存在** |
| 服务 | `dsh web` 监听 `127.0.0.1:3080`，由外壳管理 |
| 应用测试 | **126 项全过**（`npm test`）|

---

## 十一、可以做但**官方没做**的方向（下一轮的候选）

按价值排序，都基于本文件的层级事实：

| # | 方向 | 为什么官方没有 | 数据源 |
|---|---|---|---|
| **1** | **层级溯源账本** | 官方列表只按作用域分组，**没有层与覆盖关系** | 三个 patch 文件 + `--dump-config` |
| **2** | **"这行为什么长这样"** | 每行显示：哪一层定义 → 哪几层覆盖过 → 谁赢了 → 从第几行来 | 同上 |
| **3** | **模拟覆盖**（改一个键，预览最终值） | `--dump-config` 只有结果，没有"如果改成 X" | 同上 |
| **4** | **归档区 `unarchiveSession`** | 官方 `dsh-workspace` **只有 `archiveSession`，没有取消归档** | 需要新增能力（风险较高，见下） |

**方向 1–3 是纯只读的**，风险低，且正好补上官方 UI 的空缺。

**方向 4 的风险提示**（上一个会话查到的）：
- `archivedSessionIds` 是**注册表全局**的集合，存在 `~/.dsh/storages/workspace.json`
- **磁盘文件从不删除**，注释说"accounting slots 保留以便取消归档时恢复位置"
- 但**没有 `unarchiveSession` 方法** —— 要么 patch 自带包（升级会被覆盖），要么写一个插件补上这个能力
- **绝对不要直接读写 `workspace.json`**：那是 rc 版的内部格式，升级改了 schema 会静默损坏用户数据

---

## 十二、相关文档

| 主题 | 去哪 |
|---|---|
| 外壳本身 | [README.md](./README.md) |
| 外壳版本史（含每个坑的实测证据）| [CHANGELOG.md](./CHANGELOG.md) |
| 上一个会话的交接 | [NEXT-STEPS.md](./NEXT-STEPS.md) |
| 本机环境审计 | `../../../ENVIRONMENT.md` |
| AI 工作规范 | `../../../AGENTS.md` |
| 官方插件清单页说明 | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-settings-plugin-inventory/README.zh.md` |
| 官方共享核心说明 | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/README.zh.md` |
| 官方 Web 表层说明 | `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-web-app/README.zh.md` |
| 官方启动器说明 | `D:\nvm\v24.18.0\node_modules\@deepseek-ai\dsh\README.zh.md` |
