// Types matching STOCK_ROLES_API_HANDOVER.md (2026-07-26) `/roles/*` surface —
// client-local role & privilege management (lives in the client DB, separate
// from the Auth API's global role system).

export interface ClientRole {
  pk: number;
  role_name: string;
  role_gid: string;
  utility_name: string;
  is_system: boolean;
  created_by: string;
  created_date: string;
}

export interface RoleCreatePayload {
  role_name: string;
  utility_name: string;
  is_system?: boolean;
}

export interface RoleUpdatePayload {
  role_gid: string;
  role_name?: string | null;
  is_system?: boolean | null;
}

export interface ClientPrivilege {
  pk: number;
  privilege_name: string;
  privilege_gid: string;
  utility_name: string;
}

export interface PrivilegeCreatePayload {
  privilege_name: string;
  utility_name: string;
}

export interface RolePrivilegeMappingPayload {
  role_gid: string;
  privilege_gid: string;
}

export interface UserRoleAssignment {
  user_gid: string;
  role_gid: string;
  role_name: string;
  assigned_by: string;
  assigned_date: string;
}

export interface UserRoleAssignPayload {
  user_email: string;
  role_gid: string;
}
