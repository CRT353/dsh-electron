'use strict';
/**
 * verify-packaged-logpath.js —— 对**真实打包产物**做一次可重复的验收。
 *
 * 为什么需要它：v1.3.1 之前，"打包态默认日志路径落在不可写的 resources\app.asar 内
 * → 发行版完全没有日志"这一修复只有推理（代码上看路径必然在 asar 内 + asar 写入必然抛
 * ENOENT），没能在产物上真跑一遍 —— 而打包版 GUI 又必须人工双击才能验证。
 * 本脚本绕开 GUI：打包产物里的 `lib/config.js` 不依赖 Electron，可以直接拿**产物里的
 * 真实字节**跑它的真实逻辑，于是"日志会不会落进 asar"这件事可以自动化验收。
 *
 * 用法（先 npm run dist，再执行）：
 *   node tools/verify-packaged-logpath.js
 *   node tools/verify-packaged-logpath.js dist\win-unpacked\resources\app.asar
 *
 * 退出码：0 = 全部通过；1 = 有检查失败；2 = 找不到产物/无法读取（不是代码问题）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ASAR = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) passed += 1;
  else failed += 1;
}

function loadAsar() {
  try {
    return require('@electron/asar');
  } catch (err) {
    console.error('无法加载 @electron/asar（它随 electron-builder 一起安装）：请先 npm install');
    console.error(`  原始错误：${err && err.message}`);
    process.exit(2);
  }
}

function main() {
  const asarPath = path.resolve(process.argv[2] || DEFAULT_ASAR);
  console.log(`产物 asar: ${asarPath}\n`);
  if (!fs.existsSync(asarPath)) {
    console.error('找不到打包产物。先执行 npm run dist（或 npm run build）再运行本脚本。');
    process.exit(2);
  }

  const asar = loadAsar();
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verify-packaged-'));
  try {
    asar.extractAll(asarPath, extractDir);
    const cfg = require(path.join(extractDir, 'lib', 'config.js'));
    const pkg = JSON.parse(fs.readFileSync(path.join(extractDir, 'package.json'), 'utf8'));

    // ---- 1. 产物内容 ----
    const entries = asar.listPackage(asarPath).map((s) => s.replace(/^[\\/]/, ''));
    console.log(`打包版本号: ${pkg.version}`);
    check('asar 内不含 node_modules 冗余', !entries.some((e) => e.startsWith('node_modules')), `${entries.length} 个条目`);

    // ---- 2. 关键：默认日志路径不得落在 asar 内 ----
    // 用产物自身的 package.json#name 推导 userData —— 这正是 Electron 的做法
    // （app.getPath('userData') = %APPDATA%\<app.getName()>），因此这里验证的就是真实取值。
    const userData = path.join(process.env.APPDATA || os.homedir(), pkg.name);
    console.log(`由产物推导的 userData: ${userData}（依据 asar 内 package.json 的 name）\n`);

    check('isInsideAsar 能识别真实打包路径', cfg.isInsideAsar(asarPath) === true);

    const packaged = cfg.loadConfig({}, { root: asarPath, userDataDir: userData });
    check(
      '打包态默认日志路径落在 userData 目录（修复生效）',
      packaged.logFile === path.join(userData, 'load-status.log'),
      packaged.logFile
    );
    check('日志路径不在 app.asar 内', !/app\.asar/i.test(packaged.logFile));

    // 旧实现的默认路径（<asar>\load-status.log）在 OS 层确实写不进去 —— 旧缺陷的实证
    let oldErr = null;
    try { fs.appendFileSync(path.join(asarPath, 'load-status.log'), 'x'); } catch (err) { oldErr = err; }
    check('旧路径（asar 内）写入确实失败', oldErr !== null, oldErr ? String(oldErr.code) : '竟然写成功了(!)');

    // 其余契约不得回归
    const dev = cfg.loadConfig({}, { root: 'D:\\proj\\dsh_electron', userDataDir: userData });
    check('开发态行为不变（仍写项目目录）', dev.logFile === path.join('D:\\proj\\dsh_electron', 'load-status.log'), dev.logFile);

    const explicit = cfg.loadConfig({ DSH_LOG_FILE: 'D:\\custom\\x.log' }, { root: asarPath, userDataDir: userData });
    check('DSH_LOG_FILE 仍然优先', explicit.logFile === 'D:\\custom\\x.log', explicit.logFile);

    const fallback = cfg.loadConfig({}, { root: asarPath });
    check('userDataDir 缺失时兜底到可写目录（不在 asar 内）', !cfg.isInsideAsar(fallback.logFile), fallback.logFile);

    // ---- 3. 顺带守一个已实测的坑 ----
    if (!pkg.productName) {
      console.log(
        '\n[WARN] 产物 package.json 没有顶层 productName —— Electron 会用 name 作为应用标识，' +
        `因此打包版的 userData 是 %APPDATA%\\${pkg.name}，与开发版（npm start）**同一个目录**：` +
        '两者的单实例锁会冲突，先启动的持有锁、后启动的一启动就静默退出（退出码 0，无窗口无日志）。' +
        '要恢复隔离，请在 package.json 顶层补 "productName"。'
      );
    } else {
      check('产物声明了顶层 productName（打包版与开发版 userData 隔离）', true, pkg.productName);
    }

    console.log(`\n结论：通过 ${passed} 项，失败 ${failed} 项`);
    process.exit(failed === 0 ? 0 : 1);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

main();
