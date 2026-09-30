'use strict';
/**
 * tools/selftest.js 的退出码与"能力探测"语义。
 *
 * 为什么要测：这个脚本是"真实环境全链路自检"的唯一守门人，却没有任何测试。
 * 两处已修问题都在它的输出语义上：
 *   1) `--inspect <port>` 曾经把"我查不到"写成"未查到监听者"并以 0 退出
 *      （在拿不到 netstat 的环境里，这会让人得出"端口空闲"的错误结论）；
 *   2) 能力探测曾经以"3080 此刻正被监听且命令行可读"为通过条件，在没跑 DSH 的机器上
 *      必然假失败。
 * 本文件的断言刻意兼容两种环境（有/无进程查询能力），但**不允许**把"查不到"当成"端口空闲"。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { startServer, freePort } = require('./helpers');

const SELFTEST = path.join(__dirname, '..', 'tools', 'selftest.js');

/**
 * 以子进程方式运行脚本并收集输出。
 *
 * 注意：**不能用管道**。本仓库运行所在的受限沙箱禁止以 pipe 捕获子进程输出
 * （Node 的 child_process 默认 stdio:'pipe' 会直接 spawn EPERM），所以这里把
 * stdout/stderr 重定向到临时文件再读回；退出码语义与管道方式完全一致。
 */
function runNode(args, timeoutMs = 20000) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-selftest-run-'));
  const outPath = path.join(box, 'out.txt');
  const errPath = path.join(box, 'err.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, args, { stdio: ['ignore', outFd, errFd] });
    } catch (err) {
      fs.closeSync(outFd);
      fs.closeSync(errFd);
      fs.rmSync(box, { recursive: true, force: true });
      resolve({ code: null, stdout: '', stderr: '', error: err });
      return;
    }

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(outFd); } catch (_) { /* 忽略 */ }
      try { fs.closeSync(errFd); } catch (_) { /* 忽略 */ }
      const stdout = fs.readFileSync(outPath, 'utf8');
      const stderr = fs.readFileSync(errPath, 'utf8');
      fs.rmSync(box, { recursive: true, force: true });
      resolve({ ...payload, stdout, stderr });
    };

    child.on('error', (err) => finish({ code: null, error: err }));
    child.on('exit', (code) => finish({ code }));
    setTimeout(() => { try { child.kill(); } catch (_) { /* 忽略 */ } }, timeoutMs);
  });
}

test('selftest 拒绝在真实 DSH 端口 3080 上运行破坏性自检（退出码 2）', async () => {
  const res = await runNode([SELFTEST, '--port', '3080']);
  assert.strictEqual(res.code, 2, `应拒绝执行；stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /拒绝在真实 DSH 端口 3080 上运行/);
});

test('--inspect：查到监听者时退出码 0，查不到能力时退出码 3 —— 绝不谎报"端口空闲"', async () => {
  const server = await startServer();
  try {
    const res = await runNode([SELFTEST, '--inspect', String(server.port)]);
    assert.ok(res.code === 0 || res.code === 3, `只允许 0（有结论）或 3（查询能力不可用）；实际 ${res.code}`);
    if (res.code === 3) {
      assert.match(res.stdout, /查询能力不可用/, '必须明确说明是"查不到"，并给出原因');
      // 注意：说明文字里本身含有"这不是'端口空闲'"这句，所以不能用 /端口空闲/ 做否定断言 ——
      // 要否定的是"宣称空闲"那句话本身。
      assert.doesNotMatch(res.stdout, /端口空闲（查询正常完成/, '查不到时绝不能宣称端口空闲');
    } else {
      assert.match(res.stdout, /pid\s*:/, '查询能力可用时应给出监听进程 pid');
    }
  } finally {
    await server.close();
  }
});

test('--inspect：空闲端口上不得把"查询能力不可用"说成端口空闲、也不得报错崩栈', async () => {
  const port = await freePort();
  const res = await runNode([SELFTEST, '--inspect', String(port)]);
  assert.ok(res.code === 0 || res.code === 3, `实际退出码 ${res.code}，stderr=${res.stderr}`);
  assert.doesNotMatch(res.stderr, /TypeError|ReferenceError/, '不得崩栈');
  if (res.code === 0) {
    assert.match(res.stdout, /端口空闲|pid\s*:/);
  } else {
    assert.match(res.stdout, /查询能力不可用/);
  }
});
