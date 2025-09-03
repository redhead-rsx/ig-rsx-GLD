import {
  IGClient,
  igHeaders,
  userIdFromUsernameApi,
} from "./igClient.js";
import followIndex from "./followIndex.js";
import followDb from "./followDb.js";

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function s1(username) {
  return userIdFromUsernameApi(username);
}

async function s2(username) {
  const res = await fetch(`/${encodeURIComponent(username)}/`, {
    credentials: "include",
    headers: igHeaders(),
  });
  const html = await res.text();
  if (res.status === 429) throw new Error("http_429");
  if (res.status === 403) throw new Error("http_403");
  if (!res.ok) throw new Error(`http_${res.status}`);
  if (/login/i.test(html)) throw new Error("auth_required");
  const ld = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i
  );
  if (ld) {
    try {
      const data = JSON.parse(ld[1]);
      const sameAs = (
        data?.mainEntityOfPage?.["@id"] || data?.url || ""
      ).toString();
      const mld = sameAs.match(/profilePage_(\d+)/);
      if (mld?.[1]) return mld[1];
    } catch {}
  }
  const m = html.match(/"profilePage_(\d+)"/);
  if (m?.[1]) return m[1];
  const m2 = html.match(
    new RegExp(
      `"id":"(\\d+)","username":"${username.replace(
        /[-/\\^$*+?.()|[\]{}]/g,
        "\\$&"
      )}"`
    )
  );
  if (m2?.[1]) return m2[1];
  throw new Error("parse_failed");
}

async function s3(username) {
  const body = new URLSearchParams({
    doc_id: "8845758582119845",
    variables: JSON.stringify({ username }),
  });
  const res = await fetch("/graphql/query", {
    method: "POST",
    credentials: "include",
    headers: igHeaders({
      "content-type": "application/x-www-form-urlencoded",
    }),
    body,
  });
  const text = await res.text();
  if (res.status === 429) throw new Error("http_429");
  if (res.status === 403) throw new Error("http_403");
  if (!res.ok) throw new Error(`http_${res.status}`);
  if (/login/i.test(text)) throw new Error("auth_required");
  try {
    const j = JSON.parse(text);
    const id = j?.data?.user?.id || j?.data?.user_by_username?.id;
    if (!id) throw new Error("no_id");
    return id;
  } catch {
    throw new Error("parse_json");
  }
}

async function lookupUserIdRobust(username) {
  const strategies = [s1, s2, s3];
  let lastErr = "none";
  for (let i = 0; i < strategies.length; i++) {
    try {
      return await strategies[i](username);
    } catch (e) {
      lastErr = e.message || String(e);
      await delay(200 * (i + 1));
    }
  }
  throw new Error("lookup_failed:" + lastErr);
}

async function firstMediaFromV1(username) {
  const res = await fetch(
    `/api/v1/feed/user/${encodeURIComponent(username)}/username/?count=12`,
    { credentials: "include", headers: igHeaders() },
  );
  if (!res.ok) throw new Error("http_" + res.status);
  const j = await res.json();
  const item = (j?.items || []).find((it) => it && it.pk && !it.has_liked);
  return item?.pk || null;
}

async function mediaIdFromShortcode(shortcode) {
  const r = await fetch(`/p/${shortcode}/?__a=1&__d=dis`, {
    credentials: "include",
  });
  const j = await r.json().catch(() => ({}));
  return j?.graphql?.shortcode_media?.id || null;
}

async function firstMediaFromGraphQL(username) {
  const body = new URLSearchParams({
    doc_id: "8633614153419931",
    variables: JSON.stringify({ id: null, username, fetch_media_count: 12 }),
  });
  const r = await fetch("/graphql/query", {
    method: "POST",
    credentials: "include",
    headers: igHeaders({
      "content-type": "application/x-www-form-urlencoded",
    }),
    body,
  });
  if (!r.ok) throw new Error("http_" + r.status);
  const j = await r.json();
  const node = j?.data?.user?.edge_owner_to_timeline_media?.edges?.[0]?.node;
  if (node?.id) return node.id;
  if (node?.shortcode) return await mediaIdFromShortcode(node.shortcode);
  return null;
}

async function getFirstLikeableMediaId(username) {
  try {
    const pk = await firstMediaFromV1(username);
    if (pk) return pk;
  } catch {}
  const pk2 = await firstMediaFromGraphQL(username);
  if (!pk2) throw new Error("no_media");
  return pk2;
}

async function likeMedia(mediaId) {
  const res = await fetch(`/web/likes/${mediaId}/like/`, {
    method: "POST",
    credentials: "include",
    headers: igHeaders({
      "content-type": "application/x-www-form-urlencoded",
    }),
    body: "",
  });
  if (!res.ok) throw new Error("http_" + res.status);
  const j = await res.json().catch(() => ({}));
  if (j?.status !== "ok") throw new Error("like_failed");
  return true;
}

export class IGRunner {
  constructor() {
    this.ig = new IGClient();
  }

  async execute(task) {
    switch (task.kind) {
      case "FOLLOW": {
        const id = String(task.userId || '').trim();
        const username = String(task.username || '').trim().toLowerCase();
        if (!id) return { ok: false, result: 'invalid_id', error: 'user_id_missing' };
        return await this.followWithGuard(id, username);
      }
      case "UNFOLLOW": {
        const id = String(task.userId || '').trim();
        if (!id) return { ok: false, result: 'invalid_id', error: 'user_id_missing' };
        return await this.ig.unfollow(id);
      }
      case "LIKE": {
        const username = String(task.username || '').trim().toLowerCase();
        if (!username)
          return { ok: false, result: 'invalid_id', error: 'user_id_missing' };
        const mediaId = await getFirstLikeableMediaId(username);
        await likeMedia(mediaId);
        return { ok: true };
      }
      case "LOOKUP": {
        const userId = await lookupUserIdRobust(task.username);
        return { userId };
      }
      case "LIST_FOLLOWERS":
        return await this.ig.listFollowers(task);
      case "LIST_FOLLOWING":
        return await this.ig.listFollowing(task);
      case "FRIENDSHIP_STATUS_BULK": {
        await followDb.init();
        const users = [];
        for (const u of task.users || []) {
          const id = String(u?.id || "").trim();
          if (!id) continue;
          users.push({ id, username: String(u.username || "").trim().toLowerCase() });
        }
        for (const id of task.ids || task.userIds || []) {
          const nid = String(id).trim();
          if (!nid) continue;
          users.push({ id: nid, username: "" });
        }
        const res = {};
        const ids = users.map((u) => u.id);
        const dbHits = await followDb.bulkHas(ids);
        const toCheck = [];
        for (const u of users) {
          if (followIndex.hasId(u.id) || dbHits.has(u.id)) {
            res[u.id] = { following: true, resolved: true };
          } else {
            toCheck.push(u);
          }
        }
        if (toCheck.length) {
          const rel = await this.ig.getFriendshipStatusBulk(
            toCheck.map((u) => u.id),
            { forceFresh: !!task.forceFresh },
          );
          const learn = [];
          for (const u of toCheck) {
            const r = rel[u.id];
            if (r) {
              res[u.id] = r;
              if (r.following) {
                followIndex.add(u.id, u.username);
                learn.push({ id: u.id, username: u.username, source: "filter" });
              }
            }
          }
          if (learn.length) await followDb.upsertMany(learn);
        }
        return res;
      }
      case "FOLLOW_INDEX_INIT": {
        await followDb.init();
        const sample = await followDb.sampleIds(task.max || 15000);
        for (const id of sample) followIndex.add(id);
        await followIndex.init(task.max);
        return { ok: true };
      }
      case "FOLLOW_INDEX_CHECK": {
        await followDb.init();
        const ids = (task.ids || []).map((id) => String(id).trim());
        const dbHits = await followDb.bulkHas(ids);
        const hits = ids.filter((id) => followIndex.hasId(id) || dbHits.has(id));
        return { ids: hits };
      }
      default:
        throw new Error("unknown_task");
    }
  }

  async followWithGuard(userId, username) {
    const id = String(userId).trim();
    const uname = String(username || "").trim().toLowerCase();
    await followDb.init();
    if (followIndex.hasId(id) || (await followDb.has(id))) {
      console.debug(
        `[guard] skip already_following id=%s user=@%s (by index/db)`,
        id,
        uname,
      );
      return {
        action: "follow",
        userId: id,
        username: uname,
        result: "already_following",
      };
    }
    const r = await this.ig.getFriendshipStatusSingle(id);
    if (r?.following) {
      followIndex.add(id, uname);
      await followDb.upsert({ id, username: uname, source: "guard" });
      console.debug(
        `[guard] skip already_following id=%s user=@%s (by single)`,
        id,
        uname,
      );
      return {
        action: "follow",
        userId: id,
        username: uname,
        result: "already_following",
      };
    }
    const out = await this.ig.follow(id);
    if (out?.status === "ok" || out?.friendship_status?.following) {
      followIndex.add(id, uname);
      await followDb.upsert({ id, username: uname, source: "success" });
    }
    return out;
  }
}