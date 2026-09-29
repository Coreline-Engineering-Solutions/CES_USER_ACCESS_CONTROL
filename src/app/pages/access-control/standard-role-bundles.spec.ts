import { describe, expect, it } from 'vitest';

import { missingStandardRoleNames } from './standard-role-bundles';

const STANDARD = ['Viewer', 'Planner', 'Manager'];

/**
 * The `loaded` flag is the whole reason this function exists. An empty role
 * list means two opposite things — "this database has no roles" and "we were
 * refused the read" — and the Client Portal acted on the wrong one, offering
 * "Create them" on databases that already had all three. Clicking it minted
 * empty duplicates.
 */
describe('missingStandardRoleNames', () => {
  it('reports nothing missing when the role list was never read', () => {
    // The regression. A 401 on /roles/list leaves the list empty; without the
    // flag every standard role looks absent and the UI invites the user to
    // create roles that already exist.
    expect(missingStandardRoleNames(false, [], STANDARD)).toEqual([]);
  });

  it('still reports nothing missing on a failed read of a populated database', () => {
    // Belt and braces: even if a stale list survives a failed reload, an
    // unread state must not drive the banner.
    expect(missingStandardRoleNames(false, ['Viewer'], STANDARD)).toEqual([]);
  });

  it('reports all three on a genuinely empty database', () => {
    expect(missingStandardRoleNames(true, [], STANDARD)).toEqual(['Viewer', 'Planner', 'Manager']);
  });

  it('reports only the ones actually absent', () => {
    expect(missingStandardRoleNames(true, ['Manager', 'Viewer'], STANDARD)).toEqual(['Planner']);
  });

  it('reports nothing when all three are present', () => {
    expect(missingStandardRoleNames(true, ['Viewer', 'Planner', 'Manager'], STANDARD)).toEqual([]);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    // Real rows have been seen with padding; a near-miss here would create a
    // duplicate under a slightly different name, which is worse than either
    // outcome it is choosing between.
    expect(missingStandardRoleNames(true, ['  viewer ', 'PLANNER', 'Manager'], STANDARD)).toEqual([]);
  });

  it('survives null and undefined role names', () => {
    expect(
      missingStandardRoleNames(true, [null as unknown as string, 'Manager'], STANDARD),
    ).toEqual(['Viewer', 'Planner']);
  });
});
