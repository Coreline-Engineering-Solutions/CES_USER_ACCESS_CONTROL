import { Injectable, inject } from '@angular/core';
import { SessionService } from '../session/session.service';

/**
 * READ-ONLY view of the central Auth API's role model — the "platform" store.
 *
 * Under the access-control cutover (thread 8ba7fa15) the Client Portal
 * manages CLIENT-LOCAL roles (`ClientRolesService`, the GIS API `/roles/*`
 * surface on the client's own database). The Auth API's roles are the
 * platform's standard set — seeded and maintained by the platform, not by a
 * client admin — and while `USE_CLIENT_PERMISSIONS` runs in dual-check mode
 * a privilege must be in BOTH stores for the API to allow it.
 *
 * So this app never WRITES the platform store any more (that is the Admin
 * Portal's "Platform role" section, and the standard-roles seed). It reads
 * it for exactly two things:
 *   1. the privilege editor's ceiling indicator — "this privilege is on your
 *      client role but the platform role doesn't carry it, so it won't work
 *      until the platform role is seeded";
 *   2. the permission-check tool, which shows both stores' answers side by
 *      side so an operator can tell which one is saying no.
 *
 * Every write method that used to live here was removed deliberately. Do not
 * add them back — a client admin editing platform roles is what the cutover
 * exists to stop.
 */
@Injectable({ providedIn: 'root' })
export class PlatformRolesService {
  private readonly session = inject(SessionService);
  private readonly AUTH_API = 'https://auth-api-frankfurt.onrender.com/auth';

  private get sessionGid(): string {
    return this.session.session()?.session_gid ?? this.session.readCookie('session_gid') ?? '';
  }

  private async call(body: Record<string, any>): Promise<any> {
    const res = await fetch(this.AUTH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_gid: this.sessionGid, ...body }),
    });
    return res.json();
  }

  private ok(data: any): boolean {
    if (typeof data === 'string') return data.startsWith('_S');
    const r = data?.response;
    return typeof r === 'string' && r.startsWith('_S');
  }

  private name(p: any): string {
    return String(p?.privilege_name ?? p?.name ?? p?.privilege ?? p ?? '').trim();
  }

  /** The active database's NAME (not gid) — what the Auth functions key on. */
  async activeDbName(): Promise<string> {
    const pick = (db: any): string =>
      String(db?.name ?? db?.db_name ?? db?.database_name ?? db?.database ?? '').trim();

    let db = this.session.currentDb();
    let name = pick(db);
    if (!name) {
      try {
        db = await this.session.ensureCurrentDb();
        name = pick(db);
      } catch {
        /* fall through to the gid lookup below */
      }
    }
    if (name) return name;

    const gid = String(db?.db_gid ?? db?.global_id ?? db?.gid ?? '').trim();
    if (!gid) return '';
    try {
      const all = this.session.databases().length ? this.session.databases() : await this.session.fetchDatabases();
      const hit = (all ?? []).find(
        (d: any) => String(d?.db_gid ?? d?.global_id ?? d?.gid ?? '').trim() === gid,
      );
      return pick(hit);
    } catch {
      return '';
    }
  }

  /**
   * Privileges the PLATFORM role of this name carries on the active
   * database — the ceiling a client-local role of the same name sits under
   * while dual-check is on. `null` when the Auth API could not answer (as
   * opposed to an empty set, which is a real answer): callers must show
   * "unknown", never "none".
   */
  async rolePrivileges(roleName: string, utility = 'GIS System'): Promise<Set<string> | null> {
    try {
      const db_name = await this.activeDbName();
      const payload: Record<string, any> = { function: '_check_role_privileges', utility, role: roleName };
      if (db_name) payload['db_name'] = db_name;
      const data = await this.call(payload);
      if (!this.ok(data)) return null;
      const list = data?.privilege_list ?? [];
      return new Set((Array.isArray(list) ? list : []).map((p) => this.name(p)).filter(Boolean));
    } catch (err) {
      console.warn('[PlatformRoles] _check_role_privileges failed for', roleName, err);
      return null;
    }
  }

  /** `_check_function_permission` — the Auth-side half of dual-check. */
  async checkFunctionPermission(privilege: string, utility = 'GIS System'): Promise<boolean> {
    const data = await this.call({ function: '_check_function_permission', utility, privilege });
    if (typeof data === 'boolean') return data;
    if (typeof data?.has_permission === 'boolean') return data.has_permission;
    if (typeof data?.permission === 'boolean') return data.permission;
    if (typeof data?.allowed === 'boolean') return data.allowed;
    return this.ok(data);
  }
}
