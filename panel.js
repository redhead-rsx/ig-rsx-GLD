const DEFAULT_CFG = {
  baseDelayMs: 3000,
  jitterPct: 20,
  pageSize: 10,
  likePerProfile: 1,
  actionModeDefault: 'follow_like',
  includeAlreadyFollowing: false,
};
let cfg = { ...DEFAULT_CFG };
const state = {
  data: [],
  processed: 0,
  total: 0,
  phase: 'idle',
  nextActionAt: null,
  page: 1,
  pageSize: DEFAULT_CFG.pageSize,
};
let running = false;
let etaTimer = null;

function send(msg) {
  window.postMessage({ from: 'ig-panel', ...msg }, '*');
}

function qs(sel) {
  return document.querySelector(sel);
}

if (window.__RSX_PANEL_MSG_HANDLER) {
  window.removeEventListener('message', window.__RSX_PANEL_MSG_HANDLER);
}
window.__RSX_PANEL_MSG_HANDLER = (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'PANEL_READY') {
    init();
    return;
  }
  if (!msg.__RSX__ || !msg.type) return;
  if (msg.type === 'FOLLOWERS_LOADED') {
    if (msg.error) {
      alert(msg.error);
      return;
    }
    const seen = new Set(state.data.map((i) => i.id || i.username));
    for (const it of msg.items || []) {
      const key = it.id || it.username;
      if (!seen.has(key)) {
        state.data.push(it);
        seen.add(key);
      }
    }
    state.page = 1;
    renderPage();
    updatePager();
  } else if (msg.type === 'ROW_UPDATE') {
    const idx =
      msg.index !== undefined
        ? msg.index
        : state.data.findIndex(
            (f) => f.id === msg.id || f.username === msg.username,
          );
    if (idx >= 0) {
      state.data[idx].status = normalizeStatus(msg.status);
      updateRowIfVisible(idx);
    }
  } else if (msg.type === 'QUEUE_TICK') {
    state.processed = msg.processed || 0;
    state.total = msg.total || 0;
    state.phase = msg.phase || 'idle';
    state.nextActionAt = msg.nextActionAt || null;
    updateOverlay();
  } else if (msg.type === 'QUEUE_DONE') {
    state.phase = 'done';
    state.nextActionAt = null;
    updateOverlay();
    running = false;
    updateRunButtons();
  }
};
window.addEventListener('message', window.__RSX_PANEL_MSG_HANDLER);
window.__IG_PANEL_CLEANUP = () => {
  window.removeEventListener('message', window.__RSX_PANEL_MSG_HANDLER);
  window.__RSX_PANEL_MSG_HANDLER = null;
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
    state.pageSize = parseInt(qs('#pageSize').value, 10);
    cfg.pageSize = state.pageSize;
    saveCfg();
    renderPage();
    updatePager();
  });
  qs('#cfgPageSize').addEventListener('change', () => {
    cfg.pageSize =
      parseInt(qs('#cfgPageSize').value, 10) || DEFAULT_CFG.pageSize;
    state.pageSize = cfg.pageSize;
    saveCfg();
    qs('#pageSize').value = String(state.pageSize);
    renderPage();
    updatePager();
  });
  qs('#likeCount').addEventListener('input', handleLikeInput);
  qs('#cfgSave').addEventListener('click', saveCfgFromInputs);
  qs('#prevPage').addEventListener('click', gotoPrev);
  qs('#nextPage').addEventListener('click', gotoNext);
  qs('#chkAll').addEventListener('change', (e) => {
    state.data.forEach((f) => (f.checked = e.target.checked));
    renderPage();
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
  if (!state.data.length || running) return;
  const selected = state.data.filter((f) => f.checked);
  const list = (selected.length ? selected : state.data).filter(
    (f) => !(f.status && f.status.skip_reason),
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
  if (state.pageSize === 0) return 1;
  return Math.max(1, Math.ceil(state.data.length / state.pageSize));
}

function itemIsOnCurrentPage(idx) {
  const start = (state.page - 1) * state.pageSize;
  const end = state.pageSize === 0 ? state.data.length : start + state.pageSize;
  return idx >= start && idx < end;
}

function renderRow(item, idxGlobal) {
  const tr = document.createElement('tr');
  tr.dataset.idx = String(idxGlobal);
  const tdChk = document.createElement('td');
  const chk = document.createElement('input');
  chk.type = 'checkbox';
  chk.checked = !!item.checked;
  chk.addEventListener('change', () => {
    item.checked = chk.checked;
  });
  tdChk.appendChild(chk);
  const tdUser = document.createElement('td');
  tdUser.textContent = '@' + item.username;
  const tdStatus = document.createElement('td');
  tdStatus.className = 'status';
  tdStatus.innerHTML = renderStatus(item.status);
  tr.appendChild(tdChk);
  tr.appendChild(tdUser);
  tr.appendChild(tdStatus);
  return tr;
}

function renderPage() {
  const body = qs('#queueTable tbody');
  body.innerHTML = '';
  const start = (state.page - 1) * state.pageSize;
  const end =
    state.pageSize === 0 ? state.data.length : start + state.pageSize;
  const list = state.data.slice(start, end);
  list.forEach((item, i) => {
    body.appendChild(renderRow(item, start + i));
  });
}

function updateRowIfVisible(idx) {
  if (!itemIsOnCurrentPage(idx)) return;
  const tbody = qs('#queueTable tbody');
  const tr = tbody.querySelector(`tr[data-idx="${idx}"]`);
  if (tr) tr.replaceWith(renderRow(state.data[idx], idx));
}

function renderStatus(st) {
  if (!st) return '';
  const span = document.createElement('span');
  span.className = `badge ${st.kind || ''}`;
  span.textContent = st.text || '';
  return span.outerHTML;
}

function updatePager() {
  qs('#pageInfo').textContent = `${state.page}/${getTotalPages()}`;
  qs('#pageSize').value = String(state.pageSize);
}

function startEta() {
  if (etaTimer) return;
  etaTimer = setInterval(() => {
    const etaEl = qs('#rsx-eta');
    if (!state.nextActionAt) {
      etaEl.textContent = '--:--.-';
      return;
    }
    const rem = Math.max(0, state.nextActionAt - Date.now());
    const m = Math.floor(rem / 60000);
    const s = Math.floor((rem % 60000) / 1000);
    const d = Math.floor((rem % 1000) / 100);
    etaEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
  }, 200);
}

function stopEta() {
  clearInterval(etaTimer);
  etaTimer = null;
  qs('#rsx-eta').textContent = '--:--.-';
}

function updateOverlay() {
  qs('#rsx-prog').textContent = `${state.processed} / ${state.total}`;
  qs('#rsx-phase').textContent = state.phase;
  if (state.phase === 'done' || !state.nextActionAt) {
    stopEta();
  } else {
    startEta();
  }
}

function gotoNext() {
  const totalPages = getTotalPages();
  if (state.page < totalPages) {
    state.page++;
    renderPage();
    updatePager();
  }
}

function gotoPrev() {
  if (state.page > 1) {
    state.page--;
    renderPage();
    updatePager();
  }
}

function normalizeStatus(st) {
  if (!st) return null;
  if (st.text) return st;
  if (st.error) return { text: st.error, kind: 'err' };
  if (st.likesTotal)
    return {
      text: `Likes: ${st.likesDone || 0}/${st.likesTotal}`,
      kind: 'ok',
    };
  if (st.result === 'already_following' || st.skip_reason === 'already_following')
    return { text: 'Já seguia', kind: 'skip' };
  if (st.result === 'followed' || st.followed || st.unfollowed)
    return { text: 'Seguido', kind: 'ok' };
  return st;
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
  state.pageSize = cfg.pageSize;
  renderPage();
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
    state.pageSize = cfg.pageSize;
    qs('#pageSize').value = String(state.pageSize);
    handleLikeInput();
    renderPage();
    updatePager();
  });
}

function saveCfg() {
  chrome.storage.local.set(cfg);
  chrome.runtime.sendMessage({ type: 'CFG_UPDATED', cfg });
}
