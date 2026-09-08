import { Injectable, computed, signal } from '@angular/core';
import Cookies from 'js-cookie';
import { UserSessionService } from '../../classes/ClassesAuth';

export type SessionInfo = {
  session_gid: string;
  email: string;
  /**
   * Stable UUID for this user across the auth system. May be `''` for a
   * tick after first login until `_logged_in` or `_status` resolves —
   * consumers should treat empty as "not yet known".
   */
  user_gid: string;
};

@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly AUTH_API = 'https://auth-api-frankfurt.onrender.com';

  readonly session = signal<SessionInfo | null>(null);
  readonly loading = signal<boolean>(true);
  readonly accessList = signal<any[]>([]);
  readonly requiredTool = signal<string | null>(null);
  readonly profileImage = signal<string | null>(null);

  /** Database switcher — same /auth/dbs, /auth/db/current, /auth/db/set
   *  contract as CES_MODULES' navbar (ported verbatim, same AUTH_API). */
  readonly databases = signal<any[]>([]);
  readonly currentDb = signal<any>(null);
  readonly loadingDbs = signal<boolean>(false);

  /**
   * True when the user holds `_list_user_projects` on `GIS System` — the
   * same system-manager privilege check used across the CES app family.
   * Resolved during `validate()`; defaults to false until proven otherwise.
   */
  readonly isSystemManager = signal<boolean>(false);

  readonly isValid = computed(() => Boolean(this.session()));

  async validate(requiredTool: string | null = null): Promise<void> {
    this.requiredTool.set(requiredTool);
    this.loading.set(true);

    const session_gid = this.readCookie('session_gid');
    const user_email = this.readCookie('user_email');

    if (!session_gid || !user_email) {
      this.accessList.set([]);
      this.session.set(null);
      this.loading.set(false);
      this.redirectIfInvalidInProd();
      return;
    }

    // Set session immediately so pages can start making API calls.
    this.session.set({ session_gid, email: user_email, user_gid: '' });

    const service = new UserSessionService(user_email, session_gid);

    const withTimeout = async <T>(p: Promise<T>, ms: number): Promise<T> => {
      return await Promise.race([
        p,
        new Promise<T>((_resolve, reject) => {
          setTimeout(() => reject(new Error('Session validation timed out')), ms);
        })
      ]);
    };

    try {
      const loggedInResponse: any = await withTimeout(service.loggedIn({ session_gid }), 10000);

      const responseStr = typeof loggedInResponse === 'string'
        ? loggedInResponse.trim().toLowerCase()
        : String(loggedInResponse?.message ?? loggedInResponse ?? '').trim().toLowerCase();

      if (responseStr === 'user not signed in' || responseStr === 'not signed in') {
        this.accessList.set([]);
        this.session.set(null);
        return;
      }

      let userGid = '';
      if (typeof loggedInResponse === 'object' && loggedInResponse?.user_gid) {
        userGid = String(loggedInResponse.user_gid);
      } else {
        try {
          userGid = await withTimeout(service.fetchUserStatus(), 8000);
        } catch {
          // Degrade gracefully — some auth deployments don't return user_gid here.
        }
      }

      let accessList = await withTimeout(service.fetchAccessList(), 20000);

      // An empty list is INCONCLUSIVE, not a denial — retry once before
      // treating it as an answer.
      //
      // fetchAccessList() does `data?.utility_list || []`, so an error
      // response (`{detail: "User not logged in."}`, an auth-service timeout,
      // a 5xx body) comes back as an empty array WITHOUT throwing. It never
      // reaches the catch below, so the optimistic-session rescue there does
      // not apply.
      // Deliberately NOT retried. An empty list only happens when auth is
      // already struggling, so a retry adds load at precisely the moment
      // load is the problem — the same self-amplifying shape as a retry
      // storm, and this app talks to the auth service every CES tool
      // depends on. The fail-open below already prevents the sign-out that
      // the retry was protecting against; the worst a single empty read now
      // costs is a Projects tab that needs a refresh.

      this.accessList.set(accessList || []);

      // Compare on a NORMALISED key, not raw equality. The auth API is not
      // consistent about separators — the same utility appears as
      // "User Access Control" and "User_Access_Control" depending on the
      // caller — and CES_WEB's dashboard already normalises for exactly this
      // reason (utilitiesMatch/normalizeUtilityKey). An exact-match check here
      // would lock every user out of the tool the moment the API returned the
      // other spelling, which is a far worse failure than the gap it closes.
      const norm = (v: unknown): string =>
        String(v ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const toolKeys = (accessList || [])
        .map((item: any) => norm(typeof item === 'string' ? item : item?.utility_name ?? item?.name))
        .filter(Boolean);

      // Deny only on a POSITIVE answer that the tool is absent.
      //
      // A still-empty list after the retry means the auth service could not
      // tell us anything, and signing someone out because a dependency was
      // briefly unhealthy is a worse failure than the gap this leaves. The
      // gap is also close to theoretical: a user with genuinely zero
      // utilities cannot reach this app from the dashboard in the first
      // place, since the dashboard builds its tiles from this same list.
      const listResolved = toolKeys.length > 0;
      const hasAccess = !requiredTool || !listResolved || toolKeys.includes(norm(requiredTool));

      if (!listResolved && requiredTool) {
        console.warn(
          '[Session] Access list came back empty twice — keeping the session rather than ' +
          'signing out on an inconclusive answer. The utility check for ' +
          `"${requiredTool}" did not run.`
        );
      }

      if (hasAccess) {
        this.session.set({ session_gid, email: user_email, user_gid: userGid });
      } else {
        this.session.set(null);
      }

      // Best-effort, non-fatal system-manager check.
      try {
        const isSysMgr = await withTimeout(
          this.checkPermission(session_gid, 'GIS System', '_list_user_projects'),
          8000
        );
        this.isSystemManager.set(isSysMgr);
      } catch {
        this.isSystemManager.set(false);
      }
    } catch (err) {
      console.error('[Session] Validation error (keeping optimistic session):', err);
      // Keep the optimistic session — don't clear it on a transient network error.
    } finally {
      this.loading.set(false);
      if (!this.isValid()) {
        this.redirectIfInvalidInProd();
      }
    }
  }

  /**
   * Wraps `POST /auth { function: "_check_function_permission", ... }`.
   * Tolerates multiple response shapes the auth API has used over time.
   */
  private async checkPermission(
    session_gid: string,
    utility: string,
    privilege: string
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.AUTH_API}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          function: '_check_function_permission',
          session_gid,
          utility,
          privilege,
        }),
      });
      if (!res.ok) return false;
      const data: any = await res.json();
      if (typeof data === 'boolean') return data;
      if (typeof data?.has_permission === 'boolean') return data.has_permission;
      if (typeof data?.permission === 'boolean') return data.permission;
      if (typeof data?.allowed === 'boolean') return data.allowed;
      if (data?.response === '_S') return true;
      if (data?.response === '_E') return false;
      return false;
    } catch (err) {
      console.warn('[Session] checkPermission error:', err);
      return false;
    }
  }

  /** Convenience getter — returns the cached user_gid or ''. */
  getUserGid(): string {
    return this.session()?.user_gid || '';
  }

  // ─── Database switcher ────────────────────────────────────────────────
  // Ported from CES_MODULES' navbar/session.service.ts — same three
  // endpoints, same session_gid contract, same confirm-before-reload logic.

  async fetchDatabases(): Promise<any[]> {
    const sess = this.session();
    if (!sess) return [];

    this.loadingDbs.set(true);
    try {
      const res = await fetch(`${this.AUTH_API}/auth/dbs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid }),
      });
      const data = await res.json();
      // API returns { response: "_S", db_list: [...] }
      const dbs = Array.isArray(data) ? data : (data?.db_list ?? data?.data ?? data?.dbs ?? []);
      this.databases.set(dbs);
      return dbs;
    } catch (err) {
      console.error('[Session] Failed to fetch databases:', err);
      return [];
    } finally {
      this.loadingDbs.set(false);
    }
  }

  /**
   * Which user accounts are actually linked/granted to a database — the
   * authoritative source CES_ACCESS_CONTROL's databases-page already uses
   * (user-session.ts's dbUsersList, same AUTH_API, same
   * `/auth/db/users/list` endpoint), ported here because the Stock Access
   * panel's own GIS-side lookup (StockAccessApiService.dbUsersList, hitting
   * `/admin/db-users` on the GIS API) was coming back empty for at least
   * one real org/database, leaving the Grant access modal with no one to
   * grant. Central-auth db-user linkage and GIS-side db-user linkage are
   * evidently not the same list — this is the one AC's own working "who's
   * linked to this db" screen relies on.
   */
  async dbUsersList(db_gid: string): Promise<any[]> {
    const sess = this.session();
    if (!sess || !db_gid) return [];
    try {
      const res = await fetch(`${this.AUTH_API}/auth/db/users/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid, db_gid }),
      });
      const data = await res.json();
      const list = data?.emails ?? data?.email_list ?? data?.users ?? data;
      const result = Array.isArray(list) ? list : [];
      // Temporary, loud diagnostic — the frontend port of this call
      // (matching AC's user-session.ts byte-for-byte: same URL, same
      // payload) is coming back empty against at least one real database,
      // and there's no way to tell from here whether that's a genuinely
      // empty result, a non-2xx response with a JSON error body (still
      // parses fine, still returns []), or something else. Remove once
      // the Grant modal's dropdown is confirmed working end-to-end.
      console.info('[Session] dbUsersList', db_gid, '-> status', res.status, 'raw:', data, '-> parsed', result.length, 'user(s)');
      return result;
    } catch (err) {
      console.error('[Session] dbUsersList failed for', db_gid, ':', err);
      return [];
    }
  }

  /**
   * Name-based fallback for the same "who's linked to this db" question —
   * AC's databases-page tries this when the gid-based lookup above throws
   * or the database has no gid yet. Needs the database's actual name (from
   * databases()/fetchDatabases(), NOT an org's UAC-side registered label —
   * those are different strings for the same database).
   */
  async checkDatabaseUsers(database: string): Promise<any[]> {
    const sess = this.session();
    if (!sess || !database) return [];
    try {
      const res = await fetch(`${this.AUTH_API}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ function: '_check_database_users', session_gid: sess.session_gid, database }),
      });
      const data = await res.json();
      const result = typeof data?.response === 'string' && data.response.startsWith('_S') ? (data.emails ?? []) : [];
      console.info('[Session] checkDatabaseUsers', database, '-> status', res.status, 'raw:', data, '-> parsed', result.length, 'user(s)'); // temporary, see dbUsersList
      return result;
    } catch (err) {
      console.error('[Session] checkDatabaseUsers failed for', database, ':', err);
      return [];
    }
  }

  /**
   * Every registered user in the system, system-wide — not scoped to any
   * one database's linkage. Ported from AC's users-page.ts (user-session.ts
   * fetchUsers(), same AUTH_API, `_list_users` RPC function). Used as a
   * last-resort catch-all: a grant's user_id can be a real, valid system
   * user who simply never showed up in any of the three narrower "linked to
   * this specific db" lookups above (dbUsersList x2, checkDatabaseUsers) —
   * confirmed live: grants existed for user_gids that stayed unresolved to
   * an email through all three, permanently showing as a bare UUID in
   * Users & their access. This is the same directory AC's own user
   * management screen is built on, so if a person is registered at all,
   * they're in here.
   */
  async listAllUsers(): Promise<any[]> {
    const sess = this.session();
    if (!sess) return [];
    try {
      const res = await fetch(`${this.AUTH_API}/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ function: '_list_users', session_gid: sess.session_gid }),
      });
      const data = await res.json();
      const result = typeof data?.response === 'string' && data.response.startsWith('_S') ? (data.user_list ?? []) : [];
      console.info('[Session] listAllUsers -> status', res.status, '->', Array.isArray(result) ? result.length : 0, 'user(s)'); // temporary, see dbUsersList
      return Array.isArray(result) ? result : [];
    } catch (err) {
      console.error('[Session] listAllUsers failed:', err);
      return [];
    }
  }

  // Note: an earlier version of this had a system-wide allUserEmails()
  // directory here for panels' email dropdowns. Replaced 2 Sep by
  // DbUsersService (services/db-users.service.ts) — every dropdown in this
  // app is meant to offer users linked to the CURRENTLY ACTIVE db, not the
  // full system-wide list, so that's what lives there now instead.

  private currentDbInflight: Promise<any> | null = null;

  /**
   * The active database, fetching it once if it has not been resolved yet.
   *
   * `currentDb` is NOT populated by validate() — the only thing that fetched
   * it on bootstrap was the navbar's own ngOnInit. Anything else that needed
   * the active db therefore raced a network call it did not start: page
   * components run their ngOnInit before that fetch resolves, read a null
   * currentDb, and (in DbUsersService's case) gave up permanently. That is
   * why the user/role lists came up empty after a database switch and only
   * filled in after a manual refresh — a refresh loses the same race just as
   * often, which is what made it look intermittent rather than broken.
   *
   * Callers await this instead of sampling the signal. Concurrent callers
   * share one in-flight request, so every panel calling it on init costs a
   * single fetch.
   */
  async ensureCurrentDb(): Promise<any> {
    const existing = this.currentDb();
    if (existing) return existing;
    if (this.currentDbInflight) return this.currentDbInflight;

    this.currentDbInflight = this.fetchCurrentDb().finally(() => {
      this.currentDbInflight = null;
    });
    return this.currentDbInflight;
  }

  async fetchCurrentDb(): Promise<any> {
    const sess = this.session();
    if (!sess) return null;

    try {
      const res = await fetch(`${this.AUTH_API}/auth/db/current`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid }),
      });
      const data = await res.json();
      this.currentDb.set(data);
      return data;
    } catch (err) {
      console.error('[Session] Failed to fetch current DB:', err);
      return null;
    }
  }

  /**
   * Flips the session's active DB, then polls /auth/db/current until the
   * backend confirms it — reloading before that confirmation lands the new
   * page against the OLD DB context (stale data), so callers must not
   * reload on a `false` return.
   */
  async setCurrentDb(db_gid: string): Promise<boolean> {
    const sess = this.session();
    if (!sess) return false;

    try {
      const res = await fetch(`${this.AUTH_API}/auth/db/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid, db_gid }),
      });
      await res.json();

      const POLL_INTERVAL_MS = 400;
      const MAX_WAIT_MS = 8000;
      const start = Date.now();
      while (Date.now() - start < MAX_WAIT_MS) {
        const current = await this.fetchCurrentDb();
        const liveDbGid = String(current?.db_gid ?? '').trim();
        if (liveDbGid === db_gid) return true;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      console.warn('[Session] DB switch confirmation timed out after', MAX_WAIT_MS, 'ms');
      return false;
    } catch (err) {
      console.error('[Session] Failed to set DB:', err);
      return false;
    }
  }

  private readonly privilegeCache = new Map<string, boolean>();

  /**
   * Checks an Auth-API privilege (e.g. `_manage_client_roles`/`_stock_admin`
   * — see STOCK_ROLES_API_HANDOVER.md) via `_check_function_permission`,
   * same mechanism `isSystemManager` already uses internally. Cached per
   * (utility, privilege) pair for the life of the session.
   */
  async hasPrivilege(privilege: string, utility: string = 'GIS System'): Promise<boolean> {
    const key = `${utility}::${privilege}`;
    if (this.privilegeCache.has(key)) return this.privilegeCache.get(key)!;

    const sess = this.session();
    if (!sess) return false;

    const result = await this.checkPermission(sess.session_gid, utility, privilege);
    this.privilegeCache.set(key, result);
    return result;
  }

  readCookie(name: string): string | null {
    const fromJsCookie = Cookies.get(name);
    if (fromJsCookie) return fromJsCookie;

    const prefix = `${name}=`;
    const match = document.cookie
      .split(';')
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith(prefix));
    return match ? decodeURIComponent(match.substring(prefix.length)) : null;
  }

  async logout(): Promise<void> {
    const sess = this.session();
    if (sess) {
      try {
        const service = new UserSessionService(sess.email, sess.session_gid);
        await service.logout();
      } catch (err) {
        console.warn('[Session] Logout call failed, clearing local session anyway:', err);
      }
    }
    Cookies.remove('session_gid');
    Cookies.remove('user_email');
    this.session.set(null);
    this.accessList.set([]);
    this.isSystemManager.set(false);
    this.privilegeCache.clear();
    this.redirectIfInvalidInProd();
  }

  private redirectIfInvalidInProd() {
    if (this.isProdHost() && !this.isValid()) {
      window.location.href = 'https://www.corelineengineering.com/Login';
    }
  }

  private isProdHost(): boolean {
    const host = window.location.hostname;
    return host.endsWith('.corelineengineering.com') || host === 'corelineengineering.com';
  }

  async fetchProfileImage(): Promise<string | null> {
    const sess = this.session();
    if (!sess) return null;

    try {
      const service = new UserSessionService(sess.email, sess.session_gid);
      const imageUrl = await service.fetchProfileImageURL();

      if (imageUrl) {
        this.profileImage.set(imageUrl);
        return imageUrl;
      }

      return null;
    } catch {
      return null;
    }
  }

  getInitials(): string {
    const email = this.session()?.email;
    if (!email) return '?';
    return email.charAt(0).toUpperCase();
  }
}
