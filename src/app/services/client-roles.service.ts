import { Injectable, inject, signal } from '@angular/core';
import { RolesApiService } from './roles-api.service';
import { ClientPrivilege, ClientRole, UserRoleAssignment } from './roles.types';

/**
 * CLIENT-LOCAL role management — the GIS API `/roles/*` surface, backed by
 * `admin.client_roles / client_privileges / client_role_privileges /
 * client_user_roles` in the client's OWN database.
 *
 * This is the store `/roles/my-privileges` reads and every privilege gate
 * in every CES app resolves against. It is the Client Portal's management
 * surface for the access-control cutover (thread 8ba7fa15; tiaan, 16 Sep:
 * "the Client Portal becomes the management surface for client-local roles,
 * and the Auth API role section on the Users page stays as the
 * bootstrap-only surface").
 *
 * Every client database has its OWN Manager / Planner / Viewer rows with
 * their OWN privilege links, so two clients' "Manager" roles can differ —
 * that is the point. Roles and privileges are addressed by gid, never by
 * name (tiaan: Fibretime and frogfoot carry duplicate role names today).
 *
 * Scoping is structural: the server resolves the client database from the
 * session, and no call here carries a db_gid. There is no way to read or
 * write another client's roles through this service with a valid session.
 *
 * This service was the AUTH-API-backed one until 21 Sep (a deliberate
 * 11 Sep decision, correct when the backend enforced only Auth roles). With
 * `USE_CLIENT_PERMISSIONS` on, the two stores diverged: edits here changed
 * the Auth role while the gates read client-local. The Auth-API READ side
 * now lives in `PlatformRolesService`; its writes were removed on purpose.
 */
@Injectable({ providedIn: 'root' })
export class ClientRolesService {
  private readonly api = inject(RolesApiService);

  readonly loading = signal(false);

  /** Last-loaded role list, so callers that only hold a gid can resolve
   *  name/utility without another round trip. */
  private roleCache: ClientRole[] = [];
  /** Privilege catalogue, name <-> gid. The `/roles/privileges/assign|revoke`
   *  calls take gids; the UI (and the standard-role bundles) speak names. */
  private privByName = new Map<string, ClientPrivilege>();
  private privByGid = new Map<string, ClientPrivilege>();

  private ok(data: any): boolean {
    if (data === true) return true;
    const r = data?.response;
    if (typeof r === 'string') return r.startsWith('_S');
    return data?.success === true;
  }

  private static key(name: string): string {
    return String(name ?? '').trim().toLowerCase();
  }

  // ─── Roles ──────────────────────────────────────────────────────────────

  /** Every client-local role on the active database, all utilities. */
  async listRoles(): Promise<ClientRole[]> {
    const res = await this.api.rolesList();
    const rows = (Array.isArray(res) ? res : (res as any)?.roles) ?? [];
    const roles: ClientRole[] = (rows as any[])
      .filter((r) => r && r.role_gid && r.role_name)
      .map((r) => ({
        pk: Number(r.pk ?? 0),
        role_name: String(r.role_name).trim(),
        role_gid: String(r.role_gid),
        utility_name: String(r.utility_name ?? '').trim(),
        is_system: !!r.is_system,
        created_by: String(r.created_by ?? ''),
        created_date: String(r.created_date ?? ''),
      }))
      .sort((a, b) => a.role_name.localeCompare(b.role_name));
    this.roleCache = roles;
    return roles;
  }

  /** From the last `listRoles()` — refreshes the list if the gid is unknown. */
  async roleByGid(role_gid: string): Promise<ClientRole | null> {
    let hit = this.roleCache.find((r) => r.role_gid === role_gid) ?? null;
    if (!hit) {
      await this.listRoles();
      hit = this.roleCache.find((r) => r.role_gid === role_gid) ?? null;
    }
    return hit;
  }

  /** Case-insensitive name + utility match against the last list. `null`
   *  when missing OR duplicated — a duplicate must never be picked blind. */
  findRole(role_name: string, utility_name: string): ClientRole | null {
    const n = ClientRolesService.key(role_name);
    const u = ClientRolesService.key(utility_name);
    const hits = this.roleCache.filter(
      (r) => ClientRolesService.key(r.role_name) === n && ClientRolesService.key(r.utility_name) === u,
    );
    return hits.length === 1 ? hits[0] : null;
  }

  /** Throws with the server's detail on failure so the caller can show it. */
  async createRole(role_name: string, utility_name = 'GIS System', is_system = false): Promise<ClientRole> {
    const res: any = await this.api.roleCreate({ role_name, utility_name, is_system });
    if (!this.ok(res) && !res?.role_gid) {
      throw new Error(res?.detail ?? res?.message ?? 'The API did not confirm the role was created.');
    }
    await this.listRoles();
    const created = res?.role_gid
      ? this.roleCache.find((r) => r.role_gid === String(res.role_gid))
      : this.findRole(role_name, utility_name);
    if (!created) throw new Error('Role created but not found on re-read — refresh and try again.');
    return created;
  }

  async deleteRole(role: ClientRole): Promise<boolean> {
    const res = await this.api.roleDelete(role.role_gid);
    const ok = this.ok(res);
    if (ok) this.roleCache = this.roleCache.filter((r) => r.role_gid !== role.role_gid);
    return ok;
  }

  // ─── Privileges ─────────────────────────────────────────────────────────

  /**
   * The whole privilege catalogue on this database, as NAMES. Loads (and
   * caches) the name<->gid maps every write below needs. `utility` narrows
   * the returned names; the maps always hold everything.
   */
  async availablePrivileges(utility?: string): Promise<string[]> {
    const res = await this.api.privilegesList();
    const rows = (Array.isArray(res) ? res : (res as any)?.privileges) ?? [];
    this.privByName.clear();
    this.privByGid.clear();
    const all: ClientPrivilege[] = [];
    for (const p of rows as any[]) {
      if (!p?.privilege_gid || !p?.privilege_name) continue;
      const cp: ClientPrivilege = {
        pk: Number(p.pk ?? 0),
        privilege_name: String(p.privilege_name).trim(),
        privilege_gid: String(p.privilege_gid),
        utility_name: String(p.utility_name ?? '').trim(),
      };
      // First one wins on a duplicate NAME — the catalogue has carried
      // repeats before (Auth API: 144 rows / 136 names); one gid per name
      // is what the editor needs.
      if (!this.privByName.has(ClientRolesService.key(cp.privilege_name))) {
        this.privByName.set(ClientRolesService.key(cp.privilege_name), cp);
      }
      this.privByGid.set(cp.privilege_gid, cp);
      all.push(cp);
    }
    const u = utility ? ClientRolesService.key(utility) : '';
    const picked = u ? all.filter((p) => ClientRolesService.key(p.utility_name) === u) : all;
    // A catalogue whose rows don't carry the asked-for utility_name (or carry
    // none) is still the catalogue — don't return nothing on a label mismatch.
    const src = picked.length ? picked : all;
    return Array.from(new Set(src.map((p) => p.privilege_name))).sort();
  }

  private async privilegeGid(name: string): Promise<string | null> {
    if (this.privByName.size === 0) await this.availablePrivileges();
    return this.privByName.get(ClientRolesService.key(name))?.privilege_gid ?? null;
  }

  /**
   * Privileges linked to ONE role, as names. Uses the `role_gid` filter on
   * `/roles/privileges/list` (API 91ce046, 16 Sep) and trusts the answer
   * ONLY when the server echoes the gid back — an older API returns the
   * whole catalogue for this call, which would read as "this role has
   * everything". Throws in that case rather than lie.
   */
  async rolePrivileges(role: ClientRole): Promise<string[]> {
    const res: any = await this.api.privilegesListForRole(role.role_gid);
    if (String(res?.role_gid ?? '') !== role.role_gid) {
      throw new Error('This API build cannot report a single role\'s privileges (no role_gid echo) — it needs the 16 Sep /roles/privileges/list change.');
    }
    if (this.privByName.size === 0) await this.availablePrivileges();
    const rows = (Array.isArray(res?.privileges) ? res.privileges : []) as any[];
    return rows
      .map((p) => String(p?.privilege_name ?? this.privByGid.get(String(p?.privilege_gid ?? ''))?.privilege_name ?? '').trim())
      .filter(Boolean);
  }

  async assignPrivilege(role: ClientRole, privilege_name: string): Promise<boolean> {
    const privilege_gid = await this.privilegeGid(privilege_name);
    if (!privilege_gid) {
      console.warn('[ClientRoles] no client-local privilege named', privilege_name, '— not on this database\'s catalogue');
      return false;
    }
    return this.ok(await this.api.privilegeAssign({ role_gid: role.role_gid, privilege_gid }));
  }

  async removePrivilege(role: ClientRole, privilege_name: string): Promise<boolean> {
    const privilege_gid = await this.privilegeGid(privilege_name);
    if (!privilege_gid) return false;
    return this.ok(await this.api.privilegeRevoke({ role_gid: role.role_gid, privilege_gid }));
  }

  // ─── User <-> role ──────────────────────────────────────────────────────

  /**
   * Every (user, role) pair on the active database. The API returns
   * `user_gid` (no email); the component joins to the db-users directory
   * for display. role_name / utility_name are filled from the role list
   * when the row doesn't carry them.
   */
  async listAssignments(): Promise<UserRoleAssignment[]> {
    if (this.roleCache.length === 0) await this.listRoles();
    const byGid = new Map(this.roleCache.map((r) => [r.role_gid, r]));
    const res = await this.api.userRolesList(null);
    const rows = (Array.isArray(res) ? res : (res as any)?.assignments) ?? [];
    return (rows as any[])
      .filter((a) => a && a.role_gid)
      .map((a) => {
        const role = byGid.get(String(a.role_gid));
        return {
          user_gid: String(a.user_gid ?? ''),
          user_email: a.user_email ? String(a.user_email).trim().toLowerCase() : undefined,
          role_gid: String(a.role_gid),
          role_name: String(a.role_name ?? role?.role_name ?? ''),
          utility_name: String(a.utility_name ?? role?.utility_name ?? ''),
          assigned_by: String(a.assigned_by ?? ''),
          assigned_date: String(a.assigned_date ?? ''),
        };
      });
  }

  async assignUserRole(user_email: string, role: ClientRole): Promise<boolean> {
    return this.ok(await this.api.userRoleAssign({ user_email, role_gid: role.role_gid }));
  }

  async removeUserRole(user_email: string, role_gid: string): Promise<boolean> {
    return this.ok(await this.api.userRoleRevoke({ user_email, role_gid }));
  }

  // ─── Check ──────────────────────────────────────────────────────────────

  /** The client-local half of dual-check, for the caller's own session. */
  async checkClientPermission(privilege: string): Promise<boolean> {
    const res: any = await this.api.checkPermission(privilege);
    if (typeof res?.has_permission === 'boolean') return res.has_permission;
    return false;
  }
}
