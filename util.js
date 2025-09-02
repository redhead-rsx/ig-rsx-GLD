export function normUser(u) {
  const id = String(u?.pk ?? u?.id ?? "").trim();
  const username = String(u?.username ?? u?.handle ?? "")
    .trim()
    .toLowerCase();
  return id ? { id, username } : null;
}

export function dedupById(arr) {
  const seen = new Set();
  const out = [];
  for (const u of arr) {
    if (!u || !u.id || seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  return out;
}
