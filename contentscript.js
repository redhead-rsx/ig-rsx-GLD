// Ponte: recebe start/stop do popup
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "BOT_START") {
    window.bot.start(msg.users);
  } else if (msg.type === "BOT_STOP") {
    window.bot.stop();
  }
});
