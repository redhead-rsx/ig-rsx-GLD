import { IGRunner } from "./runner.js";

const runner = new IGRunner();

function log(...args) {
  console.debug('[page]', ...args);
}

window.addEventListener("message", async (ev) => {
  const msg = ev.data;
  if (!msg?.__BOT__ || msg.type !== "TASK") return;
  try {
    log('task', msg.action);
    const data = await runner.execute({ kind: msg.action, ...(msg.payload || {}) });
    window.postMessage(
      {
        __BOT__: true,
        type: "TASK_RESULT",
        requestId: msg.requestId,
        ok: true,
        data,
      },
      "*",
    );
  } catch (e) {
    window.postMessage(
      {
        __BOT__: true,
        type: "TASK_RESULT",
        requestId: msg.requestId,
        ok: false,
        error: String(e),
      },
      "*",
    );
  }
});
