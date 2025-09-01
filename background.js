let queue = [];
let running = false;
let processed = 0;
let timer = null;
let currentSettings = {};

function log(...args) {
  console.debug('[bg]', ...args);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_PROCESS') {
    if (running) {
      sendResponse({ ok: false });
      return;
    }
    queue = msg.items || [];
    processed = 0;
    currentSettings = msg.settings || {};
    running = true;
    log('start', queue.length);
    processNext();
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === 'STOP_PROCESS') {
    stop();
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
  log('stop');
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (tabId) chrome.tabs.sendMessage(tabId, { type: 'STOPPED' });
  });
}

function execCommand(tabId, action, payload) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ ok: false, error: 'no_response' });
      }
    }, 10000);
    log('exec', action, payload);
    chrome.tabs.sendMessage(
      tabId,
      { type: 'EXEC', action, payload },
      (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false, error: 'no_response' });
        }
      },
    );
  });
}

async function processNext() {
  if (!running) return;
  if (!queue.length) {
    stop();
    return;
  }
  const item = queue.shift();
  const tab = await new Promise((r) =>
    chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t[0]))
  );
  const tabId = tab?.id;
  if (!tabId) {
    stop();
    return;
  }
  try {
    if (currentSettings.actionMode === 'follow' || currentSettings.actionMode === 'follow_like') {
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
    if (currentSettings.actionMode === 'follow_like') {
      const total = currentSettings.likeCount || 0;
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
    if (currentSettings.actionMode === 'unfollow') {
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
    timer = setTimeout(stop, delay);
    return;
  }
  timer = setTimeout(processNext, delay);
}

function nextDelay() {
  const base = parseInt(currentSettings.delayMs, 10) || 0;
  const jitterPct = parseInt(currentSettings.randomJitterPct, 10) || 0;
  const jitter = (base * jitterPct) / 100 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
