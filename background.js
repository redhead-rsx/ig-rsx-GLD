// Service worker: gerencia fila de tarefas e agenda com alarms
const QKEY = "silent.queue.v1";
let running = false;
let processedCount = 0;
let totalCount = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "QUEUE_ADD") {
    addToQueue(msg.items || []);
    sendResponse({ ok: true });
  } else if (msg.type === "RUN_START") {
    running = true;
    processedCount = 0;
    getQueue().then((q) => {
      totalCount = q.length;
      scheduleNext(500);
    });
    sendResponse({ ok: true });
    return true;
  } else if (msg.type === "RUN_STOP") {
    running = false;
    chrome.alarms.clear("tick");
    processedCount = 0;
    totalCount = 0;
    sendResponse({ ok: true });
  } else if (msg.type === "GET_QUEUE") {
    getQueue().then(q => sendResponse({ ok: true, queue: q }));
    return true;
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "tick") runOne();
});

async function getQueue() {
  return (await chrome.storage.local.get([QKEY]))[QKEY] || [];
}
async function setQueue(q) {
  await chrome.storage.local.set({ [QKEY]: q });
}
async function addToQueue(items) {
  const q = await getQueue();
  q.push(...items);
  await setQueue(q);
}

function scheduleNext(ms) {
  chrome.alarms.create("tick", { when: Date.now() + ms });
}

async function runOne() {
  if (!running) return;
  const q = await getQueue();
  if (!q.length) return;

  const task = q.shift();
  await setQueue(q);

  // envia para content script executar no contexto da página
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    const waitMs = 5000;
    processedCount++;
    chrome.runtime.sendMessage({
      type: "TASK_DONE",
      ok: false,
      task,
      error: "no_tab",
    });
    chrome.runtime.sendMessage({
      type: "TASK_PROGRESS",
      processed: processedCount,
      total: totalCount,
      current: task,
      nextWaitMs: waitMs,
    });
    scheduleNext(waitMs);
    return;
  }

  try {
    chrome.tabs.sendMessage(tab.id, { type: "EXEC_TASK", task }, (res) => {
      const waitMs = 4000 + Math.random() * 2000;
      processedCount++;
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({
          type: "TASK_DONE",
          ok: false,
          task,
          error: String(
            chrome.runtime.lastError.message || chrome.runtime.lastError,
          ),
        });
      } else {
        chrome.runtime.sendMessage({
          type: "TASK_DONE",
          ok: res?.ok,
          task,
          error: res?.error,
        });
      }
      chrome.runtime.sendMessage({
        type: "TASK_PROGRESS",
        processed: processedCount,
        total: totalCount,
        current: task,
        nextWaitMs: waitMs,
      });
      scheduleNext(waitMs);
    });
  } catch (e) {
    const waitMs = 5000;
    processedCount++;
    chrome.runtime.sendMessage({
      type: "TASK_DONE",
      ok: false,
      task,
      error: String(e),
    });
    chrome.runtime.sendMessage({
      type: "TASK_PROGRESS",
      processed: processedCount,
      total: totalCount,
      current: task,
      nextWaitMs: waitMs,
    });
    scheduleNext(waitMs);
  }
}
