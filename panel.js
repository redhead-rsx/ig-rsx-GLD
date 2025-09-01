const SETTINGS_KEY = 'ig_settings';
let followers = [];
let page = 1;
let pageSize = 10;
let running = false;
let countdownTimer = null;
let settings = {
  delayMs: 0,
  randomJitterPct: 0,
  actionMode: 'follow',
  likeCount: 1,
  pageSizeDefault: 10,
};

function send(msg) {
  window.postMessage({ from: 'ig-panel', ...msg }, '*');
}

function qs(sel) {
  return document.querySelector(sel);
}

window.addEventListener('message', (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'PANEL_READY') {
    init();
  } else if (msg.type === 'FOLLOWERS_LOADED') {
    qs('#progressHud').classList.add('hidden');
    if (msg.error) {
      alert(msg.error);
      return;
    }
    followers = msg.items || [];
    page = 1;
    renderTable();
    updatePager();
  } else if (msg.type === 'ROW_UPDATE') {
    const row = followers.find((f) => f.id === msg.id);
    if (row) {
      row.status = { ...(row.status || {}), ...msg.status };
      renderTable();
    }
  } else if (msg.type === 'PROGRESS') {
    qs('#progressText').textContent = `${msg.done}/${msg.total}`;
    startCountdown(msg.etaMs || 0);
    qs('#progressHud').classList.remove('hidden');
  } else if (msg.type === 'STOPPED') {
    running = false;
    qs('#progressHud').classList.add('hidden');
    updateRunButtons();
  }
});

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
    settings.actionMode = document.querySelector('input[name="actionMode"]:checked').value;
    settings.likeCount = parseInt(qs('#likeCount').value, 10) || 1;
    saveSettings();
    startProcessing();
    qs('#processMenu').style.display = 'none';
  });
  qs('#btnStart').addEventListener('click', startProcessing);
  qs('#btnStop').addEventListener('click', stopProcessing);
  qs('#btnStopHud').addEventListener('click', stopProcessing);
  qs('#pageSize').addEventListener('change', () => {
    pageSize = parseInt(qs('#pageSize').value, 10);
    settings.pageSizeDefault = pageSize;
    saveSettings();
    renderTable();
    updatePager();
  });
  qs('#cfgPageSize').addEventListener('change', () => {
    settings.pageSizeDefault = parseInt(qs('#cfgPageSize').value, 10) || 10;
    pageSize = settings.pageSizeDefault;
    saveSettings();
    qs('#pageSize').value = String(pageSize);
    renderTable();
    updatePager();
  });
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
  loadSettings();
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
  if (!followers.length) return;
  const selected = followers.filter((f) => f.checked);
  const list = selected.length ? selected : followers;
  const items = list.map((u) => ({ id: u.id, username: u.username }));
  settings.delayMs = parseInt(qs('#cfgDelay').value, 10) || 0;
  settings.randomJitterPct = parseInt(qs('#cfgJitter').value, 10) || 0;
  saveSettings();
  send({ type: 'START_PROCESS', items, settings });
  running = true;
  updateRunButtons();
}

function stopProcessing() {
  send({ type: 'STOP_PROCESS' });
  running = false;
  qs('#progressHud').classList.add('hidden');
  updateRunButtons();
}

function updateRunButtons() {
  qs('#btnStart').disabled = running;
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
    tdStatus.innerHTML = renderStatus(f.status);
    tr.appendChild(tdChk);
    tr.appendChild(tdUser);
    tr.appendChild(tdStatus);
    body.appendChild(tr);
  }
}

function renderStatus(st) {
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

function startCountdown(ms) {
  clearInterval(countdownTimer);
  let remain = Math.floor(ms / 1000);
  const el = qs('#countdown');
  const update = () => {
    const m = String(Math.floor(remain / 60)).padStart(2, '0');
    const s = String(remain % 60).padStart(2, '0');
    el.textContent = `${m}:${s}`;
  };
  update();
  countdownTimer = setInterval(() => {
    remain = Math.max(0, remain - 1);
    update();
    if (remain <= 0) clearInterval(countdownTimer);
  }, 1000);
}

async function loadSettings() {
  const st = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  settings = { ...settings, ...st };
  qs('#cfgDelay').value = settings.delayMs;
  qs('#cfgJitter').value = settings.randomJitterPct;
  qs('#likeCount').value = settings.likeCount;
  pageSize = settings.pageSizeDefault || 10;
  qs('#pageSize').value = String(pageSize);
  qs('#cfgPageSize').value = pageSize;
  const radio = document.querySelector(
    `input[name="actionMode"][value="${settings.actionMode}"]`
  );
  if (radio) radio.checked = true;
}

function saveSettings() {
  chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
