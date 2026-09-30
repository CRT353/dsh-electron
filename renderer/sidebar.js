// 侧边栏逻辑：只做"把主进程推送的状态画出来"。
// 安全注意：所有动态内容一律用 textContent 写入（日志、命令行、URL 都可能
// 携带不可信字符，绝不用 innerHTML 拼接）。
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const netDot = $('net-dot'), netText = $('net-text');
  const dshDot = $('dsh-dot'), dshText = $('dsh-text');
  const viewDot = $('view-dot'), viewText = $('view-text');
  const alertBox = $('alert-box'), alertText = $('alert-text');
  const noticeBox = $('notice-box'), noticeText = $('notice-text');
  const metaUrl = $('meta-url'), metaSource = $('meta-source'), metaPid = $('meta-pid'), metaTime = $('meta-time');
  const btnReload = $('btn-reload'), btnRestart = $('btn-restart'), btnAdopt = $('btn-adopt'), btnLog = $('btn-log');

  // "操作进行中"标记：禁用态的所有权归 render()（由状态推导），但操作期间优先。
  // 旧实现里 btnAdopt 的 finally 会无条件 disabled=false、btnRestart 会在操作期间被
  // 轮询推送重新启用 —— 按钮与实际状态自相矛盾（可重复提交、弹假失败提示、
  // 文案卡在"重启中…"最长一个就绪超时周期）。
  let restartBusy = false;
  let adoptBusy = false;

  function setDot(el, kind) {
    el.className = 'dot ' + kind; // ok | warn | bad
  }

  function setValue(el, text, kind) {
    el.textContent = text;
    el.className = 'status-value' + (kind ? ' v-' + kind : '');
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    try {
      return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
    } catch (_) {
      return '-';
    }
  }

  function clip(text, max) {
    const str = String(text == null ? '' : text);
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  /** 服务来源文案：把"归属"如实呈现，不再一律显示"本程序管理" */
  function sourceText(s) {
    const pid = s.servicePid ? ` pid ${s.servicePid}` : '';
    const observed = s.observed && s.observed.pid ? ` pid ${s.observed.pid}` : '';
    switch (s.mode) {
      case 'managed':
        return (s.adopted ? '本程序接管' : '本程序管理') + pid;
      case 'reuse':
        return '外部服务' + (observed || pid) + '（未纳管）';
      case 'foreign':
        return '端口占用者身份未确认' + observed;
      case 'orphan':
        return '孤儿进程（疑似 dsh' + (observed || pid) + '）';
      case 'takeover':
        return '已被其他进程接管' + observed;
      case 'starting':
        return '启动中…';
      case 'stopped':
        return '已停止';
      default:
        return '未知';
    }
  }

  function listenerText(s) {
    const parts = [];
    if (s.serviceName) parts.push(s.serviceName);
    if (s.servicePid) parts.push('pid ' + s.servicePid);
    if (s.servicePid) parts.push(s.listenerVerified ? '命令行已校验' : '仅观察认定');
    if (!s.servicePid && s.observed && s.observed.pid) {
      parts.push((s.observed.name || '未知') + ' pid ' + s.observed.pid + (s.observed.dshLike ? '（疑似 dsh）' : '（非 dsh）'));
    }
    if (s.wrapperPid && s.wrapperPid !== s.servicePid) parts.push('启动进程 pid ' + s.wrapperPid);
    return parts.length ? parts.join(' · ') : '-';
  }

  function render(s) {
    if (!s) return;

    // 网络
    if (s.netCheckEnabled === false) {
      setDot(netDot, 'warn');
      setValue(netText, '未检测', 'warn');
    } else if (s.internetOnline) {
      setDot(netDot, 'ok');
      setValue(netText, '在线', 'ok');
    } else {
      setDot(netDot, 'bad');
      setValue(netText, '离线', 'bad');
    }

    // DSH 服务
    if (s.starting) {
      setDot(dshDot, 'warn');
      setValue(dshText, '启动中…', 'warn');
    } else if (s.dshOnline) {
      const weak = s.dshDetail && s.dshDetail.identity === 'weak';
      setDot(dshDot, weak ? 'warn' : 'ok');
      setValue(dshText, weak ? '运行中(身份弱)' : '运行中', weak ? 'warn' : 'ok');
    } else {
      setDot(dshDot, 'bad');
      setValue(dshText, '异常', 'bad');
    }

    // 视图
    if (s.viewState === 'ready') {
      setDot(viewDot, 'ok');
      setValue(viewText, '已加载', 'ok');
    } else if (s.viewState === 'loading') {
      setDot(viewDot, 'warn');
      setValue(viewText, '加载中…', 'warn');
    } else if (s.viewState === 'failed') {
      setDot(viewDot, 'bad');
      setValue(viewText, '加载失败', 'bad');
    } else {
      setDot(viewDot, 'warn');
      setValue(viewText, '待加载', 'warn');
    }

    metaUrl.textContent = s.dshUrl || '-';
    metaSource.textContent = sourceText(s);
    metaPid.textContent = listenerText(s);
    metaTime.textContent = fmtTime(s.lastDshCheck || s.lastNetCheck);

    // 异常提示
    const problems = [];
    if (s.remoteTarget) problems.push('DSH_URL 指向远端地址，已超出"仅本机"安全假设');
    if (s.netCheckEnabled !== false && !s.internetOnline) problems.push('网络离线，无法访问外网');
    if (s.starting) problems.push('DSH 服务正在启动，请稍候…');
    else if (!s.dshOnline) problems.push('DSH 服务不可达（' + (s.dshUrl || '') + '）');
    if (s.mode === 'orphan') problems.push('服务归属漂移：本程序记录的 pid 已退出，端口仍被疑似 dsh 的进程服务（将对账失败，可选择"接管并重启"）');
    if (s.mode === 'takeover') problems.push('端口已被非本程序的进程接管，本程序不再管理该服务（不会自动清理它）');
    if (s.mode === 'foreign') problems.push('端口有响应但无法确认是 DSH 服务，请确认端口是否被其他程序占用');
    if (s.viewState === 'failed') problems.push('DSH 视图加载失败：' + clip(s.viewError || '未知原因', 160));
    if (s.lastError) problems.push('最近错误：' + clip(s.lastError, 200));

    if (problems.length > 0) {
      alertText.textContent = problems.join('\n');
      alertBox.classList.remove('hidden');
    } else {
      alertBox.classList.add('hidden');
    }

    // 按钮可用性
    btnRestart.disabled = restartBusy || !s.restartable;
    btnRestart.title = s.restartable
      ? '重启本程序管理的 DSH 服务'
      : (s.mode === 'reuse' ? 'DSH 由外部启动；如需本程序管理，请用"接管并重启"' : '当前状态不可重启');

    // 接管按钮始终可见（灰显比隐藏更好找），只在"端口被外部 dsh 占用"时可用
    btnAdopt.disabled = adoptBusy || !s.forceRestartable;
    btnAdopt.title = s.forceRestartable
      ? '终止当前监听端口的外部 dsh 进程，并由本程序接管拉起（会先终止该进程）'
      : (s.managed
        ? '当前服务已由本程序管理，无需接管'
        : '仅当端口被"外部启动的 dsh"占用时可用（例如你自己在终端里执行 dsh web 启动的服务）');
  }

  function showNotice(text, isError) {
    noticeText.textContent = text;
    noticeBox.classList.remove('hidden');
    noticeBox.classList.toggle('notice-error', Boolean(isError));
    clearTimeout(showNotice._timer);
    showNotice._timer = setTimeout(() => noticeBox.classList.add('hidden'), 8000);
  }

  // 初始状态 + 订阅推送
  window.dshBridge.getStatus().then(render);

  window.dshBridge.onStatus(render);

  btnReload.addEventListener('click', () => {
    window.dshBridge.reloadDsh();
    showNotice('已请求刷新 DSH 视图', false);
  });

  btnRestart.addEventListener('click', async () => {
    restartBusy = true;
    btnRestart.disabled = true;
    const original = btnRestart.textContent;
    btnRestart.textContent = '重启中…';
    try {
      const res = await window.dshBridge.restartService({ force: false });
      if (res && res.ok) showNotice('服务已重启', false);
      else showNotice('重启未完成：' + ((res && (res.message || res.reason)) || '未知原因'), true);
    } finally {
      restartBusy = false; // 只解除"操作中"；禁用态仍由 render() 按最新状态决定
      btnRestart.textContent = original;
    }
  });

  btnAdopt.addEventListener('click', async () => {
    adoptBusy = true;
    btnAdopt.disabled = true;
    const original = btnAdopt.textContent;
    btnAdopt.textContent = '接管中…';
    try {
      const res = await window.dshBridge.restartService({ force: true });
      if (res && res.ok) showNotice('已接管外部 dsh 进程并重启', false);
      else showNotice('接管失败：' + ((res && (res.message || res.reason)) || '未知原因'), true);
    } finally {
      // 旧实现在这里无条件 `disabled = false`，会在状态推送已把按钮置灰之后又把它点亮，
      // 造成约一个轮询周期内"title 说无需接管、按钮却可点"的矛盾窗口。
      adoptBusy = false;
      btnAdopt.textContent = original;
    }
  });

  btnLog.addEventListener('click', async () => {
    const res = await window.dshBridge.openLog();
    if (!res || !res.ok) showNotice('打开日志失败：' + ((res && res.error) || '未知原因'), true);
  });
})();
