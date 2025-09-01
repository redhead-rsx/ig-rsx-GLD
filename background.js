const DEFAULT_CFG = {
  baseDelayMs: 3000,
  jitterPct: 20,
  pageSize: 10,
  likePerProfile: 1,
  actionModeDefault: 'follow_like',
};
let queue = [];
let running = false;
let processed = 0;
let timer = null;
let state = { mode: 'follow', likeCount: 0, cfg: { ...DEFAULT_CFG } };
let cachedCfg = { ...DEFAULT_CFG };

function log(...args) {
  console.debug('[bg]', ...args);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PING_SW') {
    sendResponse({ ok: true, from: 'sw' });
  } else if (msg.type === 'START_QUEUE') {
    if (running) return sendResponse({ ok: false, error: 'already_running' });
    const { mode, likeCount, targets, cfg } = msg;
    if (!['follow', 'follow_like', 'unfollow'].includes(mode))
      return sendResponse({ ok: false, error: 'invalid_mode' });
    if (!Array.isArray(targets) || !targets.length)
      return sendResponse({ ok: false, error: 'invalid_targets' });
    queue = targets.slice();
    processed = 0;
    state = { mode, likeCount: likeCount || 0, cfg: { ...DEFAULT_CFG, ...(cfg || {}) } };
    running = true;
    log('start', queue.length, mode);
    processNext();
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'STOP_QUEUE') {
    stop('STOPPED');
    sendResponse({ ok: true });
  } else if (msg.type === 'CFG_UPDATED') {
    cachedCfg = { ...cachedCfg, ...(msg.cfg || {}) };
    sendResponse({ ok: true });
  }
});

function stop(reason = 'STOPPED') {
  running = false;
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  log('stop', reason);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId) chrome.tabs.sendMessage(tabId, { type: reason });
  });
}

function sendToTab(tabId, message, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: 'timeout' });
      }
    }, timeoutMs);
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (done) return;
      clearTimeout(t);
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: chrome.runtime.lastError.message });
      }
      resolve(resp || { ok: false, error: 'no_response' });
    });
  });
}

async function execCommand(tabId, action, payload) {
  const ping = await sendToTab(tabId, { type: 'PING_CS' });
  if (!ping?.ok) {
    log('ping failed', ping?.error);
    return { ok: false, error: ping?.error || 'ping_failed' };
  }
  log('exec', action, payload);
  return sendToTab(tabId, { type: 'EXEC_TASK', action, payload });
}

async function processNext() {
  if (!running) return;
  if (!queue.length) {
    stop('DONE');
    return;
  }
  const item = queue.shift();
  const tab = await new Promise((r) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t[0]))
  );
  const tabId = tab?.id;
  if (!tabId) {
    stop('STOPPED');
    return;
  }
  try {
    if (state.mode === 'follow' || state.mode === 'follow_like') {
      const res = await execCommand(tabId, 'FOLLOW', {
        userId: item.id,
        username: item.username,
      });
      chrome.tabs.sendMessage(tabId, {
        type: 'ROW_UPDATE',
        id: item.id,
        status: { followed: !!res?.ok, error: res?.ok ? undefined : res?.error },
      });
      if (!res?.ok) throw new Error(res.error || 'follow_failed');
    }
    if (state.mode === 'follow_like') {
      const total = state.likeCount || 0;
      for (let i = 0; i < total; i++) {
        const r = await execCommand(tabId, 'LIKE', {
          userId: item.id,
          username: item.username,
        });
        chrome.tabs.sendMessage(tabId, {
          type: 'ROW_UPDATE',
          id: item.id,
          status: {
            likesTotal: total,
            likesDone: i + 1,
            error: r?.ok ? undefined : r?.error,
          },
        });
        if (!r?.ok) throw new Error(r.error || 'like_failed');
      }
    }
    if (state.mode === 'unfollow') {
      const r = await execCommand(tabId, 'UNFOLLOW', {
        userId: item.id,
        username: item.username,
      });
      chrome.tabs.sendMessage(tabId, {
        type: 'ROW_UPDATE',
        id: item.id,
        status: { unfollowed: !!r?.ok, error: r?.ok ? undefined : r?.error },
      });
      if (!r?.ok) throw new Error(r.error || 'unfollow_failed');
    }
  } catch (e) {
    chrome.tabs.sendMessage(tabId, {
      type: 'ROW_UPDATE',
      id: item.id,
      status: { error: String(e.message || e) },
    });
  }
  processed++;
  const total = processed + queue.length;
  const delay = nextDelay();
  chrome.tabs.sendMessage(tabId, {
    type: 'PROGRESS',
    done: processed,
    total,
    etaMs: delay,
  });
  if (queue.length === 0) {
    timer = setTimeout(() => stop('DONE'), delay);
    return;
  }
  timer = setTimeout(processNext, delay);
}

function nextDelay() {
  const base = parseInt(state.cfg.baseDelayMs, 10) || 0;
  const jitterPct = parseInt(state.cfg.jitterPct, 10) || 0;
  const jitter = ((base * jitterPct) / 100) * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
