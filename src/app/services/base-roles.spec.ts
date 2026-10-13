import { describe, expect, it } from 'vitest';

import { baseRolesByPerson, describeHeldBaseRoles, isBaseRole, otherBaseRoles } from './base-roles';

const roles = [
  { role_gid: 'm', role_name: 'Manager', utility_name: 'GIS System' },
  { role_gid: 'p', role_name: 'Planner', utility_name: 'GIS System' },
  { role_gid: 'v', role_name: 'Viewer', utility_name: 'GIS System' },
  { role_gid: 's', role_name: 'Stock Operator', utility_name: 'GIS System' },
  { role_gid: 'mv', role_name: 'Viewer', utility_name: 'Modules' },
];
const emailOf = (a: { user_email?: string }) => String(a.user_email ?? '');

describe('isBaseRole', () => {
  it('is true for Manager, Planner and Viewer in GIS System', () => {
    expect(isBaseRole(roles[0])).toBe(true);
    expect(isBaseRole(roles[1])).toBe(true);
    expect(isBaseRole(roles[2])).toBe(true);
  });

  it('is false for specialist roles and for a same-named role in another utility', () => {
    expect(isBaseRole(roles[3])).toBe(false);
    expect(isBaseRole(roles[4])).toBe(false);
    expect(isBaseRole(null)).toBe(false);
  });
});

describe('baseRolesByPerson', () => {
  const assignments = [
    { user_email: 'a@x.com', role_gid: 'm' },
    { user_email: 'a@x.com', role_gid: 'v' },
    { user_email: 'a@x.com', role_gid: 's' },
    { user_email: 'b@x.com', role_gid: 'p' },
    { user_email: 'c@x.com', role_gid: 'mv' },
    { user_email: 'c@x.com', role_gid: 'm' },
    { user_email: 'c@x.com', role_gid: 'm' },
  ];

  it('collects the base roles each person holds and ignores the rest', () => {
    const held = baseRolesByPerson(assignments, roles, emailOf);
    expect(held.get('a@x.com')?.map((h) => h.role_name)).toEqual(['Manager', 'Viewer']);
    expect(held.get('b@x.com')?.map((h) => h.role_name)).toEqual(['Planner']);
    expect(held.get('c@x.com')?.map((h) => h.role_name)).toEqual(['Manager']);
  });

  it('skips assignments with no email', () => {
    expect(baseRolesByPerson([{ role_gid: 'm' }], roles, emailOf).size).toBe(0);
  });
});

describe('otherBaseRoles', () => {
  const held = baseRolesByPerson([
    { user_email: 'a@x.com', role_gid: 'm' },
    { user_email: 'a@x.com', role_gid: 'v' },
  ], roles, emailOf);

  it('lists what moving to the target would revoke', () => {
    expect(otherBaseRoles(held, 'a@x.com', 'p').map((h) => h.role_name)).toEqual(['Manager', 'Viewer']);
    expect(otherBaseRoles(held, 'a@x.com', 'm').map((h) => h.role_name)).toEqual(['Viewer']);
  });

  it('is empty for someone with no base role', () => {
    expect(otherBaseRoles(held, 'nobody@x.com', 'p')).toEqual([]);
  });

  it('describes the tag', () => {
    expect(describeHeldBaseRoles(otherBaseRoles(held, 'a@x.com', 'p'))).toBe('Manager, Viewer');
  });
});
