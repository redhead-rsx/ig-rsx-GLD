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
    updatePager();
    if (typeof msg.removedAlreadyFollowing === 'number') {
      qs('#collectProgress').textContent = `Coletados ${followers.length}/${msg.total} (removidos ${msg.removedAlreadyFollowing} já seguidos)`;
    }
  } else if (msg.type === 'ROW_UPDATE') {
    const row = followers.find((f) => f.id === msg.id);
    if (row) {
      row.status = { ...(row.status || {}), ...msg.status };
      renderTable();
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
    ov.processed = msg.processed || ov.processed;
    ov.total = msg.total || ov.total;
    ov.phase = 'done';
    ov.nextActionAt = null;
    qs('#rsx-prog').textContent = `${ov.processed} / ${ov.total}`;
    qs('#rsx-phase').textContent = ov.phase;
    clearInterval(ovTimer);
    ovTimer = null;
    tickOverlay();
    updateRunButtons();
  } else if (msg.type === 'COLLECT_PROGRESS') {
    qs('#collectProgress').textContent = `Coletados ${msg.fetched}/${msg.totalTarget} (removidos ${msg.removedAlreadyFollowing || 0} já seguidos)`;
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
    send({ type: 'LOAD_FOLLOWERS', limit });
  });
  qs('#btnLoadFollowing').addEventListener('click', () => {
    const limit = parseInt(qs('#limit').value, 10) || 0;
    send({ type: 'LOAD_FOLLOWING', limit });
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
    updatePager();
  });
  qs('#cfgPageSize').addEventListener('change', () => {
    cfg.pageSize = parseInt(qs('#cfgPageSize').value, 10) || DEFAULT_CFG.pageSize;
    pageSize = cfg.pageSize;
    saveCfg();
    qs('#pageSize').value = String(pageSize);
    renderTable();
    updatePager();
  });
  qs('#likeCount').addEventListener('input', handleLikeInput);
  qs('#cfgSave').addEventListener('click', saveCfgFromInputs);
  qs('#prevPage').addEventListener('click', () => {
    if (page > 1) {
      page--;
      renderTable();
      updatePager();
    }
  });
  qs('#nextPage').addEventListener('click', () => {
    const totalPages = getTotalPages();
    if (page < totalPages) {
      page++;
      renderTable();
      updatePager();
    }
  });
  qs('#chkAll').addEventListener('change', (e) => {
    followers.forEach((f) => (f.checked = e.target.checked));
    renderTable();
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
  const list = selected.length ? selected : followers;
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
    tdStatus.innerHTML = renderStatus(f);
    tr.appendChild(tdChk);
    tr.appendChild(tdUser);
    tr.appendChild(tdStatus);
    body.appendChild(tr);
  }
}

function renderStatus(f) {
  const st = f.status;
  if (f.rel?.rel_unknown) return '<span class="badge wait">?</span>';
  if (f.rel?.following) return '<span class="badge info">Já seguia</span>';
  if (!st) return '';
  if (st.error) return `<span class="badge error">${st.error}</span>`;
  if (st.likesTotal)
    return `<span class="badge wait">Likes: ${st.likesDone || 0}/${st.likesTotal}</span>`;
  if (st.followed || st.unfollowed)
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
    baseDelayMs: +qs('#cfgDelayMs').value || cfg.baseDelayMs || DEFAULT_CFG.baseDelayMs,
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
  qs('#cfgDelayMs').value = cfg.baseDelayMs;
  qs('#cfgJitterPct').value = cfg.jitterPct;
  qs('#cfgLikePerProfile').value = cfg.likePerProfile;
  qs('#cfgMode').value = cfg.actionModeDefault;
  qs('#cfgIncludeAlreadyFollowing').checked = cfg.includeAlreadyFollowing;
  qs('#modeFollow').checked = cfg.actionModeDefault === 'follow';
  qs('#modeFollowLike').checked = cfg.actionModeDefault === 'follow_like';
  qs('#modeUnfollow').checked = cfg.actionModeDefault === 'unfollow';
  pageSize = cfg.pageSize;
  renderTable();
  updatePager();
  handleLikeInput();
}

function loadCfg() {
  chrome.storage.local.get(DEFAULT_CFG, (st) => {
    cfg = { ...DEFAULT_CFG, ...st };
    qs('#cfgDelayMs').value = cfg.baseDelayMs;
    qs('#cfgJitterPct').value = cfg.jitterPct;
    qs('#cfgPageSize').value = cfg.pageSize;
    qs('#cfgLikePerProfile').value = cfg.likePerProfile;
    qs('#cfgMode').value = cfg.actionModeDefault;
    qs('#cfgIncludeAlreadyFollowing').checked = cfg.includeAlreadyFollowing;
    qs('#likeCount').value = cfg.likePerProfile;
    qs('#modeFollow').checked = cfg.actionModeDefault === 'follow';
    qs('#modeFollowLike').checked = cfg.actionModeDefault === 'follow_like';
    qs('#modeUnfollow').checked = cfg.actionModeDefault === 'unfollow';
    pageSize = cfg.pageSize;
    qs('#pageSize').value = String(pageSize);
    handleLikeInput();
    renderTable();
    updatePager();
  });
}

function saveCfg() {
  chrome.storage.local.set(cfg);
  chrome.runtime.sendMessage({ type: 'CFG_UPDATED', cfg });
}