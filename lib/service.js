'use strict';
/**
 * DSH 服务生命周期管理（不依赖 Electron，全部依赖可注入 → 可单测）
 *
 * 设计要点（对应本轮修复）：
 *  1. 串行化：ensure() 用 in-flight Promise 去重，避免并发拉起两个实例。
 *  2. 权威身份：以"监听 DSH 端口的真实 pid"作为服务身份，而不是 spawn 返回的
 *     包装进程 pid（Windows 下是 cmd.exe，kill 它杀不掉真服务）。
 *  3. 重启前先等端口释放，端口没空出来就放弃拉起（不再盲拉第二个实例）。
 *  4. 归属漂移检测：refresh() 每次轮询校验 pid 存活；发现"我们的 pid 死了但端口
 *     仍被服务"时判定 ORPHAN（疑似仍是我们的 dsh）或 TAKEOVER（被别人接管），
 *     并在 UI 上如实显示，不再谎报"本程序管理"。
 *  5. 终止校验：decideKill() 默认拒绝，只信"本程序记录/观察到的 pid"或
 *     "白名单进程名 + 命令行匹配 dsh"两种证据。
 *  6. 清理不吞异常：每一步都记进 steps，返回结构化结果，退出前只等有限时间。
 */

const { buildSpawnPlan, isPidAlive, decideKill, isPortInUse, waitForPortReleased, findListenerPid, TRUSTED_NAMES, DEFAULT_KILL_PATTERN } = require('./procs');
const { safeUrl } = require('./log');

const MODES = {
  UNKNOWN: 'unknown',
  REUSE: 'reuse',       // 外部启动的服务，本程序只复用、不管理
  FOREIGN: 'foreign',   // 有进程在监听，但不是 DSH（身份未确认）
  MANAGED: 'managed',   // 本程序拉起并管理
  STARTING: 'starting',
  STOPPED: 'stopped',   // 本程序管理的服务已停止
  ORPHAN: 'orphan',     // 我们的进程记录失效，但端口仍由一个疑似 dsh 的进程服务
  TAKEOVER: 'takeover'  // 端口被别的进程占用（不再是我们的服务）
};

class ServiceManager {
  constructor(options = {}) {
    const config = options.config || {};
    this.config = {
      url: config.url,
      host: config.host || '127.0.0.1',
      port: config.port || 3080,
      startCommand: config.startCommand || 'dsh web --no-open',
      cwd: config.cwd,
      env: config.env,
      stdio: config.stdio || ['ignore', 'pipe', 'pipe'],
      readyTimeoutMs: config.readyTimeoutMs || 60000,
      killTimeoutMs: config.killTimeoutMs || 8000,
      readyPollMs: config.readyPollMs || 1000,
      verify: {
        pattern: (config.verify && config.verify.pattern) || DEFAULT_KILL_PATTERN,
        allowUnverified: Boolean(config.verify && config.verify.allowUnverified)
      }
    };
    this.config.spawnPlan = config.spawnPlan || buildSpawnPlan(this.config.startCommand);

    this.logger = options.logger || { info() {}, warn() {}, error() {}, stream() {} };
    // 平台可注入：终止策略在两个平台上不同（Windows 树杀 / POSIX 信号），
    // 可注入才能在单机上同时覆盖两条分支。
    this.platform = options.platform || process.platform;
    this.deps = {
      spawn: options.spawn || require('child_process').spawn,
      kill: options.kill || ((pid, signal) => process.kill(pid, signal)),
      exec: options.exec || require('./exec').createExec(),
      probeHealth: options.probeHealth || (async () => ({ ok: false, reachable: false })),
      findListenerPid: options.findListenerPid || ((port, host) => findListenerPid(port, { host, exec: this.deps.exec })),
      readProcessInfo: options.readProcessInfo,
      isPidAlive: options.isPidAlive || isPidAlive,
      isPortInUse: options.isPortInUse || isPortInUse,
      waitForPortReleased: options.waitForPortReleased || waitForPortReleased,
      now: options.now || (() => Date.now()),
      sleep: options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))),
      setTimer: options.setTimer || setTimeout
    };

    this.state = {
      mode: MODES.UNKNOWN,
      starting: false,
      owned: false,          // 本程序是否对当前服务负责（拉起过或显式接管）
      everSpawned: false,
      adopted: false,
      proc: null,
      wrapperPid: null,
      listenerPid: null,
      listenerName: null,
      listenerCommandLine: null,
      listenerVerified: false,
      baselineListenerPid: null,
      observed: null,        // 当前实际监听端口的进程（信息展示用）
      listenerUnresolved: false, // 端口有响应但从未能解析出监听进程（netstat/ps 受限）
      readyFailure: null,    // 最近一次拉起的失败性质：identity-mismatch | timeout
      trustedPids: new Set(),
      expectingExit: false,  // 本次退出是否由本程序主动触发（避免把正常清理记成故障）
      lastError: null,
      lastKill: null,
      spawnCount: 0
    };
    this._inflight = null;
    this._killing = false;
    this._killResult = null;
  }

  snapshot() {
    const s = this.state;
    return {
      mode: s.mode,
      starting: s.starting,
      owned: Boolean(s.owned),
      managed: s.mode === MODES.MANAGED,
      adopted: Boolean(s.adopted),
      wrapperPid: s.wrapperPid,
      listenerPid: s.listenerPid,
      listenerName: s.listenerName,
      listenerVerified: Boolean(s.listenerVerified),
      observed: s.observed ? { pid: s.observed.pid, name: s.observed.name, dshLike: Boolean(s.observed.dshLike) } : null,
      lastError: s.lastError,
      lastKill: s.lastKill,
      spawnCount: s.spawnCount,
      readyFailure: s.readyFailure,
      listenerUnresolved: Boolean(s.listenerUnresolved),
      // "spawn 相关性"：该监听者是在我们拉起之后才出现的，且进程名属于可信名单。
      // 当命令行读不到（CIM/WMI 被策略限制）时，这是唯一可用的归属证据。
      spawnCorrelated: this._isSpawnCorrelated(s.observed),
      restartable: s.mode === MODES.MANAGED || s.mode === MODES.STOPPED,
      forceRestartable: Boolean(
        s.observed &&
        [MODES.REUSE, MODES.FOREIGN, MODES.ORPHAN, MODES.TAKEOVER].includes(s.mode) &&
        (s.observed.dshLike || (s.readyFailure !== null && this._isSpawnCorrelated(s.observed)))
      )
    };
  }

  /**
   * 监听者是否"由本程序拉起"（spawn 相关）：我们 spawn 过、它的 pid 与我们 spawn 前
   * 记录的基线不同、且进程名在可信名单内。用于命令行证据不可得时的接管判定。
   */
  _isSpawnCorrelated(listener) {
    const s = this.state;
    if (!listener || !listener.pid) return false;
    if (!s.everSpawned) return false;
    if (listener.pid === s.baselineListenerPid) return false;
    return TRUSTED_NAMES.has(String(listener.name || '').toLowerCase());
  }

  _isDshLike(listener) {
    if (!listener) return false;
    const name = String(listener.name || '').toLowerCase();
    const cmd = listener.commandLine || '';
    if (!TRUSTED_NAMES.has(name)) return false;
    if (cmd && this.config.verify.pattern.test(cmd)) return true;
    if (/dsh/i.test(name)) return true;
    return false;
  }

  async _resolveListener() {
    try {
      const listener = await this.deps.findListenerPid(this.config.port, this.config.host);
      if (!listener) return null;
      return { ...listener, dshLike: this._isDshLike(listener) };
    } catch (err) {
      this.logger.warn(`查询端口监听者失败: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  _adoptListener(listener, source) {
    const s = this.state;
    s.listenerPid = listener.pid;
    s.listenerName = listener.name || null;
    s.listenerCommandLine = listener.commandLine || null;
    s.listenerVerified = Boolean(listener.commandLine && this.config.verify.pattern.test(listener.commandLine));
    const appearedAfterSpawn = listener.pid !== s.baselineListenerPid;
    if (appearedAfterSpawn) s.trustedPids.add(listener.pid);
    s.observed = listener;
    s.owned = true;
    s.mode = MODES.MANAGED;
    s.lastError = null;
    s.listenerUnresolved = false;
    s.readyFailure = null;
    if (!s.listenerVerified) {
      this.logger.warn(
        `服务身份未通过命令行校验（pid=${listener.pid} name=${listener.name || '未知'}），` +
        `本次依据"${source}"纳入管理；清理时仍会做默认拒绝校验。`
      );
    }
    this.logger.info(`已接管服务：pid=${listener.pid} name=${listener.name || '未知'} 来源=${source}`);
  }

  /** 确保服务可用：已有则复用/校验归属，没有则拉起 */
  async ensure() {
    if (this._inflight) {
      this.logger.info('ensure() 已在执行中，复用同一次启动流程（防止重复拉起）');
      return this._inflight;
    }
    this._inflight = this._ensure()
      .catch((err) => {
        this.state.starting = false;
        this.state.lastError = `启动流程异常: ${err && err.message ? err.message : err}`;
        this.logger.error('启动流程异常', err);
        return this.snapshot();
      })
      .finally(() => { this._inflight = null; });
    return this._inflight;
  }

  async _ensure() {
    const s = this.state;
    const probe = await this.deps.probeHealth().catch(() => ({ ok: false, reachable: false }));
    const listener = await this._resolveListener();
    s.observed = listener;

    if (probe.reachable) {
      if (s.listenerPid && listener && listener.pid === s.listenerPid) {
        s.mode = MODES.MANAGED;
        this.logger.info(`服务健康，且监听者与本程序记录一致（pid=${listener.pid}）`);
        return this.snapshot();
      }
      if (!s.everSpawned && !s.adopted) {
        s.mode = probe.ok ? MODES.REUSE : MODES.FOREIGN;
        this.logger.info(
          `端口 ${this.config.port} 已有服务（外部启动，本程序只复用不管理）: ${safeUrl(this.config.url)} ` +
          `listener=${listener ? `${listener.pid}/${listener.name || '未知'}` : '未知'} 身份=${probe.identity || 'weak'}`
        );
        if (listener && listener.dshLike) this.logger.info('该外部监听进程看起来就是 dsh，可在侧边栏选择"接管并重启"把它纳入管理。');
        return this.snapshot();
      }
      s.mode = listener ? MODES.TAKEOVER : MODES.UNKNOWN;
      s.lastError = listener
        ? `端口 ${this.config.port} 现由 pid ${listener.pid}（${listener.name || '未知'}）监听，不是本程序拉起的服务`
        : `端口 ${this.config.port} 有服务响应，但无法确认监听进程`;
      this.logger.warn(s.lastError);
      return this.snapshot();
    }

    await this._spawnService();
    return this.snapshot();
  }

  async _spawnService() {
    const s = this.state;
    const plan = this.config.spawnPlan;
    s.starting = true;
    s.mode = MODES.STARTING;
    s.everSpawned = true;
    s.spawnCount += 1;
    s.expectingExit = false;

    const baseline = await this._resolveListener();
    s.baselineListenerPid = baseline ? baseline.pid : null;

    this.logger.info(
      `未检测到可用服务，开始拉起: ${plan.display} ` +
      `(launcher=${plan.launcher}, resolved=${plan.resolved}, file=${plan.file})`
    );

    let proc;
    try {
      proc = this.deps.spawn(plan.file, plan.args, {
        cwd: this.config.cwd,
        windowsHide: true,
        shell: false,
        stdio: this.config.stdio,
        env: this.config.env || process.env
      });
    } catch (err) {
      s.starting = false;
      s.mode = MODES.STOPPED;
      s.lastError = `拉起服务失败: ${err && err.message ? err.message : err}`;
      this.logger.error('拉起服务失败', err);
      return this.snapshot();
    }

    s.proc = proc;
    s.wrapperPid = proc.pid;
    this.logger.info(`已启动服务进程 pid=${proc.pid}`);

    const isCurrent = (p) => p === s.proc;
    if (proc.stdout) proc.stdout.on('data', (chunk) => this.logger.stream('dsh-svc', chunk));
    if (proc.stderr) proc.stderr.on('data', (chunk) => this.logger.stream('dsh-svc-err', chunk));
    proc.on('error', (err) => {
      if (!isCurrent(proc)) return;
      s.lastError = `服务进程错误: ${err && err.message ? err.message : err}`;
      this.logger.error('服务进程错误', err);
    });
    proc.on('exit', (code, signal) => this._onExit(proc, code, signal));

    const ready = await this._waitForReady();
    s.starting = false;
    if (ready.ok) return this.snapshot();

    // 就绪失败也必须承认归属：本程序确实 spawn 过这个进程。旧实现不置 owned，
    // 于是退出时 killManaged 直接返回 not-managed ⇒ 自己拉起的服务变成遗留进程；
    // 之后点"重启服务"还会因为端口仍被占用而永远卡在 port-busy（既停不掉也重启不了）。
    s.owned = true;
    if (s.wrapperPid) s.trustedPids.add(s.wrapperPid);
    // 端口上的监听者不是我们认领的那个进程：清掉，确保清理时不会拿它当"我们的 pid"直接终止
    s.listenerPid = null;
    s.listenerName = null;
    s.listenerVerified = false;
    s.readyFailure = ready.reason;
    s.mode = ready.reason === 'identity-mismatch' ? MODES.TAKEOVER : MODES.STOPPED;
    if (ready.reason === 'identity-mismatch') {
      // 保留 _waitForReady 写下的具体原因：服务其实已经起来并占着端口，
      // 改写成"未在 N 秒内就绪"会把排查方向带偏。
      this.logger.error(`拉起后未能接管：${s.lastError}`);
    } else {
      s.lastError = `服务未在 ${Math.round(this.config.readyTimeoutMs / 1000)}s 内就绪`;
      this.logger.error(
        `${s.lastError}（端口 ${this.config.port} 仍无响应）。` +
        `常见原因：启动命令报错、端口被占、DSH 自身 boot 失败（具体堆栈见上方 dsh-svc-err 日志）。`
      );
    }
    return this.snapshot();
  }

  async _waitForReady() {
    const s = this.state;
    const deadline = this.deps.now() + this.config.readyTimeoutMs;
    let okStreak = 0;
    for (;;) {
      const probe = await this.deps.probeHealth().catch(() => ({ ok: false, reachable: false }));
      if (probe.ok) {
        okStreak += 1;
        const listener = await this._resolveListener();
        if (listener && listener.pid !== s.baselineListenerPid) {
          if (!listener.dshLike && !this.config.verify.allowUnverified) {
            s.mode = MODES.TAKEOVER;
            s.readyFailure = 'identity-mismatch';
            s.lastError =
              `端口就绪但监听进程身份不符（pid=${listener.pid} name=${listener.name || '未知'}），拒绝接管；` +
              `本程序此前已启动进程 pid=${s.wrapperPid}——若确认它就是刚拉起的服务，可用"接管并重启"（依据 spawn 相关性）收回管理权。`;
            this.logger.warn(s.lastError);
            return { ok: false, reason: 'identity-mismatch' };
          }
          this._adoptListener(listener, listener.dshLike ? 'commandline-match' : 'observation');
          return { ok: true, reason: 'ready' };
        }
        if (!listener && okStreak >= 2) {
          // 端口健康但查不到监听者（netstat/ps 被策略限制）：退化为以包装进程 pid 记录。
          // 关键：这种降级态下 listenerPid 始终为空，refresh() 必须认识它，否则每轮轮询都会
          // 因为"listenerPid 为空 ⇒ alive=false"把完全正常的服务误报成 orphan，
          // 还会打印字面量"原 pid null 已退出"。
          s.owned = true;
          s.mode = MODES.MANAGED;
          s.listenerVerified = false;
          s.listenerUnresolved = true;
          this.logger.warn(
            `服务已就绪，但无法解析监听进程（netstat/ps 可能被限制）。以启动进程 pid=${s.wrapperPid} 作为存活依据；` +
            `清理时会重新解析真实监听者并做身份校验，无法确认时不会强杀。`
          );
          return { ok: true, reason: 'ready-unresolved' };
        }
      } else {
        okStreak = 0;
      }
      if (this.deps.now() >= deadline) return { ok: false, reason: 'timeout' };
      await this.deps.sleep(this.config.readyPollMs);
    }
  }

  _onExit(proc, code, signal) {
    const s = this.state;
    const isCurrent = proc === s.proc;
    const expected = Boolean(s.expectingExit);
    this.logger.info(
      `服务进程退出 code=${code} signal=${signal}` +
      `${expected ? '（本程序请求终止，属预期）' : ''}${isCurrent ? '' : '（历史进程，忽略）'}`
    );
    if (!isCurrent) return;
    s.proc = null;
    if (expected) {
      // 主动清理导致的退出不算故障：Windows 上 process.kill 会把退出码报成 1，
      // 若按异常处理会在界面上留下一条假的"当前问题"
      s.expectingExit = false;
      return;
    }
    if (code !== 0 && code !== null) {
      let hint = '';
      if (this.logger.recentErrors) {
        const errs = this.logger.recentErrors(1);
        if (errs.length) hint = ` | 最近错误: ${errs[0].split('\n')[0].slice(0, 200)}`;
      }
      s.lastError = `服务进程异常退出 code=${code}${signal ? ` signal=${signal}` : ''}${hint}`;
      this.logger.error(s.lastError);
    }
  }

  /** 每次轮询调用：校验存活与归属，返回快照 */
  async refresh(input = {}) {
    const s = this.state;
    const healthy = Boolean(input.healthy);
    const reachable = input.reachable === undefined ? healthy : Boolean(input.reachable);
    if (s.starting || this._killing) return this.snapshot();

    if (s.mode === MODES.MANAGED || s.mode === MODES.STOPPED) {
      // 降级态（netstat/ps 受限，从未解析出监听者）：不能因为 listenerPid 为空就断言"归属漂移"。
      // 旧实现每轮都会把这种完全正常的服务误报成 orphan，并打印字面量"原 pid null 已退出"，
      // 同时把"重启服务"按钮变灰（restartable 只认 managed/stopped）。
      if (s.listenerUnresolved && !s.listenerPid) {
        if (reachable) {
          s.mode = MODES.MANAGED;
          s.lastError = null;
          return this.snapshot();
        }
        s.mode = MODES.STOPPED;
        s.listenerUnresolved = false;
        return this.snapshot();
      }
      const alive = s.listenerPid ? this.deps.isPidAlive(s.listenerPid) : false;
      if (reachable && alive) {
        s.mode = MODES.MANAGED;
        s.lastError = null; // 已确认健康：清掉"当前问题"，历史错误仍在日志里
        return this.snapshot();
      }
      if (reachable && !alive) {
        const listener = await this._resolveListener();
        s.observed = listener;
        if (listener && listener.pid !== s.listenerPid) {
          if (listener.dshLike) {
            s.mode = MODES.ORPHAN;
            s.lastError = s.listenerPid
              ? `归属漂移：本程序记录的 pid ${s.listenerPid} 已退出，端口 ${this.config.port} 仍由疑似 dsh 的 pid ${listener.pid} 服务（孤儿进程）`
              : `端口 ${this.config.port} 由疑似 dsh 的 pid ${listener.pid} 服务，但本程序没有记录到它（可用"接管并重启"收回管理权）`;
          } else {
            s.mode = MODES.TAKEOVER;
            s.lastError = `端口 ${this.config.port} 已被 pid ${listener.pid}（${listener.name || '未知'}）接管，本程序不再管理该服务`;
          }
          this.logger.warn(s.lastError);
          return this.snapshot();
        }
        if (!listener) {
          s.lastError = s.listenerPid
            ? `端口有响应但监听进程无法确认（原 pid ${s.listenerPid} 已退出）`
            : '端口有响应但监听进程无法确认（本程序未记录到监听 pid）';
          s.mode = MODES.ORPHAN;
          this.logger.warn(s.lastError);
        }
        return this.snapshot();
      }
      if (!reachable && alive) {
        s.mode = MODES.MANAGED;
        return this.snapshot();
      }
      s.mode = MODES.STOPPED;
      s.listenerPid = null;
      return this.snapshot();
    }

    if (s.mode === MODES.REUSE || s.mode === MODES.FOREIGN) {
      if (!reachable) {
        s.mode = MODES.STOPPED;
        s.lastError = s.lastError || '外部服务已停止';
        s.observed = null;
      }
      return this.snapshot();
    }

    if (s.mode === MODES.ORPHAN || s.mode === MODES.TAKEOVER) {
      if (!reachable) {
        s.mode = MODES.STOPPED;
        s.observed = null;
      }
      return this.snapshot();
    }
    return this.snapshot();
  }

  _forceKill(pid, steps, timeoutMs) {
    const platform = this.platform;
    if (platform === 'win32') {
      // 允许调用方按剩余预算收紧 taskkill 的执行超时（默认 8s）
      const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1000, Math.min(8000, Math.floor(timeoutMs))) : 8000;
      const res = this.deps.exec({ file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'], timeoutMs: t });
      steps.push(`taskkill:${pid}:${res.ok ? 'ok' : `failed(${(res.stderr || '').trim().slice(0, 80)})`}`);
      return res.ok;
    }
    try {
      this.deps.kill(pid, 'SIGKILL');
      steps.push(`sigkill:${pid}:ok`);
      return true;
    } catch (err) {
      steps.push(`sigkill:${pid}:${err && err.code ? err.code : 'error'}`);
      return false;
    }
  }

  _canKill() {
    const s = this.state;
    if (!s.owned) return false;
    // TAKEOVER 通常意味着端口被别的进程占着（listenerPid 是别人的），绝不能动；
    // 但"自己 spawn 之后认领失败"这一类 TAKEOVER 里 listenerPid 已被清空，
    // 只剩我们自己的包装进程可清理，此时允许收尾，避免留下孤儿。
    if (s.mode === MODES.TAKEOVER) return !s.listenerPid && Boolean(s.wrapperPid);
    return [MODES.MANAGED, MODES.STOPPED, MODES.ORPHAN].includes(s.mode);
  }

  /** 清理本程序负责的服务（幂等；非本程序负责的一律不动） */
  async killManaged(reason = 'quit', options = {}) {
    if (this._killing) return this._killResult || { ok: false, reason: 'in-progress' };
    if (!this._canKill()) {
      const verdict = { ok: false, reason: this.state.owned ? `mode:${this.state.mode}` : 'not-managed' };
      this.logger.info(`跳过清理（${reason}）：本程序不负责该服务（${verdict.reason}）`);
      return verdict;
    }
    this._killing = true;
    try {
      this._killResult = await this._kill(reason, options.budgetMs);
      return this._killResult;
    } finally {
      this._killing = false;
    }
  }

  async _kill(reason, budgetMs) {
    const s = this.state;
    const steps = [];
    const alive = (pid) => this.deps.isPidAlive(pid);

    // 时间预算必须由本函数**自己**遵守，而不是只在外面套一个超时：
    // 旧实现的各步等待是 `4000 + taskkill(最长 8000) + 3000 + 兜底查询(最长 13000) + 4000`
    // 合计远超 main.js 传给 shutdown 的 killTimeoutMs（默认 8000），于是超时后
    // app.exit(0) 会在强杀/兜底还没跑完时就结束进程 ⇒ 服务被留成孤儿、lastKill 也不记录。
    // 现在每一步只用"剩余时间"，兜底在预算不足时显式跳过并如实记录。
    const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : this.config.killTimeoutMs;
    const deadline = this.deps.now() + budget;
    const remaining = () => Math.max(0, deadline - this.deps.now());

    const targets = [];
    if (s.listenerPid && alive(s.listenerPid)) targets.push({ pid: s.listenerPid, kind: 'listener' });
    if (s.wrapperPid && s.wrapperPid !== s.listenerPid && alive(s.wrapperPid)) targets.push({ pid: s.wrapperPid, kind: 'launcher' });
    this.logger.info(`开始清理服务（${reason}）: targets=${JSON.stringify(targets)} owned=${s.owned} mode=${s.mode} budget=${budget}ms`);
    if (targets.length) s.expectingExit = true; // 让退出事件按"预期终止"记录，不产生假的故障提示

    // 1) 第一轮终止
    //    - POSIX：SIGTERM（真信号，进程有机会优雅收尾），端口不让出再升级 SIGKILL。
    //    - Windows：process.kill() 本身就是强制终止，而且**不连带子进程**（没有 POSIX 信号，
    //      目标进程注册的 SIGTERM 处理器不会执行）。所以这里直接用 taskkill /T /F 结束整棵
    //      进程树。旧实现先 process.kill、再按"pid 是否还活着"决定要不要 taskkill —— 而那时
    //      pid 必然已死，/T 永远轮不到，被停服务的子孙进程会残留成孤儿。
    //    - taskkill 不可用时退回 process.kill，避免"拿不到强杀能力就什么都不做"。
    for (const target of targets) {
      if (this.platform === 'win32') {
        const treeKilled = this._forceKill(target.pid, steps, Math.min(8000, Math.max(2000, remaining())));
        if (!treeKilled) {
          try {
            this.deps.kill(target.pid);
            steps.push(`kill-fallback:${target.pid}:ok`);
          } catch (err) {
            steps.push(`kill-fallback:${target.pid}:${err && err.code ? err.code : 'error'}`);
          }
        }
      } else {
        try {
          this.deps.kill(target.pid);
          steps.push(`sigterm:${target.pid}:ok`);
        } catch (err) {
          steps.push(`sigterm:${target.pid}:${err && err.code ? err.code : 'error'}`);
        }
      }
    }

    let released = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: Math.min(4000, remaining()) });
    if (released) {
      this._finishKill(reason, steps, true);
      return { ok: true, released: true, steps };
    }

    // 2) 升级强杀：POSIX 走 SIGKILL；Windows 上第一轮已做过树杀，这里只对"仍存活的 pid"重试
    for (const target of targets) {
      if (!alive(target.pid)) continue;
      this._forceKill(target.pid, steps, remaining());
    }
    released = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: Math.min(3000, remaining()) });
    if (released) {
      this._finishKill(reason, steps, true);
      return { ok: true, released: true, steps };
    }

    // 3) 兜底：解析当前监听者 → 身份校验通过才杀
    // 预算不足以完成"查询 + 校验 + 终止 + 等端口"时，不再硬闯（硬闯只会被外层超时截断，
    // 连日志都来不及写），而是如实报告并保留可诊断的记录。
    if (remaining() < 2000) {
      steps.push(`fallback:skipped-budget(remaining=${remaining()}ms)`);
      this.logger.warn(`清理兜底被跳过：预算已用尽（${steps.join(' → ')}）。端口 ${this.config.port} 仍被占用。`);
      this._finishKill(reason, steps, false);
      return { ok: false, reason: 'budget-exhausted', steps };
    }
    const listener = await this._resolveListener();
    if (!listener) {
      this.logger.warn(`清理兜底失败：端口 ${this.config.port} 仍被占用，但无法解析监听进程`);
      this._finishKill(reason, steps, false);
      return { ok: false, reason: 'port-busy-listener-unknown', steps };
    }
    const verdict = decideKill({
      pid: listener.pid,
      name: listener.name,
      commandLine: listener.commandLine,
      trustedPids: [...s.trustedPids, s.listenerPid, s.wrapperPid].filter(Boolean),
      pattern: this.config.verify.pattern,
      allowUnverified: this.config.verify.allowUnverified
    });
    steps.push(`fallback-verdict:${verdict.reason}`);
    this.logger.info(`清理兜底：pid=${listener.pid} name=${listener.name || '未知'} 判定=${verdict.reason}`);

    if (!verdict.allowed) {
      const message =
        `拒绝终止 pid ${listener.pid}（${verdict.reason}）：端口 ${this.config.port} 仍被占用。` +
        `如确认该进程就是本程序拉起的 DSH，可设置 DSH_ALLOW_UNVERIFIED_KILL=1 后重试。`;
      this.logger.warn(message);
      this._finishKill(reason, steps, false);
      return { ok: false, reason: `refused:${verdict.reason}`, message, steps };
    }

    this._forceKill(listener.pid, steps, remaining());
    const releasedFinal = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: Math.min(4000, remaining()) });
    this._finishKill(reason, steps, releasedFinal);
    return { ok: releasedFinal, released: releasedFinal, steps };
  }

  _finishKill(reason, steps, released) {
    const s = this.state;
    s.lastKill = { reason, released, steps, at: new Date().toISOString() };
    if (!s.proc) s.expectingExit = false; // 进程已退出并处理过退出事件，收掉预期标记
    if (released) {
      s.listenerPid = null;
      s.wrapperPid = null;
      s.proc = null;
      s.owned = false;
      s.mode = MODES.STOPPED;
      s.observed = null;
      s.listenerUnresolved = false;
      s.readyFailure = null;
      this.logger.info(`服务已清理完成（${reason}）：${steps.join(' → ')}`);
    } else {
      s.lastError = `清理未完全成功（${reason}）：${steps.join(' → ')}`;
      this.logger.error(s.lastError);
    }
  }

  /**
   * 重启服务
   * options.force = true 时允许"接管"外部 dsh 进程（需身份证据）
   */
  async restart(options = {}) {
    const s = this.state;
    if (s.starting) return { ok: false, reason: 'starting', message: '服务正在启动中，请稍候' };

    if (s.mode === MODES.REUSE || s.mode === MODES.FOREIGN) {
      if (!options.force) {
        return {
          ok: false,
          reason: s.mode === MODES.REUSE ? 'external' : 'foreign',
          message: s.mode === MODES.REUSE
            ? 'DSH 由外部启动，本程序不负责重启（可选择"接管并重启"）'
            : '端口被非 DSH 进程占用，拒绝操作'
        };
      }
      return this.adoptAndRestart();
    }

    if (![MODES.MANAGED, MODES.STOPPED, MODES.ORPHAN, MODES.TAKEOVER].includes(s.mode)) {
      return { ok: false, reason: `mode:${s.mode}` };
    }

    const killResult = await this.killManaged('restart', { budgetMs: this.config.killTimeoutMs });
    const released = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: this.config.killTimeoutMs });
    if (!released) {
      return {
        ok: false,
        reason: 'port-busy',
        message: `端口 ${this.config.port} 仍被占用，已放弃拉起（避免两个实例抢端口导致 boot 失败）`,
        killResult
      };
    }
    this._killing = false;
    this._killResult = null;
    s.mode = MODES.STOPPED;
    await this.ensure();
    return { ok: s.mode === MODES.MANAGED, state: this.snapshot(), killResult };
  }

  /** 显式接管外部 dsh 进程并重启（用户点"接管并重启"时才走这里） */
  async adoptAndRestart() {
    const s = this.state;
    const listener = (await this._resolveListener()) || s.observed;
    if (!listener) return { ok: false, reason: 'listener-unknown', message: '无法确认监听进程，已拒绝接管' };

    // 命令行证据不可得时的兜底证据：该监听者是在本程序拉起之后才出现的、进程名可信，
    // 且我们此前确实在认领它时失败过（readyFailure 非空）。这条路径**只在用户显式点击**
    // "接管并重启"时才会走到，比自动认领保守得多，但能避免"外壳拒绝管理自己拉起的服务、
    // 且应用内没有任何按钮可用"的死局（典型触发：CIM/WMI 被策略限制，读不到命令行）。
    const spawnCorrelated = s.readyFailure !== null && this._isSpawnCorrelated(listener);

    if (!listener.dshLike && !spawnCorrelated) {
      return {
        ok: false,
        reason: 'not-dsh-like',
        message: `pid ${listener.pid}（${listener.name || '未知'}）不像 DSH 服务，已拒绝接管`
      };
    }
    if (!listener.commandLine && !this.config.verify.allowUnverified && !spawnCorrelated) {
      return {
        ok: false,
        reason: 'no-commandline-evidence',
        message: '无法读取该进程命令行，出于安全默认拒绝接管；如确认无误可设置 DSH_ALLOW_UNVERIFIED_KILL=1'
      };
    }
    if (!listener.dshLike && spawnCorrelated) {
      this.logger.warn(
        `接管依据为 spawn 相关性：pid=${listener.pid} 在本次拉起之后出现且进程名可信，但命令行不可读`
      );
    }

    this.logger.warn(`用户显式接管外部服务：pid=${listener.pid} name=${listener.name || '未知'}（接管后清理将包含该进程）`);
    s.adopted = true;
    s.owned = true;
    s.listenerPid = listener.pid;
    s.listenerName = listener.name || null;
    s.listenerCommandLine = listener.commandLine || null;
    s.listenerVerified = Boolean(listener.commandLine && this.config.verify.pattern.test(listener.commandLine));
    s.trustedPids.add(listener.pid);
    s.mode = MODES.MANAGED;
    s.lastError = null;
    s.listenerUnresolved = false;

    return this.restart({ force: false });
  }

  /** 退出前调用：限时清理，避免退出被拖住 */
  async shutdown(options = {}) {
    const budgetMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : this.config.killTimeoutMs;
    let timer = null;
    try {
      return await Promise.race([
        this.killManaged('quit', { budgetMs }),
        new Promise((resolve) => {
          // 兜底保险：_kill 已按 budgetMs 分配内部等待，正常都会先返回；这里留出余量
          // （覆盖最后一次端口探测/进程查询），避免像旧实现那样在强杀与兜底还没跑完时
          // 就放行 app.exit —— 那会把服务留成孤儿，而且连 lastKill 记录都来不及写。
          timer = this.deps.setTimer(() => {
            this.logger.error(`退出清理超出预算（${budgetMs}ms）仍未返回，放弃等待；服务可能被留在原地`);
            resolve({ ok: false, reason: 'shutdown-timeout' });
          }, budgetMs + 5000);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { ServiceManager, MODES };
