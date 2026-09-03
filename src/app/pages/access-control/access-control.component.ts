import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RolesApiService } from '../../services/roles-api.service';
import { SessionService } from '../../session/session.service';
import { DbUsersService } from '../../services/db-users.service';
import { AdminUsersService, NewUserDraft } from '../../services/admin-users.service';
import { ClientRolesService } from '../../services/client-roles.service';
import { ClientRole, UserRoleAssignment } from '../../services/roles.types';
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
  private readonly clientRoles = inject(ClientRolesService);

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
  /** Privilege NAMES from the auth API's `_available_privileges` (the
   *  catalogue AC has always used). The GIS `/roles/privileges/list`
   *  surface this used to read was not pulling anything through and was
   *  not db-specific - see ClientRolesService for why this moved. */
  readonly privileges = signal<string[]>([]);
  readonly privilegesError = signal<string | null>(null);

  /** Roles-tab scaling: filter + collapsed create form, so a db with dozens
   *  of roles stays usable instead of pushing everything off-screen. */
  readonly roleSearch = signal('');
  readonly showCreateRole = signal(false);
  readonly filteredRoles = computed<ClientRole[]>(() => {
    const q = this.roleSearch().trim().toLowerCase();
    const list = this.roles();
    if (!q) return list;
    return list.filter((r) => r.role_name.toLowerCase().includes(q) || r.utility_name.toLowerCase().includes(q));
  });

  readonly newRoleName = signal('');
  readonly newRoleUtility = signal('GIS System');
  readonly creatingRole = signal(false);
  readonly roleError = signal<string | null>(null);

  // Privilege CREATE removed 3 Sep — the privilege list is defined by the
  // backend and pulled through read-only; UAC links existing privileges to
  // roles, it does not mint new privilege names. See RolesApiService.

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

  // --- Per-role privilege editor -----------------------------------------
  // A real two-way editor now: `_check_role_privileges` returns what is
  // actually on the role for THIS database, so the checkboxes reflect real
  // state and Save applies the difference (assign what was ticked, remove
  // what was unticked). The earlier blind tick-then-Link/Unlink panel only
  // existed because the GIS /roles/* surface had no per-role read.
  readonly privRoleTarget = signal<ClientRole | null>(null);
  readonly privLinked = signal<Set<string>>(new Set());   // as loaded from the server
  readonly privDraft = signal<Set<string>>(new Set());    // as edited here
  readonly privSearch = signal('');
  readonly privLoading = signal(false);
  readonly privBusy = signal(false);
  readonly privResult = signal<string | null>(null);
  readonly privError = signal<string | null>(null);

  readonly filteredPrivileges = computed<string[]>(() => {
    const q = this.privSearch().trim().toLowerCase();
    const list = this.privileges();
    if (!q) return list;
    return list.filter((n) => n.toLowerCase().includes(q));
  });

  /** Ticked-minus-loaded and loaded-minus-ticked - what Save will actually
   *  send, and what the footer counts so the admin can see the size of the
   *  change before committing it. */
  readonly privToAdd = computed<string[]>(() => {
    const linked = this.privLinked();
    return Array.from(this.privDraft()).filter((n) => !linked.has(n));
  });
  readonly privToRemove = computed<string[]>(() => {
    const draft = this.privDraft();
    return Array.from(this.privLinked()).filter((n) => !draft.has(n));
  });
  readonly privDirty = computed(() => this.privToAdd().length > 0 || this.privToRemove().length > 0);

  async openRolePrivileges(role: ClientRole): Promise<void> {
    this.privRoleTarget.set(role);
    this.privSearch.set('');
    this.privResult.set(null);
    this.privError.set(null);
    this.privLinked.set(new Set());
    this.privDraft.set(new Set());
    this.privLoading.set(true);
    try {
      const linked = await this.clientRoles.rolePrivileges(role.role_name, role.utility_name || 'GIS System');
      this.privLinked.set(new Set(linked));
      this.privDraft.set(new Set(linked));
    } catch (err: any) {
      console.error('[AccessControl] role privileges load failed:', err);
      this.privError.set('Could not load this role\'s current privileges.');
    } finally {
      this.privLoading.set(false);
    }
  }

  closeRolePrivileges(): void {
    this.privRoleTarget.set(null);
  }

  togglePrivilege(name: string): void {
    this.privDraft.update((set) => {
      const next = new Set(set);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  resetPrivilegeDraft(): void {
    this.privDraft.set(new Set(this.privLinked()));
    this.privResult.set(null);
    this.privError.set(null);
  }

  /** Applies only the difference. Each call is reported individually so a
   *  partial failure names the privileges that did not take rather than
   *  rolling back a set of changes that already landed server-side. */
  async saveRolePrivileges(): Promise<void> {
    const role = this.privRoleTarget();
    if (!role) return;
    const add = this.privToAdd();
    const remove = this.privToRemove();
    if (add.length === 0 && remove.length === 0) return;

    const utility = role.utility_name || 'GIS System';
    this.privBusy.set(true);
    this.privError.set(null);
    this.privResult.set(null);
    const failed: string[] = [];
    let added = 0;
    let removed = 0;

    for (const name of add) {
      try {
        if (await this.clientRoles.assignPrivilege(role.role_name, name, utility)) added++;
        else failed.push(name);
      } catch { failed.push(name); }
    }
    for (const name of remove) {
      try {
        if (await this.clientRoles.removePrivilege(role.role_name, name, utility)) removed++;
        else failed.push(name);
      } catch { failed.push(name); }
    }

    // Re-read rather than assuming - the server is the truth about what
    // actually stuck, especially after a partial failure.
    try {
      const linked = await this.clientRoles.rolePrivileges(role.role_name, utility);
      this.privLinked.set(new Set(linked));
      this.privDraft.set(new Set(linked));
    } catch { /* leave the draft as-is; the message below still applies */ }

    this.privBusy.set(false);
    const parts: string[] = [];
    if (added) parts.push('added ' + added);
    if (removed) parts.push('removed ' + removed);
    this.privResult.set(
      failed.length === 0
        ? 'Saved - ' + (parts.join(', ') || 'no change') + ' on ' + role.role_name + '.'
        : 'Saved ' + (parts.join(', ') || 'nothing') + '; failed on: ' + failed.join(', ') + '.',
    );
  }


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
      const [rolesRes, privNames, assignRes] = await Promise.all([
        this.rolesApi.rolesList(),
        this.clientRoles.availablePrivileges('GIS System').catch((err) => {
          console.error('[AccessControl] privilege catalogue failed:', err);
          this.privilegesError.set('Could not load the privilege list from the auth API.');
          return [] as string[];
        }),
        this.rolesApi.userRolesList(),
      ]);
      this.roles.set(rolesRes?.roles ?? []);
      this.privileges.set(privNames);
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
