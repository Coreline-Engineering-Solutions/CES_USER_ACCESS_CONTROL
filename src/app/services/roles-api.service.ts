import { Injectable, inject } from '@angular/core';
import axios, { AxiosInstance } from 'axios';
import { SessionService } from '../session/session.service';
import { environment } from '../../environments/environment';
import {
  ClientPrivilege, ClientRole, PrivilegeCreatePayload, RoleCreatePayload,
  RolePrivilegeMappingPayload, RoleUpdatePayload, UserRoleAssignPayload,
  UserRoleAssignment,
} from './roles.types';

/**
 * Wraps every `/roles/*` endpoint from STOCK_ROLES_API_HANDOVER.md
 * (2026-07-26) — client-local role/privilege management. All require the
 * `_manage_client_roles` privilege except `checkPermission`, which only
 * needs a valid session. Mirrors CES_MODULES' ModulesApiService shape
 * (axios instance + session_gid auto-injection) for convention parity.
 */
@Injectable({ providedIn: 'root' })
export class RolesApiService {
  private readonly session = inject(SessionService);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      baseURL: environment.apiBaseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private get sessionGid(): string {
    return this.session.session()?.session_gid ?? this.session.readCookie('session_gid') ?? '';
  }

  private async post<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
    const gid = this.sessionGid;
    if (!gid) {
      console.warn('[RolesAPI] No session_gid available for request:', path);
    }
    const payload = { session_gid: gid, ...body };
    const { data } = await this.http.post(path, payload);
    return data as T;
  }

  // ─── Roles ──────────────────────────────────────────────────────────────

  rolesList() {
    return this.post<{ response: string; roles: ClientRole[] }>('/roles/list', {});
  }

  roleCreate(payload: RoleCreatePayload) {
    return this.post<{ response: string; role_gid: string; pk: number }>('/roles/create', payload);
  }

  roleUpdate(payload: RoleUpdatePayload) {
    return this.post<{ response: string }>('/roles/update', payload);
  }

  roleDelete(role_gid: string) {
    return this.post<{ response: string }>('/roles/delete', { role_gid });
  }

  // ─── Privileges ─────────────────────────────────────────────────────────

  privilegesList() {
    return this.post<{ response: string; privileges: ClientPrivilege[] }>('/roles/privileges/list', {});
  }

  privilegeCreate(payload: PrivilegeCreatePayload) {
    return this.post<{ response: string; privilege_gid: string; pk: number }>('/roles/privileges/create', payload);
  }

  // ─── Role-privilege mappings ────────────────────────────────────────────

  privilegeAssign(payload: RolePrivilegeMappingPayload) {
    return this.post<{ response: string }>('/roles/privileges/assign', payload);
  }

  privilegeRevoke(payload: RolePrivilegeMappingPayload) {
    return this.post<{ response: string }>('/roles/privileges/revoke', payload);
  }

  // ─── User-role assignments ──────────────────────────────────────────────

  userRoleAssign(payload: UserRoleAssignPayload) {
    return this.post<{ response: string }>('/roles/users/assign', payload);
  }

  userRoleRevoke(payload: UserRoleAssignPayload) {
    return this.post<{ response: string }>('/roles/users/revoke', payload);
  }

  userRolesList(user_email?: string | null) {
    return this.post<{ response: string; assignments: UserRoleAssignment[] }>('/roles/users/list', {
      user_email: user_email ?? null,
    });
  }

  // ─── Permission check ───────────────────────────────────────────────────

  checkPermission(privilege: string) {
    return this.post<{ response: string; has_permission: boolean }>('/roles/check-permission', { privilege });
  }
}
