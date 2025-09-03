const DB_NAME = 'ig_rsx';
const STORE_NAME = 'followed_v1';
const MAX_MEM = 50000;

const followDb = {
  db: null,
  memSet: new Set(),
  _initPromise: null,
  async init(limit = MAX_MEM) {
    if (this.db) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = (ev) => {
        this.db = ev.target.result;
        resolve();
      };
      req.onerror = () => resolve();
    }).then(async () => {
      if (!this.db) return;
      await new Promise((resolve) => {
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && this.memSet.size < limit) {
            this.memSet.add(String(cursor.key));
            cursor.continue();
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    });
    return this._initPromise;
  },
  async upsert({ id, username = '', source = 'filter' } = {}) {
    const nid = String(id || '').trim();
    if (!nid || !this.db) return;
    const data = {
      id: nid,
      username: String(username || '').trim().toLowerCase(),
      source,
      lastSeen: Date.now(),
    };
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    this.memSet.add(nid);
  },
  async upsertMany(arr = []) {
    if (!this.db || !Array.isArray(arr) || !arr.length) return;
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const it of arr) {
        const nid = String(it?.id || '').trim();
        if (!nid) continue;
        store.put({
          id: nid,
          username: String(it?.username || '').trim().toLowerCase(),
          source: it?.source || 'filter',
          lastSeen: Date.now(),
        });
        this.memSet.add(nid);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
  async has(id) {
    const nid = String(id || '').trim();
    if (!nid) return false;
    if (this.memSet.has(nid)) return true;
    if (!this.db) return false;
    return new Promise((resolve) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(nid);
      req.onsuccess = (e) => resolve(!!e.target.result);
      req.onerror = () => resolve(false);
    });
  },
  async bulkHas(ids = []) {
    const out = new Set();
    if (!Array.isArray(ids) || !ids.length) return out;
    const missing = [];
    for (const id of ids) {
      const nid = String(id || '').trim();
      if (!nid) continue;
      if (this.memSet.has(nid)) out.add(nid);
      else missing.push(nid);
    }
    if (!missing.length || !this.db) return out;
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let remaining = missing.length;
      for (const id of missing) {
        const req = store.get(id);
        req.onsuccess = (e) => {
          if (e.target.result) out.add(id);
          if (--remaining === 0) resolve();
        };
        req.onerror = () => {
          if (--remaining === 0) resolve();
        };
      }
    });
    return out;
  },
  async prune({ ttlDays = 365 } = {}) {
    if (!this.db) return;
    const cutoff = Date.now() - ttlDays * 86400000;
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const v = cursor.value;
          if (v?.lastSeen && v.lastSeen < cutoff) {
            store.delete(cursor.primaryKey);
            this.memSet.delete(String(cursor.primaryKey));
          }
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  },
  async exportJson() {
    if (!this.db) return [];
    const all = [];
    await new Promise((resolve) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          all.push(cursor.value);
          cursor.continue();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    return all;
  },
  async importJson(data = []) {
    if (!Array.isArray(data) || !data.length) return;
    await this.upsertMany(data);
  },
  sampleIds(n = 1000) {
    const out = [];
    for (const id of this.memSet) {
      out.push(id);
      if (out.length >= n) break;
    }
    return out;
  },
};

export default followDb;
