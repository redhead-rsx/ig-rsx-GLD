import { IGRunner } from "./runner.js";

const runner = new IGRunner();

function log(...args) {
  console.debug('[page]', ...args);
}

window.addEventListener('message', async (ev) => {
  const d = ev.data;
  if (!d || !d.__BOT__ || d.type !== 'TASK') return;
  const { requestId, action, payload } = d;
  try {
    if (action === 'ping_page') {
      return window.postMessage({ type: 'TASK_RESULT', requestId, ok: true, from: 'page' }, '*');
    }
    log('task', action);
    const data = await runner.execute({ kind: action, ...(payload || {}) });
    window.postMessage({ type: 'TASK_RESULT', requestId, ok: true, data }, '*');
  } catch (e) {
    window.postMessage(
      { type: 'TASK_RESULT', requestId, ok: false, error: (e && e.message) || String(e) },
      '*',
    );
  }
});
