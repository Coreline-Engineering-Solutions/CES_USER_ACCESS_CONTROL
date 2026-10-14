/**
 * Search, role filter and paging for the Users tab, so a database with hundreds
 * of people stays quick to read and quick to reach one person in.
 */
export interface UserListRow {
  email: string;
  roles: ReadonlyArray<{ role_gid: string; role_name: string }>;
}

/** The role filter's two special values; any other value is a role_gid. */
export const ANY_ROLE = '';
export const NO_ROLE = '__none__';

export function filterUserRows<T extends UserListRow>(rows: readonly T[], query: string, roleFilter: string): T[] {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return rows.filter((row) => {
    if (roleFilter === NO_ROLE) {
      if (row.roles.length > 0) return false;
    } else if (roleFilter !== ANY_ROLE) {
      if (!row.roles.some((r) => r.role_gid === roleFilter)) return false;
    }
    if (terms.length === 0) return true;
    // an email, or a role the person holds: "ilse manager" finds Ilse's row
    const hay = `${row.email} ${row.roles.map((r) => r.role_name).join(' ')}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export interface Page<T> {
  items: T[];
  /** 0-based page actually shown (the request is clamped into range). */
  page: number;
  pageCount: number;
  /** 1-based first and last row number on this page, 0 when empty. */
  from: number;
  to: number;
  total: number;
}

/** `size` 0 means everything on one page. */
export function paginate<T>(items: readonly T[], page: number, size: number): Page<T> {
  const total = items.length;
  if (size <= 0 || total === 0) {
    return { items: items.slice(), page: 0, pageCount: 1, from: total ? 1 : 0, to: total, total };
  }
  const pageCount = Math.max(1, Math.ceil(total / size));
  const safe = Math.min(Math.max(0, page), pageCount - 1);
  const start = safe * size;
  const slice = items.slice(start, start + size);
  return { items: slice, page: safe, pageCount, from: start + 1, to: start + slice.length, total };
}

export const USER_PAGE_SIZES: readonly number[] = [25, 50, 100, 0];

export function pageSizeLabel(size: number): string {
  return size === 0 ? 'All' : String(size);
}
