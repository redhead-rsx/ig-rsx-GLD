const DEFAULT_CFG = {
  baseDelayMs: 3000,
  jitterPct: 20,
  pageSize: 10,
  likePerProfile: 1,
  actionModeDefault: 'follow_like',
};

let cachedCfg = { ...DEFAULT_CFG };
let state = { mode: 'follow', likeCount: 0, cfg: { ...DEFAULT_CFG } };
const q = {
  items: [],
  idx: 0,
  processed: 0,
  total: 0,
  isRunning: false,
  timer: null,
  phase: 'idle',
  nextActionAt: null,
  backoffStep: 0,
};
const summary = { processed: 0, success: 0, failed: 0, skipped: 0 };
let activeTabId = null;

function log(...args) {
  console.debug('[bg]', ...args);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'PING_SW') {
    sendResponse({ ok: true, from: 'sw' });
  } else if (msg.type === 'START_QUEUE') {
    if (q.isRunning) return sendResponse({ ok: false, error: 'already_running' });
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
      q.items = targets.slice();
      q.idx = 0;
      q.processed = 0;
      q.total = q.items.length;
      q.isRunning = true;
      q.phase = 'idle';
      q.nextActionAt = null;
      q.backoffStep = 0;
      state = {
        mode,
        likeCount: likeCount || 0,
        cfg: { ...DEFAULT_CFG, ...(cfg || {}) },
      };
      Object.assign(summary, { processed: 0, success: 0, failed: 0, skipped: 0 });
      scheduleNext(0);
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === 'STOP_QUEUE') {
    stopQueue();
    sendResponse({ ok: true });
  } else if (msg.type === 'CFG_UPDATED') {
    cachedCfg = { ...cachedCfg, ...(msg.cfg || {}) };
    sendResponse({ ok: true });
  }
});

function stopQueue() {
  q.isRunning = false;
  clearTimeout(q.timer);
  q.timer = null;
  q.nextActionAt = null;
  q.phase = 'paused';
  emitTick();
}

function postToPanel(message) {
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, message);
  }
}

function computeNextDelayMs(cfg) {
  const base = parseInt(cfg.baseDelayMs, 10) || 0;
  const jitterPct = parseInt(cfg.jitterPct, 10) || 0;
  const jitter = ((base * jitterPct) / 100) * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function computeBackoffMs() {
  const base = parseInt(state.cfg.baseDelayMs, 10) || 1000;
  const ms = Math.min(60000, base * Math.pow(2, q.backoffStep));
  q.backoffStep++;
  return ms;
}

function resetBackoff() {
  q.backoffStep = 0;
}

function emitTick(extra = {}) {
  postToPanel({
    type: 'QUEUE_TICK',
    processed: q.processed,
    total: q.total,
    phase: q.phase,
    nextActionAt: q.nextActionAt,
    current: q.items[q.idx] || null,
    ...extra,
  });
}

function scheduleNext(waitMs) {
  q.phase = 'waiting';
  q.nextActionAt = Date.now() + waitMs;
  clearTimeout(q.timer);
  emitTick({ nextDelayMs: waitMs });
  q.timer = setTimeout(startAction, waitMs);
}

async function startAction() {
  if (q.idx >= q.total) {
    finishQueue();
    return;
  }
  q.phase = 'executing';
  emitTick();
  const item = q.items[q.idx];
  const resp = await execWithTimeout(item);
  handleResult(resp);
}

async function execWithTimeout(item) {
  let transient = false;
  let lastStatus = {};
  try {
    if (state.mode === 'follow' || state.mode === 'follow_like') {
      const res = await execCommand(activeTabId, 'FOLLOW', {
        userId: item.id,
        username: item.username,
      });
      if (!res?.ok || !res.data?.ok)
        throw new Error(res?.data?.error || res?.error || 'follow_failed');
      if (res.data?.result) lastStatus.result = res.data.result;
    }
    if (state.mode === 'follow_like') {
      const totalLikes = state.likeCount || 0;
      for (let i = 0; i < totalLikes; i++) {
        const r = await execCommand(activeTabId, 'LIKE', {
          userId: item.id,
          username: item.username,
        });
        postToPanel({
          type: 'ROW_UPDATE',
          index: q.idx,
          id: item.id,
          status: {
            likesTotal: totalLikes,
            likesDone: i + 1,
            error: r?.ok && r.data?.ok ? undefined : r?.data?.error || r?.error,
          },
        });
        if (!r?.ok || !r.data?.ok)
          throw new Error(r?.data?.error || r?.error || 'like_failed');
        lastStatus = { ...lastStatus, likesTotal: totalLikes, likesDone: i + 1 };
      }
    }
    if (state.mode === 'unfollow') {
      const r = await execCommand(activeTabId, 'UNFOLLOW', {
        userId: item.id,
        username: item.username,
      });
      if (!r?.ok || r.data?.status !== 'ok')
        throw new Error(r?.error || 'unfollow_failed');
      lastStatus.unfollowed = true;
    }
    resetBackoff();
    return { ok: true, status: lastStatus };
  } catch (e) {
    const err = String(e.message || e);
    transient = isTransientError(err);
    return { ok: false, error: err, transient };
  }
}

function handleResult(resp) {
  const item = q.items[q.idx];
  const status = resp.status || (resp.ok ? {} : { error: resp.error });
  postToPanel({ type: 'ROW_UPDATE', index: q.idx, id: item.id, status });
  q.processed++;
  summary.processed = q.processed;
  if (status.result === 'already_following' || status.skip_reason === 'already_following') {
    summary.skipped++;
  } else if (resp.ok) {
    summary.success++;
  } else {
    summary.failed++;
  }
  chrome.runtime.sendMessage({
    type: 'QUEUE_SUMMARY',
    processed: summary.processed,
    success: summary.success,
    failed: summary.failed,
    skipped: summary.skipped,
    total: q.total,
  });
  q.idx++;
  if (q.idx >= q.total) {
    finishQueue();
    return;
  }
  if (resp.transient) {
    q.phase = 'backoff';
    const ms = computeBackoffMs();
    q.nextActionAt = Date.now() + ms;
    clearTimeout(q.timer);
    emitTick({ backoffMs: ms });
    q.timer = setTimeout(() => scheduleNext(computeNextDelayMs(state.cfg)), ms);
  } else {
    scheduleNext(computeNextDelayMs(state.cfg));
  }
}

function finishQueue() {
  q.phase = 'done';
  clearTimeout(q.timer);
  q.timer = null;
  q.nextActionAt = null;
  emitTick();
  postToPanel({ type: 'QUEUE_DONE', processed: q.processed, total: q.total });
  chrome.runtime.sendMessage({
    type: 'QUEUE_SUMMARY',
    processed: summary.processed,
    success: summary.success,
    failed: summary.failed,
    skipped: summary.skipped,
    total: q.total,
  });
  q.isRunning = false;
}

function isTransientError(err) {
  return /429|rate|timeout|temporarily/i.test(err);
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