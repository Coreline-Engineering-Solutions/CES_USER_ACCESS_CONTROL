import { describe, expect, it } from 'vitest';

import {
  PickItem,
  allShownSelected,
  capList,
  filterItems,
  selectionSummary,
  setShown,
  stepIndex,
  toggleKey,
} from './picker-logic';

const items: PickItem[] = [
  { key: 'Delft', label: 'Delft', sub: 'Delft FTTH rollout' },
  { key: 'Bothasig', label: 'Bothasig', sub: 'Cape Town north' },
  { key: 'Mooiwater', label: 'Mooiwater', sub: 'Field team zone' },
  { key: 'PM Test', label: 'PM Test' },
];

describe('filterItems', () => {
  it('returns everything for an empty or blank search', () => {
    expect(filterItems(items, '')).toHaveLength(4);
    expect(filterItems(items, '   ')).toHaveLength(4);
  });

  it('matches the label or the second line, ignoring case', () => {
    expect(filterItems(items, 'cape').map((i) => i.key)).toEqual(['Bothasig']);
    expect(filterItems(items, 'DELFT').map((i) => i.key)).toEqual(['Delft']);
  });

  it('needs every word, in any order', () => {
    expect(filterItems(items, 'rollout delft').map((i) => i.key)).toEqual(['Delft']);
    expect(filterItems(items, 'delft cape')).toEqual([]);
  });

  it('does not change the original list', () => {
    const copy = filterItems(items, '');
    copy.pop();
    expect(items).toHaveLength(4);
  });
});

describe('selection', () => {
  it('toggleKey flips one key and leaves the original alone', () => {
    const start = new Set(['Delft']);
    const added = toggleKey(start, 'PM Test');
    expect([...added].sort()).toEqual(['Delft', 'PM Test']);
    expect([...start]).toEqual(['Delft']);
    expect([...toggleKey(added, 'Delft')]).toEqual(['PM Test']);
  });

  it('setShown ticks only what is shown and keeps what is hidden', () => {
    const shown = filterItems(items, 'cape');
    const next = setShown(new Set(['Delft']), shown, true);
    expect([...next].sort()).toEqual(['Bothasig', 'Delft']);
  });

  it('setShown can untick just the shown ones', () => {
    const all = new Set(items.map((i) => i.key));
    const next = setShown(all, filterItems(items, 'cape'), false);
    expect(next.has('Bothasig')).toBe(false);
    expect(next.size).toBe(3);
  });

  it('allShownSelected is false for an empty list and true once every shown item is ticked', () => {
    expect(allShownSelected(new Set(), [])).toBe(false);
    const shown = filterItems(items, 'delft');
    expect(allShownSelected(new Set(['Delft']), shown)).toBe(true);
    expect(allShownSelected(new Set(), shown)).toBe(false);
  });

  it('selecting all of 18 then searching keeps the 18', () => {
    const many: PickItem[] = Array.from({ length: 18 }, (_, i) => ({ key: `P${i}`, label: `Project ${i}` }));
    const all = setShown(new Set(), filterItems(many, ''), true);
    expect(all.size).toBe(18);
    // searching changes what is shown, not what is selected
    expect(filterItems(many, 'Project 1')).toHaveLength(9); // Project 1 and Project 10 to 17
    expect(all.size).toBe(18);
  });
});

describe('selectionSummary', () => {
  it('says all when nothing is filtered out', () => {
    expect(selectionSummary(3, 18, 18, 'projects')).toBe('3 selected, all 18 projects');
  });

  it('says how many are shown when a search narrows the list', () => {
    expect(selectionSummary(0, 5, 18, 'projects')).toBe('0 selected, 5 of 18 projects shown');
  });

  it('handles an empty list', () => {
    expect(selectionSummary(0, 0, 0, 'people')).toBe('0 selected, no people');
  });
});

describe('capList and stepIndex', () => {
  it('capList keeps a short list whole', () => {
    expect(capList([1, 2, 3], 5)).toEqual({ visible: [1, 2, 3], hidden: 0 });
  });

  it('capList cuts a long list and reports how much is hidden', () => {
    const out = capList(Array.from({ length: 250 }, (_, i) => i), 100);
    expect(out.visible).toHaveLength(100);
    expect(out.hidden).toBe(150);
  });

  it('stepIndex stops at both ends and handles an empty list', () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(1, 1, 5)).toBe(2);
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});
