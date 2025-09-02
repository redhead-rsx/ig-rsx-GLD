import { IGClient, igHeaders } from './igClient.js';

function normUser(u) {
  const id = String(u?.pk ?? u?.id ?? '').trim();
  const username = String(u?.username ?? u?.handle ?? '').trim().toLowerCase();
  return { id, username };
}

const followIndex = {
  ready: false,
  ids: new Set(),
  usernames: new Map(),
  loadedAt: 0,
  _initPromise: null,
  async init(max = 15000) {
    if (this.ready) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      try {
        const res = await fetch('/api/v1/accounts/current_user/', {
          credentials: 'include',
          headers: igHeaders(),
        });
        const j = await res.json().catch(() => ({}));
        const selfId = String(j?.user?.pk || j?.user?.id || '').trim();
        if (!selfId) {
          this.ready = true;
          this.loadedAt = Date.now();
          return;
        }
        const ig = new IGClient();
        for (let cursor = null; this.ids.size < max;) {
          const { users, nextCursor } = await ig.listFollowing({
            userId: selfId,
            limit: 24,
            cursor,
          });
          for (const u of users || []) {
            const { id, username } = normUser(u);
            if (!id) continue;
            this.add(id, username);
            if (this.ids.size >= max) break;
          }
          if (!nextCursor || this.ids.size >= max) break;
          cursor = nextCursor;
        }
        this.ready = true;
        this.loadedAt = Date.now();
      } catch (e) {
        console.warn('[followIndex] init failed', e);
        this.ready = true;
        this.loadedAt = Date.now();
      }
    })();
    return this._initPromise;
  },
  hasId(id) {
    return this.ids.has(String(id).trim());
  },
  add(id, username) {
    const nid = String(id).trim();
    if (!nid) return;
    this.ids.add(nid);
    if (username) {
      this.usernames.set(String(username).trim().toLowerCase(), nid);
    }
  },
};

export default followIndex;
