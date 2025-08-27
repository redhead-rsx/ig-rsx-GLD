// src/igClient.js
export class IGClient {
  constructor() {
    this.base = "https://www.instagram.com";
  }

  getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  headersJson(extra = {}) {
    return {
      "content-type": "application/x-www-form-urlencoded",
      "x-csrftoken": this.getCsrf() || "",
      "x-instagram-ajax": "1010212815",
      "x-asbd-id": "129477",
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
      ...extra
    };
  }

  async _fetch(path, { method = "GET", body, qs, json = true, headers } = {}) {
    const url = new URL(path.startsWith("http") ? path : (this.base + path));
    if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      method,
      credentials: "include",
      headers: this.headersJson(headers),
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`http_${res.status}:${text.slice(0,140)}`);
    }
    return json ? res.json() : res.text();
  }

  // ---------- AÇÕES ----------
  async follow(userId) {
    return this._fetch(`/api/v1/friendships/create/${userId}/`, {
      method: "POST", body: new URLSearchParams({})
    });
  }

  async unfollow(userId) {
    return this._fetch(`/api/v1/friendships/destroy/${userId}/`, {
      method: "POST", body: new URLSearchParams({})
    });
  }

  async like(mediaId) {
    return this._fetch(`/web/likes/${mediaId}/like/`, {
      method: "POST", body: new URLSearchParams({})
    });
  }

  async unlike(mediaId) {
    return this._fetch(`/web/likes/${mediaId}/unlike/`, {
      method: "POST", body: new URLSearchParams({})
    });
  }

  // ---------- LOOKUP ----------
  async userIdFromUsername(username) {
    // Atenção: esse endpoint retorna HTML, a extensão original deve extrair do JSON embutido.
    // Aqui simplificamos: tentar versão API v1 (se habilitado)
    const data = await this._fetch(`/api/v1/users/web_profile_info/?username=${username}`, { json: true });
    return data?.data?.user?.id;
  }

  // ---------- LISTAGENS ----------
  async listFollowers({ userId, limit = 24, cursor = null }) {
    const qs = {
      query_hash: "7dd9a7e2160524fd85f50317462cff9f",
      variables: JSON.stringify({ id: userId, include_reel: true, fetch_mutual: false, first: limit, after: cursor })
    };
    const data = await this._fetch("/graphql/query/", { qs, json: true });
    const cont = data?.data?.user?.edge_followed_by;
    return {
      users: cont?.edges?.map(e => ({ id: e.node.id, username: e.node.username })) || [],
      nextCursor: cont?.page_info?.has_next_page ? cont.page_info.end_cursor : null
    };
  }

  async listFollowing({ userId, limit = 24, cursor = null }) {
    const qs = {
      query_hash: "c56ee0ae1f89cdbd1c89e2bc6b8f3d18",
      variables: JSON.stringify({ id: userId, include_reel: true, fetch_mutual: false, first: limit, after: cursor })
    };
    const data = await this._fetch("/graphql/query/", { qs, json: true });
    const cont = data?.data?.user?.edge_follow;
    return {
      users: cont?.edges?.map(e => ({ id: e.node.id, username: e.node.username })) || [],
      nextCursor: cont?.page_info?.has_next_page ? cont.page_info.end_cursor : null
    };
  }

  // ---------- FEED ----------
  async lastMediaIdFromUserId(userId, username) {
    // Versão GraphQL
    const qs = {
      doc_id: "8633614153419931",
      variables: JSON.stringify({ id: userId, first: 12 })
    };
    try {
      const data = await this._fetch("/graphql/query/", { qs, json: true, method: "POST" });
      const node = data?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node;
      return node?.id;
    } catch (e) {
      // fallback API v1
      const data = await this._fetch(`/api/v1/feed/user/${username}/username/?count=12`, { json: true });
      return data?.items?.[0]?.id;
    }
  }
}
