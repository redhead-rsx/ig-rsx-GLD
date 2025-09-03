const DEFAULT_CFG = {
  baseDelayMs: 3000,
  jitterPct: 20,
  pageSize: 10,
  likePerProfile: 1,
  actionModeDefault: "follow_like",
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
  phase: "idle", // 'waiting'|'executing'|'backoff'|'paused'|'done'
  nextActionAt: null,
  // extra state
  mode: "follow",
  likeCount: 0,
  cfg: { ...DEFAULT_CFG },
  tabId: null,
  followsOkCycle: 0,
  feedbackStrikes: 0,
  startedAt: null,
  backoffReason: null,
  inFlight: false,
};

const ALARM_NEXT_ACTION = "ALARM_NEXT_ACTION";
const ALARM_BACKOFF = "ALARM_BACKOFF";
const ALARM_WATCHDOG = "ALARM_WATCHDOG";
const ALARM_EXEC_WATCHDOG = "ALARM_EXEC_WATCHDOG";
const EXEC_TIMEOUT_MS = 90_000;

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
    q_followsOkCycle: q.followsOkCycle,
    q_feedbackStrikes: q.feedbackStrikes,
    q_startedAt: q.startedAt,
    q_backoffReason: q.backoffReason,
    q_inFlight: q.inFlight,
  });
}

async function rehydrate() {
  const s = await chrome.storage.session.get([
    "q_isRunning",
    "q_idx",
    "q_total",
    "q_processed",
    "q_phase",
    "q_nextActionAt",
    "q_cfg",
    "q_items",
    "q_followsOkCycle",
    "q_feedbackStrikes",
    "q_startedAt",
    "q_backoffReason",
    "q_inFlight",
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
      phase: "idle",
      nextActionAt: null,
      cfg: { ...DEFAULT_CFG },
      feedbackStrikes: 0,
      startedAt: null,
      backoffReason: null,
      inFlight: false,
    },
    {
      items: s.q_items || [],
      idx: s.q_idx || 0,
      total: s.q_total || 0,
      processed: s.q_processed || 0,
      isRunning: s.q_isRunning || false,
      phase: s.q_phase || "idle",
      nextActionAt: s.q_nextActionAt || null,
      cfg: { ...DEFAULT_CFG, ...(s.q_cfg || {}) },
      followsOkCycle: s.q_followsOkCycle || 0,
      feedbackStrikes: s.q_feedbackStrikes || 0,
      startedAt: s.q_startedAt || null,
      backoffReason: s.q_backoffReason || null,
      inFlight: s.q_inFlight || false,
    },
  );
  let action = "none";
  const now = Date.now();
  if (q.isRunning) {
    if (q.phase === "backoff") {
      if (now >= (q.nextActionAt || 0)) {
        scheduleNext(computeDelayMs());
        action = "scheduleNext";
      } else {
        chrome.alarms.create(ALARM_BACKOFF, { when: q.nextActionAt });
        action = "recreate_backoff";
      }
    } else if (q.phase === "waiting") {
      if (now >= (q.nextActionAt || 0)) {
        startAction();
        action = "start_immediate";
      } else {
        chrome.alarms.create(ALARM_NEXT_ACTION, { when: q.nextActionAt });
        action = "recreate_next";
      }
    } else if (q.phase === "executing") {
      q.inFlight = true;
      if (q.startedAt && now - q.startedAt > EXEC_TIMEOUT_MS + 5000) {
        finishItem({ status: { error: "timeout" } });
        action = "timeout";
      } else {
        chrome.alarms.create(ALARM_EXEC_WATCHDOG, { when: now + 1000 });
        action = "resume_exec";
      }
    }
    chrome.alarms.create(ALARM_WATCHDOG, { when: Date.now() + 30_000 });
  }
  log(
    `[rehydrate] phase=${q.phase} now=${now} nextAt=${q.nextActionAt} action=${action}`,
  );
  emitTick({
    reason: q.phase === "backoff" ? q.backoffReason : undefined,
    strikes: q.feedbackStrikes,
  });
}

chrome.runtime.onStartup?.addListener(rehydrate);
rehydrate();

let backoffStep = 0;
let cachedCfg = { ...DEFAULT_CFG };

function log(...args) {
  console.debug("[bg]", ...args);
}

function postToPanel(message) {
  if (!q.tabId) return;
  chrome.tabs.sendMessage(q.tabId, message);
}

function emitTick(extra = {}) {
  postToPanel({
    type: "QUEUE_TICK",
    processed: q.processed,
    total: q.total,
    phase: q.phase,
    nextActionAt: q.nextActionAt,
    ...extra,
  });
}

function computeDelayMs() {
  let base = Number(q.cfg.baseDelayMs);
  const jitterPct = Number(q.cfg.jitterPct) || 0;
  if (!Number.isFinite(base) || base < 1000) {
    log("[sched] invalid baseDelayMs, using 3000ms");
    base = 3000;
  }
  const jitter = ((base * jitterPct) / 100) * (Math.random() * 2 - 1);
  const delay = Math.max(0, Math.round(base + jitter));
  log(`[delay] base=${base}ms jitter=${jitterPct}% → waitMs=${delay}`);
  return delay;
}

function watchWaitingBackoff() {
  if (!q.isRunning || q.paused || q.phase === "done") return;
  const now = Date.now();
  if (q.phase === "waiting" && q.nextActionAt) {
    const late = now - q.nextActionAt;
    if (late > 1000) {
      log(`[watchdog] waiting late by ${late}ms`);
      chrome.alarms.clear(ALARM_NEXT_ACTION);
      if (late <= 60_000) {
        startAction();
      } else {
        scheduleNext(computeDelayMs());
      }
    }
  } else if (q.phase === "backoff" && q.nextActionAt) {
    const late = now - q.nextActionAt;
    if (late > 1000) {
      log("[watchdog] backoff late");
      scheduleNext(computeDelayMs());
    }
  }
  chrome.alarms.create(ALARM_WATCHDOG, { when: Date.now() + 30_000 });
}

function execWatchdog() {
  if (q.phase !== "executing" || !q.inFlight) return;
  const now = Date.now();
  if (q.startedAt && now - q.startedAt > EXEC_TIMEOUT_MS) {
    log("[watchdog] exec timeout");
    finishItem({ status: { error: "timeout" } });
  } else {
    chrome.alarms.create(ALARM_EXEC_WATCHDOG, { when: now + 1000 });
  }
}

function scheduleNext(waitMs) {
  let ms = Number(waitMs);
  if (!Number.isFinite(ms) || ms < 0) {
    log("[sched] invalid waitMs, defaulting to 0");
    ms = 0;
  }
  if (q.paused) return;
  q.phase = "waiting";
  q.backoffReason = null;
  q.nextActionAt = Date.now() + ms;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);
  saveQ({
    phase: "waiting",
    nextActionAt: q.nextActionAt,
    backoffReason: null,
    inFlight: false,
  });
  emitTick();
  log(`[sched] scheduleNext waitMs=${ms} nextAt=${q.nextActionAt}`);
  chrome.alarms.create(ALARM_NEXT_ACTION, { when: q.nextActionAt });
}

function enterBackoff(backoffMs, reason) {
  let ms = Number(backoffMs);
  if (!Number.isFinite(ms) || ms < 0) {
    log("[sched] invalid backoffMs, defaulting to 0");
    ms = 0;
  }
  q.phase = "backoff";
  q.backoffReason = reason;
  q.nextActionAt = Date.now() + ms;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);
  const extra = { reason };
  if (reason === "feedback_required") {
    q.feedbackStrikes++;
    extra.strikes = q.feedbackStrikes;
  }
  saveQ({
    phase: "backoff",
    nextActionAt: q.nextActionAt,
    backoffReason: q.backoffReason,
    inFlight: false,
  });
  emitTick(extra);
  log(
    `[sched] enterBackoff waitMs=${ms} nextAt=${q.nextActionAt} reason=${reason}`,
  );
  chrome.alarms.create(ALARM_BACKOFF, { when: q.nextActionAt });
}

async function startAction() {
  if (!q.isRunning || q.paused || q.inFlight || q.idx >= q.total) return;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);

  q.phase = "executing";
  q.startedAt = Date.now();
  q.inFlight = true;
  await saveQ({
    phase: "executing",
    startedAt: q.startedAt,
    inFlight: true,
  });
  emitTick();
  log(`startAction idx=${q.idx}/total=${q.total} phase=executing`);

  chrome.alarms.create(ALARM_EXEC_WATCHDOG, { when: Date.now() + 1000 });

  const item = q.items[q.idx];
  const normId = String(item?.id || "").trim();
  if (!normId) {
    finishItem({
      status: { ok: false, result: "invalid_id", error: "user_id_missing" },
    });
    return;
  }

  const resp = await execWithTimeout(item);
  finishItem(resp);
}

function finishItem(resp) {
  if (!q.inFlight || q.phase !== "executing") return;
  const item = q.items[q.idx];
  q.inFlight = false;
  q.startedAt = null;
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);
  postToPanel({ type: "ROW_UPDATE", id: item.id, status: resp.status });
  log(
    `result idx=${q.idx} ok=${!resp.status?.error} backoffMs=${
      resp.backoffMs || 0
    }`,
  );

  q.processed++;
  q.idx++;

  if (
    (q.mode === "follow" || q.mode === "follow_like") &&
    resp?.status?.followed
  ) {
    q.followsOkCycle++;
  }

  if (q.idx >= q.total) return finishQueue();

  if (resp && resp.status?.error === "feedback_required") {
    enterBackoff(60 * 60 * 1000, "feedback_required");
  } else if (resp && resp.backoffMs) {
    enterBackoff(resp.backoffMs, resp.reason);
  } else {
    if (
      (q.mode === "follow" || q.mode === "follow_like") &&
      resp?.status?.followed &&
      q.followsOkCycle % 40 === 0 &&
      q.idx < q.total
    ) {
      enterBackoff(20 * 60 * 1000, "auto_throttle_40");
    } else {
      scheduleNext(computeDelayMs());
    }
  }
}

function finishQueue() {
  q.isRunning = false;
  q.phase = "done";
  q.nextActionAt = null;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  chrome.alarms.clear(ALARM_WATCHDOG);
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);
  saveQ({
    isRunning: false,
    phase: "done",
    nextActionAt: null,
    backoffReason: null,
    inFlight: false,
  });
  emitTick();
  postToPanel({ type: "QUEUE_DONE", processed: q.processed, total: q.total });
}

function stopQueue() {
  q.isRunning = false;
  q.paused = false;
  q.phase = "idle";
  q.items = [];
  q.idx = 0;
  q.total = 0;
  q.processed = 0;
  q.nextActionAt = null;
  q.feedbackStrikes = 0;
  q.startedAt = null;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  chrome.alarms.clear(ALARM_WATCHDOG);
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);
  saveQ({
    isRunning: false,
    phase: "idle",
    idx: 0,
    total: 0,
    processed: 0,
    nextActionAt: null,
    feedbackStrikes: 0,
    startedAt: null,
    backoffReason: null,
    inFlight: false,
  });
  emitTick();
}

function resetQueue() {
  q.isRunning = false;
  q.paused = false;
  q.phase = "idle";
  q.items = [];
  q.idx = 0;
  q.total = 0;
  q.processed = 0;
  q.nextActionAt = null;
  q.feedbackStrikes = 0;
  q.startedAt = null;
  chrome.alarms.clear(ALARM_NEXT_ACTION);
  chrome.alarms.clear(ALARM_BACKOFF);
  chrome.alarms.clear(ALARM_WATCHDOG);
  chrome.alarms.clear(ALARM_EXEC_WATCHDOG);
  saveQ({
    isRunning: false,
    phase: "idle",
    idx: 0,
    total: 0,
    processed: 0,
    nextActionAt: null,
    feedbackStrikes: 0,
    startedAt: null,
    backoffReason: null,
    inFlight: false,
  });
  emitTick();
  postToPanel({ type: "QUEUE_RESET" });
}

function sendToTab(tabId, message, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const alarmName = `MSG_TIMEOUT_${Math.random()}`;
    const onAlarm = (a) => {
      if (a.name !== alarmName) return;
      chrome.alarms.onAlarm.removeListener(onAlarm);
      resolve({ ok: false, error: "timeout" });
    };
    chrome.alarms.onAlarm.addListener(onAlarm);
    chrome.alarms.create(alarmName, { when: Date.now() + timeoutMs });
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      chrome.alarms.clear(alarmName);
      chrome.alarms.onAlarm.removeListener(onAlarm);
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: chrome.runtime.lastError.message });
      }
      resolve(resp || { ok: false, error: "no_response" });
    });
  });
}

async function precheckWindow(tabId, items, windowSize = 50) {
  const slice = items.slice(0, windowSize);
  if (!slice.length) return { items, removed: [] };
  const ids = slice.map((it) => it.id);
  const idxResp = await execCommand(tabId, "FOLLOW_INDEX_CHECK", { ids });
  const idxSet = new Set(idxResp?.data?.ids || []);
  const phase1 = slice.filter((it) => !idxSet.has(it.id));
  const resp = phase1.length
    ? await execCommand(tabId, "FRIENDSHIP_STATUS_BULK", {
        users: phase1,
        forceFresh: true,
      })
    : { data: {} };
  const rels = resp?.data || {};
  const removedIds = new Set(idxSet);
  const kept = [];
  for (const it of items) {
    if (removedIds.has(it.id)) continue;
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
        type: "ROW_UPDATE",
        id,
        status: { removedAlreadyFollowing: true },
      });
    }
    postToPanel({
      type: "PRECHECK_REMOVED",
      window: ids.length,
      removed: removedIds.size,
    });
  }
  console.debug(
    "[collect] preExec window=%d removedAlreadyFollowing=%d",
    ids.length,
    removedIds.size,
  );
  return { items: kept, removed: Array.from(removedIds) };
}

async function execCommand(tabId, action, payload) {
  const ping = await sendToTab(tabId, { type: "PING_CS" });
  if (!ping?.ok) {
    log("ping failed", ping?.error);
    return { ok: false, error: ping?.error || "ping_failed" };
  }
  log("exec", action, payload);
  return sendToTab(tabId, { type: "EXEC_TASK", action, payload });
}

async function execWithTimeout(item) {
  const status = {};
  let transient = false;
  try {
    if (q.mode === "follow" || q.mode === "follow_like") {
      const res = await execCommand(q.tabId, "FOLLOW", {
        userId: item.id,
        username: item.username,
      });
      if (!res?.ok) throw new Error(res?.error || "follow_failed");
      status.followed = res.data?.result !== "already_following";
      if (res.data?.result === "already_following") {
        status.alreadyFollowing = true;
      }
    }
    if (q.mode === "follow_like") {
      const totalLikes = q.likeCount || 0;
      for (let i = 0; i < totalLikes; i++) {
        const r = await execCommand(q.tabId, "LIKE", {
          userId: item.id,
          username: item.username,
        });
        status.likesTotal = totalLikes;
        status.likesDone = i + 1;
        if (!r?.ok) throw new Error(r?.error || "like_failed");
      }
    }
    if (q.mode === "unfollow") {
      const r = await execCommand(q.tabId, "UNFOLLOW", {
        userId: item.id,
        username: item.username,
      });
      status.unfollowed = !!r?.ok;
      if (!r?.ok) throw new Error(r?.error || "unfollow_failed");
    }
    resetBackoff();
  } catch (e) {
    const err = String(e.message || e);
    if (isFeedbackRequiredError(err)) {
      status.error = "feedback_required";
      transient = true;
    } else {
      status.error = err;
      transient = isTransientError(err);
    }
  }

  let backoffMs = null;
  let reason = null;
  if (status.error === "feedback_required") {
    backoffMs = 60 * 60 * 1000;
    reason = "feedback_required";
  } else if (status.error && transient) {
    backoffMs = calcBackoff();
  }

  return { status, backoffMs, reason };
}

function isTransientError(err) {
  return /429|rate|timeout|temporarily/i.test(err);
}

function isFeedbackRequiredError(err) {
  return (
    /http_400/i.test(err) &&
    /(feedback_required|limit|limite|frequ|few minutes|espere alguns minutos)/i.test(
      err,
    )
  );
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
  if (msg?.type === "PING_SW") {
    sendResponse({ ok: true, from: "sw" });
  } else if (msg.type === "START_QUEUE") {
    if (q.isRunning)
      return sendResponse({ ok: false, error: "already_running" });
    const { mode, likeCount, targets, cfg } = msg;
    if (!["follow", "follow_like", "unfollow"].includes(mode))
      return sendResponse({ ok: false, error: "invalid_mode" });
    if (!Array.isArray(targets) || !targets.length)
      return sendResponse({ ok: false, error: "invalid_targets" });
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      q.tabId = tabs[0]?.id || null;
      if (!q.tabId) return sendResponse({ ok: false, error: "no_tab" });
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
      q.phase = "idle";
      q.mode = mode;
      q.likeCount = likeCount || 0;
      q.cfg = { ...DEFAULT_CFG, ...(cfg || {}) };
      backoffStep = 0;
      log("start", q.total, mode);
      chrome.alarms.clear(ALARM_WATCHDOG);
      chrome.alarms.create(ALARM_WATCHDOG, { when: Date.now() + 30_000 });
      scheduleNext(0);
      sendResponse({ ok: true });
    });
    return true;
  } else if (msg.type === "STOP_QUEUE") {
    stopQueue();
    sendResponse({ ok: true });
  } else if (msg.type === "RESET_QUEUE") {
    resetQueue();
    sendResponse({ ok: true });
  } else if (msg.type === "CFG_UPDATED") {
    cachedCfg = { ...cachedCfg, ...(msg.cfg || {}) };
    sendResponse({ ok: true });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_BACKOFF) {
    if (q.phase === "backoff") {
      log("[alarm] BACKOFF → scheduleNext");
      scheduleNext(computeDelayMs());
    }
  } else if (alarm.name === ALARM_NEXT_ACTION) {
    if (q.phase === "waiting" && q.isRunning && !q.paused) {
      log("[alarm] NEXT_ACTION → startAction");
      startAction();
    }
  } else if (alarm.name === ALARM_WATCHDOG) {
    watchWaitingBackoff();
  } else if (alarm.name === ALARM_EXEC_WATCHDOG) {
    execWatchdog();
  }
});
