/**
 * `/roles/list` now says how many privileges (and users) each role carries,
 * so the roles table no longer needs one `/roles/{gid}/privileges` request per
 * role to tell two rows with the same name apart. Older API builds omit the
 * fields; then the caller keeps counting the old way.
 */

/** A count only if the server really sent one. A missing or unreadable value
 *  is `null`, never 0 - a false zero looks exactly like an empty duplicate,
 *  and that is the signal someone deletes on. */
export function countOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

/**
 * role_gid -> privilege count, taken from the list itself. Returns `null`
 * unless EVERY role carries a count: a partly counted list would show some
 * rows with a number and others as "unknown", so the caller should fall back
 * to counting each role separately instead.
 */
export function privilegeCountsFromList(
  roles: readonly { role_gid: string; privilege_count?: number | null }[],
): Record<string, number> | null {
  if (roles.length === 0) return null;
  const out: Record<string, number> = {};
  for (const r of roles) {
    if (r.privilege_count == null) return null;
    out[r.role_gid] = r.privilege_count;
  }
  return out;
}
