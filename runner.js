import {
  IGClient,
  igHeaders,
  userIdFromUsernameApi,
} from "./igClient.js";

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

export class IGRunner {
  constructor() {
    this.ig = new IGClient();
  }

  async execute(task) {
    switch (task.kind) {
      case "FOLLOW":
        return await this.ig.follow(task.userId);
      case "UNFOLLOW":
        return await this.ig.unfollow(task.userId);
      case "LIKE":
        return await this.ig.like(task.mediaId);
      case "LOOKUP": {
        const userId = await lookupUserIdRobust(task.username);
        return { userId };
      }
      case "LIST_FOLLOWERS":
        return await this.ig.listFollowers(task);
      case "LIST_FOLLOWING":
        return await this.ig.listFollowing(task);
      case "LAST_MEDIA":
        return await this.ig.lastMediaIdFromUserId(task.userId, task.username);
      default:
        throw new Error("unknown_task");
    }
  }
}
