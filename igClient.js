// src/igClient.js
export function csrfFromCookie() {
  const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export function igHeaders(extra = {}) {
  return {
    "x-csrftoken": csrfFromCookie(),
    "x-ig-app-id": "936619743392459",
    "x-asbd-id": "129477",
    "x-instagram-ajax": "1010212815",
    "x-requested-with": "XMLHttpRequest",
    ...extra,
  };
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function userIdFromUsernameApi(username) {
  const u = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(
    username
  )}`;
  const res = await fetch(u, { credentials: "include", headers: igHeaders() });
  const text = await res.text();
  if (res.status === 302 && /login/i.test(text)) throw new Error("auth_required");
  if (res.status === 429) throw new Error("http_429");
  if (res.status === 403) throw new Error("http_403");
  if (!res.ok) throw new Error(`http_${res.status}`);
  try {
    const j = JSON.parse(text);
    const id = j?.data?.user?.id;
    if (!id) throw new Error("no_id");
    return id;
  } catch {
    if (/login/i.test(text)) throw new Error("auth_required");
    throw new Error("parse_json");
  }
}

export class IGClient {
  constructor() {
    this.base = "https://www.instagram.com";
    this._relCache = new Map();
    this._relTtlMs = 15 * 60 * 1000;
    this._relBatchSize = 50;
  }

  getCsrf() {
    return csrfFromCookie();
  }

  headersJson(extra = {}) {
    return {
      "content-type": "application/x-www-form-urlencoded",
      ...igHeaders(extra),
    };
  }

  async _fetch(path, { method = "GET", body, qs, json = true, headers } = {}) {
    const url = new URL(path.startsWith("http") ? path : this.base + path);
    if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      credentials: "include",
      headers: this.headersJson(headers),
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`http_${res.status}:${txt.slice(0, 140)}`);
    }
    return json ? res.json() : res.text();
  }

  // ---------- AÇÕES ----------
  async follow(userId) {
    return this._fetch(`/api/v1/friendships/create/${userId}/`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
  }

  async unfollow(userId) {
    return this._fetch(`/api/v1/friendships/destroy/${userId}/`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
  }

  async like(mediaId) {
    return this._fetch(`/web/likes/${mediaId}/like/`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
  }

  async unlike(mediaId) {
    return this._fetch(`/web/likes/${mediaId}/unlike/`, {
      method: "POST",
      body: new URLSearchParams({}),
    });
  }

  // ---------- LOOKUP ----------
  async userIdFromUsername(username) {
    return userIdFromUsernameApi(username);
  }

  // ---------- LISTAGENS ----------
  async listFollowers({ userId, limit = 24, cursor = null }) {
    const qs = {
      query_hash: "7dd9a7e2160524fd85f50317462cff9f",
      variables: JSON.stringify({
        id: userId,
        include_reel: true,
        fetch_mutual: false,
        first: limit,
        after: cursor,
      }),
    };
    const data = await this._fetch("/graphql/query/", { qs, json: true });
    const cont = data?.data?.user?.edge_followed_by;
    return {
      users:
        cont?.edges?.map((e) => ({ id: e.node.id, username: e.node.username })) || [],
      nextCursor: cont?.page_info?.has_next_page
        ? cont.page_info.end_cursor
        : null,
    };
  }

  async listFollowing({ userId, limit = 24, cursor = null }) {
    const qs = {
      query_hash: "c56ee0ae1f89cdbd1c89e2bc6b8f3d18",
      variables: JSON.stringify({
        id: userId,
        include_reel: true,
        fetch_mutual: false,
        first: limit,
        after: cursor,
      }),
    };
    const data = await this._fetch("/graphql/query/", { qs, json: true });
    const cont = data?.data?.user?.edge_follow;
    return {
      users:
        cont?.edges?.map((e) => ({ id: e.node.id, username: e.node.username })) || [],
      nextCursor: cont?.page_info?.has_next_page
        ? cont.page_info.end_cursor
        : null,
    };
  }

  async getFriendshipStatusBulk(userIds = [], opts = {}) {
    const { forceFresh = false } = opts;
    const res = {};
    const now = Date.now();
    const toQuery = [];
    for (const id of userIds) {
      const cached = this._relCache.get(id);
      if (!forceFresh && cached && now - cached.ts < this._relTtlMs) {
        res[id] = {
          following: !!cached.following,
          followed_by: !!cached.followed_by,
        };
      } else {
        toQuery.push(id);
      }
    }

    const chunks = [];
    for (let i = 0; i < toQuery.length; i += this._relBatchSize) {
      chunks.push(toQuery.slice(i, i + this._relBatchSize));
    }

    for (const chunk of chunks) {
      for (let attempt = 0; ; attempt++) {
        try {
          const body = new URLSearchParams({ user_ids: chunk.join(',') });
          const data = await this._fetch(
            '/api/v1/friendships/show_many/',
            { method: 'POST', body }
          );
          const fs = data?.friendship_statuses || {};
          for (const [id, r] of Object.entries(fs)) {
            const entry = {
              following: !!r.following,
              followed_by: !!r.followed_by,
            };
            this._relCache.set(id, { ...entry, ts: Date.now() });
            res[id] = entry;
          }
          break;
        } catch (e) {
          if (String(e.message || e).startsWith('http_429')) {
            const wait = Math.min(2000 * 2 ** attempt, 60000) + Math.random() * 1000;
            console.debug('[collect] backoff: ms=%d (429)', Math.round(wait));
            await delay(wait);
            continue;
          }
          for (const id of chunk) {
            res[id] = {
              following: false,
              followed_by: false,
              rel_unknown: true,
            };
          }
          break;
        }
      }
    }

    console.debug(
      '[collect] bulk rel: requested=%d, cachedHit=%d',
      userIds.length,
      userIds.length - toQuery.length,
    );

    for (const id of userIds) {
      if (!res[id]) {
        const cached = this._relCache.get(id);
        if (cached) {
          res[id] = {
            following: !!cached.following,
            followed_by: !!cached.followed_by,
          };
        } else {
          res[id] = { following: false, followed_by: false, rel_unknown: true };
        }
      }
    }
    return res;
  }

  // ---------- FEED ----------
  async lastMediaIdFromUserId(userId, username) {
    // Versão GraphQL
    const qs = {
      doc_id: "8633614153419931",
      variables: JSON.stringify({ id: userId, first: 12 }),
    };
    try {
      const data = await this._fetch("/graphql/query/", {
        qs,
        json: true,
        method: "POST",
      });
      const node =
        data?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node;
      return node?.id;
    } catch (e) {
      // fallback API v1
      const data = await this._fetch(
        `/api/v1/feed/user/${username}/username/?count=12`,
        { json: true }
      );
      return data?.items?.[0]?.id;
    }
  }
}
