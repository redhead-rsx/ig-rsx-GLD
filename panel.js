const followersPerPage = 10;
let followers = [];
let currentPage = 1;
let currentUsername = null;
let followersState = { cursor: null, totalLoaded: 0, lastIndex: 0 };
let queueView = null;
let panelDoc;
let nextWaitMs = 0;
let countdownTimer = null;
const qs = (sel) => panelDoc?.querySelector(sel);
const on = (sel, ev, fn) => qs(sel)?.addEventListener(ev, fn);
const LOG_KEY = (user) => `silent.log.${user}`;
const STATE_KEY = (user) => `silent.followers.${user}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function init(root) {
  panelDoc = root;
  bindTabs();
  bindDropdown();
  panelDoc
    .getElementById("loadFollowers")
    .addEventListener("click", loadFollowersOfCurrentProfile);
  panelDoc.getElementById("process").addEventListener("click", openActionDialog);
  panelDoc.getElementById("dlgCancel").addEventListener("click", closeActionDialog);
  panelDoc.getElementById("dlgAdd").addEventListener("click", confirmActionDialog);
  panelDoc
    .getElementById("start")
    .addEventListener("click", startRun);
  panelDoc
    .getElementById("stop")
    .addEventListener("click", stopRun);
  panelDoc
    .querySelectorAll('input[name="actionMode"]')
    .forEach((r) => r.addEventListener("change", onDialogModeChange));
  onDialogModeChange();
  loadConfig();
  restoreState().then(restoreLog);
  updateRunButtons(false);
  on("#clearLog", "click", clearRunLog);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

function bindTabs() {
  panelDoc.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      panelDoc
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      panelDoc
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      panelDoc.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

function bindDropdown() {
  const btn = panelDoc.getElementById("loadBtn");
  const menu = panelDoc.getElementById("loadMenu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  });
  panelDoc.addEventListener("click", () => {
    menu.style.display = "none";
  });
}

export function extractUsernameFromUrl(url) {
  const m = url.match(
    /^https?:\/\/(www\.)?instagram\.com\/([^\/\?#]+)(?:[\/\?#].*)?$/i
  );
  const u = m?.[2] || "";
  const blacklist = new Set([
    "explore",
    "accounts",
    "reels",
    "p",
    "stories",
    "direct",
    "challenge",
    "graphql",
    "api",
    "about",
    "legal",
  ]);
  return blacklist.has(u.toLowerCase()) ? null : u;
}

function execTask(task) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "EXEC_IN_ACTIVE_TAB", task }, (res) => {
      if (!chrome.runtime.lastError && res !== undefined) {
        resolve(res);
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) return resolve(undefined);
          chrome.tabs.sendMessage(tabId, { type: "EXEC_TASK", task }, (r) =>
            resolve(r)
          );
        });
      }
    });
  });
}

function getLocal(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => resolve(res[key]));
  });
}

function setLocal(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function logLine(html) {
  const box = qs("#runLog");
  if (!box) return;
  const ts = new Date().toLocaleTimeString();
  const line = `<div>[${ts}] ${html}</div>`;
  box.insertAdjacentHTML("afterbegin", line);
  if (!currentUsername) return;
  const key = LOG_KEY(currentUsername);
  getLocal(key).then((log) => {
    const arr = Array.isArray(log) ? log : [];
    arr.unshift(line);
    if (arr.length > 500) arr.length = 500;
    setLocal(key, arr);
  });
}

async function restoreLog() {
  if (!currentUsername) return;
  const key = LOG_KEY(currentUsername);
  const log = (await getLocal(key)) || [];
  const box = qs("#runLog");
  if (box) box.innerHTML = log.join("");
}

function clearRunLog() {
  const box = qs("#runLog");
  if (box) box.innerHTML = "";
  if (currentUsername) setLocal(LOG_KEY(currentUsername), []);
}

function updateRunButtons(running) {
  panelDoc.getElementById("start").disabled = running;
  panelDoc.getElementById("stop").disabled = !running;
}

function startRun() {
  if (followers.some((u) => u.status?.queued || u.status?.running)) {
    const cont = confirm("Continuar processando a fila atual?");
    if (!cont) return;
  }
  chrome.runtime.sendMessage({ type: "RUN_START" });
  logLine("Execução iniciada");
  updateRunButtons(true);
}

function stopRun() {
  chrome.runtime.sendMessage({ type: "RUN_STOP" });
  logLine("Execução parada");
  updateRunButtons(false);
}

async function loadState() {
  if (!currentUsername) return;
  const key = STATE_KEY(currentUsername);
  const saved = await getLocal(key);
  if (saved) {
    followers = saved.users || [];
    followersState.cursor = saved.cursor;
    followersState.totalLoaded = saved.totalLoaded || 0;
    followersState.lastIndex = saved.lastIndex || 0;
  }
  queueView = (await getLocal(`silent.queueView.${currentUsername}`)) || null;
}

async function saveState() {
  if (!currentUsername) return;
  const key = STATE_KEY(currentUsername);
  await setLocal(key, {
    users: followers,
    cursor: followersState.cursor,
    totalLoaded: followersState.totalLoaded,
    lastIndex: followersState.lastIndex,
  });
  await setLocal(`silent.queueView.${currentUsername}`, queueView);
}

async function restoreState() {
  currentUsername = extractUsernameFromUrl(location.href);
  if (!currentUsername) return;
  await loadState();
  currentPage = 1;
  if (queueView && queueView.items?.length) {
    renderQueue();
  } else if (followers.length) {
    renderFollowers();
  }
}

async function lookupUserId(username) {
  let lastErr = "unknown";
  for (let i = 0; i < 3; i++) {
    const res = await execTask({ kind: "LOOKUP", username }).catch((e) => ({
      ok: false,
      error: String(e),
    }));
    if (res?.ok && (res.out?.userId || res.out?.id)) {
      return res.out.userId || res.out.id;
    }
    lastErr = res?.error || "no_response";
    await sleep(300 * (i + 1));
  }
  throw new Error("lookup_failed:" + lastErr);
}

async function loadFollowersOfCurrentProfile() {
  const username = extractUsernameFromUrl(location.href);
  if (!username) {
    alert("Abra um perfil do Instagram para carregar seguidores.");
    return;
  }

  const saved = (await chrome.storage.local.get(STATE_KEY(username)))[
    STATE_KEY(username)
  ];
  let startIndex = 0;
  let resume = false;
  if (saved?.users?.length) {
    if (confirm("Você gostaria de tentar continuar de onde parou?")) {
      resume = true;
    } else {
      const v = prompt(
        "Digite o número do seguidor para começar (0 = mais recente).",
        "0"
      );
      startIndex = Math.max(0, parseInt(v || "0", 10) || 0);
    }
  } else {
    const v = prompt(
      "Digite o número do seguidor para começar (0 = mais recente).",
      "0"
    );
    startIndex = Math.max(0, parseInt(v || "0", 10) || 0);
  }

  let userId;
  try {
    userId = await lookupUserId(username);
  } catch (e) {
    alert("Não foi possível resolver o usuário.\nDetalhes: " + e.message);
    return;
  }

  const MAX = 200;
  let collected = resume ? saved.users || [] : [];
  let cursor = resume ? saved.cursor || null : null;

  while (collected.length < MAX) {
    const res = await execTask({
      kind: "LIST_FOLLOWERS",
      userId,
      limit: 24,
      cursor,
    }).catch((e) => ({ ok: false, error: String(e) }));

    if (!res?.ok || !res.out) {
      alert("Falha ao listar seguidores: " + (res?.error || "desconhecido"));
      break;
    }

    const batch = res.out.users || [];
    collected = collected.concat(batch);
    cursor = res.out.nextCursor || null;
    if (!cursor || batch.length === 0) break;
    await sleep(200);
  }

  if (startIndex > 0 && collected.length > startIndex) {
    collected = collected.slice(startIndex);
  }

  const state = {
    users: collected
      .slice(0, MAX)
      .map((u) => ({ id: u.id, username: u.username, status: {} })),
    cursor,
    totalLoaded: collected.length,
    lastIndex: resume ? saved.lastIndex || 0 : startIndex,
  };

  await chrome.storage.local.set({ [STATE_KEY(username)]: state });

  currentUsername = username;
  followersState.cursor = state.cursor;
  followersState.totalLoaded = state.totalLoaded;
  followersState.lastIndex = state.lastIndex;
  renderFollowersTable(username, state.users);
}

function renderFollowersTable(username, users) {
  currentUsername = username;
  followers = users || [];
  currentPage = 1;
  renderFollowers();
}

function renderStatus(td, st) {
  td.innerHTML = "";
  const parts = [];
  if (st.queued) parts.push("Na fila");
  if (st.running) parts.push("Em andamento…");
  if (st.followed) parts.push(createBadge("Seguido", "badge--seguido"));
  if (st.likesTotal)
    parts.push(
      createBadge(
        `Likes: ${st.likesDone || 0}/${st.likesTotal}`,
        "badge--like",
      ),
    );
  if (st.unfollowed) parts.push(createBadge("Unfollowed", "badge--unfollow"));
  if (st.error) parts.push(`Erro: ${st.error}`);
  parts.forEach((p) => {
    if (typeof p === "string") {
      const s = document.createElement("span");
      s.textContent = p;
      td.appendChild(s);
    } else td.appendChild(p);
    td.appendChild(document.createTextNode(" "));
  });
}

function createBadge(text, cls) {
  const b = document.createElement("span");
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

function renderFollowers() {
  const tbody = panelDoc.querySelector("#followersTable tbody");
  tbody.innerHTML = "";
  const start = (currentPage - 1) * followersPerPage;
  const pageUsers = followers.slice(start, start + followersPerPage);
  pageUsers.forEach((u) => {
    const tr = document.createElement("tr");
    const tdCheck = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "user-check";
    chk.checked = !!u.checked;
    chk.addEventListener("change", () => {
      u.checked = chk.checked;
    });
    tdCheck.appendChild(chk);
    const tdAvatar = document.createElement("td");
    const av = document.createElement("div");
    av.className = "avatar";
    tdAvatar.appendChild(av);
    const tdUser = document.createElement("td");
    tdUser.textContent = "@" + u.username;
    const tdStatus = document.createElement("td");
    renderStatus(tdStatus, u.status || {});
    tr.append(tdCheck, tdAvatar, tdUser, tdStatus);
    tbody.appendChild(tr);
  });
  renderPagination(followers.length);
}

function renderQueue() {
  const tbody = panelDoc.querySelector("#followersTable tbody");
  tbody.innerHTML = "";
  if (!queueView) return;
  const start = (currentPage - 1) * followersPerPage;
  const pageItems = queueView.items.slice(start, start + followersPerPage);
  pageItems.forEach((item) => {
    const u =
      followers.find((f) => f.id === item.userId) || {
        username: item.username,
        status: {},
      };
    const tr = document.createElement("tr");
    const tdCheck = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.disabled = true;
    tdCheck.appendChild(chk);
    const tdAvatar = document.createElement("td");
    const av = document.createElement("div");
    av.className = "avatar";
    tdAvatar.appendChild(av);
    const tdUser = document.createElement("td");
    tdUser.textContent = "@" + (u.username || item.username);
    const tdStatus = document.createElement("td");
    renderStatus(tdStatus, u.status || {});
    tr.append(tdCheck, tdAvatar, tdUser, tdStatus);
    tbody.appendChild(tr);
  });
  renderPagination(queueView.items.length);
}

function renderPagination(total) {
  const totalPages = Math.ceil(total / followersPerPage);
  const container = panelDoc.getElementById("pagination");
  container.innerHTML = "";
  if (totalPages <= 1) return;
  const render = queueView ? renderQueue : renderFollowers;
  const addBtn = (label, handler, disabled = false, active = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (disabled) b.disabled = true;
    if (active) b.classList.add("active");
    b.addEventListener("click", handler);
    container.appendChild(b);
  };
  addBtn("<<", () => {
    currentPage = 1;
    render();
  }, currentPage === 1);
  addBtn("<", () => {
    if (currentPage > 1) {
      currentPage--;
      render();
    }
  }, currentPage === 1);
  for (let p = 1; p <= totalPages; p++) {
    addBtn(
      String(p),
      () => {
        currentPage = p;
        render();
      },
      false,
      p === currentPage,
    );
  }
  addBtn(
    ">",
    () => {
      if (currentPage < totalPages) {
        currentPage++;
        render();
      }
    },
    currentPage === totalPages,
  );
  addBtn(
    ">>",
    () => {
      currentPage = totalPages;
      render();
    },
    currentPage === totalPages,
  );
}

function openActionDialog() {
  panelDoc.getElementById("actionDialog").classList.add("show");
}

function closeActionDialog() {
  panelDoc.getElementById("actionDialog").classList.remove("show");
}

function onDialogModeChange() {
  const mode = panelDoc.querySelector('input[name="actionMode"]:checked').value;
  panelDoc.getElementById("dlgLikeCount").style.display =
    mode === "follow-like" ? "inline-block" : "none";
}

async function confirmActionDialog() {
  if (!followers.length) {
    closeActionDialog();
    return;
  }
  let list = followers.filter((u) => u.checked);
  if (!list.length) list = followers;
  const mode = panelDoc.querySelector('input[name="actionMode"]:checked').value;
  const likeCount = parseInt(panelDoc.getElementById("dlgLikeCount").value, 10) || 1;
  const items = [];
  const snapshot = [];
  for (const u of list) {
    const st = {
      queued: true,
      running: false,
      followed: false,
      likesTotal: mode === "follow-like" ? likeCount : 0,
      likesDone: 0,
      unfollowed: false,
      error: undefined,
    };
    if (mode === "follow") {
      items.push({ kind: "FOLLOW", userId: u.id, username: u.username });
    } else if (mode === "follow-like") {
      items.push({ kind: "FOLLOW", userId: u.id, username: u.username });
      for (let i = 0; i < likeCount; i++) {
        items.push({ kind: "LAST_MEDIA", userId: u.id, username: u.username });
        items.push({
          kind: "LIKE",
          userId: u.id,
          username: u.username,
          likeIndex: i + 1,
          likeTotal: likeCount,
        });
      }
    } else if (mode === "unfollow") {
      items.push({ kind: "UNFOLLOW", userId: u.id, username: u.username });
    }
    u.status = st;
    snapshot.push({
      userId: u.id,
      username: u.username,
      likesPlanned: st.likesTotal,
    });
  }
  queueView = { createdAt: Date.now(), items: snapshot };
  chrome.runtime.sendMessage({ type: "QUEUE_ADD", items });
  logLine(`Fila criada com ${items.length} itens`);
  chrome.runtime.sendMessage({ type: "RUN_START" });
  logLine("Execução iniciada");
  await saveState();
  currentPage = 1;
  panelDoc.querySelector('.tab-btn[data-tab="queue"]').click();
  renderQueue();
  updateRunButtons(true);
  showToast(`${items.length} tarefas adicionadas`);
  closeActionDialog();
}

function showToast(msg) {
  const t = panelDoc.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => {
    t.style.display = "none";
  }, 3000);
}

async function loadConfig() {
  const cfg = (await getLocal("silent.cfg.v1")) || {};
  const ids = [
    "cfgActionDelay",
    "cfgSkipDelay",
    "cfgRandomPercent",
    "cfgRetrySoft",
    "cfgRetryHard",
    "cfgRetry429",
    "cfgUnfollowOlderThan",
    "cfgNotUnfollowYoungerThan",
  ];
  panelDoc.getElementById("cfgKeepFollowers").checked = !!cfg.keepFollowers;
  panelDoc.getElementById("cfgUnfollowOlderThanChk").checked =
    !!cfg.unfollowOlderThanChk;
  panelDoc.getElementById("cfgNotUnfollowYoungerThanChk").checked =
    !!cfg.notUnfollowYoungerThanChk;
  ids.forEach((id) => {
    if (cfg[id] !== undefined) panelDoc.getElementById(id).value = cfg[id];
  });
  panelDoc
    .querySelectorAll("#tab-settings input")
    .forEach((el) => el.addEventListener("change", saveConfig));
}

function saveConfig() {
  const cfg = {
    cfgActionDelay:
      parseInt(panelDoc.getElementById("cfgActionDelay").value, 10) || 0,
    cfgSkipDelay:
      parseInt(panelDoc.getElementById("cfgSkipDelay").value, 10) || 0,
    cfgRandomPercent:
      parseInt(panelDoc.getElementById("cfgRandomPercent").value, 10) || 0,
    cfgRetrySoft:
      parseInt(panelDoc.getElementById("cfgRetrySoft").value, 10) || 0,
    cfgRetryHard:
      parseInt(panelDoc.getElementById("cfgRetryHard").value, 10) || 0,
    cfgRetry429:
      parseInt(panelDoc.getElementById("cfgRetry429").value, 10) || 0,
    keepFollowers: panelDoc.getElementById("cfgKeepFollowers").checked,
    unfollowOlderThanChk: panelDoc.getElementById("cfgUnfollowOlderThanChk")
      .checked,
    unfollowOlderThan:
      parseInt(panelDoc.getElementById("cfgUnfollowOlderThan").value, 10) || 0,
    notUnfollowYoungerThanChk: panelDoc.getElementById(
      "cfgNotUnfollowYoungerThanChk",
    ).checked,
    notUnfollowYoungerThan:
      parseInt(
        panelDoc.getElementById("cfgNotUnfollowYoungerThan").value,
        10,
      ) || 0,
  };
  setLocal("silent.cfg.v1", cfg);
}

function startCountdown(ms) {
  if (countdownTimer) clearInterval(countdownTimer);
  let remain = Math.floor((ms || 0) / 1000);
  update();
  countdownTimer = setInterval(() => {
    remain = Math.max(0, remain - 1);
    update();
    if (remain <= 0) clearInterval(countdownTimer);
  }, 1000);
  function update() {
    const m = String(Math.floor(remain / 60)).padStart(2, "0");
    const s = String(remain % 60).padStart(2, "0");
    const el = qs("#hudCountdown");
    if (el) el.textContent = `${m}:${s}`;
  }
}

function findRow(userId, username) {
  return followers.find(
    (f) => f.id === userId || f.username === username,
  );
}

function renderRow(_row) {
  if (queueView) {
    renderQueue();
  } else {
    renderFollowers();
  }
}

function handleRuntimeMessage(msg) {
  if (msg.type === "TASK_PROGRESS") {
    const hp = qs("#hudProgress");
    if (hp) hp.textContent = `${msg.processed}/${msg.total}`;
    const t = msg.current || {};
    const who = t.username ? "@" + t.username : t.userId || "";
    let action = t.kind || "—";
    if (t.kind === "LIKE" && t.likeTotal)
      action = `LIKE ${t.likeIndex || 1}/${t.likeTotal} ${who}`;
    else if (t.kind === "FOLLOW") action = `FOLLOW ${who}`;
    else if (t.kind === "UNFOLLOW") action = `UNFOLLOW ${who}`;
    const ha = qs("#hudAction");
    if (ha) ha.textContent = action;
    nextWaitMs = msg.nextWaitMs || 0;
    startCountdown(nextWaitMs);
    return;
  }
  if (msg.type !== "TASK_DONE") return;
  const { ok, task, error } = msg;
  const row = findRow(task.userId, task.username);
  if (!row) return;
  const st = row.status || (row.status = {});
  if (task.kind === "FOLLOW") st.followed = !!ok;
  if (task.kind === "LIKE") {
    st.likesDone = Math.max((st.likesDone || 0) + (ok ? 1 : 0), 0);
  }
  if (task.kind === "UNFOLLOW") st.unfollowed = !!ok;
  if (!ok) st.error = error || "erro";
  renderRow(row);
  saveState();
  const who = row.username || task.username || task.userId || "";
  if (ok) {
    if (task.kind === "FOLLOW") logLine(`✓ FOLLOW @${who}`);
    else if (task.kind === "LIKE")
      logLine(`✓ LIKE (${st.likesDone || 0}/${st.likesTotal || 0}) @${who}`);
    else if (task.kind === "UNFOLLOW") logLine(`✓ UNFOLLOW @${who}`);
  } else {
    logLine(`✗ ${task.kind} @${who} — ${error}`);
  }
}

if (typeof document !== "undefined") {
  const root = document.currentScript?.getRootNode?.();
  if (root instanceof ShadowRoot) {
    init(root);
  }
}

