import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from '../session/session.service';
import { StockAccessApiService } from './stock-access-api.service';

export interface DbLinkedUser {
  /** Real UUID when the GIS-side lookup had one; falls back to the email
   *  itself when only the auth-side (email-only) source saw this person —
   *  same "not a valid id but fine for display" pattern used across the
   *  Stock panel's own user merge. Callers that SUBMIT a gid must not trust
   *  this blindly — check it looks like a UUID first. */
  user_gid: string;
  email: string;
}

/**
 * Users actually linked/granted to the CURRENTLY ACTIVE database (the
 * navbar db switcher) — shared across every panel that needs a "pick a
 * known user" dropdown scoped to the db being worked in, rather than the
 * full system-wide directory (SessionService.allUserEmails()). 2 Sep:
 * every email dropdown in this app was pointed at the full list; the
 * actual requirement is "users linked to the db" everywhere.
 *
 * Merges the same two sources stock-access-panel.component.ts's own
 * per-org loadUsers() already merges per org — GIS /admin/db-users (often
 * has a real user_gid) and auth-api /auth/db/users/list (often email-only)
 * — simplified here to the one currently-active db instead of looping
 * every org, since that's the scope every OTHER panel in this app actually
 * needs. Lives as its own service (not folded into SessionService) because
 * StockAccessApiService already injects SessionService — folding this in
 * there would be a circular dependency.
 */
@Injectable({ providedIn: 'root' })
export class DbUsersService {
  private readonly session = inject(SessionService);
  private readonly stockAccess = inject(StockAccessApiService);

  readonly users = signal<DbLinkedUser[]>([]);
  readonly loading = signal(false);

  private lastDbGid = '';
  private inflight: Promise<void> | null = null;

  private activeDbGid(): string {
    const db = this.session.currentDb();
    return String(db?.db_gid ?? db?.global_id ?? db?.gid ?? '').trim();
  }

  /** Loads (or reloads, if the active db changed since last time) the
   *  current db's linked users. Idempotent for the same db — safe to call
   *  from every panel's ngOnInit without duplicating fetches. */
  ensureLoaded(): Promise<void> {
    const dbGid = this.activeDbGid();
    if (!dbGid) {
      this.users.set([]);
      return Promise.resolve();
    }
    if (dbGid === this.lastDbGid && this.users().length > 0) return Promise.resolve();
    if (this.inflight) return this.inflight;

    this.loading.set(true);
    this.inflight = Promise.all([
      this.stockAccess.dbUsersList(dbGid).catch(() => null),
      this.session.dbUsersList(dbGid).catch(() => [] as any[]),
    ])
      .then(([gisRes, authRes]) => {
        const gisListRaw =
          (gisRes as any)?.users ?? (gisRes as any)?.emails ?? (gisRes as any)?.email_list ??
          (gisRes as any)?.user_list ?? (gisRes as any)?.data ?? gisRes;
        const gisList: any[] = Array.isArray(gisListRaw) ? gisListRaw : [];
        const authList: any[] = Array.isArray(authRes) ? authRes : [];
        this.lastDbGid = dbGid;
        this.users.set(DbUsersService.scopeToAuthMembership(authList, gisList));
      })
      .finally(() => {
        this.loading.set(false);
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Force a reload even if this db was already loaded — e.g. after the
   *  active db changes via the navbar switcher. */
  reload(): Promise<void> {
    this.lastDbGid = '';
    return this.ensureLoaded();
  }

  /** Same merge/dedup logic as stock-access-panel.component.ts's private
   *  mergeUserLists — deduped by email (case-insensitive); a real gid from
   *  one source wins over an email-fallback id seen for the same person in
   *  another. */
  /**
   * Auth API decides membership; the GIS list only enriches.
   *
   * Found 3 Sep, after three rounds of narrowing this downstream and the
   * dropdowns still showing everyone: CES_ACCESS_CONTROL - which lists db
   * users correctly - uses ONLY `/auth/db/users/list`. UAC and Stock also
   * called the GIS API's `/admin/db-users` and treated it as an equal
   * source, merging its rows in. If that endpoint does not actually filter
   * on the db_gid it is handed, every merge downstream inherits the whole
   * directory, and no amount of per-org/per-scope narrowing in the UI can
   * put it back - which matches exactly what kept being reported.
   *
   * So: an email only appears if the AUTH list has it for this database.
   * The GIS row for that same person is used purely to supply a real
   * user_gid (auth rows are often email-only, and a grant that submits an
   * email where a UUID column is expected fails hard). Anyone present only
   * in the GIS response is dropped, deliberately - that is the leak.
   */
  private static scopeToAuthMembership(authList: any[], gisList: any[]): DbLinkedUser[] {
    const authScoped = DbUsersService.mergeUserLists([authList]);
    if (authScoped.length === 0) {
      // Auth had nothing to say for this db. Returning the GIS list here
      // would re-open the leak, so return nothing and let the caller show
      // its "no users found" state with manual entry.
      return [];
    }
    const gidByEmail = new Map<string, string>();
    for (const u of DbUsersService.mergeUserLists([gisList])) {
      if (u.user_gid && u.user_gid !== u.email) gidByEmail.set(u.email.toLowerCase(), u.user_gid);
    }
    return authScoped.map((u) => {
      const better = gidByEmail.get(u.email.toLowerCase());
      return better ? { ...u, user_gid: better } : u;
    });
  }

  private static mergeUserLists(lists: any[][]): DbLinkedUser[] {
    const byEmail = new Map<string, DbLinkedUser>();
    for (const list of lists) {
      for (const u of list) {
        const isStr = typeof u === 'string';
        const email = String(isStr ? u : (u?.email ?? u?.user_email ?? u?.userEmail ?? '')).trim();
        if (!email) continue;
        const realId = String(isStr ? '' : (
          u?.user_gid ?? u?.userGid ?? u?.gid ?? u?.uuid ?? u?.UUID ??
          u?.user_id ?? u?.userId ?? u?.id ?? u?.global_id ?? u?.globalId ?? ''
        )).trim();
        const key = email.toLowerCase();
        const existing = byEmail.get(key);
        if (!existing) {
          byEmail.set(key, { user_gid: realId || email, email });
        } else if (realId && existing.user_gid === existing.email) {
          existing.user_gid = realId;
        }
      }
    }
    return Array.from(byEmail.values()).sort((a, b) => a.email.localeCompare(b.email));
  }
}
