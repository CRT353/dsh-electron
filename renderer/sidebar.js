// 侧边栏逻辑：渲染主进程推送的状态，异常时给出视觉提示
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const netDot = $('net-dot'), netText = $('net-text');
  const dshDot = $('dsh-dot'), dshText = $('dsh-text');
  const alertBox = $('alert-box'), alertText = $('alert-text');
  const metaUrl = $('meta-url'), metaSource = $('meta-source'), metaTime = $('meta-time');
  const btnReload = $('btn-reload'), btnRestart = $('btn-restart');

  function setDot(el, kind) {
    el.className = 'dot ' + kind; // ok | warn | bad
  }

  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function render(s) {
    if (!s) return;

    // 网络状态
    if (s.internetOnline) {
      setDot(netDot, 'ok');
      netText.textContent = '在线';
      netText.className = 'status-value v-ok';
    } else {
      setDot(netDot, 'bad');
      netText.textContent = '离线';
      netText.className = 'status-value v-bad';
    }

    // DSH 服务状态
    if (s.starting) {
      setDot(dshDot, 'warn');
      dshText.textContent = '启动中…';
      dshText.className = 'status-value v-warn';
    } else if (s.dshOnline) {
      setDot(dshDot, 'ok');
      dshText.textContent = '运行中';
      dshText.className = 'status-value v-ok';
    } else {
      setDot(dshDot, 'bad');
      dshText.textContent = '异常';
      dshText.className = 'status-value v-bad';
    }

    // 详情
    metaUrl.textContent = s.dshUrl || '-';
    if (s.serviceManaged) {
      metaSource.textContent = s.serviceExited
        ? '本程序管理（已停止）'
        : (s.servicePid ? `本程序管理 (PID ${s.servicePid})` : '本程序管理');
    } else {
      metaSource.textContent = '外部服务';
    }
    metaTime.textContent = fmtTime(s.lastDshCheck || s.lastNetCheck);

    // 异常提示
    const problems = [];
    if (!s.internetOnline) problems.push('网络离线，无法访问外网');
    if (s.starting) problems.push('DSH 服务正在启动，请稍候…');
    else if (!s.dshOnline) problems.push('DSH 服务不可达（' + (s.dshUrl || '') + '）');

    if (problems.length > 0) {
      alertText.textContent = problems.join('；');
      alertBox.classList.remove('hidden');
    } else {
      alertBox.classList.add('hidden');
    }

    // 重启按钮：仅本程序管理的服务可用
    btnRestart.disabled = !s.serviceManaged;
    btnRestart.title = s.serviceManaged
      ? '重启 DSH 服务'
      : 'DSH 由外部启动，本程序不负责管理';
  }

  // 初始状态 + 订阅推送
  window.dshBridge.getStatus().then(render);
  window.dshBridge.onStatus(render);

  btnReload.addEventListener('click', () => window.dshBridge.reloadDsh());
  btnRestart.addEventListener('click', async () => {
    btnRestart.disabled = true;
    btnRestart.textContent = '重启中…';
    const res = await window.dshBridge.restartService();
    btnRestart.textContent = '重启服务';
    if (res && res.reason === 'external') {
      alertText.textContent = 'DSH 由外部启动，无法在此重启';
      alertBox.classList.remove('hidden');
    }
  });
})();
