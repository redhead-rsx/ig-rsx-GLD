// Injetado na aba do perfil. Abre 1ª mídia e dá like
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    // espera grid
    let tries = 0, target = null;
    while (tries < 20 && !target) {
      target = document.querySelector('article a[href*="/p/"], article a[href*="/reel/"]');
      if (!target) { await sleep(500); tries++; }
    }
    if (!target) throw new Error("no_media");

    target.click();
    await sleep(1500);

    const modal = document.querySelector('[role="dialog"]') || document;
    const likeBtn = modal.querySelector(
      'button[aria-label*="Curtir" i], button[aria-label*="Like" i], button[aria-pressed="false"]'
    );
    if (!likeBtn) throw new Error("like_button_not_found");

    likeBtn.click();
    await sleep(800);

    chrome.runtime.sendMessage({ type: "LIKE_DONE" });
  } catch (e) {
    chrome.runtime.sendMessage({ type: "LIKE_SKIP", reason: e.message });
  }
})();
