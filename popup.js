function send(msg) {
  return new Promise(res => chrome.runtime.sendMessage(msg, res));
}

document.getElementById("follow").onclick = async () => {
  const u = document.getElementById("username").value.trim();
  if (!u) return;
  await send({ type: "QUEUE_ADD", items: [{ kind: "LOOKUP", username: u }] });
  log("Adicionado follow de @" + u);
};

document.getElementById("like").onclick = async () => {
  const u = document.getElementById("username").value.trim();
  if (!u) return;
  await send({ type: "QUEUE_ADD", items: [{ kind: "LAST_MEDIA", username: u }] });
  log("Adicionado like em @" + u);
};

document.getElementById("start").onclick = () => send({ type: "RUN_START" });
document.getElementById("stop").onclick = () => send({ type: "RUN_STOP" });

function log(t) {
  document.getElementById("log").textContent += t + "\n";
}
