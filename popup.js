document.addEventListener('DOMContentLoaded', async () => {
  const btn = document.getElementById('open');
  const warning = document.getElementById('warning');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https?:\/\/(www\.)?instagram\.com\//i.test(tab.url || '')) {
    warning.textContent = 'Abra o Instagram para usar a ferramenta.';
    warning.style.display = 'block';
    btn.disabled = true;
    return;
  }
  btn.addEventListener('click', () => {
    chrome.tabs.sendMessage(tab.id, { type: 'OPEN_PANEL' });
    window.close();
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'QUEUE_SUMMARY') {
    const sumEl = document.getElementById('summary');
    if (!sumEl) return;
    sumEl.style.display = 'block';
    document.getElementById('sumProcessed').textContent = msg.processed;
    document.getElementById('sumSuccess').textContent = msg.success;
    document.getElementById('sumFailed').textContent = msg.failed;
    document.getElementById('sumSkipped').textContent = msg.skipped;
  }
});