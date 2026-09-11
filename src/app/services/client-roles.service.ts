import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from '../session/session.service';
import { ClientRole, UserRoleAssignment } from './roles.types';

/**
 * Role/privilege management against the CENTRAL auth API, scoped to a
 * database by name.
 *
 * Why this exists next to RolesApiService: the GIS API's `/roles/*` surface
 * (RolesApiService) is client-local and, in practice, was not pulling the
 * privilege catalogue through at all, and what it does return is not
 * db-specific. AC has always used these auth-API functions instead, and
 * they take a `db_name` - which is what actually makes a role's privilege
 * set per-database. Ported here so UAC and AC read and write the SAME
 * privilege data rather than two disagreeing views of it.
 *
 * Every call passes the ACTIVE database's name. A client admin therefore
 * only ever reads or edits their own company's role privileges.
 *
 * 11 Sep: this became the WHOLE role surface, not just the privilege editor.
 * Backend confirmed that every protected endpoint checks the Auth API's
 * roles (`check_function_permission` -> Auth API) and that nothing reads
 * the client-local `admin.client_*` tables the GIS `/roles/*` surface
 * writes. So roles listed, created, and assigned to users through
 * RolesApiService existed in UAC's UI and changed nobody's access. The
 * role list, role creation and user<->role assignment now go through here
 * too, mirroring what CES_ACCESS_CONTROL has always done. RolesApiService
 * is kept only for what has no Auth-API equivalent yet.
 *
 * Roles here have no gid - the Auth API keys them by (utility, name) per
 * database. `ClientRole.role_gid` is synthesised as `utility::name` so the
 * component and templates that track by gid keep working unchanged.
 */
@Injectable({ providedIn: 'root' })
export class ClientRolesService {
  private readonly session = inject(SessionService);
  private readonly AUTH_API = 'https://auth-api-frankfurt.onrender.com/auth';

  readonly loading = signal(false);

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

  /** Privilege entries come back as bare strings from some functions and as
   *  objects from others - same widened match AC's roles-page uses. */
  private name(p: any): string {
    return String(p?.privilege_name ?? p?.name ?? p?.privilege ?? p ?? '').trim();
  }

  /** The active database's NAME (not gid) - what these auth functions key
   *  on. Read live from the session, falling back to a gid->name lookup
   *  through the databases list when currentDb only carries a gid. */
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

  /** The whole privilege catalogue for a utility - the list to pick from. */
  async availablePrivileges(utility = 'GIS System'): Promise<string[]> {
    const data = await this.call({ function: '_available_privileges', utility });
    const list = this.ok(data) ? (data?.privilege_list ?? []) : [];
    return (Array.isArray(list) ? list : []).map((p) => this.name(p)).filter(Boolean);
  }

  /** Privileges currently ON a role, for this database. This is the call
   *  the GIS `/roles/*` surface has no equivalent for - it is what lets the
   *  privilege editor show real state instead of a blind action list. */
  async rolePrivileges(role: string, utility = 'GIS System'): Promise<string[]> {
    const db_name = await this.activeDbName();
    const payload: Record<string, any> = { function: '_check_role_privileges', utility, role };
    if (db_name) payload['db_name'] = db_name;
    const data = await this.call(payload);
    const list = this.ok(data) ? (data?.privilege_list ?? []) : [];
    return (Array.isArray(list) ? list : []).map((p) => this.name(p)).filter(Boolean);
  }

  /** Roles defined for a utility (name list). */
  async availableRoles(utility = 'GIS System'): Promise<string[]> {
    const data = await this.call({ function: '_available_roles', utility });
    const list = this.ok(data) ? (data?.role_list ?? []) : [];
    return (Array.isArray(list) ? list : [])
      .map((r: any) => String(r?.role_name ?? r?.name ?? r?.role ?? r ?? '').trim())
      .filter(Boolean);
  }

  async assignPrivilege(role: string, privilege: string, utility = 'GIS System'): Promise<boolean> {
    const db_name = await this.activeDbName();
    const payload: Record<string, any> = { function: '_assign_role_privilege', utility, role, privilege };
    if (db_name) payload['db_name'] = db_name;
    return this.ok(await this.call(payload));
  }

  async removePrivilege(role: string, privilege: string, utility = 'GIS System'): Promise<boolean> {
    const db_name = await this.activeDbName();
    const payload: Record<string, any> = { function: '_remove_role_privilege', utility, role, privilege };
    if (db_name) payload['db_name'] = db_name;
    return this.ok(await this.call(payload));
  }

  // ─── Roles (the enforced ones) ───────────────────────────────────────────

  /** Stable key for a role the Auth API identifies only by (utility, name). */
  static roleKey(utility: string, role: string): string {
    return `${String(utility ?? '').trim()}::${String(role ?? '').trim()}`;
  }

  /** Inverse of roleKey. */
  static parseRoleKey(key: string): { utility: string; role: string } {
    const i = String(key ?? '').indexOf('::');
    return i < 0
      ? { utility: 'GIS System', role: String(key ?? '') }
      : { utility: key.slice(0, i), role: key.slice(i + 2) };
  }

  /**
   * Every role on the active database across the given utilities, in the
   * `ClientRole` shape the access-control screen already renders. One
   * `_available_roles` call per utility; the auth function scopes to the
   * session's current database.
   */
  async listRoles(utilities: string[]): Promise<ClientRole[]> {
    const uniq = Array.from(new Set(utilities.map((u) => String(u ?? '').trim()).filter(Boolean)));
    const perUtility = await Promise.all(
      uniq.map(async (utility) => {
        try {
          const names = await this.availableRoles(utility);
          return names.map((role_name) => ({ utility_name: utility, role_name }));
        } catch (err) {
          console.warn('[ClientRoles] _available_roles failed for', utility, err);
          return [];
        }
      }),
    );
    return perUtility.flat().map((r) => ({
      pk: 0,
      role_name: r.role_name,
      role_gid: ClientRolesService.roleKey(r.utility_name, r.role_name),
      utility_name: r.utility_name,
      is_system: false,
      created_by: '',
      created_date: '',
    }));
  }

  /**
   * Create a role on the active database. This is a REST route on the
   * auth API (`/auth/role/create`), not a `function:` call - same route
   * CES_ACCESS_CONTROL's RoleService uses. Needs the db GID, not name.
   */
  async createRole(role: string, utility = 'GIS System'): Promise<boolean> {
    const role_name = String(role ?? '').trim();
    if (!role_name) throw new Error('Role name is required.');
    const db_gid = await this.activeDbGid();
    if (!db_gid) throw new Error('No active database.');
    const res = await fetch(`${this.AUTH_API}/role/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_gid: this.sessionGid, utility, role_name, db_gid }),
    });
    let data: any = null;
    try { data = await res.json(); } catch { data = null; }
    if (this.ok(data)) return true;
    if (typeof data === 'string') {
      const t = data.trim().toLowerCase();
      if (t.startsWith('_s') || t.includes('success')) return true;
    }
    const detail = data?.detail ?? data?.response ?? (typeof data === 'string' ? data : '') ?? '';
    throw new Error(String(detail || `Role create failed (${res.status}).`));
  }

  /** Emails holding a role on the active database. */
  async roleUsers(role: string, utility = 'GIS System'): Promise<string[]> {
    const db_name = await this.activeDbName();
    const payload: Record<string, any> = { function: '_check_role_users', utility, role };
    if (db_name) payload['db_name'] = db_name;
    const data = await this.call(payload);
    const list = this.ok(data) ? (data?.emails ?? data?.email_list ?? data?.users ?? []) : [];
    return (Array.isArray(list) ? list : [])
      .map((e: any) => String(e?.email ?? e?.user_email ?? e ?? '').trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Every (user, role) pair on the active database, built from one
   * `_check_role_users` per role. `user_gid` carries the EMAIL - the auth
   * API has no user gid in this surface, and email is what every join in
   * the screen actually needs.
   */
  async listAssignments(roles: ClientRole[]): Promise<UserRoleAssignment[]> {
    const perRole = await Promise.all(
      roles.map(async (r) => {
        try {
          const emails = await this.roleUsers(r.role_name, r.utility_name);
          return emails.map((email) => ({
            user_gid: email,
            user_email: email,
            role_gid: r.role_gid,
            role_name: r.role_name,
            utility_name: r.utility_name,
            assigned_by: '',
            assigned_date: '',
          }));
        } catch (err) {
          console.warn('[ClientRoles] _check_role_users failed for', r.role_gid, err);
          return [];
        }
      }),
    );
    return perRole.flat();
  }

  async assignUserRole(email: string, role: string, utility = 'GIS System'): Promise<boolean> {
    const db_name = await this.activeDbName();
    const payload: Record<string, any> = {
      function: '_assign_user_role',
      email: String(email ?? '').trim(),
      utility,
      role,
    };
    if (db_name) payload['db_name'] = db_name;
    return this.ok(await this.call(payload));
  }

  async removeUserRole(email: string, role: string, utility = 'GIS System'): Promise<boolean> {
    const db_name = await this.activeDbName();
    const payload: Record<string, any> = {
      function: '_remove_user_role',
      email: String(email ?? '').trim(),
      utility,
      role,
    };
    if (db_name) payload['db_name'] = db_name;
    return this.ok(await this.call(payload));
  }

  /** The real check - what every protected endpoint asks. Uncached. */
  async checkFunctionPermission(privilege: string, utility = 'GIS System'): Promise<boolean> {
    const data = await this.call({ function: '_check_function_permission', utility, privilege });
    if (typeof data === 'boolean') return data;
    if (typeof data?.has_permission === 'boolean') return data.has_permission;
    if (typeof data?.permission === 'boolean') return data.permission;
    if (typeof data?.allowed === 'boolean') return data.allowed;
    return this.ok(data);
  }

  /** The active database's GID - what `/role/create` keys on. */
  private async activeDbGid(): Promise<string> {
    const pick = (db: any) => String(db?.db_gid ?? db?.global_id ?? db?.gid ?? '').trim();
    let gid = pick(this.session.currentDb());
    if (gid) return gid;
    try {
      gid = pick(await this.session.ensureCurrentDb());
    } catch {
      /* fall through */
    }
    return gid;
  }
}
