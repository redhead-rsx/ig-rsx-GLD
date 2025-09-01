function log(...args) {
  console.debug('[cs]', ...args);
}

// Inject helper scripts into the page
(function inject() {
  for (const f of ["igClient.js", "runner.js", "injected.js"]) {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(f);
    s.type = "module";
    (document.head || document.documentElement).appendChild(s);
  }
    log('injected helpers');
  })();

const _pending = {};

chrome.runtime.sendMessage({ type: 'PING_SW' }, (resp) => {
  if (chrome.runtime.lastError) {
    console.warn('[cs] ping sw erro:', chrome.runtime.lastError.message);
  } else {
    console.log('[cs] ping sw ok:', resp);
  }
});

if (window.__IG_CS_TASK_HANDLER) {
  window.removeEventListener('message', window.__IG_CS_TASK_HANDLER);
}
  window.__IG_CS_TASK_HANDLER = (ev) => {
    const d = ev.data;
    if (!d || d.__BOT__ || !d.type) return;
    if (d.type === 'TASK_RESULT' && d.requestId && _pending[d.requestId]) {
      try {
        _pending[d.requestId](d);
      } finally {
        delete _pending[d.requestId];
      }
    }
  };
  window.addEventListener('message', window.__IG_CS_TASK_HANDLER);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'PING_CS') {
      return sendResponse({ ok: true, from: 'cs' });
    }
    if (msg.type === 'OPEN_PANEL') {
      openPanel();
    } else if (msg.type === 'EXEC_TASK') {
      const id = Date.now() + '_' + Math.random().toString(36).slice(2);
      _pending[id] = sendResponse;
      window.postMessage(
        {
          __BOT__: true,
          type: 'TASK',
          requestId: id,
          action: msg.action,
          payload: msg.payload,
        },
        '*',
      );
      return true;
    } else if (
      ['ROW_UPDATE', 'PROGRESS', 'STOPPED', 'FOLLOWERS_LOADED'].includes(msg.type)
    ) {
      window.postMessage(msg, '*');
    }
  });

async function openPanel() {
  const old = document.getElementById("ig-panel-root");
  if (old) {
    window.__IG_PANEL_CLEANUP?.();
    old.remove();
  }
  log('openPanel');
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

function execTask(action, payload = {}) {
  return new Promise((resolve) => {
    const id = Date.now() + '_' + Math.random();
    const timeout = setTimeout(() => {
      delete _pending[id];
      resolve({ ok: false, error: 'no_response' });
    }, 10000);
    _pending[id] = (res) => {
      clearTimeout(timeout);
      resolve({ ok: res.ok, data: res.data, error: res.error });
    };
    log('execTask', action, payload);
    window.postMessage(
      { __BOT__: true, type: 'TASK', action, payload, requestId: id },
      '*',
    );
  });
}

async function loadUsers(limit, mode) {
  const username = location.pathname.split("/").filter(Boolean)[0];
  if (!username || limit <= 0)
    return { items: [], total: 0, error: "invalid_username_or_limit" };
  log(`[collect] start ${mode} target ${limit}`);
  const lookup = await execTask("LOOKUP", { username }).catch((e) => {
    console.error('[cs]', '[collect] lookup failed', e);
    return null;
  });
  const userId = lookup?.data?.userId || lookup?.data?.id;
  if (!userId) return { items: [], total: 0, error: "user_not_found" };
  const seen = new Set();
  let items = [];
  let cursor = null;
  while (items.length < limit) {
    const res = await execTask(
      mode === "following" ? "LIST_FOLLOWING" : "LIST_FOLLOWERS",
      { userId, limit: 24, cursor }
    ).catch((e) => {
      console.error('[cs]', '[collect] page failed', e);
      return null;
    });
    const batch = res?.data?.users || [];
    if (!batch.length) break;
    for (const u of batch) {
      if (!seen.has(u.id)) {
        seen.add(u.id);
        items.push({ id: u.id, username: u.username });
      }
      if (items.length >= limit) break;
    }
    log(`[collect] fetched ${items.length}/${limit}`);
    window.postMessage(
      { type: "PROGRESS", done: items.length, total: limit },
      "*",
    );
    cursor = res?.data?.nextCursor || res?.data?.cursor;
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
