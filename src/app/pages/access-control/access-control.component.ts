import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { SlicePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StockAccessApiService } from '../../services/stock-access-api.service';
import { RolesApiService } from '../../services/roles-api.service';
import { SessionService } from '../../session/session.service';
import { AccessRole, AccessScope, LocationAccessGrant, StockLocation } from '../../services/stock-access.types';
import { ClientPrivilege, ClientRole, UserRoleAssignment } from '../../services/roles.types';

type Tab = 'locations' | 'roles' | 'users';

@Component({
  selector: 'app-access-control',
  standalone: true,
  imports: [FormsModule, SlicePipe],
  templateUrl: './access-control.component.html',
})
export class AccessControlComponent implements OnInit {
  private readonly stockAccess = inject(StockAccessApiService);
  private readonly rolesApi = inject(RolesApiService);
  private readonly session = inject(SessionService);

  readonly activeTab = signal<Tab>('locations');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  readonly canAdmin = signal(false); // _stock_admin — grant/revoke location access
  readonly canManageRoles = signal(false); // _manage_client_roles — /roles/* writes

  // ─── Stock location grants ──────────────────────────────────────────────
  readonly locations = signal<StockLocation[]>([]);
  readonly grants = signal<LocationAccessGrant[]>([]);

  readonly orgs = computed(() => {
    const map = new Map<string, { org_id: string; count: number; types: Set<string> }>();
    for (const l of this.locations()) {
      const e = map.get(l.org_id) ?? { org_id: l.org_id, count: 0, types: new Set<string>() };
      e.count += 1;
      e.types.add(l.location_type);
      map.set(l.org_id, e);
    }
    return Array.from(map.values());
  });

  readonly showGrantModal = signal(false);
  readonly granting = signal(false);
  readonly grantError = signal<string | null>(null);
  readonly grantUserId = signal('');
  readonly grantRole = signal<AccessRole>('viewer');
  readonly grantScope = signal<AccessScope>('location');
  readonly grantLocationId = signal('');
  readonly grantOrgId = signal('');

  readonly revoking = signal<string | null>(null);

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
    void this.session.hasPrivilege('_stock_admin').then((v) => this.canAdmin.set(v));
    void this.session.hasPrivilege('_manage_client_roles').then((v) => this.canManageRoles.set(v));
  }

  setTab(t: Tab): void {
    this.activeTab.set(t);
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [locRes, grantRes, rolesRes, privRes, assignRes] = await Promise.all([
        this.stockAccess.locationsList(),
        this.stockAccess.locationAccessList(),
        this.rolesApi.rolesList(),
        this.rolesApi.privilegesList(),
        this.rolesApi.userRolesList(),
      ]);
      this.locations.set(locRes?.locations ?? []);
      this.grants.set(grantRes?.access ?? []);
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

  locationName(id: string | null): string {
    if (!id) return '—';
    return this.locations().find((l) => l.global_id === id)?.name ?? id.slice(0, 8);
  }

  // ─── Grant / revoke location access ─────────────────────────────────────

  openGrant(orgId?: string): void {
    this.grantUserId.set('');
    this.grantRole.set('viewer');
    this.grantScope.set(orgId ? 'org' : 'location');
    this.grantLocationId.set('');
    this.grantOrgId.set(orgId ?? '');
    this.grantError.set(null);
    this.showGrantModal.set(true);
  }

  closeGrant(): void {
    this.showGrantModal.set(false);
  }

  async submitGrant(): Promise<void> {
    const userId = this.grantUserId().trim();
    if (!userId) {
      this.grantError.set('User ID is required.');
      return;
    }
    if (this.grantScope() === 'location' && !this.grantLocationId()) {
      this.grantError.set('Select a location.');
      return;
    }
    if (this.grantScope() === 'org' && !this.grantOrgId().trim()) {
      this.grantError.set('Organisation ID is required.');
      return;
    }

    this.granting.set(true);
    this.grantError.set(null);
    try {
      await this.stockAccess.locationAccessGrant({
        user_id: userId,
        role: this.grantRole(),
        scope: this.grantScope(),
        location_id: this.grantScope() === 'location' ? this.grantLocationId() : null,
        org_id: this.grantScope() === 'org' ? this.grantOrgId().trim() : null,
      });
      this.showGrantModal.set(false);
      await this.load();
    } catch (err: any) {
      console.error('[AccessControl] grant failed:', err);
      this.grantError.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to grant access');
    } finally {
      this.granting.set(false);
    }
  }

  async revokeGrant(g: LocationAccessGrant): Promise<void> {
    this.revoking.set(g.global_id);
    try {
      await this.stockAccess.locationAccessRevoke(g.global_id);
      this.grants.update((list) => list.filter((x) => x.global_id !== g.global_id));
    } catch (err: any) {
      console.error('[AccessControl] revoke failed:', err);
      this.error.set(err?.response?.data?.detail ?? err?.message ?? 'Failed to revoke access');
    } finally {
      this.revoking.set(null);
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
