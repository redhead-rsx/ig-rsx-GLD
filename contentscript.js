// Injeta scripts e cria ponte com SW
(function inject() {
  for (const f of ["igClient.js", "runner.js", "injected.js"]) {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(f);
    s.type = "module";
    (document.head || document.documentElement).appendChild(s);
  }
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "EXEC_TASK") {
    window.postMessage({ __BOT__: true, type: "TASK", task: msg.task }, "*");
    const onMsg = (ev) => {
      if (ev.data?.__BOT__ && ev.data.type === "TASK_RESULT") {
        window.removeEventListener("message", onMsg);
        sendResponse(ev.data.payload);
      }
    };
    window.addEventListener("message", onMsg);
    return true;
  }
});
