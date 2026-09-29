'use strict';
/** lib/procs.js 单测：命令解析、监听者解析、终止校验、端口探测 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  splitCommand,
  resolveExecutable,
  buildSpawnPlan,
  parseNetstatListeners,
  parseLsofListeners,
  parseSsListeners,
  matchesHost,
  pickListener,
  isPidAlive,
  decideKill,
  waitForPortReleased
} = require('../lib/procs');

test('splitCommand 处理引号与空格', () => {
  assert.deepStrictEqual(splitCommand('dsh web --no-open'), ['dsh', 'web', '--no-open']);
  assert.deepStrictEqual(splitCommand('  dsh   web  '), ['dsh', 'web']);
  assert.deepStrictEqual(
    splitCommand('"C:\\Program Files\\nodejs\\node.exe" app.js --flag'),
    ['C:\\Program Files\\nodejs\\node.exe', 'app.js', '--flag']
  );
  assert.deepStrictEqual(splitCommand("node 'a b.js'"), ['node', 'a b.js']);
  assert.deepStrictEqual(splitCommand('dsh --log="a b"'), ['dsh', '--log=a b']);
  assert.deepStrictEqual(splitCommand(''), []);
  assert.deepStrictEqual(splitCommand(null), []);
});

/** 模拟 Windows 文件系统：大小写不敏感 */
function fsStub(files) {
  const set = new Set(files.map((p) => String(p).toLowerCase()));
  return (p) => set.has(String(p).toLowerCase());
}

test('resolveExecutable 在 Windows 上优先解析 .cmd 垫片（而不是同目录无扩展名脚本）', () => {
  const isFile = fsStub([path.join('D:\\bin', 'dsh'), path.join('D:\\bin', 'dsh.cmd')]);
  const resolved = resolveExecutable('dsh', {
    platform: 'win32',
    pathEnv: 'D:\\bin',
    pathext: '.COM;.EXE;.BAT;.CMD',
    isFile
  });
  assert.strictEqual(resolved.resolved, true);
  assert.ok(/dsh\.cmd$/i.test(resolved.path), `应解析为 dsh.cmd，实际 ${resolved.path}`);
  assert.strictEqual(resolved.needsShell, true, '.cmd 垫片必须走 shell 语义（cmd.exe /c）');
});

test('resolveExecutable 支持 .exe 与 POSIX 路径', () => {
  const exe = resolveExecutable('dsh', {
    platform: 'win32',
    pathEnv: 'D:\\bin',
    pathext: '.EXE;.CMD',
    isFile: fsStub([path.join('D:\\bin', 'dsh.exe')])
  });
  assert.strictEqual(exe.needsShell, false);
  assert.ok(/dsh\.exe$/i.test(exe.path));

  const posix = resolveExecutable('dsh', {
    platform: 'linux',
    pathEnv: '/usr/local/bin:/usr/bin',
    isFile: fsStub(['/usr/bin/dsh'])
  });
  assert.strictEqual(posix.path, '/usr/bin/dsh');
  assert.strictEqual(posix.needsShell, false);

  const missing = resolveExecutable('nope-nope', { platform: 'linux', pathEnv: '/usr/bin', isFile: () => false });
  assert.strictEqual(missing.resolved, false);
});

test('buildSpawnPlan 永不用 shell:true（避免无法回收的包装进程 pid）', () => {
  const winCmd = buildSpawnPlan('dsh web --no-open', {
    platform: 'win32',
    comspec: 'C:\\Windows\\system32\\cmd.exe',
    pathEnv: 'D:\\bin',
    pathext: '.CMD',
    isFile: fsStub([path.join('D:\\bin', 'dsh.cmd')])
  });
  assert.strictEqual(winCmd.useShell, false);
  assert.strictEqual(winCmd.launcher, 'cmd');
  assert.strictEqual(winCmd.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepStrictEqual(winCmd.args, ['/d', '/s', '/c', 'dsh web --no-open']);

  const winExe = buildSpawnPlan('dsh web --no-open', {
    platform: 'win32',
    pathEnv: 'D:\\bin',
    pathext: '.EXE',
    isFile: fsStub([path.join('D:\\bin', 'dsh.exe')])
  });
  assert.strictEqual(winExe.launcher, 'direct');
  assert.deepStrictEqual(winExe.args, ['web', '--no-open']);

  const posix = buildSpawnPlan('dsh web --no-open', {
    platform: 'linux',
    pathEnv: '/usr/bin',
    isFile: fsStub(['/usr/bin/dsh'])
  });
  assert.strictEqual(posix.file, '/usr/bin/dsh');
  assert.strictEqual(posix.launcher, 'direct');

  const meta = buildSpawnPlan('a && b', { platform: 'linux', isFile: () => false });
  assert.strictEqual(meta.file, '/bin/sh');
  assert.deepStrictEqual(meta.args, ['-c', 'a && b']);

  assert.throws(() => buildSpawnPlan('', {}), /为空/);
});

test('parseNetstatListeners 解析 Windows netstat 输出（含 IPv6 与 ESTABLISHED 过滤）', () => {
  const fixture = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       38088',
    '  TCP    127.0.0.1:3080         127.0.0.1:64830        ESTABLISHED     38088',
    '  TCP    [::]:3080              [::]:0                 LISTENING       4',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1024',
    '  UDP    0.0.0.0:500             *:*                                    2048'
  ].join('\r\n');
  const listeners = parseNetstatListeners(fixture);
  assert.strictEqual(listeners.length, 3);
  assert.deepStrictEqual(listeners[0], { protocol: 'TCP', address: '127.0.0.1', port: 3080, pid: 38088 });
  assert.strictEqual(listeners[1].address, '[::]');
  assert.strictEqual(listeners[2].port, 135);
});

test('parseLsofListeners / parseSsListeners 解析 POSIX 输出', () => {
  const lsof = [
    'COMMAND  PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'node    1234 user   23u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:3080 (LISTEN)'
  ].join('\n');
  const parsed = parseLsofListeners(lsof);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].pid, 1234);
  assert.strictEqual(parsed[0].port, 3080);
  assert.strictEqual(parsed[0].address, '127.0.0.1');

  const ss = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      511          127.0.0.1:3080      0.0.0.0:*    users:(("node",pid=4321,fd=23))'
  ].join('\n');
  const parsedSs = parseSsListeners(ss);
  assert.strictEqual(parsedSs.length, 1);
  assert.strictEqual(parsedSs[0].pid, 4321);
  assert.strictEqual(parsedSs[0].port, 3080);
});

test('matchesHost / pickListener 覆盖 IPv6 与 0.0.0.0', () => {
  assert.strictEqual(matchesHost('0.0.0.0', '127.0.0.1'), true);
  assert.strictEqual(matchesHost('::', '127.0.0.1'), true);
  assert.strictEqual(matchesHost('[::1]', 'localhost'), true);
  assert.strictEqual(matchesHost('192.168.1.5', '127.0.0.1'), false);

  const picked = pickListener([
    { address: '0.0.0.0', port: 3080, pid: 11 },
    { address: '127.0.0.1', port: 3080, pid: 22 }
  ], 3080, '127.0.0.1');
  assert.strictEqual(picked.pid, 22, '应优先精确匹配目标地址');
});

test('isPidAlive 正确处理 ESRCH / EPERM', () => {
  assert.strictEqual(isPidAlive(1234, { kill: () => {} }), true);
  assert.strictEqual(isPidAlive(1234, { kill: () => { const e = new Error('gone'); e.code = 'ESRCH'; throw e; } }), false);
  assert.strictEqual(isPidAlive(1234, { kill: () => { const e = new Error('denied'); e.code = 'EPERM'; throw e; } }), true);
  assert.strictEqual(isPidAlive(0, { kill: () => {} }), false);
  assert.strictEqual(isPidAlive(null, { kill: () => {} }), false);
});

test('decideKill 默认拒绝：只认"本程序记录的 pid"或"白名单名+命令行匹配 dsh"', () => {
  assert.strictEqual(decideKill({ pid: 0 }).allowed, false);
  assert.strictEqual(decideKill({ pid: 0 }).reason, 'invalid-pid');

  assert.deepStrictEqual(
    decideKill({ pid: 38088, trustedPids: [38088], name: 'anything.exe' }),
    { allowed: true, reason: 'tracked-pid' }
  );

  const foreign = decideKill({ pid: 999, name: 'postgres.exe', commandLine: 'postgres -D data' });
  assert.strictEqual(foreign.allowed, false);
  assert.match(foreign.reason, /untrusted-name/);

  const noEvidence = decideKill({ pid: 999, name: 'node.exe', commandLine: null });
  assert.strictEqual(noEvidence.allowed, false);
  assert.strictEqual(noEvidence.reason, 'no-commandline-evidence');

  const match = decideKill({ pid: 999, name: 'node.exe', commandLine: 'node D:\\nvm\\node_modules\\@deepseek-ai\\dsh\\bin.js web --no-open' });
  assert.strictEqual(match.allowed, true);
  assert.strictEqual(match.reason, 'commandline-match');

  const mismatch = decideKill({ pid: 999, name: 'node.exe', commandLine: 'node other-app.js' });
  assert.strictEqual(mismatch.allowed, false);
  assert.strictEqual(mismatch.reason, 'commandline-mismatch');

  const override = decideKill({ pid: 999, name: 'postgres.exe', commandLine: 'postgres', allowUnverified: true });
  assert.strictEqual(override.allowed, true);
  assert.strictEqual(override.risky, true);
});

test('waitForPortReleased 轮询到端口释放', async () => {
  let calls = 0;
  const released = await waitForPortReleased(3080, '127.0.0.1', {
    timeoutMs: 200,
    intervalMs: 5,
    probe: async () => {
      calls += 1;
      return calls < 3; // 前两次占用，之后释放
    }
  });
  assert.strictEqual(released, true);
  assert.strictEqual(calls, 3);

  const never = await waitForPortReleased(3080, '127.0.0.1', {
    timeoutMs: 30,
    intervalMs: 5,
    probe: async () => true
  });
  assert.strictEqual(never, false);
});
