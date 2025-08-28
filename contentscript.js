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

chrome.runtime.onMessage.addListener(async (msg, _s, _send) => {
  if (msg?.type !== "TOGGLE_PANEL") return;
  let root = document.getElementById("igx-panel-root");
  if (root) {
    root.remove();
    if (!msg.open) return;
  }
  if (msg.open === false) return;
  root = document.createElement("div");
  root.id = "igx-panel-root";
  const shadow = root.attachShadow({ mode: "open" });
  document.documentElement.appendChild(root);

  const html = await fetch(chrome.runtime.getURL("panel.html")).then((r) =>
    r.text(),
  );
  shadow.innerHTML = html;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("panel.css");
  shadow.appendChild(link);

  const script = document.createElement("script");
  script.type = "module";
  script.src = chrome.runtime.getURL("panel.js");
  shadow.appendChild(script);
});
