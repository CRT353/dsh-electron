'use strict';
/**
 * 子进程输出捕获封装：永不抛异常，返回结构化结果。
 * 单独成模块是为了让 procs/service 都能注入替身（单测里不需要真的执行命令）。
 */
const { execFileSync } = require('child_process');

function createExec(options = {}) {
  const defaultTimeout = options.timeoutMs || 5000;
  return function exec(spec = {}) {
    const started = Date.now();
    try {
      const stdout = execFileSync(spec.file, spec.args || [], {
        encoding: 'utf8',
        timeout: spec.timeoutMs || defaultTimeout,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: spec.maxBuffer || 4 * 1024 * 1024
      });
      return { ok: true, stdout: String(stdout == null ? '' : stdout), stderr: '', code: 0, ms: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        stdout: err && err.stdout ? String(err.stdout) : '',
        stderr: err && err.stderr ? String(err.stderr) : (err && err.message) || 'exec failed',
        code: err && typeof err.status === 'number' ? err.status : null,
        ms: Date.now() - started
      };
    }
  };
}

module.exports = { createExec };
