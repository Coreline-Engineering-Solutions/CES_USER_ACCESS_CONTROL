import { Injectable, inject, signal } from '@angular/core';
import { SessionService } from '../session/session.service';

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
        db = await this.session.fetchCurrentDb();
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
}
