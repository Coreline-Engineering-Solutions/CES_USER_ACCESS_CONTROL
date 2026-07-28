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
