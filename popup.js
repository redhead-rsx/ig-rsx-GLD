const followersPerPage = 10;
let followers = [];
let currentPage = 1;
let currentUsername = null;

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindDropdown();
  document
    .getElementById("loadFollowers")
    .addEventListener("click", loadFollowersHandler);
  document.getElementById("process").addEventListener("click", processQueue);
  document
    .getElementById("start")
    .addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "RUN_START" }),
    );
  document
    .getElementById("stop")
    .addEventListener("click", () =>
      chrome.runtime.sendMessage({ type: "RUN_STOP" }),
    );
  document
    .querySelectorAll('input[name="mode"]')
    .forEach((r) => r.addEventListener("change", onModeChange));
  document.getElementById("likeCount").addEventListener("change", saveMode);
  restoreMode();
  loadConfig();
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
      document.getElementById(btn.dataset.tab).classList.add("active");
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
  const m = url && url.match(/^https?:\/\/www\.instagram\.com\/([^\/]+)\/?/);
  return m ? m[1] : null;
}

async function execTaskInActiveTab(task) {
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
  let startIndex = 0;
  let cursor = null;
  followers = [];
  let totalLoaded = 0;
  if (saved && saved.users && saved.users.length) {
    const resume = confirm("Você gostaria de tentar continuar de onde parou?");
    if (resume) {
      followers = saved.users;
      cursor = saved.cursor;
      startIndex = saved.lastIndex || saved.users.length;
      totalLoaded = startIndex;
    } else {
      startIndex =
        parseInt(
          prompt(
            "Limite da fila: 200. Digite o número do seguidor para começar (0 = mais recente).",
            "0",
          ),
          10,
        ) || 0;
    }
  } else {
    startIndex =
      parseInt(
        prompt(
          "Limite da fila: 200. Digite o número do seguidor para começar (0 = mais recente).",
          "0",
        ),
        10,
      ) || 0;
  }
  let lookup;
  try {
    lookup = await execTaskInActiveTab({ kind: "LOOKUP", username });
  } catch (e) {
    console.error(e);
  }
  if (!lookup || !lookup.userId) {
    alert("Não foi possível resolver o usuário.");
    return;
  }
  const userId = lookup.userId;
  while (followers.length < 200) {
    let res;
    try {
      res = await execTaskInActiveTab({
        kind: "LIST_FOLLOWERS",
        userId,
        limit: 24,
        cursor,
      });
    } catch (e) {
      console.error(e);
    }
    if (!res || !res.users) break;
    for (const u of res.users) {
      if (totalLoaded < startIndex) {
        totalLoaded++;
        continue;
      }
      if (followers.length >= 200) break;
      followers.push({ id: u.id, username: u.username });
      totalLoaded++;
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  await setLocal(key, {
    users: followers,
    cursor,
    totalLoaded,
    lastIndex: totalLoaded,
  });
  currentPage = 1;
  renderFollowers();
}

function renderFollowers() {
  const tbody = document.querySelector("#followersTable tbody");
  tbody.innerHTML = "";
  const start = (currentPage - 1) * followersPerPage;
  const pageUsers = followers.slice(start, start + followersPerPage);
  pageUsers.forEach((u, idx) => {
    const tr = document.createElement("tr");
    const tdCheck = document.createElement("td");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.className = "user-check";
    chk.dataset.index = start + idx;
    tdCheck.appendChild(chk);
    const tdUser = document.createElement("td");
    tdUser.textContent = "@" + u.username;
    tr.appendChild(tdCheck);
    tr.appendChild(tdUser);
    tbody.appendChild(tr);
  });
  renderPagination();
}

function renderPagination() {
  const totalPages = Math.ceil(followers.length / followersPerPage);
  const container = document.getElementById("pagination");
  container.innerHTML = "";
  if (totalPages <= 1) return;
  const prev = document.createElement("button");
  prev.textContent = "<";
  prev.disabled = currentPage === 1;
  prev.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderFollowers();
    }
  });
  container.appendChild(prev);
  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement("button");
    btn.textContent = p;
    if (p === currentPage) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentPage = p;
      renderFollowers();
    });
    container.appendChild(btn);
  }
  const next = document.createElement("button");
  next.textContent = ">";
  next.disabled = currentPage === totalPages;
  next.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      renderFollowers();
    }
  });
  container.appendChild(next);
}

function onModeChange() {
  const mode = document.querySelector('input[name="mode"]:checked');
  document.getElementById("likeCount").disabled =
    mode && mode.value !== "follow-like";
  saveMode();
}

async function restoreMode() {
  const data = await getLocal("silent.mode");
  if (data) {
    const modeEl = document.querySelector(
      `input[name="mode"][value="${data.mode}"]`,
    );
    if (modeEl) modeEl.checked = true;
    if (typeof data.likeCount === "number") {
      document.getElementById("likeCount").value = data.likeCount;
    }
  } else {
    document.querySelector('input[name="mode"][value="follow"]').checked = true;
  }
  onModeChange();
}

function saveMode() {
  const modeEl = document.querySelector('input[name="mode"]:checked');
  const likeCount =
    parseInt(document.getElementById("likeCount").value, 10) || 1;
  setLocal("silent.mode", {
    mode: modeEl ? modeEl.value : "follow",
    likeCount,
  });
}

async function processQueue() {
  if (!followers.length) return;
  const checked = Array.from(
    document.querySelectorAll(".user-check:checked"),
  ).map((c) => followers[parseInt(c.dataset.index, 10)]);
  const list = checked.length ? checked : followers;
  const modeEl = document.querySelector('input[name="mode"]:checked');
  const mode = modeEl ? modeEl.value : "follow";
  const likeCount =
    parseInt(document.getElementById("likeCount").value, 10) || 1;
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
  }
  chrome.runtime.sendMessage({ type: "QUEUE_ADD", items });
  showToast(`${items.length} tarefas adicionadas à fila.`);
}

function showToast(msg) {
  const t = document.getElementById("toast");
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
  document.getElementById("cfgKeepFollowers").checked = !!cfg.keepFollowers;
  document.getElementById("cfgUnfollowOlderThanChk").checked =
    !!cfg.unfollowOlderThanChk;
  document.getElementById("cfgNotUnfollowYoungerThanChk").checked =
    !!cfg.notUnfollowYoungerThanChk;
  ids.forEach((id) => {
    if (cfg[id] !== undefined) document.getElementById(id).value = cfg[id];
  });
  document
    .querySelectorAll("#config input")
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
