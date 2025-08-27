const followersPerPage = 10;
let followers = [];
let currentPage = 1;
let currentUsername = null;
let followersState = { cursor: null, totalLoaded: 0, lastIndex: 0 };

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindDropdown();
  document
    .getElementById("loadFollowers")
    .addEventListener("click", loadFollowersHandler);
  document.getElementById("process").addEventListener("click", openActionDialog);
  document.getElementById("dlgCancel").addEventListener("click", closeActionDialog);
  document.getElementById("dlgAdd").addEventListener("click", confirmActionDialog);
  document
    .getElementById("start")
    .addEventListener("click", () => chrome.runtime.sendMessage({ type: "RUN_START" }));
  document
    .getElementById("stop")
    .addEventListener("click", () => chrome.runtime.sendMessage({ type: "RUN_STOP" }));
  document
    .querySelectorAll('input[name="actionMode"]')
    .forEach((r) => r.addEventListener("change", onDialogModeChange));
  onDialogModeChange();
  loadConfig();
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
});

function bindTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".tab-content")
        .forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

function bindDropdown() {
  const btn = document.getElementById("loadBtn");
  const menu = document.getElementById("loadMenu");
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  });
  document.addEventListener("click", () => {
    menu.style.display = "none";
  });
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) =>
      resolve(tabs[0]),
    );
  });
}

function extractUsernameFromUrl(url) {
  const m = url && url.match(/^https?:\/\/(www\.)?instagram\.com\/([^\/?#]+)\/?.*/);
  return m ? m[2] : null;
}

async function execTask(task) {
  const tab = await getActiveTab();
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: "EXEC_TASK", task }, (resp) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(resp);
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

async function loadFollowersHandler() {
  const tab = await getActiveTab();
  const username = extractUsernameFromUrl(tab.url);
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
  let lookup;
  for (let i = 0; i < 2; i++) {
    try {
      lookup = await execTask({ kind: "LOOKUP", username });
      if (lookup && lookup.userId) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!lookup || !lookup.userId) {
    alert("Não foi possível resolver o usuário.");
    return;
  }
  const userId = lookup.userId;
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
  const tbody = document.querySelector("#followersTable tbody");
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
  const container = document.getElementById("pagination");
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
  document.getElementById("actionDialog").classList.add("show");
}

function closeActionDialog() {
  document.getElementById("actionDialog").classList.remove("show");
}

function onDialogModeChange() {
  const mode = document.querySelector('input[name="actionMode"]:checked').value;
  document.getElementById("dlgLikeCount").style.display =
    mode === "follow-like" ? "inline-block" : "none";
}

async function confirmActionDialog() {
  if (!followers.length) {
    closeActionDialog();
    return;
  }
  let list = followers.filter((u) => u.checked);
  if (!list.length) list = followers;
  const mode = document.querySelector('input[name="actionMode"]:checked').value;
  const likeCount = parseInt(document.getElementById("dlgLikeCount").value, 10) || 1;
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
  const t = document.getElementById("toast");
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
  document.getElementById("cfgKeepFollowers").checked = !!cfg.keepFollowers;
  document.getElementById("cfgUnfollowOlderThanChk").checked =
    !!cfg.unfollowOlderThanChk;
  document.getElementById("cfgNotUnfollowYoungerThanChk").checked =
    !!cfg.notUnfollowYoungerThanChk;
  ids.forEach((id) => {
    if (cfg[id] !== undefined) document.getElementById(id).value = cfg[id];
  });
  document
    .querySelectorAll("#tab-settings input")
    .forEach((el) => el.addEventListener("change", saveConfig));
}

function saveConfig() {
  const cfg = {
    cfgActionDelay:
      parseInt(document.getElementById("cfgActionDelay").value, 10) || 0,
    cfgSkipDelay:
      parseInt(document.getElementById("cfgSkipDelay").value, 10) || 0,
    cfgRandomPercent:
      parseInt(document.getElementById("cfgRandomPercent").value, 10) || 0,
    cfgRetrySoft:
      parseInt(document.getElementById("cfgRetrySoft").value, 10) || 0,
    cfgRetryHard:
      parseInt(document.getElementById("cfgRetryHard").value, 10) || 0,
    cfgRetry429:
      parseInt(document.getElementById("cfgRetry429").value, 10) || 0,
    keepFollowers: document.getElementById("cfgKeepFollowers").checked,
    unfollowOlderThanChk: document.getElementById("cfgUnfollowOlderThanChk")
      .checked,
    unfollowOlderThan:
      parseInt(document.getElementById("cfgUnfollowOlderThan").value, 10) || 0,
    notUnfollowYoungerThanChk: document.getElementById(
      "cfgNotUnfollowYoungerThanChk",
    ).checked,
    notUnfollowYoungerThan:
      parseInt(
        document.getElementById("cfgNotUnfollowYoungerThan").value,
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

