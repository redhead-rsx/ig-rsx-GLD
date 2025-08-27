// Service Worker: agenda tasks, injeta liker em perfis
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "LIKE_PROFILE") {
    const profileUrl = msg.profileUrl;

    chrome.tabs.create({ url: profileUrl, active: false }, (tab) => {
      const tabId = tab.id;
      const start = Date.now();

      const onMsg = (res, snd) => {
        if (snd.tab?.id !== tabId) return;
        if (res.type === "LIKE_DONE" || res.type === "LIKE_SKIP") {
          chrome.runtime.onMessage.removeListener(onMsg);
          chrome.tabs.remove(tabId);
          sendResponse({
            ok: res.type === "LIKE_DONE",
            ...res,
            tookMs: Date.now() - start
          });
        }
      };
      chrome.runtime.onMessage.addListener(onMsg);

      chrome.scripting.executeScript({
        target: { tabId },
        files: ["liker.js"]
      });
    });

    return true; // async
  }
});
