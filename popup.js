document.getElementById("start").onclick = () => {
  const raw = document.getElementById("users").value;
  const users = raw.split(",").map(u => u.trim()).filter(Boolean);
  chrome.tabs.query({ active: true, currentWindow: true }, () => {
    chrome.runtime.sendMessage({ type: "BOT_START", users });
  });
  log("Bot iniciado");
};

document.getElementById("stop").onclick = () => {
  chrome.runtime.sendMessage({ type: "BOT_STOP" });
  log("Bot parado");
};

function log(txt) {
  document.getElementById("log").textContent += txt + "\n";
}
