const DEFAULT_CFG = {
  baseDelayMs: 3000,
  jitterPct: 20,
  pageSize: 10,
  likePerProfile: 1,
  actionModeDefault: 'follow_like',
  includeAlreadyFollowing: false,
};
let cfg = { ...DEFAULT_CFG };
let followers = [];
let page = 1;
let pageSize = DEFAULT_CFG.pageSize;
let running = false;
let ov = { processed: 0, total: 0, phase: 'idle', nextActionAt: null };
let ovTimer = null;

function send(msg) {
  window.postMessage({ from: 'ig-panel', ...msg }, '*');
}

function qs(sel) {
  return document.querySelector(sel);
}

if (window.__IG_PANEL_MSG_HANDLER) {
  window.removeEventListener('message', window.__IG_PANEL_MSG_HANDLER);
}
window.__IG_PANEL_MSG_HANDLER = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'PANEL_READY') {
    init();
  } else if (msg.type === 'FOLLOWERS_LOADED') {
    if (msg.error) {
      alert(msg.error);
      return;
    }
    followers = msg.items || [];
    page = 1;
    renderTable();
    window.__rsxApplyPendingV2?.();
    updatePager();
  } else if (msg.type === 'ROW_UPDATE') {
    const row = followers.find((f) => f.id === msg.id);
    if (row) {
      row.status = { ...(row.status || {}), ...msg.status };
      updateRow(msg.id);
    }
  } else if (msg.type === 'QUEUE_TICK') {
    ov.processed = msg.processed || 0;
    ov.total = msg.total || 0;
    ov.phase = msg.phase || 'idle';
    ov.nextActionAt = msg.nextActionAt || null;
    qs('#rsx-prog').textContent = `${ov.processed} / ${ov.total}`;
    qs('#rsx-phase').textContent = ov.phase;
    tickOverlay();
    if (!ovTimer && ov.phase !== 'done' && ov.phase !== 'paused') {
      ovTimer = setInterval(tickOverlay, 200);
    }
    if (ov.phase === 'done' || ov.phase === 'paused') {
      running = false;
      clearInterval(ovTimer);
      ovTimer = null;
      ov.nextActionAt = null;
      tickOverlay();
      updateRunButtons();
    }
  } else if (msg.type === 'QUEUE_DONE') {
    running = false;
    updateRunButtons();
  }
};
window.addEventListener('message', window.__IG_PANEL_MSG_HANDLER);
window.__IG_PANEL_CLEANUP = () => {
  window.removeEventListener('message', window.__IG_PANEL_MSG_HANDLER);
  window.__IG_PANEL_MSG_HANDLER = null;
};

function init() {
  bindTabs();
  qs('#btnLoadFollowers').addEventListener('click', () => {
    const limit = parseInt(qs('#limit').value, 10) || 0;
    send({
      type: 'LOAD_FOLLOWERS',
      limit,
      includeAlreadyFollowing: cfg.includeAlreadyFollowing,
    });
  });
  qs('#btnLoadFollowing').addEventListener('click', () => {
    const limit = parseInt(qs('#limit').value, 10) || 0;
    send({
      type: 'LOAD_FOLLOWING',
      limit,
      includeAlreadyFollowing: cfg.includeAlreadyFollowing,
    });
  });
  qs('#btnProcess').addEventListener('click', () => {
    toggleMenu('#processMenu');
  });
  qs('#btnLoad').addEventListener('click', () => {
    toggleMenu('#loadMenu');
  });
  qs('#btnProcessConfirm').addEventListener('click', () => {
    startProcessing();
    qs('#processMenu').style.display = 'none';
  });
  qs('#btnStart').addEventListener('click', startProcessing);
  qs('#btnStop').addEventListener('click', stopProcessing);
  qs('#pageSize').addEventListener('change', () => {
    pageSize = parseInt(qs('#pageSize').value, 10);
    cfg.pageSize = pageSize;
    saveCfg();
    renderTable();
    window.__rsxApplyPendingV2?.();
    updatePager();
  });
  qs('#cfgPageSize').addEventListener('change', () => {
    cfg.pageSize = parseInt(qs('#cfgPageSize').value, 10) || DEFAULT_CFG.pageSize;
    pageSize = cfg.pageSize;
    saveCfg();
    qs('#pageSize').value = String(pageSize);
    renderTable();
    window.__rsxApplyPendingV2?.();
    updatePager();
  });
  qs('#likeCount').addEventListener('input', handleLikeInput);
  qs('#cfgSave').addEventListener('click', saveCfgFromInputs);
  qs('#prevPage').addEventListener('click', () => {
    if (page > 1) {
      page--;
      renderTable();
      window.__rsxApplyPendingV2?.();
      updatePager();
    }
  });
  qs('#nextPage').addEventListener('click', () => {
    const totalPages = getTotalPages();
    if (page < totalPages) {
      page++;
      renderTable();
      window.__rsxApplyPendingV2?.();
      updatePager();
    }
  });
  qs('#chkAll').addEventListener('change', (e) => {
    followers.forEach((f) => (f.checked = e.target.checked));
    renderTable();
    window.__rsxApplyPendingV2?.();
  });
  loadCfg();
  updateRunButtons();
}

function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      qs(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
}

function toggleMenu(sel) {
  const m = qs(sel);
  m.style.display = m.style.display === 'block' ? 'none' : 'block';
}

function startProcessing() {
  if (!followers.length || running) return;
  const selected = followers.filter((f) => f.checked);
  const list = (selected.length ? selected : followers).filter(
    (f) => !(f.status && f.status.skip_reason)
  );
  const targets = list.map((u) => ({ id: u.id, username: u.username }));
  const mode = document.querySelector('input[name="actionMode"]:checked').value;
  const likeCount = parseInt(qs('#likeCount').value, 10) || 0;
  const cfgSnapshot = getCurrentCfg();
  send({ type: 'START_QUEUE', mode, likeCount, targets, cfg: cfgSnapshot });
  running = true;
  updateRunButtons();
}

function stopProcessing() {
  send({ type: 'STOP_QUEUE' });
  running = false;
  updateRunButtons();
}

function updateRunButtons() {
  qs('#btnStart').disabled = running;
  qs('#btnProcess').disabled = running;
  qs('#btnLoad').disabled = running;
  qs('#btnStop').disabled = !running;
}

function getTotalPages() {
  if (pageSize === 0) return 1;
  return Math.max(1, Math.ceil(followers.length / pageSize));
}

function renderTable() {
  const body = qs('#queueTable tbody');
  body.innerHTML = '';
  let list = followers;
  if (pageSize !== 0) {
    const start = (page - 1) * pageSize;
    list = followers.slice(start, start + pageSize);
  }
  for (const f of list) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(f.id);
    tr.dataset.username = '@' + f.username;
    const tdChk = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!f.checked;
    chk.addEventListener('change', () => {
      f.checked = chk.checked;
    });
    tdChk.appendChild(chk);
    const tdUser = document.createElement('td');
    tdUser.textContent = '@' + f.username;
    const tdStatus = document.createElement('td');
    tdStatus.className = 'status';
    tdStatus.innerHTML = renderStatus(f.status);
    tr.appendChild(tdChk);
    tr.appendChild(tdUser);
    tr.appendChild(tdStatus);
    body.appendChild(tr);
  }
}

function updateRow(id) {
  const rowEl = qs(`#queueTable tbody tr[data-id="${id}"]`);
  if (rowEl) {
    const st = followers.find((f) => f.id === id)?.status;
    const tdStatus = rowEl.querySelector('td.status');
    if (tdStatus) tdStatus.innerHTML = renderStatus(st);
  }
}

function renderStatus(st) {
  if (!st) return '';
  if (st.error) return `<span class="badge error">${st.error}</span>`;
  if (st.likesTotal)
    return `<span class="badge wait">Likes: ${st.likesDone || 0}/${st.likesTotal}</span>`;
  if (st.result === 'already_following' || st.skip_reason === 'already_following')
    return '<span class="badge wait">Já seguia</span>';
  if (st.result === 'followed' || st.followed || st.unfollowed)
    return '<span class="badge success">Seguido</span>';
  return '';
}

function updatePager() {
  qs('#pageInfo').textContent = `${page}/${getTotalPages()}`;
  qs('#pageSize').value = String(pageSize);
}

function tickOverlay() {
  const etaEl = qs('#rsx-eta');
  if (!ov.nextActionAt) {
    etaEl.textContent = '--:--.-';
    return;
  }
  const rem = Math.max(0, ov.nextActionAt - Date.now());
  const m = Math.floor(rem / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  const d = Math.floor((rem % 1000) / 100);
  etaEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}
function handleLikeInput() {
  const v = parseInt(qs('#likeCount').value, 10) || 0;
  const radio = qs('#modeFollowLike');
  radio.disabled = v <= 0;
  if (v <= 0 && radio.checked) qs('#modeFollow').checked = true;
}

function getCurrentCfg() {
  return {
    baseDelayMs:
      (parseInt(qs('#cfgDelaySec').value, 10) * 1000) ||
      cfg.baseDelayMs ||
      DEFAULT_CFG.baseDelayMs,
    jitterPct: +qs('#cfgJitterPct').value || cfg.jitterPct || DEFAULT_CFG.jitterPct,
    pageSize: cfg.pageSize || DEFAULT_CFG.pageSize,
    likePerProfile:
      +qs('#cfgLikePerProfile').value || cfg.likePerProfile || DEFAULT_CFG.likePerProfile,
    actionModeDefault:
      qs('#cfgMode').value || cfg.actionModeDefault || DEFAULT_CFG.actionModeDefault,
    includeAlreadyFollowing: qs('#cfgIncludeAlreadyFollowing').checked,
  };
}

function saveCfgFromInputs() {
  cfg = getCurrentCfg();
  saveCfg();
  qs('#likeCount').value = String(cfg.likePerProfile);
  qs('#cfgPageSize').value = cfg.pageSize;
  qs('#pageSize').value = String(cfg.pageSize);
  qs('#cfgDelaySec').value = Math.floor(cfg.baseDelayMs / 1000);
  qs('#cfgJitterPct').value = cfg.jitterPct;
  qs('#cfgLikePerProfile').value = cfg.likePerProfile;
  qs('#cfgMode').value = cfg.actionModeDefault;
  qs('#modeFollow').checked = cfg.actionModeDefault === 'follow';
  qs('#modeFollowLike').checked = cfg.actionModeDefault === 'follow_like';
  qs('#modeUnfollow').checked = cfg.actionModeDefault === 'unfollow';
  qs('#cfgIncludeAlreadyFollowing').checked = cfg.includeAlreadyFollowing;
  pageSize = cfg.pageSize;
  renderTable();
  window.__rsxApplyPendingV2?.();
  updatePager();
  handleLikeInput();
}

function loadCfg() {
  chrome.storage.local.get(DEFAULT_CFG, (st) => {
    cfg = { ...DEFAULT_CFG, ...st };
    qs('#cfgDelaySec').value = Math.floor(cfg.baseDelayMs / 1000);
    qs('#cfgJitterPct').value = cfg.jitterPct;
    qs('#cfgPageSize').value = cfg.pageSize;
    qs('#cfgLikePerProfile').value = cfg.likePerProfile;
    qs('#cfgMode').value = cfg.actionModeDefault;
    qs('#likeCount').value = cfg.likePerProfile;
    qs('#modeFollow').checked = cfg.actionModeDefault === 'follow';
    qs('#modeFollowLike').checked = cfg.actionModeDefault === 'follow_like';
    qs('#modeUnfollow').checked = cfg.actionModeDefault === 'unfollow';
    qs('#cfgIncludeAlreadyFollowing').checked = cfg.includeAlreadyFollowing;
    pageSize = cfg.pageSize;
      qs('#pageSize').value = String(pageSize);
      handleLikeInput();
      renderTable();
      window.__rsxApplyPendingV2?.();
      updatePager();
    });
  }

function saveCfg() {
  chrome.storage.local.set(cfg);
  chrome.runtime.sendMessage({ type: 'CFG_UPDATED', cfg });
}

(function ensureV2Listener() {
  if (window.__rsxV2Bound) return;
  window.__rsxV2Bound = true;

  const overlay = { processed: 0, total: 0, phase: 'idle', nextActionAt: null };
  let ovTimer = setInterval(tick, 200);

  const pendingMap = Object.create(null);

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || !d.__RSX_V2__ || d.type !== 'QEVENT_V2') return;
    if (d.sub === 'tick') {
      overlay.processed = d.processed;
      overlay.total = d.total;
      overlay.phase = d.phase;
      overlay.nextActionAt = d.nextActionAt || null;
      const prog = document.querySelector('#rsx-prog');
      if (prog) prog.textContent = `${overlay.processed} / ${overlay.total}`;
      const ph = document.querySelector('#rsx-phase');
      if (ph) ph.textContent = overlay.phase;
      if (!ovTimer && overlay.phase !== 'done' && overlay.phase !== 'paused') {
        ovTimer = setInterval(tick, 200);
      }
      if (overlay.phase === 'done') {
        clearInterval(ovTimer);
        ovTimer = null;
        overlay.nextActionAt = null;
        tick();
      }
    } else if (d.sub === 'item') {
      const uname = d.username;
      if (!applyRowStatus(uname, d)) pendingMap[uname] = d;
    } else if (d.sub === 'done') {
      overlay.phase = 'done';
      overlay.nextActionAt = null;
      const ph = document.querySelector('#rsx-phase');
      if (ph) ph.textContent = overlay.phase;
      const prog = document.querySelector('#rsx-prog');
      if (prog) prog.textContent = `${d.processed} / ${d.total}`;
      clearInterval(ovTimer);
      ovTimer = null;
      tick();
    }
  });

  window.__rsxApplyPendingV2 = function applyPendingOnPage() {
    for (const uname in pendingMap) {
      if (applyRowStatus(uname, pendingMap[uname])) delete pendingMap[uname];
    }
  };

  function applyRowStatus(username, d) {
    const tr = document.querySelector(`[data-username="@${username}"]`);
    if (!tr) return false;
    const td = tr.querySelector('td.status');
    if (!td) return false;
    td.innerHTML = renderChip(d.result, d.message);
    return true;
  }

  function renderChip(result, message) {
    switch (result) {
      case 'followed':
        return '<span class="badge success">Seguido</span>';
      case 'liked':
        return '<span class="badge success">Curtido</span>';
      case 'already_following':
        return '<span class="badge wait">Já seguia</span>';
      case 'no_media':
      case 'skipped':
        return `<span class="badge wait">${message || result}</span>`;
      case 'error':
        return `<span class="badge error">${message || 'Erro'}</span>`;
      default:
        return `<span class="badge wait">${message || result || ''}</span>`;
    }
  }

  function tick() {
    const etaEl = document.querySelector('#rsx-eta');
    if (!etaEl) return;
    if (!overlay.nextActionAt) {
      etaEl.textContent = '--:--.-';
      return;
    }
    const rem = Math.max(0, overlay.nextActionAt - Date.now());
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    const d = Math.floor((rem % 1000) / 100);
    etaEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
  }
})();