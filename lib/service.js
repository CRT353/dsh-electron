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

const { buildSpawnPlan, isPidAlive, decideKill, isPortInUse, waitForPortReleased, findListenerPid, TRUSTED_NAMES } = require('./procs');
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
        pattern: (config.verify && config.verify.pattern) || /dsh/i,
        allowUnverified: Boolean(config.verify && config.verify.allowUnverified)
      }
    };
    this.config.spawnPlan = config.spawnPlan || buildSpawnPlan(this.config.startCommand);

    this.logger = options.logger || { info() {}, warn() {}, error() {}, stream() {} };
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
      restartable: s.mode === MODES.MANAGED || s.mode === MODES.STOPPED,
      forceRestartable: Boolean(
        s.observed && s.observed.dshLike &&
        [MODES.REUSE, MODES.FOREIGN, MODES.ORPHAN, MODES.TAKEOVER].includes(s.mode)
      )
    };
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
    if (ready) return this.snapshot();

    s.mode = MODES.STOPPED;
    s.lastError = `服务未在 ${Math.round(this.config.readyTimeoutMs / 1000)}s 内就绪`;
    this.logger.error(
      `${s.lastError}（端口 ${this.config.port} 仍无响应）。` +
      `常见原因：启动命令报错、端口被占、DSH 自身 boot 失败（具体堆栈见上方 dsh-svc-err 日志）。`
    );
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
            s.lastError = `端口就绪但监听进程身份不符（pid=${listener.pid} name=${listener.name || '未知'}），拒绝接管`;
            this.logger.warn(s.lastError);
            return false;
          }
          this._adoptListener(listener, listener.dshLike ? 'commandline-match' : 'observation');
          return true;
        }
        if (!listener && okStreak >= 2) {
          // 端口健康但查不到监听者（netstat/ps 被策略限制）：退化为以包装进程 pid 记录
          s.owned = true;
          s.mode = MODES.MANAGED;
          s.listenerVerified = false;
          this.logger.warn(
            `服务已就绪，但无法解析监听进程（netstat/ps 可能被限制）。临时以启动进程 pid=${s.wrapperPid} 记录；` +
            `若该 pid 与实际服务不同，清理时可能无法终止服务。`
          );
          return true;
        }
      } else {
        okStreak = 0;
      }
      if (this.deps.now() >= deadline) return false;
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
            s.lastError = `归属漂移：本程序记录的 pid ${s.listenerPid} 已退出，端口 ${this.config.port} 仍由疑似 dsh 的 pid ${listener.pid} 服务（孤儿进程）`;
          } else {
            s.mode = MODES.TAKEOVER;
            s.lastError = `端口 ${this.config.port} 已被 pid ${listener.pid}（${listener.name || '未知'}）接管，本程序不再管理该服务`;
          }
          this.logger.warn(s.lastError);
          return this.snapshot();
        }
        if (!listener) {
          s.lastError = `端口有响应但监听进程无法确认（原 pid ${s.listenerPid} 已退出）`;
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

  _forceKill(pid, steps) {
    const platform = process.platform;
    if (platform === 'win32') {
      const res = this.deps.exec({ file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'], timeoutMs: 8000 });
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
    return [MODES.MANAGED, MODES.STOPPED, MODES.ORPHAN].includes(s.mode);
  }

  /** 清理本程序负责的服务（幂等；非本程序负责的一律不动） */
  async killManaged(reason = 'quit') {
    if (this._killing) return this._killResult || { ok: false, reason: 'in-progress' };
    if (!this._canKill()) {
      const verdict = { ok: false, reason: this.state.owned ? `mode:${this.state.mode}` : 'not-managed' };
      this.logger.info(`跳过清理（${reason}）：本程序不负责该服务（${verdict.reason}）`);
      return verdict;
    }
    this._killing = true;
    try {
      this._killResult = await this._kill(reason);
      return this._killResult;
    } finally {
      this._killing = false;
    }
  }

  async _kill(reason) {
    const s = this.state;
    const steps = [];
    const alive = (pid) => this.deps.isPidAlive(pid);

    const targets = [];
    if (s.listenerPid && alive(s.listenerPid)) targets.push({ pid: s.listenerPid, kind: 'listener' });
    if (s.wrapperPid && s.wrapperPid !== s.listenerPid && alive(s.wrapperPid)) targets.push({ pid: s.wrapperPid, kind: 'launcher' });
    this.logger.info(`开始清理服务（${reason}）: targets=${JSON.stringify(targets)} owned=${s.owned} mode=${s.mode}`);
    if (targets.length) s.expectingExit = true; // 让退出事件按"预期终止"记录，不产生假的故障提示

    // 1) 温和终止：先杀真实监听者，避免包装进程先退出导致真服务变孤儿
    for (const target of targets) {
      try {
        this.deps.kill(target.pid);
        steps.push(`sigterm:${target.pid}:ok`);
      } catch (err) {
        steps.push(`sigterm:${target.pid}:${err && err.code ? err.code : 'error'}`);
      }
    }

    let released = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: Math.min(this.config.killTimeoutMs, 4000) });
    if (released) {
      this._finishKill(reason, steps, true);
      return { ok: true, released: true, steps };
    }

    // 2) 强杀（只对可信 pid）
    for (const target of targets) {
      if (!alive(target.pid)) continue;
      this._forceKill(target.pid, steps);
    }
    released = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: 3000 });
    if (released) {
      this._finishKill(reason, steps, true);
      return { ok: true, released: true, steps };
    }

    // 3) 兜底：解析当前监听者 → 身份校验通过才杀
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

    this._forceKill(listener.pid, steps);
    const releasedFinal = await this.deps.waitForPortReleased(this.config.port, this.config.host, { timeoutMs: 4000 });
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

    const killResult = await this.killManaged('restart');
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

    if (!listener.dshLike) {
      return {
        ok: false,
        reason: 'not-dsh-like',
        message: `pid ${listener.pid}（${listener.name || '未知'}）不像 DSH 服务，已拒绝接管`
      };
    }
    if (!listener.commandLine && !this.config.verify.allowUnverified) {
      return {
        ok: false,
        reason: 'no-commandline-evidence',
        message: '无法读取该进程命令行，出于安全默认拒绝接管；如确认无误可设置 DSH_ALLOW_UNVERIFIED_KILL=1'
      };
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

    return this.restart({ force: false });
  }

  /** 退出前调用：限时清理，避免退出被拖住 */
  async shutdown(options = {}) {
    const timeoutMs = options.timeoutMs || 8000;
    let timer = null;
    try {
      return await Promise.race([
        this.killManaged('quit'),
        new Promise((resolve) => {
          timer = this.deps.setTimer(() => resolve({ ok: false, reason: 'shutdown-timeout' }), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { ServiceManager, MODES };
