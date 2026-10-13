/**
 * The base GIS roles. A person holds exactly ONE of Manager / Planner / Viewer
 * per database (Gustav, 13 Oct). Specialist roles (Stock Operator, QA
 * Fieldworker, User System Manager, custom ones) can sit on top of that.
 */
export const BASE_ROLE_NAMES: readonly string[] = ['Manager', 'Planner', 'Viewer'];
export const BASE_ROLE_UTILITY = 'GIS System';

interface RoleLike {
  role_gid: string;
  role_name: string;
  utility_name?: string;
}

interface AssignmentLike {
  user_gid?: string;
  user_email?: string;
  role_gid: string;
  role_name?: string;
  utility_name?: string;
}

export function isBaseRole(role: Pick<RoleLike, 'role_name' | 'utility_name'> | null | undefined): boolean {
  if (!role) return false;
  return BASE_ROLE_NAMES.includes(role.role_name) && (role.utility_name ?? BASE_ROLE_UTILITY) === BASE_ROLE_UTILITY;
}

export interface HeldBaseRole {
  role_gid: string;
  role_name: string;
}

/**
 * The base roles each person holds, keyed by the person's email (whatever
 * `emailOf` gives for the assignment). A role is only counted as a base role
 * when the roles list says so, so a custom role that happens to be named
 * "Viewer" in another utility is left alone.
 */
export function baseRolesByPerson(
  assignments: readonly AssignmentLike[],
  roles: readonly RoleLike[],
  emailOf: (a: AssignmentLike) => string,
): Map<string, HeldBaseRole[]> {
  const baseByGid = new Map<string, RoleLike>();
  for (const r of roles) if (isBaseRole(r)) baseByGid.set(r.role_gid, r);
  const out = new Map<string, HeldBaseRole[]>();
  for (const a of assignments) {
    const role = baseByGid.get(a.role_gid);
    if (!role) continue;
    const email = emailOf(a);
    if (!email) continue;
    const held = out.get(email) ?? [];
    if (!held.some((h) => h.role_gid === role.role_gid)) held.push({ role_gid: role.role_gid, role_name: role.role_name });
    out.set(email, held);
  }
  return out;
}

/** The base roles `email` holds that are NOT `targetRoleGid`: what a move away from them would revoke. */
export function otherBaseRoles(held: Map<string, HeldBaseRole[]>, email: string, targetRoleGid: string): HeldBaseRole[] {
  return (held.get(email) ?? []).filter((h) => h.role_gid !== targetRoleGid);
}

/** "Viewer" or "Manager, Viewer": the tag shown next to a person who would be moved. */
export function describeHeldBaseRoles(roles: readonly HeldBaseRole[]): string {
  return roles.map((r) => r.role_name).join(', ');
}
