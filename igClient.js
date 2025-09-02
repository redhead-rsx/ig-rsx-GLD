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
