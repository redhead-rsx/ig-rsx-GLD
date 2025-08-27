import { IGRunner } from "./runner.js";

const runner = new IGRunner();

window.addEventListener("message", async (ev) => {
  if (!ev.data?.__BOT__) return;
  if (ev.data.type === "TASK") {
    try {
      const out = await runner.execute(ev.data.task);
      window.postMessage({ __BOT__: true, type: "TASK_RESULT", payload: { ok: true, out } }, "*");
    } catch (e) {
      window.postMessage({ __BOT__: true, type: "TASK_RESULT", payload: { ok: false, error: String(e) } }, "*");
    }
  }
});
