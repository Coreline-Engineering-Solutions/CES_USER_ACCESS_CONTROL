import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from '../session/session.service';

export interface NewUserDraft {
  email: string;
  first_name: string;
  last_name: string;
  username: string;
  phone: string;
}

/**
 * Creating users and linking them to a database, from UAC.
 *
 * Ported from CES_ACCESS_CONTROL's user-session.ts (registerUser /
 * dbUserAssign / dbUserRemove) — same central AUTH_API, same payloads, so
 * a user created here is the same kind of record AC's own Users page
 * creates, not a parallel one.
 *
 * The whole point of having this in UAC as well as AC: a client's own admin
 * gets their admin role FROM AC, then does their own user management here
 * without needing access to AC itself. Two rules follow from that, and both
 * are enforced by the callers of this service rather than left to the admin:
 *  1. A newly created user is ALWAYS linked to the currently-active
 *     database (the company the admin is actually working in) — never
 *     to an arbitrary db they typed. See linkToActiveDb().
 *  2. Roles come after — create + link the user first, then assign roles
 *     from the client-role list (RolesApiService).
 */
@Injectable({ providedIn: 'root' })
export class AdminUsersService {
  private readonly session = inject(SessionService);
  private readonly AUTH_API = 'https://auth-api-frankfurt.onrender.com';

  readonly working = signal(false);

  private get sessionGid(): string {
    return this.session.session()?.session_gid ?? this.session.readCookie('session_gid') ?? '';
  }

  /** Auth API returns `_S`-prefixed strings on success, sometimes as a bare
   *  string rather than an object — same tolerance AC's isAssignSuccess has. */
  private isSuccess(data: any): boolean {
    if (typeof data === 'string') return data.startsWith('_S');
    const r = data?.response;
    return typeof r === 'string' && r.startsWith('_S');
  }

  private async authPost(body: Record<string, any>): Promise<any> {
    const res = await fetch(`${this.AUTH_API}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_gid: this.sessionGid, ...body }),
    });
    return res.json();
  }

  /**
   * Create a user on the central auth system.
   *
   * AC tries several function names in order because the auth API's
   * registration RPC has been spelled differently across versions and the
   * failing ones just return a non-_S response rather than erroring. Ported
   * as-is — dropping the fallbacks here would make UAC fail on exactly the
   * deployments where AC still works.
   */
  async createUser(draft: NewUserDraft): Promise<{ ok: boolean; detail?: string }> {
    const email = draft.email.trim();
    if (!email) return { ok: false, detail: 'Email is required.' };

    const base = {
      email,
      first_name: draft.first_name.trim(),
      last_name: draft.last_name.trim(),
      username: draft.username.trim(),
      phone: draft.phone.trim(),
    };

    let lastDetail = '';
    for (const fn of ['_register_user', '_register', '_add_user', '_create_user']) {
      try {
        const data = await this.authPost({ ...base, function: fn });
        if (this.isSuccess(data)) return { ok: true };
        lastDetail = String(data?.detail ?? data?.response ?? '').trim() || lastDetail;
      } catch (err: any) {
        lastDetail = err?.message ?? lastDetail;
      }
    }
    return { ok: false, detail: lastDetail || 'The auth API did not accept the registration.' };
  }

  /**
   * Link a user to a database by gid. `/auth/db/user/assign` — the same
   * endpoint AC's databases page uses.
   */
  async assignUserToDb(email: string, db_gid: string): Promise<boolean> {
    if (!email || !db_gid) return false;
    try {
      const res = await fetch(`${this.AUTH_API}/auth/db/user/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: this.sessionGid, email: email.trim(), db_gid }),
      });
      return this.isSuccess(await res.json());
    } catch (err) {
      console.error('[AdminUsers] assignUserToDb failed:', err);
      return false;
    }
  }

  async removeUserFromDb(email: string, db_gid: string): Promise<boolean> {
    if (!email || !db_gid) return false;
    try {
      const res = await fetch(`${this.AUTH_API}/auth/db/user/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_gid: this.sessionGid, email: email.trim(), db_gid }),
      });
      return this.isSuccess(await res.json());
    } catch (err) {
      console.error('[AdminUsers] removeUserFromDb failed:', err);
      return false;
    }
  }

  /** The db_gid of the database this session is currently pointed at — the
   *  ONLY db a UAC-created user is ever linked to. Re-read live rather than
   *  trusted from page-load state, same reasoning as the Stock panel's
   *  org-create flow. */
  async activeDbGid(): Promise<string> {
    const cached = this.session.currentDb();
    const fromCache = String(cached?.db_gid ?? cached?.global_id ?? cached?.gid ?? '').trim();
    if (fromCache) return fromCache;
    try {
      const db = await this.session.fetchCurrentDb();
      return String(db?.db_gid ?? db?.global_id ?? db?.gid ?? '').trim();
    } catch {
      return '';
    }
  }
}
