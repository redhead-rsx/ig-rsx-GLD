function log(...args) {
  console.debug('[cs]', ...args);
}

function normUser(u) {
  const id = String(u?.pk ?? u?.id ?? "").trim();
  const username = String(u?.username ?? u?.handle ?? "")
    .trim()
    .toLowerCase();
  return id ? { id, username } : null;
}

function dedupById(arr) {
  const seen = new Set();
  const out = [];
  for (const u of arr) {
    if (!u || !u.id || seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  return out;
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
      [
        'ROW_UPDATE',
        'QUEUE_TICK',
        'QUEUE_DONE',
        'FOLLOWERS_LOADED',
        'PRECHECK_REMOVED',
        'QUEUE_RESET',
      ].includes(msg.type)
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

let currentBatchId = 0;

async function processBatchStrict(rawBatch, listType = "followers") {
  const norm = rawBatch.map(normUser).filter((u) => u && u.id);
  const uniq = dedupById(norm);

  // When collecting from the list of accounts the user is following, we don't
  // filter out already-following profiles here. Dedup + append only.
  if (listType === "following") {
    return { kept: uniq, removed: 0, unknown: 0 };
  }

  let removedIdx = 0;
  let phase1 = uniq;
  if (uniq.length) {
    const chk = await execTask("FOLLOW_INDEX_CHECK", {
      ids: uniq.map((u) => u.id),
    }).catch(() => ({ data: { ids: [] } }));
    const idxSet = new Set(chk.data?.ids || []);
    phase1 = [];
    for (const u of uniq) {
      if (idxSet.has(u.id)) {
        removedIdx++;
        continue;
      }
      phase1.push(u);
    }
  }

  if (!phase1.length) return { kept: [], removed: removedIdx, unknown: 0 };

  const relResp = await execTask("FRIENDSHIP_STATUS_BULK", {
    users: phase1,
  }).catch(() => ({ data: {} }));
  const rel = relResp.data || {};

  const kept = [];
  let removed = removedIdx;
  let unknown = 0;
  for (const u of phase1) {
    const r = rel[u.id];
    if (!r || r.resolved !== true) {
      unknown++;
      continue;
    }
    if (r.following === true) {
      removed++;
      continue;
    }
    kept.push({ ...u });
  }

  if (unknown > 0) {
    const usersUnknown = phase1.filter((u) => {
      const r = rel[u.id];
      return !r || r.resolved !== true;
    });
    const unkSet = new Set(usersUnknown.map((u) => u.id));
    const rel2Resp = await execTask("FRIENDSHIP_STATUS_BULK", {
      users: usersUnknown,
      forceFresh: true,
    }).catch(() => ({ data: {} }));
    const rel2 = rel2Resp.data || {};
    for (const u of phase1) {
      if (!unkSet.has(u.id)) continue;
      const r2 = rel2[u.id];
      if (!r2 || r2.resolved !== true) continue;
      if (r2.following === true) {
        removed++;
        unknown--;
        continue;
      }
      kept.push({ ...u });
      unknown--;
    }
  }

  return { kept, removed, unknown };
}

async function loadUsers(limit, listType) {
  const myId = ++currentBatchId;
  const username = location.pathname.split("/").filter(Boolean)[0];
  if (!username || limit <= 0)
    return { items: [], total: 0, error: "invalid_username_or_limit" };
  log(`[collect] start ${listType} target ${limit}`);
  await execTask('FOLLOW_INDEX_INIT', {}).catch(() => {});
  const lookup = await execTask("LOOKUP", { username }).catch((e) => {
    console.error('[cs]', '[collect] lookup failed', e);
    return null;
  });
  const userId = lookup?.data?.userId || lookup?.data?.id;
  if (!userId) return { items: [], total: 0, error: "user_not_found" };
  const seen = new Set();
  let items = [];
  let cursor = null;
  let removedTotal = 0;
  let unknownTotal = 0;
  while (items.length < limit) {
    const res = await execTask(
      listType === "following" ? "LIST_FOLLOWING" : "LIST_FOLLOWERS",
      { userId, limit: 24, cursor }
    ).catch((e) => {
      console.error('[cs]', '[collect] page failed', e);
      return null;
    });
    const raw = res?.data?.users || [];
    if (!raw.length) {
      cursor = res?.data?.nextCursor || res?.data?.cursor;
      if (!cursor) break;
      continue;
    }
    const { kept, removed, unknown } = await processBatchStrict(raw, listType);
    if (myId !== currentBatchId) {
      return { items, total: items.length, removedAlreadyFollowing: removedTotal, unknownTotal };
    }
    for (const u of kept) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      items.push(u);
      if (items.length === limit) break;
    }
    removedTotal += removed;
    unknownTotal += unknown;
    console.debug(
      `[collect] listType=%s filteredAlreadyFollowing=batch=%d total=%d`,
      listType,
      removed,
      removedTotal,
    );
    console.debug(
      `[batch] raw=%d kept=%d removed=%d unknown=%d total=%d/%d`,
      raw.length,
      kept.length,
      removed,
      unknown,
      items.length,
      limit,
    );
    window.postMessage(
      {
        type: 'COLLECT_PROGRESS',
        batchRaw: raw.length,
        batchKept: kept.length,
        batchRemovedAlreadyFollowing: removed,
        batchUnknown: unknown,
        removedAlreadyFollowing: removedTotal,
        unknownTotal,
        totalKept: items.length,
        target: limit,
      },
      '*',
    );
    cursor = res?.data?.nextCursor || res?.data?.cursor;
    if (!cursor) break;
  }
  if (items.length > limit) items.length = limit;
  return { items, total: items.length, removedAlreadyFollowing: removedTotal, unknownTotal };
}

window.addEventListener("message", async (ev) => {
  const msg = ev.data;
  if (!msg || msg.from !== "ig-panel") return;
  if (msg.type === "LOAD_FOLLOWERS" || msg.type === "LOAD_FOLLOWING") {
    const limit = Math.max(0, Math.min(200, parseInt(msg.limit, 10) || 0));
    const listType = msg.type === "LOAD_FOLLOWING" ? "following" : "followers";
    const res = await loadUsers(limit, listType);
    window.postMessage(
      {
        type: "FOLLOWERS_LOADED",
        items: res.items,
        total: res.total,
        error: res.error,
        removedAlreadyFollowing: res.removedAlreadyFollowing,
        unknownTotal: res.unknownTotal,
        listType,
      },
      "*",
    );
  } else if (msg.type === "START_QUEUE") {
    chrome.runtime.sendMessage(
      {
        type: "START_QUEUE",
        mode: msg.mode,
        likeCount: msg.likeCount,
        targets: msg.targets,
        cfg: msg.cfg,
        listType: msg.listType,
      },
      (resp) => {
        window.postMessage({ type: "QUEUE_STARTED", ok: resp?.ok }, "*");
      },
    );
  } else if (msg.type === "STOP_QUEUE") {
    chrome.runtime.sendMessage({ type: "STOP_QUEUE" });
  } else if (msg.type === "RESET_QUEUE") {
    chrome.runtime.sendMessage({ type: "RESET_QUEUE" });
  }
});