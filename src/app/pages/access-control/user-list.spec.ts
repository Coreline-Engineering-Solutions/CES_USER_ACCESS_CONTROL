import { describe, expect, it } from 'vitest';

import { ANY_ROLE, NO_ROLE, filterUserRows, pageSizeLabel, paginate } from './user-list';

const planner = { role_gid: 'p', role_name: 'Planner' };
const manager = { role_gid: 'm', role_name: 'Manager' };
const rows = [
  { email: 'ilse@corelineengineering.com', roles: [manager] },
  { email: 'janco.roos@corelinefibre.com', roles: [manager] },
  { email: 'kyle.jurgens@corelinefibre.com', roles: [planner] },
  { email: 'nobody@example.com', roles: [] },
];

describe('filterUserRows', () => {
  it('returns everyone for no search and any role', () => {
    expect(filterUserRows(rows, '', ANY_ROLE)).toHaveLength(4);
  });

  it('searches the email, ignoring case', () => {
    expect(filterUserRows(rows, 'JANCO', ANY_ROLE).map((r) => r.email)).toEqual(['janco.roos@corelinefibre.com']);
    expect(filterUserRows(rows, 'corelinefibre', ANY_ROLE)).toHaveLength(2);
  });

  it('searches the role name too, and needs every word', () => {
    expect(filterUserRows(rows, 'planner', ANY_ROLE).map((r) => r.email)).toEqual(['kyle.jurgens@corelinefibre.com']);
    expect(filterUserRows(rows, 'ilse manager', ANY_ROLE)).toHaveLength(1);
    expect(filterUserRows(rows, 'ilse planner', ANY_ROLE)).toHaveLength(0);
  });

  it('filters by one role', () => {
    expect(filterUserRows(rows, '', 'm')).toHaveLength(2);
    expect(filterUserRows(rows, '', 'p')).toHaveLength(1);
  });

  it('finds people with no role at all', () => {
    expect(filterUserRows(rows, '', NO_ROLE).map((r) => r.email)).toEqual(['nobody@example.com']);
  });

  it('combines the search and the role filter', () => {
    expect(filterUserRows(rows, 'fibre', 'm').map((r) => r.email)).toEqual(['janco.roos@corelinefibre.com']);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 68 }, (_, i) => i + 1);

  it('shows one page and says where it is', () => {
    const p = paginate(items, 0, 25);
    expect(p.items).toHaveLength(25);
    expect([p.from, p.to, p.total, p.pageCount]).toEqual([1, 25, 68, 3]);
  });

  it('the last page is the remainder', () => {
    const p = paginate(items, 2, 25);
    expect(p.items).toHaveLength(18);
    expect([p.from, p.to]).toEqual([51, 68]);
  });

  it('clamps a page that is out of range, for example after a search shrinks the list', () => {
    const p = paginate(items.slice(0, 10), 5, 25);
    expect(p.page).toBe(0);
    expect(p.items).toHaveLength(10);
  });

  it('size 0 means everything on one page', () => {
    const p = paginate(items, 3, 0);
    expect(p.items).toHaveLength(68);
    expect([p.from, p.to, p.pageCount]).toEqual([1, 68, 1]);
  });

  it('handles an empty list', () => {
    const p = paginate([], 0, 25);
    expect([p.from, p.to, p.total, p.items.length]).toEqual([0, 0, 0, 0]);
  });

  it('labels the page sizes', () => {
    expect(pageSizeLabel(0)).toBe('All');
    expect(pageSizeLabel(50)).toBe('50');
  });
});
