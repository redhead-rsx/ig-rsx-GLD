let followersPerPage = 10;
let followers = [];
let currentPage = 1;
let currentUsername = null;
let followersState = { cursor: null, totalLoaded: 0, lastIndex: 0 };
let queueView = null;
const STATE_KEY = (user) => `silent.followers.${user}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function extractUsernameFromUrl(url) {
  const m = url.match(/^https?:\/\/(www\.)?instagram\.com\/([^\/\?#]+)(?:[\/\?#].*)?$/i);
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

function execTaskInActiveTab(task) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "EXEC_IN_ACTIVE_TAB", task }, (res) => {
      if (!chrome.runtime.lastError && res !== undefined) {
        resolve(res);
      } else {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) return resolve(undefined);
          chrome.tabs.sendMessage(tabId, { type: "EXEC_TASK", task }, (r) => resolve(r));
        });
      }
    });
  });
}

async function lookupUserId(username) {
  let lastErr = "unknown";
  for (let i = 0; i < 3; i++) {
    const res = await execTaskInActiveTab({ kind: "LOOKUP", username }).catch((e) => ({
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

function updateRunButtons(running) {
  document.getElementById("btnStart").disabled = running;
  document.getElementById("btnStop").disabled = !running;
}

function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

function bindDropdown(btnId, menuId) {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  });
  document.addEventListener("click", () => {
    menu.style.display = "none";
  });
}

function renderStatus(st) {
  if (!st) return "Na fila";
  if (st.error) return `Erro: ${st.error}`;
  if (st.unfollowed) return '<span class="badge badge--unfollow">✓ Unfollowed</span>';
  if (st.followed && st.likesTotal) {
    return `<span class="badge badge--seguido">✓ Seguido</span> Likes: ${st.likesDone || 0}/${st.likesTotal}`;
  }
  if (st.followed) return '<span class="badge badge--seguido">✓ Seguido</span>';
  if (st.likesTotal) return `Likes: ${st.likesDone || 0}/${st.likesTotal}`;
  if (st.running) return "Em andamento…";
  if (st.queued) return "Na fila";
  return "";
}

function updateCounts() {
  const selected = followers.filter((u) => u.checked).length;
  document.getElementById("igBotQueueCount").textContent = followers.length;
  document.getElementById("igBotQueueSelectedCount").textContent = selected;
}

function updatePager() {
  const totalPages = Math.ceil(followers.length / followersPerPage) || 1;
  document.querySelector("#pager .pagedisplay").textContent = `${currentPage}/${totalPages}`;
}

function renderTable() {
  const tbody = document.querySelector("#queueTable tbody");
  tbody.innerHTML = "";
  const start = (currentPage - 1) * followersPerPage;
  const pageUsers = followers.slice(start, start + followersPerPage);
  for (const u of pageUsers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-id="${u.id}" ${u.checked ? "checked" : ""}></td>
      <td>${u.avatarUrl ? `<img class="avatar" src="${u.avatarUrl}"/>` : ""}</td>
      <td>@${u.username}</td>
      <td>${renderStatus(u.status)}</td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.id;
      const u = followers.find((f) => f.id === id);
      if (u) u.checked = cb.checked;
      updateCounts();
    });
  });
  updatePager();
  updateCounts();
}

function updatePagerControls() {
  document.querySelector("#pager .prev").addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });
  document.querySelector("#pager .next").addEventListener("click", () => {
    const totalPages = Math.ceil(followers.length / followersPerPage) || 1;
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });
  document.querySelector("#pager .pagesize").addEventListener("change", (e) => {
    followersPerPage = parseInt(e.target.value, 10) || 10;
    currentPage = 1;
    renderTable();
  });
  document.querySelector("#pager .gotoPage").addEventListener("change", (e) => {
    const totalPages = Math.ceil(followers.length / followersPerPage) || 1;
    let p = parseInt(e.target.value, 10);
    if (!p || p < 1) p = 1;
    if (p > totalPages) p = totalPages;
    currentPage = p;
    renderTable();
  });
}

async function loadFollowersOfCurrentProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const username = extractUsernameFromUrl(tab?.url || "");
  if (!username) {
    alert("Abra um perfil do Instagram para carregar seguidores.");
    return;
  }
  currentUsername = username;
  const saved = await getLocal(STATE_KEY(username));
  if (saved && saved.users?.length) {
    const cont = confirm("Continuar de onde parou?");
    if (cont) {
      followers = saved.users || [];
      followersState.cursor = saved.cursor;
      followersState.totalLoaded = saved.totalLoaded || followers.length;
      followersState.lastIndex = saved.lastIndex || followers.length;
    } else {
      followers = [];
      followersState = { cursor: null, totalLoaded: 0, lastIndex: 0 };
    }
  }
  let userId = saved?.userId;
  if (!userId) {
    try {
      userId = await lookupUserId(username);
    } catch (e) {
      alert("Falha ao buscar usuário");
      return;
    }
  }
  let cursor = followersState.cursor;
  while (followers.length < 200) {
    const res = await execTaskInActiveTab({ kind: "LIST_FOLLOWERS", userId, limit: 24, cursor });
    if (!res?.ok) break;
    const items = res.out?.users || [];
    cursor = res.out?.cursor;
    for (const it of items) {
      followers.push({ id: it.id, username: it.username, avatarUrl: it.avatarUrl, status: {}, checked: false });
    }
    followersState.cursor = cursor;
    followersState.totalLoaded = followers.length;
    followersState.lastIndex = followers.length;
    if (!cursor) break;
    await sleep(500);
  }
  await setLocal(STATE_KEY(username), {
    users: followers,
    cursor: followersState.cursor,
    totalLoaded: followersState.totalLoaded,
    lastIndex: followersState.lastIndex,
    userId,
  });
  renderTable();
}

function onProcessModeChange() {
  const likeInput = document.getElementById("numberFollowLikeLatestPics");
  likeInput.style.display = document.getElementById("radioFollowAndLike").checked ? "inline-block" : "none";
}

async function confirmProcess() {
  if (!followers.length) return;
  let list = followers.filter((u) => u.checked);
  if (!list.length) list = followers;
  const mode = document.querySelector('input[name="processAction"]:checked').value;
  const likeCount = parseInt(document.getElementById("numberFollowLikeLatestPics").value, 10) || 0;
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
        items.push({ kind: "LIKE", userId: u.id, username: u.username });
      }
    } else if (mode === "unfollow") {
      items.push({ kind: "UNFOLLOW", userId: u.id, username: u.username });
    }
    u.status = st;
    snapshot.push({ userId: u.id, username: u.username, likesPlanned: st.likesTotal });
  }
  queueView = { createdAt: Date.now(), items: snapshot };
  chrome.runtime.sendMessage({ type: "QUEUE_ADD", items });
  chrome.runtime.sendMessage({ type: "RUN_START" });
  await saveState();
  currentPage = 1;
  document.getElementById("processMenu").style.display = "none";
  renderTable();
  updateRunButtons(true);
}

function startRun() {
  if (followers.some((u) => u.status?.queued || u.status?.running)) {
    const cont = confirm("Continuar processando a fila atual?");
    if (!cont) return;
  }
  chrome.runtime.sendMessage({ type: "RUN_START" });
  updateRunButtons(true);
}

function stopRun() {
  chrome.runtime.sendMessage({ type: "RUN_STOP" });
  updateRunButtons(false);
}

async function saveState() {
  if (!currentUsername) return;
  await setLocal(STATE_KEY(currentUsername), {
    users: followers,
    cursor: followersState.cursor,
    totalLoaded: followersState.totalLoaded,
    lastIndex: followersState.lastIndex,
  });
  await setLocal(`silent.queueView.${currentUsername}`, queueView);
}

async function restoreState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentUsername = extractUsernameFromUrl(tab?.url || "");
  if (!currentUsername) return;
  const saved = await getLocal(STATE_KEY(currentUsername));
  if (saved) {
    followers = saved.users || [];
    followersState.cursor = saved.cursor;
    followersState.totalLoaded = saved.totalLoaded || 0;
    followersState.lastIndex = saved.lastIndex || 0;
  }
  queueView = (await getLocal(`silent.queueView.${currentUsername}`)) || null;
  renderTable();
}

function handleRuntimeMessage(msg) {
  if (msg?.type !== "TASK_DONE") return;
  const { ok, task, error } = msg;
  const u = followers.find((f) => f.id === task.userId || f.username === task.username);
  if (!u) return;
  const st = u.status || (u.status = {});
  st.running = true;
  st.queued = false;
  if (!ok) {
    st.error = error;
    st.running = false;
  } else {
    if (task.kind === "FOLLOW") {
      st.followed = true;
      if (!st.likesTotal) st.running = false;
    } else if (task.kind === "LIKE") {
      st.likesDone = (st.likesDone || 0) + 1;
      if (st.likesDone >= (st.likesTotal || 0)) st.running = false;
    } else if (task.kind === "UNFOLLOW") {
      st.unfollowed = true;
      st.running = false;
    }
  }
  if (!st.running) st.queued = false;
  saveState();
  renderTable();
  if (!followers.some((u) => u.status?.queued || u.status?.running)) {
    updateRunButtons(false);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  bindTabs();
  bindDropdown("btnLoadMenu", "loadMenu");
  bindDropdown("btnProcessQueue", "processMenu");
  document.getElementById("btnGetAllUsersFollowers").addEventListener("click", loadFollowersOfCurrentProfile);
  document.getElementById("btnProcessStart").addEventListener("click", confirmProcess);
  document.getElementById("btnStart").addEventListener("click", startRun);
  document.getElementById("btnStop").addEventListener("click", stopRun);
  document.getElementById("radioFollow").addEventListener("change", onProcessModeChange);
  document.getElementById("radioFollowAndLike").addEventListener("change", onProcessModeChange);
  document.getElementById("radioUnFollow").addEventListener("change", onProcessModeChange);
  updateRunButtons(false);
  updatePagerControls();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  await restoreState();
});

