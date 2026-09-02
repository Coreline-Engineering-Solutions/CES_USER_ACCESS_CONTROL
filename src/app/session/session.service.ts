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

      const accessList = await withTimeout(service.fetchAccessList(), 20000);
      this.accessList.set(accessList || []);

      const toolNames = (accessList || []).map((item: any) => item?.utility_name).filter(Boolean);
      const hasAccess = !requiredTool || toolNames.includes(requiredTool);

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
