// Inject helper scripts into the page
(function inject() {
  for (const f of ["igClient.js", "runner.js", "injected.js"]) {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(f);
    s.type = "module";
    (document.head || document.documentElement).appendChild(s);
  }
})();

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type === "OPEN_PANEL") {
    await openPanel();
  } else if (["ROW_UPDATE", "PROGRESS", "STOPPED", "FOLLOWERS_LOADED"].includes(msg.type)) {
    window.postMessage(msg, "*");
  }
});

async function openPanel() {
  const old = document.getElementById("ig-panel-root");
  if (old) old.remove();
  chrome.storage.local.remove(["ig_queue", "silent.queue.v1"]);
  const root = document.createElement("div");
  root.id = "ig-panel-root";
  Object.assign(root.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    zIndex: 2147483647,
    background: "rgba(0,0,0,0.6)",
  });
  document.documentElement.appendChild(root);
  const html = await fetch(chrome.runtime.getURL("panel.html")).then((r) => r.text());
  root.innerHTML = html;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("panel.css");
  root.appendChild(link);
  const script = document.createElement("script");
  script.type = "module";
  script.src = chrome.runtime.getURL("panel.js");
  script.addEventListener("load", () => {
    window.postMessage({ type: "PANEL_READY" }, "*");
  });
  root.appendChild(script);
}

function execTask(task) {
  return new Promise((resolve) => {
    window.postMessage({ __BOT__: true, type: "TASK", task }, "*");
    function onMsg(ev) {
      if (ev.data?.__BOT__ && ev.data.type === "TASK_RESULT") {
        window.removeEventListener("message", onMsg);
        resolve(ev.data.payload);
      }
    }
    window.addEventListener("message", onMsg);
  });
}

async function loadUsers(limit, mode) {
  const username = location.pathname.split("/").filter(Boolean)[0];
  if (!username || limit <= 0)
    return { items: [], total: 0, error: "invalid_username_or_limit" };
  console.log(`[collect] start ${mode} target ${limit}`);
  const lookup = await execTask({ kind: "LOOKUP", username }).catch((e) => {
    console.error("[collect] lookup failed", e);
    return null;
  });
  const userId = lookup?.out?.userId || lookup?.out?.id;
  if (!userId) return { items: [], total: 0, error: "user_not_found" };
  const seen = new Set();
  let items = [];
  let cursor = null;
  while (items.length < limit) {
    const res = await execTask({
      kind: mode === "following" ? "LIST_FOLLOWING" : "LIST_FOLLOWERS",
      userId,
      limit: 24,
      cursor,
    }).catch((e) => {
      console.error("[collect] page failed", e);
      return null;
    });
    const batch = res?.out?.users || [];
    if (!batch.length) break;
    for (const u of batch) {
      if (!seen.has(u.id)) {
        seen.add(u.id);
        items.push({ id: u.id, username: u.username });
      }
      if (items.length >= limit) break;
    }
    console.log(`[collect] fetched ${items.length}/${limit}`);
    window.postMessage(
      { type: "PROGRESS", done: items.length, total: limit },
      "*",
    );
    cursor = res?.out?.nextCursor || res?.out?.cursor;
    if (!cursor) break;
  }
  items = items.slice(0, limit);
  return { items, total: items.length };
}

window.addEventListener("message", async (ev) => {
  const msg = ev.data;
  if (!msg || msg.from !== "ig-panel") return;
  if (msg.type === "LOAD_FOLLOWERS" || msg.type === "LOAD_FOLLOWING") {
    const limit = Math.max(0, Math.min(200, parseInt(msg.limit, 10) || 0));
    const mode = msg.type === "LOAD_FOLLOWING" ? "following" : "followers";
    const res = await loadUsers(limit, mode);
    window.postMessage(
      { type: "FOLLOWERS_LOADED", items: res.items, total: res.total, error: res.error },
      "*",
    );
  } else if (msg.type === "START_PROCESS") {
    chrome.runtime.sendMessage({
      type: "START_PROCESS",
      items: msg.items,
      settings: msg.settings,
    });
  } else if (msg.type === "STOP_PROCESS") {
    chrome.runtime.sendMessage({ type: "STOP_PROCESS" });
  }
});
