/**
 * Pure logic behind the two pickers (ces-pick-list and ces-user-picker), kept
 * apart from the components so it can be tested without a browser.
 *
 * Built for long lists: nothing here is quadratic, and a search narrows the
 * list but never loses what was already ticked.
 */
export interface PickItem {
  /** What gets selected / emitted (an email, a project name, an id). */
  key: string;
  /** What the person reads. */
  label: string;
  /** Optional second line, searched too (a project description). */
  sub?: string;
}

/** Items matching every word typed, in any order, ignoring case. */
export function filterItems(items: readonly PickItem[], query: string): PickItem[] {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (terms.length === 0) return items.slice();
  return items.filter((item) => {
    const hay = `${item.label} ${item.sub ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** A copy of `selected` with one key flipped. */
export function toggleKey(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** A copy of `selected` with every SHOWN item ticked or unticked. Hidden items keep their state. */
export function setShown(selected: ReadonlySet<string>, shown: readonly PickItem[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const item of shown) {
    if (on) next.add(item.key);
    else next.delete(item.key);
  }
  return next;
}

export function allShownSelected(selected: ReadonlySet<string>, shown: readonly PickItem[]): boolean {
  return shown.length > 0 && shown.every((item) => selected.has(item.key));
}

/** "3 selected, 5 of 18 projects shown" */
export function selectionSummary(selectedCount: number, shownCount: number, totalCount: number, noun: string): string {
  const picked = `${selectedCount} selected`;
  if (totalCount === 0) return `${picked}, no ${noun}`;
  const shown = shownCount === totalCount ? `all ${totalCount} ${noun}` : `${shownCount} of ${totalCount} ${noun} shown`;
  return `${picked}, ${shown}`;
}

/** The first `cap` items and how many were left out, so a huge list renders quickly. */
export function capList<T>(items: readonly T[], cap: number): { visible: T[]; hidden: number } {
  if (items.length <= cap) return { visible: items.slice(), hidden: 0 };
  return { visible: items.slice(0, cap), hidden: items.length - cap };
}

/** Move the highlighted row with the arrow keys, stopping at both ends. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
