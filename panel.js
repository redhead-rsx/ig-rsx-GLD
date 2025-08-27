const followersPerPage = 10;
let followers = [];
let currentPage = 1;
let currentUsername = null;
let followersState = { cursor: null, totalLoaded: 0, lastIndex: 0 };
let panelDoc;

export function init(root) {
  panelDoc = root;
  bindTabs();
  bindDropdown();
  panelDoc
    .getElementById("loadFollowers")
    .addEventListener("click", loadFollowersHandler);
  panelDoc.getElementById("process").addEventListener("click", openActionDialog);
  panelDoc.getElementById("dlgCancel").addEventListener("click", closeActionDialog);
  panelDoc.getElementById("dlgAdd").addEventListener("click", confirmActionDialog);
  panelDoc
    .getElementById("start")
    .addEventListener("click", () => chrome.runtime.sendMessage({ type: "RUN_START" }));
  panelDoc
    .getElementById("stop")
    .addEventListener("click", () => chrome.runtime.sendMessage({ type: "RUN_STOP" }));
  panelDoc
    .querySelectorAll('input[name="actionMode"]')
    .forEach((r) => r.addEventListener("change", onDialogModeChange));
  onDialogModeChange();
  loadConfig();
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
    window.postMessage({ __BOT__: true, type: "TASK", task }, "*");
    const onMsg = (ev) => {
      if (ev.data?.__BOT__ && ev.data.type === "TASK_RESULT") {
        window.removeEventListener("message", onMsg);
        resolve(ev.data.payload);
      }
    };
    window.addEventListener("message", onMsg);
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

async function lookupUserId(username) {
  const max = 2;
  let lastErr;
  for (let i = 0; i < max; i++) {
    const res = await execTask({ kind: "LOOKUP", username }).catch((e) => ({
      ok: false,
      error: String(e),
    }));
    if (res?.ok && res.out?.userId) return res.out.userId;
    lastErr = res?.error || "unknown";
    await new Promise((r) => setTimeout(r, 300 * (i + 1)));
  }
  throw new Error("lookup_failed:" + lastErr);
}

async function loadFollowersHandler() {
  const username = extractUsernameFromUrl(location.href);
  if (!username) {
    alert("Abra um perfil do Instagram para carregar seguidores.");
    return;
  }
  currentUsername = username;
  const key = `silent.followers.${username}`;
  const saved = await getLocal(key);
  followersState = { cursor: null, totalLoaded: 0, lastIndex: 0 };
  let startIndex = 0;
  followers = [];
  if (saved && saved.users && saved.users.length) {
    const resume = confirm("Você gostaria de tentar continuar de onde parou?");
    if (resume) {
      followers = saved.users;
      followersState.cursor = saved.cursor;
      followersState.totalLoaded = saved.totalLoaded || saved.users.length;
      followersState.lastIndex = saved.lastIndex || followersState.totalLoaded;
      startIndex = followersState.lastIndex;
    } else {
      startIndex =
        parseInt(
          prompt(
            "Digite o número do seguidor para começar (0 = mais recente).",
            "0",
          ) || "0",
          10,
        ) || 0;
    }
  } else {
    startIndex =
      parseInt(
        prompt(
          "Digite o número do seguidor para começar (0 = mais recente).",
          "0",
        ) || "0",
        10,
      ) || 0;
  }
  let userId;
  try {
    userId = await lookupUserId(username);
  } catch (err) {
    alert("Não foi possível resolver o usuário. Detalhes: " + err.message);
    return;
  }
  let cursor = followersState.cursor;
  let totalLoaded = followersState.totalLoaded;
  while (followers.length < 200) {
    let res;
    try {
      res = await execTask({
        kind: "LIST_FOLLOWERS",
        userId,
        limit: 24,
        cursor,
      });
    } catch (e) {}
    if (!res || !res.users) break;
    for (const u of res.users) {
      if (totalLoaded < startIndex) {
        totalLoaded++;
        continue;
      }
      if (followers.length >= 200) break;
      followers.push({ id: u.id, username: u.username, status: u.status });
      totalLoaded++;
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  followersState.cursor = cursor;
  followersState.totalLoaded = totalLoaded;
  followersState.lastIndex = totalLoaded;
  await saveFollowersState();
  currentPage = 1;
  renderFollowers();
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
    if (u.status === "queued") {
      tdStatus.textContent = "Na fila";
    } else if (u.status === "seguido") {
      const b = document.createElement("span");
      b.className = "badge--seguido";
      b.textContent = "Seguido";
      tdStatus.appendChild(b);
    }
    tr.append(tdCheck, tdAvatar, tdUser, tdStatus);
    tbody.appendChild(tr);
  });
  renderPagination();
}

function renderPagination() {
  const totalPages = Math.ceil(followers.length / followersPerPage);
  const container = panelDoc.getElementById("pagination");
  container.innerHTML = "";
  if (totalPages <= 1) return;
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
    renderFollowers();
  }, currentPage === 1);
  addBtn("<", () => {
    if (currentPage > 1) {
      currentPage--;
      renderFollowers();
    }
  }, currentPage === 1);
  for (let p = 1; p <= totalPages; p++) {
    addBtn(
      String(p),
      () => {
        currentPage = p;
        renderFollowers();
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
        renderFollowers();
      }
    },
    currentPage === totalPages,
  );
  addBtn(
    ">>",
    () => {
      currentPage = totalPages;
      renderFollowers();
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
  for (const u of list) {
    if (mode === "follow") {
      items.push({ kind: "FOLLOW", userId: u.id });
    } else if (mode === "follow-like") {
      items.push({ kind: "FOLLOW", userId: u.id });
      for (let i = 0; i < likeCount; i++) {
        items.push({ kind: "LAST_MEDIA", userId: u.id, username: u.username });
        items.push({ kind: "LIKE" });
      }
    } else if (mode === "unfollow") {
      items.push({ kind: "UNFOLLOW", userId: u.id });
    }
    u.status = "queued";
  }
  chrome.runtime.sendMessage({ type: "QUEUE_ADD", items });
  await saveFollowersState();
  renderFollowers();
  showToast(`${items.length} tarefas adicionadas`);
  closeActionDialog();
  // chrome.runtime.sendMessage({ type: "RUN_START" }); // opcional
}

function showToast(msg) {
  const t = panelDoc.getElementById("toast");
  t.textContent = msg;
  t.style.display = "block";
  setTimeout(() => {
    t.style.display = "none";
  }, 3000);
}

async function saveFollowersState() {
  if (!currentUsername) return;
  const key = `silent.followers.${currentUsername}`;
  await setLocal(key, {
    users: followers,
    cursor: followersState.cursor,
    totalLoaded: followersState.totalLoaded,
    lastIndex: followersState.lastIndex,
  });
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

function handleRuntimeMessage(msg) {
  if (msg?.type === "TASK_DONE" && msg.ok && msg.task?.kind === "FOLLOW") {
    const idx = followers.findIndex((u) => u.id === msg.task.userId);
    if (idx !== -1) {
      followers[idx].status = "seguido";
      saveFollowersState();
      renderFollowers();
    }
  }
}

