import { describe, expect, it } from 'vitest';

import { utilityKey, visibleProjects } from './visible-projects';

const registry = [
  { id: 'stock', utility: 'Stock Manager' },
  { id: 'modules', utility: 'Modules' },
  { id: 'gis', utility: 'GIS System' },
];

describe('visibleProjects', () => {
  it('shows only the panels for tools the person is linked to', () => {
    expect(visibleProjects(registry, ['Modules', 'Stock Manager']).map((p) => p.id)).toEqual(['stock', 'modules']);
  });

  it('shows nothing when no stock, modules or GIS tool is linked', () => {
    expect(visibleProjects(registry, ['User Access Control', 'GIS Hotspot'])).toEqual([]);
    expect(visibleProjects(registry, [])).toEqual([]);
    expect(visibleProjects(registry, null)).toEqual([]);
  });

  it('ignores case, spacing and underscores when matching', () => {
    expect(visibleProjects(registry, ['stock_manager', ' GIS  system ']).map((p) => p.id)).toEqual(['stock', 'gis']);
  });

  it('reads entries given as objects, as the Auth API sends them', () => {
    expect(
      visibleProjects(registry, [{ utility_name: 'Modules' }, { name: 'Stock Manager' }, null, undefined]).map((p) => p.id),
    ).toEqual(['stock', 'modules']);
  });

  it('keeps the registry order', () => {
    expect(visibleProjects(registry, ['GIS System', 'Stock Manager']).map((p) => p.id)).toEqual(['stock', 'gis']);
  });
});

describe('utilityKey', () => {
  it('normalises names', () => {
    expect(utilityKey('Manager_Portal')).toBe('manager portal');
    expect(utilityKey(undefined)).toBe('');
  });
});
