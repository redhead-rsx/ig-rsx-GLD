export function normUser(u) {
  const id = String(u?.pk ?? u?.id ?? '').trim();
  const username = String(u?.username ?? '').trim().toLowerCase();
  return { id, username };
}
