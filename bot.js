// Classe Bot: gerencia estado e fila
class Bot {
  constructor() {
    this.running = false;
    this.queue = [];
  }

  start(users) {
    this.running = true;
    this.queue = [...users];
    this.runNext();
  }

  stop() {
    this.running = false;
    this.queue = [];
  }

  async runNext() {
    if (!this.running || this.queue.length === 0) return;
    const user = this.queue.shift();
    const profileUrl = `https://www.instagram.com/${user}/`;

    chrome.runtime.sendMessage({ type: "LIKE_PROFILE", profileUrl }, (res) => {
      console.log("Result:", res);
      setTimeout(() => this.runNext(), 5000 + Math.random() * 2000);
    });
  }
}

window.bot = new Bot();
