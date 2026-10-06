import { describe, expect, it } from 'vitest';

import { countOrNull, privilegeCountsFromList } from './role-counts';

describe('countOrNull', () => {
  it('accepts real counts, including zero', () => {
    expect(countOrNull(136)).toBe(136);
    expect(countOrNull(0)).toBe(0);
    expect(countOrNull('12')).toBe(12);
  });

  it('turns anything unreadable into null, never 0', () => {
    expect(countOrNull(undefined)).toBeNull();
    expect(countOrNull(null)).toBeNull();
    expect(countOrNull('')).toBeNull();
    expect(countOrNull('  ')).toBeNull();
    expect(countOrNull('many')).toBeNull();
    expect(countOrNull(NaN)).toBeNull();
    expect(countOrNull(-3)).toBeNull();
  });
});

describe('privilegeCountsFromList', () => {
  it('maps every role to its count', () => {
    expect(
      privilegeCountsFromList([
        { role_gid: 'A', privilege_count: 136 },
        { role_gid: 'B', privilege_count: 0 },
      ]),
    ).toEqual({ A: 136, B: 0 });
  });

  it('gives up when any role has no count, so the caller counts the old way', () => {
    expect(
      privilegeCountsFromList([
        { role_gid: 'A', privilege_count: 5 },
        { role_gid: 'B', privilege_count: null },
      ]),
    ).toBeNull();
    expect(privilegeCountsFromList([{ role_gid: 'A' }])).toBeNull();
  });

  it('gives up on an empty list', () => {
    expect(privilegeCountsFromList([])).toBeNull();
  });
});
