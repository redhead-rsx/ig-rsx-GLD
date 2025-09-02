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
let total = 0;
let state = { mode: 'follow', likeCount: 0, cfg: { ...DEFAULT_CFG } };
let cachedCfg = { ...DEFAULT_CFG };
let nextActionAt = null;
let activeTabId = null;
let lock = false;
let backoffStep = 0;

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
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      activeTabId = tabs[0]?.id || null;
      if (!activeTabId) {
        return sendResponse({ ok: false, error: 'no_tab' });
      }
      queue = targets.slice();
      processed = 0;
      total = queue.length;
      state = {
        mode,
        likeCount: likeCount || 0,
        cfg: { ...DEFAULT_CFG, ...(cfg || {}) },
      };
      running = true;
      backoffStep = 0;
      log('start', queue.length, mode);
      scheduleNext(0, 'waiting', { nextDelayMs: 0 });
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === 'STOP_QUEUE') {
    stop();
    sendResponse({ ok: true });
  } else if (msg.type === 'CFG_UPDATED') {
    cachedCfg = { ...cachedCfg, ...(msg.cfg || {}) };
    sendResponse({ ok: true });
  }
});

function stop() {
  running = false;
  queue = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  nextActionAt = null;
  lock = false;
  backoffStep = 0;
  emitTick('paused');
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
async function runNext() {
  if (!running || lock) return;
  if (!queue.length) {
    finish();
    return;
  }
  lock = true;
  const item = queue.shift();
  emitTick('executing', { current: { id: item.id, username: item.username } });
  let transient = false;
  try {
    if (state.mode === 'follow' || state.mode === 'follow_like') {
      const res = await execCommand(activeTabId, 'FOLLOW', {
        userId: item.id,
        username: item.username,
      });
      chrome.tabs.sendMessage(activeTabId, {
        type: 'ROW_UPDATE',
        id: item.id,
        status: { followed: !!res?.ok, error: res?.ok ? undefined : res?.error },
      });
      if (!res?.ok) throw new Error(res.error || 'follow_failed');
    }
    if (state.mode === 'follow_like') {
      const totalLikes = state.likeCount || 0;
      for (let i = 0; i < totalLikes; i++) {
        const r = await execCommand(activeTabId, 'LIKE', {
          userId: item.id,
          username: item.username,
        });
        chrome.tabs.sendMessage(activeTabId, {
          type: 'ROW_UPDATE',
          id: item.id,
          status: {
            likesTotal: totalLikes,
            likesDone: i + 1,
            error: r?.ok ? undefined : r?.error,
          },
        });
        if (!r?.ok) throw new Error(r.error || 'like_failed');
      }
    }
    if (state.mode === 'unfollow') {
      const r = await execCommand(activeTabId, 'UNFOLLOW', {
        userId: item.id,
        username: item.username,
      });
      chrome.tabs.sendMessage(activeTabId, {
        type: 'ROW_UPDATE',
        id: item.id,
        status: { unfollowed: !!r?.ok, error: r?.ok ? undefined : r?.error },
      });
      if (!r?.ok) throw new Error(r.error || 'unfollow_failed');
    }
    resetBackoff();
  } catch (e) {
    const err = String(e.message || e);
    chrome.tabs.sendMessage(activeTabId, {
      type: 'ROW_UPDATE',
      id: item.id,
      status: { error: err },
    });
    transient = isTransientError(err);
  }
  processed++;
  lock = false;
  if (!running) return;
  if (queue.length === 0) {
    finish();
    return;
  }
  if (transient) {
    const backoffMs = calcBackoff();
    scheduleNext(backoffMs, 'backoff', { backoffMs });
  } else {
    const delay = nextDelay();
    scheduleNext(delay, 'waiting', { nextDelayMs: delay });
  }
}

function nextDelay() {
  const base = parseInt(state.cfg.baseDelayMs, 10) || 0;
  const jitterPct = parseInt(state.cfg.jitterPct, 10) || 0;
  const jitter = ((base * jitterPct) / 100) * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function calcBackoff() {
  const base = parseInt(state.cfg.baseDelayMs, 10) || 1000;
  const ms = Math.min(60000, base * Math.pow(2, backoffStep));
  backoffStep++;
  return ms;
}

function resetBackoff() {
  backoffStep = 0;
}

function isTransientError(err) {
  return /429|rate|timeout|temporarily/i.test(err);
}

function scheduleNext(delay, phase, extra = {}) {
  if (timer) clearTimeout(timer);
  nextActionAt = Date.now() + delay;
  timer = setTimeout(runNext, delay);
  emitTick(phase, { ...extra, nextActionAt });
}

function emitTick(phase, extra = {}) {
  if (!activeTabId) return;
  chrome.tabs.sendMessage(activeTabId, {
    type: 'QUEUE_TICK',
    processed,
    total,
    phase,
    ...extra,
  });
}

function finish() {
  running = false;
  timer = null;
  nextActionAt = null;
  emitTick('done');
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'QUEUE_DONE',
      processed,
      total,
    });
  }
}