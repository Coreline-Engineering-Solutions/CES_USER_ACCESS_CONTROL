import { Injectable, computed, signal } from '@angular/core';
import Cookies from 'js-cookie';
import { UserSessionService } from '../../classes/ClassesAuth';
import { cesAppUrl } from '../ces-hosts';
import { environment } from '../../environments/environment';

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
   * Switch the session's active database. Returns true only once BOTH the
   * Auth API and the GIS API agree the switch has landed.
   *
   * Why both: the GIS API caches session→db_gid for 60s
   * (DB_GID_CACHE_TTL_SECONDS, auth_client.py:89). Switching via the Auth
   * API alone leaves the GIS API resolving the OLD client for up to a minute
   * — every /roles/*, /stock/*, /modules/* call in that window reads the
   * previous client's tables under the new client's label. Confirming the
   * Auth side (the old behaviour) proves nothing about that. So we also poll
   * the GIS API's own /admin/db/current until it reports the new db_gid.
   *
   * Ordering matters for isolation:
   *   1. clearPrivileges() FIRST — nothing may serve the old set during the
   *      transition. hasPrivilege() answers false until the new set lands.
   *   2. switch, confirm Auth, confirm GIS.
   *   3. only then set currentDb and prefetch the new db's privileges.
   * If confirmation times out we return false, leave currentDb untouched and
   * privileges empty — the old client's set is never served under the new
   * label. Callers must not reload on false.
   *
   * SWITCH_ENDPOINT: tiaan's guidance is to route the switch through the GIS
   * API's cache-invalidating endpoint so step 2 is instant rather than
   * eventual. Which endpoint/body is pending his confirmation (cutover thread
   * c5013ced). Until then this uses the Auth API and relies on the GIS-side
   * poll below, which is correct either way — just slower on a cold cache.
   */
  async setCurrentDb(db_gid: string): Promise<boolean> {
    const sess = this.session();
    if (!sess) return false;

    this.clearPrivileges();

    try {
      const setAt = Date.now();
      const res = await fetch(`${this.AUTH_API}/auth/db/set`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid, db_gid }),
      });
      await res.json();

      const POLL_INTERVAL_MS = 400;
      const AUTH_MAX_WAIT_MS = 8000;
      const GIS_MAX_WAIT_MS = 15000;

      // 1. Auth API sees it.
      let start = Date.now();
      let authOk = false;
      while (Date.now() - start < AUTH_MAX_WAIT_MS) {
        const current = await this.fetchCurrentDbRaw();
        if (String(current?.db_gid ?? '').trim() === db_gid) { authOk = true; break; }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!authOk) {
        console.warn('[Session] DB switch: Auth API never confirmed', db_gid, 'within', AUTH_MAX_WAIT_MS, 'ms');
        return false;
      }

      // 2. GIS API sees it too — this is the one that actually gates data.
      //    /auth/db/set does NOT touch the GIS API's 60 s session→db cache
      //    (tiaan, 16 Sep). Preferred: ask it to drop the cache, then poll
      //    its own view. Neither endpoint exists yet → wait the TTL out.
      const invalidated = await this.invalidateGisDbCache();
      start = Date.now();
      let gisOk = false;
      while (Date.now() - start < GIS_MAX_WAIT_MS) {
        const gisDb = await this.fetchGisCurrentDbGid();
        if (gisDb === null) {
          if (invalidated) { gisOk = true; break; } // cache dropped server-side; next call re-resolves
          const remaining = SessionService.GIS_DB_CACHE_TTL_MS - (Date.now() - setAt);
          if (remaining > 0) {
            console.warn('[Session] DB switch: GIS API has no /admin/db/current or /admin/db/invalidate-cache yet — waiting out its', Math.ceil(remaining / 1000), 's cache TTL before proceeding');
            await new Promise((r) => setTimeout(r, remaining));
          }
          gisOk = true;
          break;
        }
        if (gisDb === db_gid) { gisOk = true; break; }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!gisOk) {
        console.warn('[Session] DB switch: GIS API still resolving the previous db after', GIS_MAX_WAIT_MS, 'ms — refusing to proceed');
        return false;
      }
      console.log('[Session] DB switch confirmed after', Date.now() - setAt, 'ms ->', db_gid);

      // 3. Commit locally and warm the new db's privileges.
      await this.fetchCurrentDb();
      void this.ensurePrivileges();
      return true;
    } catch (err) {
      console.error('[Session] Failed to set DB:', err);
      return false;
    }
  }

  /** /auth/db/current WITHOUT writing currentDb — used while confirming a
   *  switch so a half-landed state never becomes the app's active db. */
  private async fetchCurrentDbRaw(): Promise<any> {
    const sess = this.session();
    if (!sess) return null;
    try {
      const res = await fetch(`${this.AUTH_API}/auth/db/current`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid }),
      });
      return await res.json();
    } catch { return null; }
  }

  /** The db_gid the GIS API currently resolves this session to — its own
   *  view, which can lag the Auth API's by up to 60s. '' on failure;
   *  `null` when the GIS API doesn't expose the endpoint at all (404),
   *  which is the case until tiaan's one-liner ships. */
  private async fetchGisCurrentDbGid(): Promise<string | null> {
    const sess = this.session();
    if (!sess) return '';
    try {
      const res = await fetch(`${environment.apiBaseUrl}/admin/db/current`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid }),
      });
      if (res.status === 404) return null;
      if (!res.ok) return '';
      const data: any = await res.json();
      return String(data?.db_gid ?? data?.data?.db_gid ?? '').trim();
    } catch { return ''; }
  }

  /** Ask the GIS API to drop its cached session→db_gid (proposed
   *  `POST /admin/db/invalidate-cache`). true = it did; false = endpoint
   *  missing or failed, so the 60 s TTL must be waited out instead. */
  private async invalidateGisDbCache(): Promise<boolean> {
    const sess = this.session();
    if (!sess) return false;
    try {
      const res = await fetch(`${environment.apiBaseUrl}/admin/db/invalidate-cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid }),
      });
      return res.ok;
    } catch { return false; }
  }

  /** GIS API cache TTL (`DB_GID_CACHE_TTL_SECONDS`, auth_client.py) plus a
   *  margin. Waited out only when the GIS API can neither confirm nor
   *  invalidate — slow, but never serves the previous client's data under
   *  the new label. */
  private static readonly GIS_DB_CACHE_TTL_MS = 60_000 + 2_000;

  // ─── Privileges ────────────────────────────────────────────────────────
  //
  // ISOLATION INVARIANT — this is the cross-client exposure boundary. Do not
  // weaken it. (Cutover thread 8ba7fa15; docs://gis_api/client-roles-and-profile.md)
  //
  //  1. Client-local privileges are populated ONLY from POST /roles/my-privileges.
  //     Its body is { session_gid } and nothing else — the GIS API resolves the
  //     client DB from the session server-side. There is no way to read another
  //     client's set with a valid session. Confirmed by tiaan 16 Sep.
  //  2. The set is stored WITH the db_gid it was fetched for. hasPrivilege()
  //     refuses to answer from a set whose db_gid !== the current db — it
  //     re-fetches instead of guessing.
  //  3. Dropped on setCurrentDb() and logout().
  //  4. FAIL-CLOSED. An empty set (AC schema not seeded on that client DB)
  //     means NO privileges. The backend fails open there by design for
  //     backward compat; the UI deliberately does not — a locked unseeded
  //     client is the correct signal that a pre-cutover step was skipped.
  //     Confirmed by tiaan 16 Sep.
  //  5. Only the bootstrap privileges that remain in the central Auth API go
  //     through _check_function_permission. Everything else is client-local.
  //
  // The previous cache was keyed `utility::privilege` with no db_gid and was
  // never cleared on a DB switch — Manager on client A, switch to client B as
  // a Viewer, and A's cached `_stock_admin=true` drew admin controls over B's
  // data. That was live before this change.

  /** Bootstrap privileges that stay in the central Auth API (session-level,
   *  not per-client-DB). `_assign_db_admin` is planned but not built yet. */
  private static readonly AUTH_API_PRIVILEGES: ReadonlySet<string> = new Set([
    '_manage_client_roles',
    '_list_user_projects',
    '_assign_db_admin',
  ]);

  private privSet: { sessionGid: string; dbGid: string; privileges: ReadonlySet<string>; fetchedAt: number } | null = null;
  private privInflight: Promise<void> | null = null;
  /** Per-(utility, privilege) cache for the Auth-API bootstrap checks only. */
  private readonly authPrivCache = new Map<string, boolean>();

  /** True when the active db returned an EMPTY privilege set — i.e. the AC
   *  schema isn't seeded there. UI should surface this plainly (fail-closed
   *  means everything privileged is hidden) rather than looking broken. */
  readonly privilegesEmpty = signal<boolean>(false);
  /** db_gid the current privilege set belongs to, or '' — for diagnostics. */
  readonly privilegesDbGid = signal<string>('');

  /**
   * Does the current user hold `privilege` on the ACTIVE client database?
   *
   * Client-local privileges: a set lookup against /roles/my-privileges for
   * the current db (fetched on demand, single-flight, discarded on switch).
   * Bootstrap Auth-API privileges: `_check_function_permission` as before.
   * `utility` only applies to the latter; client-local names are global.
   */
  async hasPrivilege(privilege: string, utility: string = 'GIS System'): Promise<boolean> {
    const sess = this.session();
    if (!sess) return false;

    if (SessionService.AUTH_API_PRIVILEGES.has(privilege)) {
      const key = `${sess.session_gid}::${utility}::${privilege}`;
      if (this.authPrivCache.has(key)) return this.authPrivCache.get(key)!;
      const result = await this.checkPermission(sess.session_gid, utility, privilege);
      this.authPrivCache.set(key, result);
      return result;
    }

    const set = await this.ensurePrivileges();
    return set ? set.has(privilege) : false; // null = no active db / fetch failed → closed
  }

  /** Synchronous read of the CURRENT db's set, for templates that can't
   *  await. Returns false if the set isn't loaded or belongs to another db —
   *  never a stale answer. Call ensurePrivileges() once on boot / after a
   *  switch so this is populated. */
  hasPrivilegeSync(privilege: string): boolean {
    const dbGid = String(this.currentDb()?.db_gid ?? '').trim();
    const sess = this.session();
    if (!sess || !dbGid || !this.privSet) return false;
    if (this.privSet.sessionGid !== sess.session_gid || this.privSet.dbGid !== dbGid) return false;
    return this.privSet.privileges.has(privilege);
  }

  /** The active db's privilege set, fetching it if missing or stale. `null`
   *  when there is no active db or the fetch failed (fail-closed). */
  async ensurePrivileges(): Promise<ReadonlySet<string> | null> {
    const db = await this.ensureCurrentDb();
    const dbGid = String(db?.db_gid ?? '').trim();
    if (!dbGid) return null;

    const sess = this.session();
    if (!sess) return null;
    const fresh = () => !!this.privSet && this.privSet.sessionGid === sess.session_gid && this.privSet.dbGid === dbGid;
    if (fresh()) return this.privSet!.privileges;

    if (!this.privInflight) {
      this.privInflight = this.fetchPrivileges(dbGid).finally(() => { this.privInflight = null; });
    }
    await this.privInflight;
    return fresh() ? this.privSet!.privileges : null;
  }

  private async fetchPrivileges(dbGid: string): Promise<void> {
    const sess = this.session();
    if (!sess) return;
    try {
      const res = await fetch(`${environment.apiBaseUrl}/roles/my-privileges`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: sess.session_gid }),
      });
      if (!res.ok) {
        console.warn('[Session] /roles/my-privileges ->', res.status, '— privileges stay closed');
        return;
      }
      const data: any = await res.json();
      const list: unknown = data?.privileges;
      const privs = new Set<string>(Array.isArray(list) ? list.map(String) : []);

      // The db may have moved while this was in flight. A set that belongs
      // to a db we're no longer on is exactly the cross-client leak — drop it.
      const nowDb = String(this.currentDb()?.db_gid ?? '').trim();
      if (nowDb !== dbGid) {
        console.warn('[Session] privileges fetched for', dbGid, 'but active db is now', nowDb, '— discarded');
        return;
      }
      if (this.session()?.session_gid !== sess.session_gid) { console.warn('[Session] privileges fetched but session changed — discarded'); return; }
      this.privSet = { sessionGid: sess.session_gid, dbGid, privileges: privs, fetchedAt: Date.now() };
      this.privilegesDbGid.set(dbGid);
      this.privilegesEmpty.set(privs.size === 0);
    } catch (err) {
      console.error('[Session] /roles/my-privileges failed — privileges stay closed:', err);
    }
  }

  /** Drop every cached privilege answer. Called on db switch and logout. */
  clearPrivileges(): void {
    this.privSet = null;
    this.privInflight = null;
    this.authPrivCache.clear();
    this.privilegesEmpty.set(false);
    this.privilegesDbGid.set('');
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
    this.clearPrivileges();
    this.redirectIfInvalidInProd();
  }

  private redirectIfInvalidInProd() {
    // /DashBoard, not /Login directly — matches GIS/AC's pattern. It's
    // gated by CES_WEB's own authGuard, which bounces to /Login only if
    // the user isn't logged in centrally at all; if they *are* logged in
    // but just lack this app's access, they land on their dashboard
    // instead of being shown a login form while already signed in.
    if (this.isProdHost() && !this.isValid()) {
      window.location.href = cesAppUrl('hub', '/Login');
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
