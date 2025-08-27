// Injeta scripts e cria ponte com SW
let panelRoot = null;

(function inject() {
  for (const f of ["igClient.js", "runner.js", "injected.js"]) {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL(f);
    s.type = "module";
    (document.head || document.documentElement).appendChild(s);
  }
})();

async function togglePanel() {
  if (panelRoot) {
    panelRoot.remove();
    panelRoot = null;
    return;
  }
  panelRoot = document.createElement("div");
  panelRoot.id = "igx-panel-root";
  Object.assign(panelRoot.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
  });
  const shadow = panelRoot.attachShadow({ mode: "open" });
  const html = await (await fetch(chrome.runtime.getURL("panel.html"))).text();
  shadow.innerHTML = html;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("panel.css");
  shadow.appendChild(link);
  const url = chrome.runtime.getURL("panel.js");
  const mod = await import(url);
  if (typeof mod.init === "function") mod.init(shadow);
  document.documentElement.appendChild(panelRoot);
}

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
  if (msg.type === "TOGGLE_PANEL") {
    togglePanel();
  }
});
