import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RolesApiService } from '../../services/roles-api.service';
import { SessionService } from '../../session/session.service';
import { DbUsersService } from '../../services/db-users.service';
import { AdminUsersService, NewUserDraft } from '../../services/admin-users.service';
import { ClientPrivilege, ClientRole, UserRoleAssignment } from '../../services/roles.types';
import { AccessProject, PROJECT_REGISTRY } from './project-registry';
import { UserDirectoryPanelComponent } from './panels/user-directory-panel.component';

type Tab = 'projects' | 'roles' | 'users' | 'directory';

@Component({
  selector: 'app-access-control',
  standalone: true,
  imports: [FormsModule, SlicePipe, NgComponentOutlet, UserDirectoryPanelComponent],
  templateUrl: './access-control.component.html',
})
export class AccessControlComponent implements OnInit {
  private readonly rolesApi = inject(RolesApiService);
  readonly session = inject(SessionService);
  readonly dbUsers = inject(DbUsersService); // template reads dbUsers.users() for email dropdowns
  private readonly adminUsers = inject(AdminUsersService);

  readonly activeTab = signal<Tab>('projects');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly canManageRoles = signal(false); // _manage_client_roles — /roles/* writes

  // ─── Projects (dynamic — see project-registry.ts) ───────────────────────
  readonly projects: AccessProject[] = PROJECT_REGISTRY;
  readonly selectedProjectId = signal<string>(PROJECT_REGISTRY[0]?.id ?? '');
  readonly selectedProject = computed<AccessProject | null>(
    () => this.projects.find((p) => p.id === this.selectedProjectId()) ?? null,
  );

  selectProject(id: string): void {
    this.selectedProjectId.set(id);
  }

  // ─── Client roles/privileges ────────────────────────────────────────────
  readonly roles = signal<ClientRole[]>([]);
  readonly privileges = signal<ClientPrivilege[]>([]);

  readonly newRoleName = signal('');
  readonly newRoleUtility = signal('GIS System');
  readonly creatingRole = signal(false);
  readonly roleError = signal<string | null>(null);

  // Privilege CREATE removed 3 Sep — the privilege list is defined by the
  // backend and pulled through read-only; UAC links existing privileges to
  // roles, it does not mint new privilege names. See RolesApiService.

  readonly mapRoleGid = signal('');
  readonly mapPrivilegeGid = signal('');
  readonly mapping = signal(false);
  readonly mapError = signal<string | null>(null);

  // --- Standard roles per database ---------------------------------------
  // Every client db is supposed to carry the same three GIS roles. Rather
  // than each admin hand-typing them (and drifting on spelling, which then
  // silently fails every downstream role-name match), this seeds whichever
  // of the three are missing. Existing roles are left alone - additive,
  // never a reset.
  static readonly STANDARD_ROLES = ['Manager', 'Planner', 'Viewer'];
  readonly seedingRoles = signal(false);
  readonly seedResult = signal<string | null>(null);

  readonly missingStandardRoles = computed<string[]>(() => {
    const have = new Set(this.roles().map((r) => r.role_name.trim().toLowerCase()));
    return AccessControlComponent.STANDARD_ROLES.filter((n) => !have.has(n.toLowerCase()));
  });

  async seedStandardRoles(): Promise<void> {
    const missing = this.missingStandardRoles();
    if (missing.length === 0) return;
    this.seedingRoles.set(true);
    this.seedResult.set(null);
    const created: string[] = [];
    const failed: string[] = [];
    for (const name of missing) {
      try {
        await this.rolesApi.roleCreate({ role_name: name, utility_name: 'GIS System' });
        created.push(name);
      } catch (err: any) {
        console.error('[AccessControl] seed role failed:', name, err);
        failed.push(name);
      }
    }
    await this.load();
    this.seedingRoles.set(false);
    this.seedResult.set(
      failed.length === 0
        ? 'Created ' + created.join(', ') + '.'
        : 'Created ' + (created.join(', ') || 'none') + '; failed: ' + failed.join(', ') + '.',
    );
  }

  // --- Per-role privilege linking -----------------------------------------
  // The /roles/* surface has no "privileges for THIS role" endpoint - only
  // "every privilege" (privilegesList) plus assign/revoke. So this is an
  // ACTION panel, not a state toggle: tick privileges, then Link or Unlink.
  // Deliberately NOT rendered as checkboxes-reflecting-current-state, which
  // would be a lie about data we cannot read. Flagged to backend; the moment
  // a per-role list endpoint exists this becomes a real two-way editor.
  readonly privRoleTarget = signal<ClientRole | null>(null);
  readonly privSelection = signal<Set<string>>(new Set());
  readonly privSearch = signal('');
  readonly privBusy = signal(false);
  readonly privResult = signal<string | null>(null);
  readonly privError = signal<string | null>(null);

  readonly filteredPrivileges = computed<ClientPrivilege[]>(() => {
    const q = this.privSearch().trim().toLowerCase();
    const list = this.privileges();
    if (!q) return list;
    return list.filter(
      (pv) => pv.privilege_name.toLowerCase().includes(q) || pv.utility_name.toLowerCase().includes(q),
    );
  });

  openRolePrivileges(role: ClientRole): void {
    this.privRoleTarget.set(role);
    this.privSelection.set(new Set());
    this.privSearch.set('');
    this.privResult.set(null);
    this.privError.set(null);
  }

  closeRolePrivileges(): void {
    this.privRoleTarget.set(null);
  }

  togglePrivSelection(gid: string): void {
    this.privSelection.update((set) => {
      const next = new Set(set);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  }

  private async applyPrivileges(mode: 'link' | 'unlink'): Promise<void> {
    const role = this.privRoleTarget();
    const gids = Array.from(this.privSelection());
    if (!role || gids.length === 0) {
      this.privError.set('Pick at least one privilege.');
      return;
    }
    this.privBusy.set(true);
    this.privError.set(null);
    this.privResult.set(null);
    let ok = 0;
    const failed: string[] = [];
    for (const gid of gids) {
      const name = this.privileges().find((pv) => pv.privilege_gid === gid)?.privilege_name ?? gid.slice(0, 8);
      try {
        if (mode === 'link') await this.rolesApi.privilegeAssign({ role_gid: role.role_gid, privilege_gid: gid });
        else await this.rolesApi.privilegeRevoke({ role_gid: role.role_gid, privilege_gid: gid });
        ok++;
      } catch (err: any) {
        console.error('[AccessControl] privilege ' + mode + ' failed:', name, err);
        failed.push(name);
      }
    }
    this.privBusy.set(false);
    const verb = mode === 'link' ? 'Linked' : 'Unlinked';
    this.privResult.set(
      failed.length === 0
        ? verb + ' ' + ok + ' privilege' + (ok === 1 ? '' : 's') + ' on ' + role.role_name + '.'
        : verb + ' ' + ok + '; failed on ' + failed.join(', ') + '.',
    );
    this.privSelection.set(new Set());
  }

  linkSelectedPrivileges(): Promise<void> { return this.applyPrivileges('link'); }
  unlinkSelectedPrivileges(): Promise<void> { return this.applyPrivileges('unlink'); }

  // ─── Add a user (create -> link to THIS db -> optional role) ────────────
  // The client admin's own user-management flow, mirroring AC's Users page
  // but scoped: a user created here is always linked to the database this
  // session is currently pointed at (the company the admin belongs to),
  // never to one they pick. Role assignment is offered in the same step
  // because "created but no role" is a dead-end user.
  readonly showAddUser = signal(false);
  readonly newUser = signal<NewUserDraft>({ email: '', first_name: '', last_name: '', username: '', phone: '' });
  readonly newUserRoleGid = signal('');
  readonly creatingUser = signal(false);
  readonly createUserError = signal<string | null>(null);
  readonly createUserSteps = signal<string[]>([]);

  openAddUser(): void {
    this.newUser.set({ email: '', first_name: '', last_name: '', username: '', phone: '' });
    this.newUserRoleGid.set('');
    this.createUserError.set(null);
    this.createUserSteps.set([]);
    this.showAddUser.set(true);
  }

  closeAddUser(): void {
    this.showAddUser.set(false);
  }

  patchNewUser(patch: Partial<NewUserDraft>): void {
    this.newUser.update((u) => ({ ...u, ...patch }));
  }

  /**
   * Create -> link to the active db -> (optionally) assign a role, in that
   * order, reporting each step as it lands. Deliberately not all-or-nothing:
   * if the db link fails after the user was created, the user still exists
   * and the admin is told exactly which step failed, rather than seeing one
   * generic failure for a partially-completed sequence.
   */
  async submitAddUser(): Promise<void> {
    const draft = this.newUser();
    const email = draft.email.trim();
    if (!email) {
      this.createUserError.set('Email is required.');
      return;
    }

    this.creatingUser.set(true);
    this.createUserError.set(null);
    this.createUserSteps.set([]);
    const step = (msg: string) => this.createUserSteps.update((l) => [...l, msg]);

    try {
      const dbGid = await this.adminUsers.activeDbGid();
      if (!dbGid) {
        this.createUserError.set('Could not determine the active database — switch to a database first, then try again.');
        return;
      }

      const created = await this.adminUsers.createUser({ ...draft, email });
      if (!created.ok) {
        this.createUserError.set(created.detail ?? 'Failed to create the user.');
        return;
      }
      step(`User ${email} created.`);

      const linked = await this.adminUsers.assignUserToDb(email, dbGid);
      if (!linked) {
        this.createUserError.set(
          'The user was created but could not be linked to this database. Link them from the Databases screen, or retry.',
        );
        return;
      }
      step('Linked to this database.');

      const roleGid = this.newUserRoleGid();
      if (roleGid) {
        try {
          await this.rolesApi.userRoleAssign({ user_email: email, role_gid: roleGid });
          const roleName = this.roles().find((r) => r.role_gid === roleGid)?.role_name ?? 'role';
          step(`Assigned ${roleName}.`);
        } catch (err: any) {
          this.createUserError.set(
            `User created and linked, but the role could not be assigned: ${err?.response?.data?.detail ?? err?.message ?? 'unknown error'}`,
          );
          return;
        }
      }

      await Promise.all([this.dbUsers.reload(), this.load()]);
      setTimeout(() => this.showAddUser.set(false), 900);
    } catch (err: any) {
      console.error('[AccessControl] add user failed:', err);
      this.createUserError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to add the user.');
    } finally {
      this.creatingUser.set(false);
    }
  }

  // --- Users on this database, with their roles ---------------------------
  // /roles/users/list only carries user_gid, which on its own is unusable in
  // a UI ("who is 3f2a8c1e?"). DbUsersService has the gid->email mapping for
  // this db, so join them here: every db-linked user, their assigned roles,
  // and a revoke that no longer needs the admin to retype the email to prove
  // who they meant.
  readonly userRows = computed(() => {
    const rolesByGid = new Map<string, UserRoleAssignment[]>();
    for (const a of this.assignments()) {
      const key = String(a.user_gid ?? '').toLowerCase();
      const list = rolesByGid.get(key) ?? [];
      list.push(a);
      rolesByGid.set(key, list);
    }
    return this.dbUsers.users().map((u) => ({
      email: u.email,
      user_gid: u.user_gid,
      roles: rolesByGid.get(String(u.user_gid ?? '').toLowerCase()) ?? [],
    }));
  });

  /** Assignments whose user_gid matches nobody linked to this db - surfaced
   *  separately rather than hidden, since a role still assigned to someone
   *  no longer on the database is exactly what an access review needs to
   *  see. */
  readonly orphanAssignments = computed<UserRoleAssignment[]>(() => {
    const known = new Set(this.dbUsers.users().map((u) => String(u.user_gid ?? '').toLowerCase()));
    return this.assignments().filter((a) => !known.has(String(a.user_gid ?? '').toLowerCase()));
  });

  /** Revoke straight from a user row - the email is already known here, so
   *  no confirm-by-retyping step (that modal only exists because the raw
   *  assignments list has no email to work from). */
  readonly rowRevoking = signal<string>('');

  async revokeRoleFromUser(email: string, a: UserRoleAssignment): Promise<void> {
    this.rowRevoking.set(email + '::' + a.role_gid);
    try {
      await this.rolesApi.userRoleRevoke({ user_email: email, role_gid: a.role_gid });
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] revoke role failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke role');
    } finally {
      this.rowRevoking.set('');
    }
  }

  /** Pre-fills the assign form below the table for one user. */
  assignRoleTo(email: string): void {
    this.assignEmail.set(email);
  }

  // ─── User-role assignments ──────────────────────────────────────────────
  readonly assignments = signal<UserRoleAssignment[]>([]);
  readonly assignEmail = signal('');
  readonly assignRoleGid = signal('');
  readonly assigning = signal(false);
  readonly assignError = signal<string | null>(null);

  readonly checkPrivilegeInput = signal('');
  readonly checkResult = signal<string | null>(null);
  readonly checking = signal(false);

  /**
   * /roles/users/list returns user_gid (no email); /roles/users/revoke
   * requires user_email. There's no gid→email lookup in this API surface,
   * so revoke needs the admin to re-enter the email rather than silently
   * sending an empty one.
   */
  readonly revokeAssignmentTarget = signal<UserRoleAssignment | null>(null);
  readonly revokeAssignmentEmail = signal('');
  readonly revokingAssignment = signal(false);
  readonly revokeAssignmentError = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
    void this.session.hasPrivilege('_manage_client_roles').then((v) => this.canManageRoles.set(v));
    void this.dbUsers.ensureLoaded();
  }

  setTab(t: Tab): void {
    this.activeTab.set(t);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [rolesRes, privRes, assignRes] = await Promise.all([
        this.rolesApi.rolesList(),
        this.rolesApi.privilegesList(),
        this.rolesApi.userRolesList(),
      ]);
      this.roles.set(rolesRes?.roles ?? []);
      this.privileges.set(privRes?.privileges ?? []);
      this.assignments.set(assignRes?.assignments ?? []);
    } catch (err: any) {
      console.error('[AccessControl] load failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to load access control data');
    } finally {
      this.loading.set(false);
    }
  }

  // ─── Client roles/privileges ─────────────────────────────────────────────

  async createRole(): Promise<void> {
    const name = this.newRoleName().trim();
    if (!name) {
      this.roleError.set('Role name is required.');
      return;
    }
    this.creatingRole.set(true);
    this.roleError.set(null);
    try {
      await this.rolesApi.roleCreate({ role_name: name, utility_name: this.newRoleUtility().trim() || 'GIS System' });
      this.newRoleName.set('');
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] role create failed:', err);
      this.roleError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to create role');
    } finally {
      this.creatingRole.set(false);
    }
  }

  async deleteRole(role: ClientRole): Promise<void> {
    try {
      await this.rolesApi.roleDelete(role.role_gid);
      this.roles.update((list) => list.filter((r) => r.role_gid !== role.role_gid));
    } catch (err: any) {
      console.error('[AccessControl] role delete failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to delete role');
    }
  }

  async assignPrivilege(): Promise<void> {
    if (!this.mapRoleGid() || !this.mapPrivilegeGid()) {
      this.mapError.set('Select both a role and a privilege.');
      return;
    }
    this.mapping.set(true);
    this.mapError.set(null);
    try {
      await this.rolesApi.privilegeAssign({ role_gid: this.mapRoleGid(), privilege_gid: this.mapPrivilegeGid() });
    } catch (err: any) {
      console.error('[AccessControl] privilege assign failed:', err);
      this.mapError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to assign privilege');
    } finally {
      this.mapping.set(false);
    }
  }

  async revokePrivilege(): Promise<void> {
    if (!this.mapRoleGid() || !this.mapPrivilegeGid()) {
      this.mapError.set('Select both a role and a privilege.');
      return;
    }
    this.mapping.set(true);
    this.mapError.set(null);
    try {
      await this.rolesApi.privilegeRevoke({ role_gid: this.mapRoleGid(), privilege_gid: this.mapPrivilegeGid() });
    } catch (err: any) {
      console.error('[AccessControl] privilege revoke failed:', err);
      this.mapError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke privilege');
    } finally {
      this.mapping.set(false);
    }
  }

  // ─── User-role assignments ────────────────────────────────────────────────

  async assignRole(): Promise<void> {
    const email = this.assignEmail().trim();
    if (!email || !this.assignRoleGid()) {
      this.assignError.set('User email and role are required.');
      return;
    }
    this.assigning.set(true);
    this.assignError.set(null);
    try {
      await this.rolesApi.userRoleAssign({ user_email: email, role_gid: this.assignRoleGid() });
      this.assignEmail.set('');
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] user role assign failed:', err);
      this.assignError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to assign role');
    } finally {
      this.assigning.set(false);
    }
  }

  openRevokeAssignment(a: UserRoleAssignment): void {
    this.revokeAssignmentTarget.set(a);
    this.revokeAssignmentEmail.set('');
    this.revokeAssignmentError.set(null);
  }

  closeRevokeAssignment(): void {
    this.revokeAssignmentTarget.set(null);
  }

  async confirmRevokeAssignment(): Promise<void> {
    const a = this.revokeAssignmentTarget();
    const email = this.revokeAssignmentEmail().trim();
    if (!a) return;
    if (!email) {
      this.revokeAssignmentError.set("Enter the user's email to confirm.");
      return;
    }
    this.revokingAssignment.set(true);
    this.revokeAssignmentError.set(null);
    try {
      await this.rolesApi.userRoleRevoke({ user_email: email, role_gid: a.role_gid });
      this.revokeAssignmentTarget.set(null);
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] user role revoke failed:', err);
      this.revokeAssignmentError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke role');
    } finally {
      this.revokingAssignment.set(false);
    }
  }

  async runCheck(): Promise<void> {
    const priv = this.checkPrivilegeInput().trim();
    if (!priv) return;
    this.checking.set(true);
    this.checkResult.set(null);
    try {
      const res = await this.rolesApi.checkPermission(priv);
      this.checkResult.set(res?.has_permission ? 'Granted' : 'Not granted');
    } catch (err: any) {
      console.error('[AccessControl] permission check failed:', err);
      this.checkResult.set('Check failed');
    } finally {
      this.checking.set(false);
    }
  }
}
