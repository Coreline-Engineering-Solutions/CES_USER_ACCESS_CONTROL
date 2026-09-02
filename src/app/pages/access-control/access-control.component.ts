import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet, SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RolesApiService } from '../../services/roles-api.service';
import { SessionService } from '../../session/session.service';
import { DbUsersService } from '../../services/db-users.service';
import { ClientPrivilege, ClientRole, UserRoleAssignment } from '../../services/roles.types';
import { AccessProject, PROJECT_REGISTRY } from './project-registry';

type Tab = 'projects' | 'roles' | 'users';

@Component({
  selector: 'app-access-control',
  standalone: true,
  imports: [FormsModule, SlicePipe, NgComponentOutlet],
  templateUrl: './access-control.component.html',
})
export class AccessControlComponent implements OnInit {
  private readonly rolesApi = inject(RolesApiService);
  readonly session = inject(SessionService);
  readonly dbUsers = inject(DbUsersService); // template reads dbUsers.users() for email dropdowns

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

  readonly newPrivilegeName = signal('');
  readonly newPrivilegeUtility = signal('GIS System');
  readonly creatingPrivilege = signal(false);
  readonly privilegeError = signal<string | null>(null);

  readonly mapRoleGid = signal('');
  readonly mapPrivilegeGid = signal('');
  readonly mapping = signal(false);
  readonly mapError = signal<string | null>(null);

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

  async createPrivilege(): Promise<void> {
    const name = this.newPrivilegeName().trim();
    if (!name) {
      this.privilegeError.set('Privilege name is required.');
      return;
    }
    this.creatingPrivilege.set(true);
    this.privilegeError.set(null);
    try {
      await this.rolesApi.privilegeCreate({ privilege_name: name, utility_name: this.newPrivilegeUtility().trim() || 'GIS System' });
      this.newPrivilegeName.set('');
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] privilege create failed:', err);
      this.privilegeError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to create privilege');
    } finally {
      this.creatingPrivilege.set(false);
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
