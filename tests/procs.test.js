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
  isPortInUse,
  isPortInUseDetailed,
  waitForPortReleased,
  findListenerPid,
  findListenerPidDetailed,
  readProcessInfo
} = require('../lib/procs');
const { createExec } = require('../lib/exec');
const { startServer, freePort } = require('./helpers');

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

test('findListenerPid 在 Windows 上用 `netstat -ano`：-p TCP 会漏掉全部 IPv6 监听项', () => {
  const calls = [];
  const fixture = [
    '',
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       42060',
    '  TCP    [::]:3080              [::]:0                 LISTENING       4',
    '  TCP    [::1]:41889            [::]:0                 LISTENING       777',
    '  UDP    [::]:500               *:*                                    2048'
  ].join('\r\n');
  const exec = (spec) => {
    calls.push(spec);
    if (spec.file === 'netstat') return { ok: true, stdout: fixture, stderr: '', code: 0 };
    return { ok: false, stdout: '', stderr: 'stub（单测不真跑进程查询）', code: 1 };
  };

  const v4 = findListenerPid(3080, { exec, platform: 'win32', host: '127.0.0.1' });
  assert.deepStrictEqual(calls[0].args, ['-ano'], '必须是 netstat -ano（旧实现传 -p TCP 会丢 IPv6）');
  assert.ok(!calls[0].args.includes('-p'), '不得再传 -p');
  assert.strictEqual(v4.pid, 42060);

  // 只绑 IPv6 的服务必须能被发现：旧实现会判成"端口空闲"并打印"无需停止"
  const v6 = findListenerPid(41889, { exec, platform: 'win32', host: '::1' });
  assert.ok(v6, '只绑 [::1] 的监听者必须能解析出来');
  assert.strictEqual(v6.pid, 777);
  assert.strictEqual(v6.address, '[::1]');
});

test('DSH 身份判定模式：不误杀路径含 dsh 的无关服务，也不误漏真实 dsh 命令行', () => {
  // 真实形态：本机 npm 垫片 dsh.cmd 实际执行的命令行（已实测核对）
  const realShim =
    '"C:\\nvm4w\\nodejs\\node.exe" "C:\\nvm4w\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" web --no-open';
  assert.strictEqual(decideKill({ pid: 1, name: 'node.exe', commandLine: realShim }).allowed, true, '真实命令行必须被认作 DSH');

  const dshForms = [
    'node D:\\x\\node_modules\\@deepseek-ai\\dsh\\bin.js web', // 作用域包路径
    'node /usr/lib/node_modules/@deepseek-ai/dsh/bin.js web', // POSIX 布局
    'dsh web --no-open', // 直接调用
    '"C:\\nvm4w\\nodejs\\dsh.cmd" web --no-open', // 垫片直调
    'node /opt/dsh/lib/bin.js web' // CLI 入口文件
  ];
  for (const commandLine of dshForms) {
    assert.strictEqual(
      decideKill({ pid: 1, name: 'node.exe', commandLine }).allowed,
      true,
      `不该漏掉真实 dsh 形态: ${commandLine}`
    );
  }

  // 旧默认 /dsh/i 会把下面这些**无关** node 服务判成 DSH 并杀掉
  const unrelated = [
    'node C:\\Users\\dsh\\app\\server.js',
    'node C:\\tools\\mydsh\\api.js',
    'node dsh-something\\server.js',
    'node C:\\projects\\dshboard\\index.js',
    'node C:\\temp\\notdsh.js'
  ];
  for (const commandLine of unrelated) {
    const verdict = decideKill({ pid: 4242, name: 'node.exe', commandLine });
    assert.strictEqual(verdict.allowed, false, `不该把无关服务判成 DSH: ${commandLine}`);
    assert.strictEqual(verdict.reason, 'commandline-mismatch', commandLine);
  }
});

test('isPortInUseDetailed：区分"确定空闲 / 在用 / 不知道"（旧实现把超时当成空闲）', async () => {
  const server = await startServer();
  try {
    assert.strictEqual((await isPortInUseDetailed(server.port, '127.0.0.1', 500)).state, 'in-use');
    assert.strictEqual(await isPortInUse(server.port, '127.0.0.1', 500), true, '旧签名的语义保持不变');
  } finally {
    await server.close();
  }

  const port = await freePort();
  assert.strictEqual((await isPortInUseDetailed(port, '127.0.0.1', 500)).state, 'free', '连接被拒绝 = 确定空闲');
  assert.strictEqual(await isPortInUse(port, '127.0.0.1', 500), false);

  // 不可达主机（TEST-NET-1）：旧实现把错误一律当成"端口空闲"，
  // 于是 stop-dsh 会打印"无人监听，无需停止"并 exit 0（服务其实还在跑）。
  assert.strictEqual(
    (await isPortInUseDetailed(port, '192.0.2.1', 300)).state,
    'unknown',
    '不可达/超时必须报"不知道"，绝不能报"确定空闲"'
  );
});

test('findListenerPidDetailed：区分"查询失败"与"这个端口没人监听"', () => {
  const failed = findListenerPidDetailed(3080, {
    exec: () => ({ ok: false, stdout: '', stderr: 'spawnSync netstat EPERM', code: null }),
    platform: 'win32',
    host: '127.0.0.1'
  });
  assert.strictEqual(failed.listener, null);
  assert.strictEqual(failed.queryFailed, true, '执行失败必须与"没人监听"区分开');
  assert.match(failed.reason, /EPERM|netstat/, failed.reason);

  const emptyOutput = findListenerPidDetailed(3080, {
    exec: () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    platform: 'win32',
    host: '127.0.0.1'
  });
  assert.strictEqual(emptyOutput.queryFailed, true, '输出里没有任何监听项 ⇒ 结论不可信');

  const otherPort = findListenerPidDetailed(3080, {
    exec: () => ({ ok: true, stdout: '  TCP    127.0.0.1:9999    0.0.0.0:0    LISTENING    1234', stderr: '', code: 0 }),
    platform: 'win32',
    host: '127.0.0.1'
  });
  assert.strictEqual(otherPort.queryFailed, false, '查询成功、只是没有目标端口 ⇒ 不是查询失败');
  assert.strictEqual(otherPort.listener, null);
});

test('readProcessInfo：解析 CIM / tasklist / ps 三种输出（此前零覆盖的命令行证据链）', () => {
  // Windows CIM（Get-CimInstance）：名字 \t 命令行
  const winCim = readProcessInfo(4242, {
    platform: 'win32',
    exec: () => ({
      ok: true,
      stdout: 'node.exe\tC:\\nvm4w\\nodejs\\node.exe C:\\x\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --no-open\r\n',
      stderr: '',
      code: 0
    })
  });
  assert.strictEqual(winCim.name, 'node.exe');
  assert.match(winCim.commandLine, /@deepseek-ai\\dsh/);

  // CIM 不可用 → 退到 tasklist：只有名字、**没有命令行**
  // （这正是"读不到命令行 ⇒ dshLike=false ⇒ 拒绝认领自己拉起的服务"的触发条件）
  let calls = 0;
  const viaTasklist = readProcessInfo(4242, {
    platform: 'win32',
    exec: (spec) => {
      calls += 1;
      if (spec.file === 'tasklist') {
        return { ok: true, stdout: '"node.exe","4242","Console","1","12,345 K"\r\n', stderr: '', code: 0 };
      }
      return { ok: false, stdout: '', stderr: 'CIM 不可用', code: 1 };
    }
  });
  assert.strictEqual(calls, 2, '应先试 CIM 再退 tasklist');
  assert.strictEqual(viaTasklist.name, 'node.exe');
  assert.strictEqual(viaTasklist.commandLine, null, 'tasklist 拿不到命令行，必须如实返回 null');

  // POSIX ps -p <pid> -o comm=,args=
  const posix = readProcessInfo(4242, {
    platform: 'linux',
    exec: () => ({ ok: true, stdout: '/usr/bin/node --experimental-loader /opt/dsh/lib/bin.js web\n', stderr: '', code: 0 })
  });
  assert.strictEqual(posix.name, 'node', '名字应取 basename');
  assert.match(posix.commandLine, /--experimental-loader/);

  assert.strictEqual(readProcessInfo(4242, {}), null, '没有 exec 时返回 null');
  assert.strictEqual(
    readProcessInfo('abc', { exec: () => ({ ok: true, stdout: 'x', code: 0 }), platform: 'win32' }),
    null,
    '非法 pid 返回 null'
  );
  assert.strictEqual(
    readProcessInfo(4242, { platform: 'win32', exec: () => ({ ok: false, stdout: '', stderr: 'x', code: 1 }) }),
    null,
    '两条来源都失败时返回 null（调用方据此按"证据不足"默认拒绝）'
  );
});

test('createExec：任何输入都不抛异常，失败也返回结构化结果', () => {
  // 注意：本环境（受限沙箱）禁止同步子进程管道（execFileSync 一律 EPERM），
  // 因此"成功路径"无法在这里覆盖；这里守住的是它对调用方的契约 —— 永不抛异常。
  const exec = createExec({ timeoutMs: 2000 });

  const missing = exec({ file: 'definitely-not-a-real-binary-xyz-123' });
  assert.strictEqual(missing.ok, false);
  assert.ok(typeof missing.stderr === 'string' && missing.stderr.length > 0, '失败必须给出可读原因');
  assert.strictEqual(missing.stdout, '');
  assert.ok(typeof missing.ms === 'number');

  assert.strictEqual(exec({}).ok, false, '空 spec 也不能抛异常');
  assert.strictEqual(exec(null).ok, false, 'null spec 也不能抛异常（旧实现会在这里抛 TypeError）');
  assert.strictEqual(exec(undefined).ok, false, 'undefined spec 也不能抛异常');
});
