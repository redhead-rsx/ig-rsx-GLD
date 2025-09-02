const DEFAULT_CFG = {
  baseDelayMs: 3000,
  jitterPct: 20,
  pageSize: 10,
  likePerProfile: 1,
  actionModeDefault: 'follow_like',
  includeAlreadyFollowing: false,
};

// Central queue state (source of truth)
const q = {
  items: [],
  idx: 0,
  total: 0,
  processed: 0,
  isRunning: false,
  paused: false,
  phase: 'idle', // 'waiting'|'executing'|'backoff'|'paused'|'done'
  nextActionAt: null,
  // extra state
  mode: 'follow',
  likeCount: 0,
  cfg: { ...DEFAULT_CFG },
  tabId: null,
};

const ALARM_NEXT_ACTION = 'ALARM_NEXT_ACTION';
const ALARM_BACKOFF = 'ALARM_BACKOFF';
const ALARM_WATCHDOG = 'ALARM_WATCHDOG';

async function saveQ(partial) {
  Object.assign(q, partial);
  await chrome.storage.session.set({
    q_isRunning: q.isRunning,
    q_idx: q.idx,
    q_total: q.total,
    q_processed: q.processed,
    q_phase: q.phase,
    q_nextActionAt: q.nextActionAt,
    q_cfg: q.cfg,
    q_items: q.items,
  });
}

async function rehydrate() {
  const s = await chrome.storage.session.get([
    'q_isRunning',
    'q_idx',
    'q_total',
    'q_processed',
    'q_phase',
    'q_nextActionAt',
    'q_cfg',
    'q_items',
  ]);
  Object.assign(
    q,
    {
      items: [],
      idx: 0,
      total: 0,
      processed: 0,
      isRunning: false,
      paused: false,
      phase: 'idle',
      nextActionAt: null,
      cfg: { ...DEFAULT_CFG },
    },
    {
      items: s.q_items || [],
      idx: s.q_idx || 0,
      total: s.q_total || 0,
      processed: s.q_processed || 0,
      isRunning: s.q_isRunning || false,
      phase: s.q_phase || 'idle',
      nextActionAt: s.q_nextActionAt || null,
      cfg: { ...DEFAULT_CFG, ...(s.q_cfg || {}) },
    },
  );
  if (q.isRunning) {
    if (q.phase === 'waiting' || q.phase === 'backoff') {
      if (Date.now() >= (q.nextActionAt || 0)) {
        if (q.phase === 'backoff') {
          scheduleNext(computeNextDelayMs());
        } else {
          startAction();
        }
      } else {
        chrome.alarms.create(
          q.phase === 'backoff' ? ALARM_BACKOFF : ALARM_NEXT_ACTION,
          { when: q.nextActionAt },
        );
      }
    } else if (q.phase === 'executing') {
      startAction();
    }
  }
  chrome.alarms.create(ALARM_WATCHDOG, {
    when: Date.now() + 60_000,
    periodInMinutes: 1,
  });
}

chrome.runtime.onStartup?.addListener(rehydrate);
rehydrate();

let backoffStep = 0;
let cachedCfg = { ...DEFAULT_CFG };

function log(...args) {
  console.debug('[bg]', ...args);
}

function postToPanel(message) {
  if (!q.tabId) return;
  chrome.tabs.sendMessage(q.tabId, message);
}

function emitTick(extra = {}) {
  postToPanel({
    type: 'QUEUE_TICK',
    processed: q.processed,
    total: q.total,
    phase: q.phase,
    nextActionAt: q.nextActionAt,
    ...extra,
  });
}

function computeNextDelayMs() {
  const base = parseInt(q.cfg.baseDelayMs, 10) || 0;
  const jitterPct = parseInt(q.cfg.jitterPct, 10) || 0;
  const jitter = ((base * jitterPct) / 100) * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function scheduleNext(waitMs) {
  // units already in ms
  if (q.paused) return;
  q.phase = 'waiting';
  q.nextActionAt = Date.now() + waitMs;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  saveQ({ phase: 'waiting', nextActionAt: q.nextActionAt });
  emitTick({ nextDelayMs: waitMs });
  log(`scheduleNext waitMs=${waitMs} nextAt=${q.nextActionAt}`);
  chrome.alarms.create(ALARM_NEXT_ACTION, { when: q.nextActionAt });
}

async function startAction() {
  if (q.paused) return;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  if (q.idx >= q.total) return finishQueue();

  q.phase = 'executing';
  await saveQ({ phase: 'executing' });
  emitTick();
  log(`startAction idx=${q.idx}/total=${q.total} phase=executing`);

  const item = q.items[q.idx];
  const resp = await execWithTimeout(item);

  // Resultado sempre processado
  postToPanel({ type: 'ROW_UPDATE', id: item.id, status: resp.status });
  log(
    `result idx=${q.idx} ok=${!resp.status.error} backoffMs=${resp.backoffMs || 0}`,
  );

  q.processed++;
  q.idx++;

  if (q.idx >= q.total) return finishQueue();

  if (resp && resp.backoffMs) {
    const ms = Math.max(0, resp.backoffMs);
    q.phase = 'backoff';
    q.nextActionAt = Date.now() + ms;
    emitTick({ backoffMs: ms });
    log(`scheduleNext(backoff) waitMs=${ms} nextAt=${q.nextActionAt}`);
    saveQ({ phase: 'backoff', nextActionAt: q.nextActionAt });
    chrome.alarms.create(ALARM_BACKOFF, { when: q.nextActionAt });
  } else {
    scheduleNext(computeNextDelayMs());
  }
}

function finishQueue() {
  q.isRunning = false;
  q.phase = 'done';
  q.nextActionAt = null;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  saveQ({ isRunning: false, phase: 'done', nextActionAt: null });
  emitTick();
  postToPanel({ type: 'QUEUE_DONE', processed: q.processed, total: q.total });
}

function stopQueue() {
  q.isRunning = false;
  q.paused = false;
  q.phase = 'paused';
  q.items = [];
  q.idx = 0;
  q.total = 0;
  q.processed = 0;
  q.nextActionAt = null;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  saveQ({
    isRunning: false,
    phase: 'paused',
    idx: 0,
    total: 0,
    processed: 0,
    nextActionAt: null,
  });
  emitTick();
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

async function precheckWindow(tabId, items, windowSize = 50) {
  const slice = items.slice(0, windowSize);
  const ids = slice.map((it) => it.id);
  if (!ids.length) return { items, removed: [] };
  const resp = await execCommand(tabId, 'FRIENDSHIP_STATUS_BULK', {
    ids,
    forceFresh: true,
  });
  const rels = resp?.data || {};
  const removedIds = new Set();
  const kept = [];
  for (const it of items) {
    const r = rels[it.id];
    if (r && r.following) {
      removedIds.add(it.id);
    } else {
      kept.push(it);
    }
  }
  if (removedIds.size) {
    for (const id of removedIds) {
      postToPanel({
        type: 'ROW_UPDATE',
        id,
        status: { removedAlreadyFollowing: true },
      });
    }
    postToPanel({
      type: 'PRECHECK_REMOVED',
      window: ids.length,
      removed: removedIds.size,
    });
  }
  console.debug(
    '[collect] preExec window=%d removedAlreadyFollowing=%d',
    ids.length,
    removedIds.size,
  );
  return { items: kept, removed: Array.from(removedIds) };
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

async function execWithTimeout(item) {
  const status = {};
  let transient = false;
  try {
    if (q.mode === 'follow' || q.mode === 'follow_like') {
      const res = await execCommand(q.tabId, 'FOLLOW', {
        userId: item.id,
        username: item.username,
      });
      status.followed = !!res?.ok;
      if (!res?.ok) throw new Error(res?.error || 'follow_failed');
    }
    if (q.mode === 'follow_like') {
      const totalLikes = q.likeCount || 0;
      for (let i = 0; i < totalLikes; i++) {
        const r = await execCommand(q.tabId, 'LIKE', {
          userId: item.id,
          username: item.username,
        });
        status.likesTotal = totalLikes;
        status.likesDone = i + 1;
        if (!r?.ok) throw new Error(r?.error || 'like_failed');
      }
    }
    if (q.mode === 'unfollow') {
      const r = await execCommand(q.tabId, 'UNFOLLOW', {
        userId: item.id,
        username: item.username,
      });
      status.unfollowed = !!r?.ok;
      if (!r?.ok) throw new Error(r?.error || 'unfollow_failed');
    }
    resetBackoff();
  } catch (e) {
    const err = String(e.message || e);
    status.error = err;
    transient = isTransientError(err);
  }

  let backoffMs = null;
  if (status.error && transient) {
    backoffMs = calcBackoff();
  }

  return { status, backoffMs };
}

function isTransientError(err) {
  return /429|rate|timeout|temporarily/i.test(err);
}

function calcBackoff() {
  const base = parseInt(q.cfg.baseDelayMs, 10) || 1000;
  const ms = Math.min(60000, base * Math.pow(2, backoffStep));
  backoffStep++;
  return ms;
}

function resetBackoff() {
  backoffStep = 0;
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
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      q.tabId = tabs[0]?.id || null;
      if (!q.tabId) return sendResponse({ ok: false, error: 'no_tab' });
      let items = targets.slice();
      if (!cfg?.includeAlreadyFollowing) {
        const pre = await precheckWindow(q.tabId, items);
        items = pre.items;
      }
      q.items = items;
      q.idx = 0;
      q.total = q.items.length;
      q.processed = 0;
      q.isRunning = true;
      q.paused = false;
      q.phase = 'idle';
      q.mode = mode;
      q.likeCount = likeCount || 0;
      q.cfg = { ...DEFAULT_CFG, ...(cfg || {}) };
      backoffStep = 0;
      log('start', q.total, mode);
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_BACKOFF) {
    scheduleNext(computeNextDelayMs());
  } else if (alarm.name === ALARM_NEXT_ACTION) {
    startAction();
  } else if (alarm.name === ALARM_WATCHDOG) {
    chrome.alarms.getAll((alarms) => {
      const hasMain = alarms.some(
        (a) => a.name === ALARM_NEXT_ACTION || a.name === ALARM_BACKOFF,
      );
      if (q.isRunning && q.nextActionAt && !hasMain && Date.now() > q.nextActionAt) {
        startAction();
      }
    });
  }
});

