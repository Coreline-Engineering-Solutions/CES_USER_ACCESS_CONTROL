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
